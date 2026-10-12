/**
 * Upload recording outputs to Google Drive.
 *
 * Auth (tried in order):
 *   1. Service account key — preferred for Google Workspace.
 *      Config: googleServiceAccountKey or GOOGLE_SERVICE_ACCOUNT_KEY env, as a
 *      key file path or the key JSON itself.
 *   2. OAuth2 refresh token — fallback for personal Gmail.
 *      Config: googleOAuth.{clientId,clientSecret,refreshToken}
 *
 * Optional feature — if Google Drive is not configured, silently skips.
 * Non-fatal — upload failure does not fail the recording pipeline.
 *
 * Folder structure in Drive:
 *   <shared-root> / <date> / <recording-slug> /
 *     recording.webm, report.md, quote.md, transcript.json, tasks.json, quote.json, meta.json
 */
import { google } from "googleapis";
import { createReadStream } from "./storage/fs.js";
import { stat, readFile, readdir } from "./storage/fs-promises.js";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getMoasurePaths } from "./moasure.js";
import { googleServiceAccountAuthOptions } from "./google-service-account.js";

let _drive = null;

export function getDriveClient(config) {
  if (_drive) return _drive;

  // Option 1: Service account key (Google Workspace — has Drive quota)
  const serviceAccountAuth = googleServiceAccountAuthOptions(config);
  if (serviceAccountAuth) {
    const auth = new google.auth.GoogleAuth({
      ...serviceAccountAuth,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
    _drive = google.drive({ version: "v3", auth });
    return _drive;
  }

  // Option 2: OAuth2 refresh token (personal Gmail fallback)
  const oauth = config.googleOAuth || {};
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || oauth.clientId;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || oauth.clientSecret;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || oauth.refreshToken;

  if (!clientId || !clientSecret || !refreshToken) return null;

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  const quotaProject = process.env.GOOGLE_CLOUD_QUOTA_PROJECT || oauth.quotaProject;
  _drive = google.drive({ version: "v3", auth });
  if (quotaProject) {
    _drive.context._options.headers = {
      ..._drive.context._options.headers,
      "x-goog-user-project": quotaProject,
    };
  }

  return _drive;
}

async function getOrCreateFolder(drive, name, parentId) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const list = await drive.files.list({
    q,
    fields: "files(id)",
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (list.data.files?.length) return list.data.files[0].id;

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  return res.data.id;
}

async function ensureRecordingDriveFolder({ jobDir, meta, config }) {
  if (meta.driveFileIds?.folderId) return meta.driveFileIds;
  return await uploadJobToDrive({ jobDir, meta, config });
}

async function uploadOrUpdateFile({ drive, fileId, requestBody, media }) {
  if (fileId) {
    const updateBody = { ...requestBody };
    delete updateBody.parents;
    const res = await drive.files.update({
      fileId,
      requestBody: updateBody,
      media,
      fields: "id, name",
      supportsAllDrives: true,
    });
    return res.data.id;
  }

  const res = await drive.files.create({
    requestBody,
    media,
    fields: "id, name",
    supportsAllDrives: true,
  });
  return res.data.id;
}

export async function uploadJobToDrive({ jobDir, meta, config }) {
  const drive = getDriveClient(config);
  if (!drive) return null;

  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || config.googleDriveFolderId;
  if (!rootFolderId) return null;

  const dateDir = meta.createdAt.slice(0, 10);
  const dateFolderId = await getOrCreateFolder(drive, dateDir, rootFolderId);
  const folderName = meta.slug || meta.id;
  const recFolderId = await getOrCreateFolder(drive, folderName, dateFolderId);

  const uploaded = {};

  // Upload audio (supports multiple files via audioFiles array)
  const audioFileList = meta.audioFiles || (meta.audioFile ? [meta.audioFile] : []);
  for (let i = 0; i < audioFileList.length; i++) {
    const audioFilename = audioFileList[i];
    const audioPath = join(jobDir, audioFilename);
    try {
      const audioStat = await stat(audioPath).catch(() => null);
      if (audioStat?.isFile()) {
        const driveKey = i === 0 ? "audio" : `audio_${i}`;
        const audioId = await uploadOrUpdateFile({
          drive,
          fileId: meta.driveFileIds?.[driveKey] || null,
          requestBody: { name: audioFilename, parents: [recFolderId] },
          media: { mimeType: meta.mimeType || "audio/webm", body: createReadStream(audioPath) },
        });
        uploaded[driveKey] = audioId;
      }
    } catch (err) {
      console.error(`[drive] failed to upload audio ${audioFilename}: ${err.message}`);
    }
  }

  // Upload text outputs
  const textFiles = [
    { name: "report.md", mime: "text/markdown", convertTo: "application/vnd.google-apps.document" },
    { name: "quote.md", mime: "text/markdown", convertTo: "application/vnd.google-apps.document" },
    { name: "quote.pdf", mime: "application/pdf" },
    { name: "transcript.json", mime: "application/json" },
    { name: "tasks.json", mime: "application/json" },
    { name: "quote-inputs.json", mime: "application/json" },
    { name: "quote-overrides.json", mime: "application/json" },
    { name: "quote.json", mime: "application/json" },
    { name: "meta.json", mime: "application/json" },
  ];
  for (const { name: fileName, mime, convertTo } of textFiles) {
    const filePath = join(jobDir, fileName);
    try {
      await stat(filePath);
      const content = mime === "application/pdf" ? await readFile(filePath) : await readFile(filePath, "utf8");
      const requestBody = { name: convertTo ? fileName.replace(/\.\w+$/, "") : fileName, parents: [recFolderId] };
      if (convertTo) requestBody.mimeType = convertTo;
      const fileId = await uploadOrUpdateFile({
        drive,
        fileId: convertTo ? null : (meta.driveFileIds?.[fileName] || null),
        requestBody,
        media: { mimeType: mime, body: Readable.from([content]) },
      });
      uploaded[fileName] = fileId;
    } catch (err) {
      if (err.code === "ENOENT") continue;
      console.error(`[drive] failed to upload ${fileName}: ${err.message}`);
    }
  }

  console.log(`[drive] ${meta.id} uploaded — ${Object.keys(uploaded).length} files`);
  uploaded.folderId = recFolderId;
  return uploaded;
}

export async function uploadMoasureBatchToDrive({ jobDir, meta, config, batchId = null }) {
  const drive = getDriveClient(config);
  if (!drive) return meta.driveFileIds || null;

  const driveIds = {
    ...(meta.driveFileIds || {}),
    ...((await ensureRecordingDriveFolder({ jobDir, meta, config })) || {}),
  };
  if (!driveIds.folderId) return driveIds;

  const paths = getMoasurePaths(jobDir);
  const moasureFolderId = await getOrCreateFolder(drive, "moasure", driveIds.folderId);
  const rawFolderId = await getOrCreateFolder(drive, "raw", moasureFolderId);
  const parsedFolderId = await getOrCreateFolder(drive, "parsed", moasureFolderId);

  const uploaded = {
    ...driveIds,
    moasureFolderId,
    moasureRawFolderId: rawFolderId,
    moasureParsedFolderId: parsedFolderId,
  };

  if (batchId) {
    const batchDir = join(paths.rawDir, batchId);
    const batchFolderId = await getOrCreateFolder(drive, batchId, rawFolderId);
    uploaded[`moasure.batch.${batchId}.folderId`] = batchFolderId;

    const batchFiles = await readdir(batchDir).catch(() => []);
    for (const fileName of batchFiles) {
      const filePath = join(batchDir, fileName);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat?.isFile()) continue;
      const mimeType = detectMimeType(fileName);
      const key = `moasure.batch.${batchId}.${fileName}`;
      uploaded[key] = await uploadOrUpdateFile({
        drive,
        fileId: meta.driveFileIds?.[key] || null,
        requestBody: { name: fileName, parents: [batchFolderId] },
        media: { mimeType, body: createReadStream(filePath) },
      });
    }
  }

  const latestFiles = [
    { path: paths.latestJsonPath, name: "latest.json", mime: "application/json", key: "moasure.parsed.latest.json" },
    { path: paths.latestMarkdownPath, name: "latest", mime: "text/markdown", convertTo: "application/vnd.google-apps.document", key: "moasure.parsed.latest.md" },
  ];
  for (const file of latestFiles) {
    const fileStat = await stat(file.path).catch(() => null);
    if (!fileStat?.isFile()) continue;
    const content = await readFile(file.path, file.mime === "application/json" ? "utf8" : "utf8");
    const requestBody = { name: file.name, parents: [parsedFolderId] };
    if (file.convertTo) requestBody.mimeType = file.convertTo;
    uploaded[file.key] = await uploadOrUpdateFile({
      drive,
      fileId: file.convertTo ? null : (meta.driveFileIds?.[file.key] || null),
      requestBody,
      media: { mimeType: file.mime, body: Readable.from([content]) },
    });
  }

  return uploaded;
}

function detectMimeType(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".mfile")) return "application/octet-stream";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
