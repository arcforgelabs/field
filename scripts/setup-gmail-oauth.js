#!/usr/bin/env node
import { createServer } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { google } from "googleapis";
import { GMAIL_SEND_SCOPES } from "../server/send-quote-email.js";

const CLOUD_SDK_CLIENT_ID = "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com";

const execFile = promisify(execFileCallback);

// Where Field runs. Nothing about any particular installation is hardcoded:
// pass the SSH host (or set FIELD_VPS) and the sender email for your own
// installation. --oauth-source-host reads the OAuth client from another
// installation's config (defaults to the target).
const { values } = parseArgs({
  options: {
    env: { type: "string", default: "staging" },
    host: { type: "string" },
    "config-path": { type: "string", default: "/opt/apps/field/config.json" },
    "oauth-source-host": { type: "string" },
    "service-user": { type: "string", default: "deploy" },
    email: { type: "string" },
    port: { type: "string", default: "8765" },
    "redirect-uri": { type: "string" },
    "client-file": { type: "string" },
    "quota-project": { type: "string" },
    "from-name": { type: "string", default: "Field" },
    "no-open": { type: "boolean", default: false },
    "no-restart": { type: "boolean", default: false },
  },
});

const targetHost = values.host || process.env.FIELD_VPS;
if (!targetHost) {
  throw new Error("Set --host <ssh-host> (or FIELD_VPS) to the machine running Field.");
}
if (!values.email) {
  throw new Error("Set --email <sender@your-domain> to the Gmail account that sends quotes.");
}
const target = {
  host: targetHost,
  configPath: values["config-path"],
  defaultEmail: values.email,
  defaultQuotaProject: process.env.GOOGLE_CLOUD_QUOTA_PROJECT || null,
};
const oauthSourceTarget = values["oauth-source-host"]
  ? { ...target, host: values["oauth-source-host"] }
  : target;

const email = values.email || target.defaultEmail;
const requestedRedirectPort = Number(values.port);
if (!Number.isFinite(requestedRedirectPort) || requestedRedirectPort <= 0) {
  throw new Error(`Invalid port "${values.port}".`);
}

const targetConfig = await readRemoteConfig(target);
const oauthSourceConfig = oauthSourceTarget === target
  ? targetConfig
  : await readRemoteConfig(oauthSourceTarget);
const clientFileOAuth = values["client-file"]
  ? await readClientFile(values["client-file"])
  : null;
const sourceOAuth = oauthSourceConfig.googleOAuth || {};
const baseOAuth = {
  clientId: clientFileOAuth?.clientId || targetConfig.googleOAuth?.clientId || sourceOAuth.clientId || null,
  clientSecret: clientFileOAuth?.clientSecret || targetConfig.googleOAuth?.clientSecret || sourceOAuth.clientSecret || null,
  quotaProject: values["quota-project"] || clientFileOAuth?.quotaProject || target.defaultQuotaProject || targetConfig.googleOAuth?.quotaProject || sourceOAuth.quotaProject || null,
  redirectUris: clientFileOAuth?.redirectUris || null,
};

if (!baseOAuth.clientId || !baseOAuth.clientSecret) {
  throw new Error(`No usable googleOAuth clientId/clientSecret found for ${values.env}.`);
}

if (baseOAuth.clientId === CLOUD_SDK_CLIENT_ID) {
  throw new Error([
    "The configured googleOAuth client is the Google Cloud SDK default client.",
    "Google blocks that client for Gmail consent in custom apps.",
    "Create an app-owned OAuth client in Google Cloud Console and retry.",
    "Use an External Desktop app client in your own Google Cloud project, add the sender as a test user if the app is in testing,",
    "then re-run this helper with --client-file /path/to/client-secret.json.",
  ].join(" "));
}

const redirectPort = await findAvailablePort(requestedRedirectPort, "127.0.0.1");
const redirectUri = buildRedirectUri({
  explicitUri: values["redirect-uri"] || null,
  redirectUris: baseOAuth.redirectUris,
  port: redirectPort,
});
const oauth = new google.auth.OAuth2(baseOAuth.clientId, baseOAuth.clientSecret, redirectUri);
const scopes = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/contacts.readonly",
  "openid",
  ...GMAIL_SEND_SCOPES,
];
const authUrl = oauth.generateAuthUrl({
  access_type: "offline",
  include_granted_scopes: true,
  prompt: "consent select_account",
  login_hint: email,
  scope: scopes,
});

console.log("");
console.log(`Target: ${values.env} (${target.host})`);
console.log(`Email: ${email}`);
console.log(`Redirect URI: ${redirectUri}`);
console.log("");
console.log("Open this URL to grant Gmail send consent:");
console.log(authUrl);
console.log("");

  if (!values["no-open"]) {
    await tryOpen(authUrl);
  }

const code = await waitForCallback(redirectPort);
const tokenResult = await oauth.getToken(code);
oauth.setCredentials(tokenResult.tokens);

