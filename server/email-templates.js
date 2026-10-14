import { existsSync } from "./storage/fs.js";
import { mkdir, readFile, rename, writeFile } from "./storage/fs-promises.js";
import { dirname, join } from "node:path";
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_DOCUMENT_TYPES,
  EMAIL_TEMPLATE_PLACEHOLDERS,
} from "../shared/email-templates.js";
import { sanitizeEmailBodyHtml } from "./email-html.js";

let statePath = null;
let overrides = {};

export async function initEmailTemplates(dataDir) {
  statePath = join(dataDir, "email-templates.json");
  overrides = await readOverrides(statePath);
}

export function listEmailTemplates() {
  requireInit();
  return {
    documentTypes: EMAIL_TEMPLATE_DOCUMENT_TYPES,
    allowedPlaceholders: EMAIL_TEMPLATE_PLACEHOLDERS,
    templates: Object.fromEntries(
      EMAIL_TEMPLATE_DOCUMENT_TYPES.map((documentType) => [
        documentType,
        DEFAULT_EMAIL_TEMPLATES[documentType].map((template) => ({
          ...template,
          ...(overrides[documentType]?.[template.id] || {}),
        })),
      ]),
    ),
  };
}

export async function updateEmailTemplate(documentType, templateId, patch, actor = null) {
  requireInit();
  const type = normalizeDocumentType(documentType);
  const id = String(templateId || "").trim();
  const existing = DEFAULT_EMAIL_TEMPLATES[type].find((template) => template.id === id);
  if (!existing) {
    const error = new Error(`unknown ${type} email template: ${id}`);
    error.statusCode = 404;
    throw error;
  }
  const current = { ...existing, ...(overrides[type]?.[id] || {}) };
  const next = {
    name: cleanText(patch?.name ?? current.name, "name", 80),
    description: cleanText(patch?.description ?? current.description, "description", 240),
    subject: cleanText(patch?.subject ?? current.subject, "subject", 240),
    html: sanitizeEmailBodyHtml(cleanText(patch?.html ?? current.html, "html", 20_000)),
    updatedAt: new Date().toISOString(),
    updatedBy: actor ? {
      id: actor.id || null,
      name: actor.name || actor.email || null,
    } : null,
  };
  overrides[type] = { ...(overrides[type] || {}), [id]: next };
  await persist();
  return { id, ...next };
}

function normalizeDocumentType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!EMAIL_TEMPLATE_DOCUMENT_TYPES.includes(normalized)) {
    const error = new Error(`documentType must be one of: ${EMAIL_TEMPLATE_DOCUMENT_TYPES.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function cleanText(value, field, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) {
    const error = new Error(`${field} is required`);
    error.statusCode = 400;
    throw error;
  }
  if (text.length > maxLength) {
    const error = new Error(`${field} must be ${maxLength} characters or fewer`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

async function readOverrides(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed?.overrides && typeof parsed.overrides === "object" ? parsed.overrides : {};
  } catch {
    return {};
  }
}

async function persist() {
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ version: 1, overrides }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, statePath);
}

function requireInit() {
  if (!statePath) throw new Error("email template store not initialised");
}
