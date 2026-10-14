// Each operator's email signature (Settings > Email signature), added under
// a new message in the composer as Gmail does. Kept in the data directory
// beside the email templates (`email-signatures.json`), by the signed-in
// person's email, so it works with either sign-in. Only the person can read
// or change their own. Unset: the default sign-off (shared/email-templates.js).
import { mkdir, readFile, rename, writeFile } from "./storage/fs-promises.js";
import { dirname, join } from "node:path";
import { DEFAULT_EMAIL_SIGNATURE_HTML } from "../shared/email-templates.js";
import { sanitizeEmailBodyHtml } from "./email-html.js";

const FILE = "email-signatures.json";
const MAX_LENGTH = 4000;

function keyFor(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) {
    const error = new Error("an email signature belongs to a signed-in person");
    error.statusCode = 403;
    throw error;
  }
  return email;
}

async function readAll(dataDir) {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, FILE), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** { html, isDefault } for the person. */
export async function readEmailSignature({ dataDir, user }) {
  const stored = (await readAll(dataDir))[keyFor(user)] || null;
  return stored?.html
    ? { html: stored.html, isDefault: false, updatedAt: stored.updatedAt || null }
    : { html: DEFAULT_EMAIL_SIGNATURE_HTML, isDefault: true, updatedAt: null };
}

/** Save the person's signature; an empty one returns them to the default. */
export async function saveEmailSignature({ dataDir, user, html }) {
  const key = keyFor(user);
  const raw = String(html ?? "").trim();
  if (raw.length > MAX_LENGTH) {
    const error = new Error(`a signature can be at most ${MAX_LENGTH} characters`);
    error.statusCode = 400;
    throw error;
  }
  const clean = raw ? sanitizeEmailBodyHtml(raw) : "";
  const all = await readAll(dataDir);
  if (clean) all[key] = { html: clean, updatedAt: new Date().toISOString() };
  else delete all[key];
  const path = join(dataDir, FILE);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  return readEmailSignature({ dataDir, user });
}