if (!tokenResult.tokens.refresh_token) {
  throw new Error("No refresh token returned. Revoke prior consent for this app and retry.");
}

const profile = await google.oauth2({ version: "v2", auth: oauth }).userinfo.get();
const consentEmail = (profile.data.email || "").trim().toLowerCase();
if (consentEmail && consentEmail !== email.trim().toLowerCase()) {
  throw new Error(`Consent completed for ${consentEmail}, but ${email} was required for ${values.env}. Re-run and choose the correct account.`);
}
const nextConfig = {
  ...targetConfig,
  googleOAuth: {
    ...(targetConfig.googleOAuth || {}),
    clientId: baseOAuth.clientId,
    clientSecret: baseOAuth.clientSecret,
    quotaProject: baseOAuth.quotaProject,
    refreshToken: tokenResult.tokens.refresh_token,
  },
  mail: {
    ...(targetConfig.mail || {}),
    fromEmail: email,
    fromName: values["from-name"],
    replyTo: email,
  },
};

await writeRemoteConfig(target, nextConfig);
if (!values["no-restart"]) {
  await restartRemoteService(target.host, values["service-user"]);
}

console.log("");
console.log(JSON.stringify({
  ok: true,
  env: values.env,
  host: target.host,
  consentEmail: consentEmail || email,
  remoteMailFrom: nextConfig.mail.fromEmail,
  restarted: !values["no-restart"],
}, null, 2));

async function readRemoteConfig(targetConfig) {
  const { stdout } = await execFile("ssh", [targetConfig.host, "cat", targetConfig.configPath], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function readClientFile(clientFilePath) {
  const parsed = JSON.parse(await readFile(clientFilePath, "utf8"));
  const installed = parsed.installed || null;
  const web = parsed.web || null;
  const candidate = installed || web || parsed;
  if (!candidate?.client_id || !candidate?.client_secret) {
    throw new Error(`OAuth client file ${clientFilePath} is missing client_id/client_secret.`);
  }
  return {
    clientId: candidate.client_id,
    clientSecret: candidate.client_secret,
    quotaProject: parsed.project_id || candidate.project_id || null,
    redirectUris: candidate.redirect_uris || null,
  };
}

function buildRedirectUri({ explicitUri, redirectUris, port }) {
  if (explicitUri) {
    return explicitUri;
  }

  const candidate = Array.isArray(redirectUris)
    ? redirectUris.find((uri) => uri.startsWith("http://localhost") || uri.startsWith("http://127.0.0.1") || uri.startsWith("http://[::1]"))
    : null;

  if (!candidate) {
    return `http://localhost:${port}`;
  }

  const url = new URL(candidate.endsWith("/") ? candidate : `${candidate}/`);
  url.port = String(port);
  if (url.pathname === "/oauth2callback/") {
    url.pathname = "/oauth2callback";
  }
  if (url.pathname === "//") {
    url.pathname = "/";
  }
  return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
}

async function findAvailablePort(startPort, host) {
  for (let port = startPort; port < startPort + 20; port += 1) {
    try {
      await canListen(host, port);
      return port;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") {
        throw error;
      }
    }
  }
  throw new Error(`No free callback port found starting at ${startPort}.`);
}

async function canListen(host, port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve();
      });
    });
  });
}

async function writeRemoteConfig(targetConfig, config) {
  const tempDir = await mkdtemp(join(tmpdir(), "field-oauth-"));
  const localPath = join(tempDir, "config.json");
  const remoteTempPath = `/tmp/field-config-${Date.now()}.json`;
  const remoteInstallScript = `install -o deploy -g deploy -m 600 '${remoteTempPath}' '${targetConfig.configPath}' && rm -f '${remoteTempPath}'`;
  await writeFile(localPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    await execFile("scp", [localPath, `${targetConfig.host}:${remoteTempPath}`], {
      maxBuffer: 8 * 1024 * 1024,
    });
    await execFile("ssh", [targetConfig.host, remoteInstallScript], {
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function restartRemoteService(host, serviceUser) {
  await execFile("ssh", [host, "sudo", "-u", serviceUser, "bash", "-lc", 'XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user restart field.service'], {
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function tryOpen(url) {
  const candidates = [
    ["xdg-open", [url]],
    ["open", [url]],
  ];
  for (const [command, args] of candidates) {
    try {
      await execFile(command, args, { maxBuffer: 1024 * 1024 });
      return;
    } catch {
      // keep trying
    }
  }
}

async function waitForCallback(port) {
  return await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`OAuth error: ${error}`);
          server.close();
          reject(new Error(`OAuth consent failed: ${error}`));
          return;
        }
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Missing code");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Gmail consent complete. You can close this tab.");
        server.close();
        resolve(code);
      } catch (err) {
        server.close();
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      console.error(`[gmail-oauth] waiting for callback on ${port}`);
    });
    server.on("error", reject);
  });
}
