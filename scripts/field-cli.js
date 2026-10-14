#!/usr/bin/env node
import process from "node:process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const USER_CONFIG_DIR = process.env.FIELD_CONFIG_DIR || join(homedir(), ".config", "field");
const USER_CONFIG_PATH = join(USER_CONFIG_DIR, "config.json");
const USER_TOKEN_PATH = join(USER_CONFIG_DIR, "token");
const LEGACY_CONFIG_PATHS = [
  join(import.meta.dirname, "..", "config.local.json"),
  join(import.meta.dirname, "..", "config.json"),
];

const userConfig = await readJsonFile(USER_CONFIG_PATH) || {};
let fieldUrl = process.env.FIELD_URL || userConfig.url || "http://localhost:19200";
let authToken = process.env.FIELD_TOKEN || "";
let authSource = process.env.FIELD_TOKEN ? "FIELD_TOKEN" : "none";

if (!authToken) {
  const tokenPath = process.env.FIELD_TOKEN_FILE || userConfig.tokenFile || USER_TOKEN_PATH;
  if (existsSync(tokenPath)) {
    authToken = String(await readFile(tokenPath, "utf8")).trim();
    authSource = tokenPath;
  }
}

if (!authToken) {
  for (const configPath of LEGACY_CONFIG_PATHS) {
    if (!existsSync(configPath)) continue;
    try {
      const config = JSON.parse(await readFile(configPath, "utf8"));
      if (config?.authToken) {
        authToken = config.authToken;
        authSource = configPath;
        break;
      }
    } catch {
      // Ignore malformed local configs here; API requests will fail explicitly later.
    }
  }
}

async function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function jobPath(id, suffix = "") {
  return `/api/jobs/${encodeURIComponent(id)}${suffix}`;
}

function buildUrl(path) {
  if (/^https?:\/\//i.test(String(path || ""))) return String(path);
  const base = fieldUrl.replace(/\/+$/, "");
  const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${String(path || "")}`;
  return `${base}${normalizedPath}`;
}

function trimText(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function parseFlag(args, flag, defaultValue = null) {
  const index = args.indexOf(flag);
  if (index === -1) return defaultValue;
  return args[index + 1] ?? defaultValue;
}

function hasFlag(args, ...flags) {
  return flags.some((flag) => args.includes(flag));
}

function collectPositionals(args, { flagsWithValue = [] } = {}) {
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (flagsWithValue.includes(value)) {
      index += 1;
      continue;
    }
    if (String(value || "").startsWith("--")) continue;
    positionals.push(value);
  }
  return positionals;
}

function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

function formatMoney(value) {
  const numeric = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(numeric)) {
    return "unavailable";
  }
  return `$${numeric.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatVersionLabel(version) {
  const numeric = Number(version || 0);
  return numeric > 0 ? `v${String(numeric).padStart(3, "0")}` : "n/a";
}

function parsePositiveInt(value) {
  const numeric = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseVersionLiteral(value) {
  const raw = trimText(value);
  if (!raw) return null;
  return parsePositiveInt(raw.replace(/^v/i, ""));
}

function parseMilestoneNumber(value) {
  const raw = trimText(value);
  if (!raw) return null;
  const normalized = raw.replace(/^m/i, "");
  const milestoneNumber = parsePositiveInt(normalized);
  if (!milestoneNumber) {
    throw new Error("milestone must be a positive human number such as 1, 2, or M3");
  }
  return milestoneNumber - 1;
}

async function parseJsonSource(source) {
  const trimmed = trimText(source);
  if (!trimmed) throw new Error("JSON source required");
  const resolvedPath = resolve(trimmed);
  if (existsSync(resolvedPath)) {
    return JSON.parse(await readFile(resolvedPath, "utf8"));
  }
  return JSON.parse(trimmed);
}

async function readOptionalBody(args) {
  const inlineBody = parseFlag(args, "--body");
  const bodyFile = parseFlag(args, "--body-file");
  if (inlineBody && bodyFile) {
    throw new Error("use either --body or --body-file, not both");
  }
  if (bodyFile) {
    return await readFile(resolve(bodyFile), "utf8");
  }
  return inlineBody ?? null;
}

// A 429 from Field's rate limits (docs/RATE_LIMITS.md): say how long to wait,
// from Retry-After. The CLI does not retry by itself.
function waitFromRetryAfter(value) {
  const seconds = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isInteger(seconds) || seconds <= 0) return "a moment";
  if (seconds < 120) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

async function rateLimitedMessage(method, path, response) {
  const body = await response.json().catch(() => ({}));
  const budget = typeof body?.budget === "string" && /^[a-z-]{1,32}$/.test(body.budget) ? ` (${body.budget} limit)` : "";
  return `${method} ${path}: Field is rate-limiting these requests${budget}. Wait ${waitFromRetryAfter(response.headers.get("retry-after") ?? body?.retryAfter)}, then try again.`;
}

async function request(method, path, { body = null, headers = {} } = {}) {
  if (!authToken) {
    throw new Error("Field is not authenticated. Run: field auth login --url https://<your-field-host>");
  }
  const requestHeaders = {
    Authorization: `Bearer ${authToken}`,
    Accept: "application/json",
    ...headers,
  };
  const options = { method, headers: requestHeaders };
  if (body != null) {
    if (body instanceof FormData) {
      options.body = body;
    } else {
      requestHeaders["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
  }

  const response = await fetch(buildUrl(path), options);
  if (response.status === 429) throw new Error(await rateLimitedMessage(method, path, response));
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return response;
}

async function readSecretFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8").trim();
}

async function readSecretFromTerminal(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("interactive input unavailable; pipe the token to: field auth login --token-stdin --url <url>");
  }
  process.stdout.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise((resolveSecret, rejectSecret) => {
    let secret = "";
    const finish = (error = null) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) rejectSecret(error);
      else resolveSecret(secret.trim());
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          secret = secret.slice(0, -1);
        } else {
          secret += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function verifyCredential(url, token) {
  const response = await fetch(`${String(url).replace(/\/+$/, "")}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (response.status === 429) throw new Error(await rateLimitedMessage("GET", "/api/auth/me", response));
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.user) {
    throw new Error(`Field authentication failed (${response.status}): ${body.error || "invalid credential"}`);
  }
  return body.user;
}

async function saveCredential({ url, token }) {
  await mkdir(USER_CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(USER_TOKEN_PATH, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(USER_TOKEN_PATH, 0o600);
  await writeFile(USER_CONFIG_PATH, `${JSON.stringify({ url }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(USER_CONFIG_PATH, 0o600);
}

async function requestJson(method, path, options = {}) {
  const response = await request(method, path, options);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${method} ${path} returned ${contentType || "non-JSON content"}`);
  }
  return await response.json();
}

async function requestText(method, path, options = {}) {
  const response = await request(method, path, options);
  return await response.text();
}

async function requestBuffer(method, path, options = {}) {
  const response = await request(method, path, options);
  return Buffer.from(await response.arrayBuffer());
}

async function uploadFile(path, fileField, filePath, extraFields = {}) {
  const fileBuffer = await readFile(resolve(filePath));
  const formData = new FormData();
  formData.append(fileField, new Blob([fileBuffer]), basename(filePath));
  for (const [key, value] of Object.entries(extraFields)) {
    if (value == null || value === "") continue;
    formData.append(key, String(value));
  }
  return await requestJson("POST", path, { body: formData, headers: { Accept: "application/json" } });
}

async function resolveVersionSelector(id, selector) {
  const raw = trimText(selector);
  if (!raw) return null;

  const literal = parseVersionLiteral(raw);
  if (literal) return literal;

  const detail = await requestJson("GET", jobPath(id));
  const normalized = raw.toLowerCase();
  if (["selected", "default", "current"].includes(normalized)) {
    return detail?.versionView?.selectedVersion || detail?.quote?.version || detail?.meta?.quoteVersion || null;
  }
  if (["latest", "draft"].includes(normalized)) {
    return detail?.versionView?.latestVersion || detail?.quote?.version || detail?.meta?.quoteVersion || null;
  }
  if (["customer", "sent", "locked"].includes(normalized)) {
    return detail?.quoteLifecycle?.lastSentQuoteVersion || detail?.versionView?.selectedVersion || detail?.quote?.version || null;
  }

  throw new Error(`unknown version selector: ${selector}. Use vNNN, latest, or customer`);
}

async function getJobDetail(id, { versionSelector = null, preferLatest = false } = {}) {
  const requestedVersion = await resolveVersionSelector(id, versionSelector);
  if (requestedVersion) {
    return await requestJson("GET", `${jobPath(id)}${buildQuery({ version: requestedVersion })}`);
  }

  const detail = await requestJson("GET", jobPath(id));
  if (!preferLatest) return detail;

  const latestVersion = detail?.versionView?.latestVersion || null;
  const selectedVersion = detail?.versionView?.selectedVersion || null;
  if (!latestVersion || latestVersion === selectedVersion) return detail;

  return await requestJson("GET", `${jobPath(id)}${buildQuery({ version: latestVersion })}`);
}

function cloneOrganizerFromDetail(detail) {
  const organizer = detail?.quote?.presentation?.organizer || { root: [], nodes: {} };
  return JSON.parse(JSON.stringify(organizer));
}

function getContainerForParent(organizer, parentId) {
  if (!parentId || parentId === "root") {
    organizer.root ||= [];
    return organizer.root;
  }

  const parent = organizer.nodes?.[parentId];
  if (!parent) throw new Error(`parent node not found: ${parentId}`);
  if (!Array.isArray(parent.children)) parent.children = [];
  return parent.children;
}

function findNodeReference(organizer, nodeId) {
  organizer.root ||= [];
  const rootIndex = organizer.root.indexOf(nodeId);
  if (rootIndex >= 0) {
    return { parentId: null, list: organizer.root, index: rootIndex };
  }

  for (const [candidateId, candidate] of Object.entries(organizer.nodes || {})) {
    const children = Array.isArray(candidate?.children) ? candidate.children : [];
    const index = children.indexOf(nodeId);
    if (index >= 0) {
      return { parentId: candidateId, list: children, index };
    }
  }

  return null;
}

function detachNode(organizer, nodeId) {
  const reference = findNodeReference(organizer, nodeId);
  if (!reference) return null;
  reference.list.splice(reference.index, 1);
  return reference;
}

function assertNoCycle(organizer, nodeId, targetParentId) {
  if (!targetParentId || targetParentId === "root") return;
  let cursor = targetParentId;
  while (cursor) {
    if (cursor === nodeId) {
      throw new Error("cannot move a node inside itself or one of its descendants");
    }
    cursor = findNodeReference(organizer, cursor)?.parentId || null;
  }
}

function attachNode(organizer, nodeId, targetParentId, index = null) {
  assertNoCycle(organizer, nodeId, targetParentId);
  const container = getContainerForParent(organizer, targetParentId);
  if (index == null || index < 0 || index > container.length) {
    container.push(nodeId);
  } else {
    container.splice(index, 0, nodeId);
  }
}

function removeNodeAndPromoteChildren(organizer, nodeId) {
  const node = organizer.nodes?.[nodeId];
  if (!node) throw new Error(`node not found: ${nodeId}`);

  const reference = findNodeReference(organizer, nodeId);
  if (!reference) throw new Error(`node is not attached in organizer tree: ${nodeId}`);

  const promotedChildren = Array.isArray(node.children) ? [...node.children] : [];
  reference.list.splice(reference.index, 1, ...promotedChildren);
  delete organizer.nodes[nodeId];
  return node;
}

function describeNode(node, nodeId) {
  const label = node?.kind === "group"
    ? (node.label || "(unnamed group)")
    : (node.labelOverride || node.sourceCode || nodeId);
  const tags = [];

  if (node?.kind === "group") {
    tags.push("group");
  } else {
    // Prefer canonical origin (engine/manual/generated) when present, falling
    // back to the legacy sourceKind for backward compatibility with older
    // persisted organizers that pre-date the schema collapse.
    const origin = node?.origin || (
      node?.sourceKind === "manual" ? "manual"
      : node?.sourceKind === "generated_component" ? "generated"
      : "engine"
    );
    tags.push(origin);
  }
  if (node?.collapsed) tags.push("collapsed");
  if (node?.amountVisible === false) tags.push("hidden");
  if (node?.amountBlank) tags.push("blank");
  if (node?.excludedFromPrice) tags.push("excluded");

  const amounts = [];
  if (typeof node?.manualPrice === "number") amounts.push(`manualPrice=${formatMoney(node.manualPrice)}`);
  if (typeof node?.manualCost === "number") amounts.push(`manualCost=${formatMoney(node.manualCost)}`);
  if (typeof node?.priceOverride === "number") amounts.push(`priceOverride=${formatMoney(node.priceOverride)}`);
  if (typeof node?.costOverride === "number") amounts.push(`costOverride=${formatMoney(node.costOverride)}`);

  return {
    label,
    tags,
    amounts,
  };
}

function printPresentationTree(organizer, nodeIds, depth = 0) {
  for (const nodeId of nodeIds || []) {
    const node = organizer.nodes?.[nodeId];
    const prefix = `${"  ".repeat(depth)}-`;
    if (!node) {
      console.log(`${prefix} ${nodeId} [missing]`);
      continue;
    }

    const description = describeNode(node, nodeId);
    const tagText = description.tags.length ? ` [${description.tags.join(", ")}]` : "";
    const amountText = description.amounts.length ? ` (${description.amounts.join(", ")})` : "";
    console.log(`${prefix} ${nodeId} :: ${description.label}${tagText}${amountText}`);

    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length) {
      printPresentationTree(organizer, children, depth + 1);
    }
  }
}

function describeRegionText(region) {
  if (!region?.country) return "not set";
  return region.region ? `${region.region}, ${region.country}` : region.country;
}

function summarizeScheduleSource(source) {
  if (!source?.kind) return null;
  if (source.kind === "rule") return `account rule "${source.ruleName}"${source.milestonesFrom === "default" ? " (Field's default milestones)" : ""}`;
  return `override, set on this job by ${source.by || "someone"}${source.ruleName ? ` (account rule "${source.ruleName}")` : ""}`;
}

function summarizeRule(rule) {
  const money = (value) => formatMoney(value);
  const band = rule.maxValue != null
    ? (rule.minValue > 0 ? `${money(rule.minValue)} to under ${money(rule.maxValue)}` : `under ${money(rule.maxValue)}`)
    : (rule.minValue > 0 ? `from ${money(rule.minValue)}` : "any value");
  const milestones = rule.milestones.length
    ? rule.milestones.map((milestone) => `${milestone.label} ${milestone.fixedTotal ? money(milestone.fixedTotal) : `${milestone.percentage}%`}`).join(", ")
    : "Field's default milestones";
  const caps = rule.caps.map((cap) => `${cap.kind} <= ${[cap.maxAmount ? money(cap.maxAmount) : null, cap.maxPercent ? `${cap.maxPercent}%` : null].filter(Boolean).join(" and ")} (${cap.mode})`).join(", ");
  return `${rule.name} [${rule.country ? describeRegionText(rule) : "every region"}, ${band}, ${rule.valueBasis}]: ${milestones}${caps ? `; caps: ${caps}` : ""}`;
}

function summarizeMilestone(milestone) {
  const humanNumber = Number(milestone?.milestoneIndex || 0) + 1;
  return [
    `M${humanNumber}`,
    milestone?.invoiceNumber || null,
    milestone?.status === "paid" && milestone?.receiptNumber ? `receipt=${milestone.receiptNumber}` : null,
    milestone?.milestoneLabel || null,
    milestone?.status || null,
    `total=${formatMoney(milestone?.total)}`,
    `paid=${formatMoney(milestone?.amountPaid)}`,
    `due=${formatMoney(milestone?.amountDue)}`,
    milestone?.dueDate ? `dueDate=${milestone.dueDate}` : null,
    Number(milestone?.revisionNumber || 1) > 1 ? `revision=${milestone.revisionNumber}` : null,
  ].filter(Boolean).join(" | ");
}

function summarizeInvoiceRevision(revision) {
  return [
    `r${revision?.revisionNumber ?? "?"}`,
    revision?.invoiceNumber || null,
    revision?.current ? "current" : "superseded",
    `total=${formatMoney(revision?.total)}`,
    revision?.quoteVersion ? `quote=v${String(revision.quoteVersion).padStart(3, "0")}` : null,
    revision?.issuedAt ? `issued=${revision.issuedAt}` : null,
    revision?.revisedBy ? `by=${revision.revisedBy}` : null,
    revision?.revisionReason ? `reason=${revision.revisionReason}` : null,
  ].filter(Boolean).join(" | ");
}

async function saveTextOutput(outputPath, content, defaultPath = "-") {
  const destination = outputPath || defaultPath;
  if (destination === "-") {
    console.log(content);
    return;
  }
  await writeFile(resolve(destination), content);
  console.log(`Saved: ${destination}`);
}

async function mutateOrganizer(id, mutator) {
  const detail = await getJobDetail(id, { preferLatest: true });
  const organizer = cloneOrganizerFromDetail(detail);
  organizer.root ||= [];
  organizer.nodes ||= {};
  await mutator(organizer, detail);
  return await requestJson("POST", `${jobPath(id)}/quote-update`, {
    body: { presentation: { organizer } },
  });
}

const commands = {
  async auth(args) {
    const [action = "status"] = collectPositionals(args, {
      flagsWithValue: ["--url", "--token-file"],
    });
    if (action === "login") {
      const requestedUrl = trimText(parseFlag(args, "--url")) || fieldUrl;
      const suppliedTokenFile = trimText(parseFlag(args, "--token-file"));
      const token = hasFlag(args, "--token-stdin")
        ? await readSecretFromStdin()
        : suppliedTokenFile
          ? String(await readFile(resolve(suppliedTokenFile), "utf8")).trim()
          : await readSecretFromTerminal("Field API token: ");
      if (!token) throw new Error("Field API token is required");
      const user = await verifyCredential(requestedUrl, token);
      await saveCredential({ url: requestedUrl, token });
      fieldUrl = requestedUrl;
      authToken = token;
      authSource = USER_TOKEN_PATH;
      console.log(`Authenticated as ${user.name || user.email || user.id}`);
      console.log(`  url: ${fieldUrl}`);
      console.log(`  token: ${USER_TOKEN_PATH}`);
      return;
    }
    if (action === "status") {
      const user = await verifyCredential(fieldUrl, authToken);
      console.log("Field authentication: ready");
      console.log(`  url: ${fieldUrl}`);
      console.log(`  identity: ${user.name || user.email || user.id}`);
      console.log(`  kind: ${user.kind || "human"}`);
      console.log(`  credential: ${authSource}`);
      return;
    }
    if (action === "logout") {
      await rm(USER_TOKEN_PATH, { force: true });
      console.log(`Removed stored token: ${USER_TOKEN_PATH}`);
      return;
    }
    throw new Error("usage: field auth <login|status|logout> [--url URL] [--token-stdin | --token-file PATH]");
  },

  async "email-templates"(args) {
    const action = args[0] || "list";
    if (action === "list") {
      const documentType = trimText(args[1]);
      const result = await requestJson("GET", "/api/email-templates");
      if (documentType) {
        const templates = result.templates?.[documentType];
        if (!templates) throw new Error(`unknown document type: ${documentType}`);
        console.log(JSON.stringify({ documentType, templates, allowedPlaceholders: result.allowedPlaceholders }, null, 2));
        return;
      }
      console.log(JSON.stringify({
        documentTypes: result.documentTypes,
        templates: Object.fromEntries(Object.entries(result.templates || {}).map(([type, rows]) => [
          type,
          rows.map((row) => ({ id: row.id, name: row.name, description: row.description })),
        ])),
        allowedPlaceholders: result.allowedPlaceholders,
      }, null, 2));
      return;
    }

    if (action === "show") {
      const [, documentType, templateId] = args;
      if (!documentType || !templateId) {
        throw new Error("usage: field email-templates show <email|quote|invoice|receipt> <template-id>");
      }
      const result = await requestJson("GET", "/api/email-templates");
      const template = result.templates?.[documentType]?.find((row) => row.id === templateId);
      if (!template) throw new Error(`unknown ${documentType} email template: ${templateId}`);
      console.log(JSON.stringify({ documentType, template, allowedPlaceholders: result.allowedPlaceholders }, null, 2));
      return;
    }

    if (action === "update") {
      const name = trimText(parseFlag(args, "--name"));
      const description = trimText(parseFlag(args, "--description"));
      const subject = trimText(parseFlag(args, "--subject"));
      const body = await readOptionalBody(args);
      const [documentType, templateId] = collectPositionals(args.slice(1), {
        flagsWithValue: ["--name", "--description", "--subject", "--body", "--body-file"],
      });
      if (!documentType || !templateId) {
        throw new Error("usage: field email-templates update <document-type> <template-id> [--name text] [--description text] [--subject text] [--body text | --body-file path]");
      }
      const patch = {
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
        ...(subject ? { subject } : {}),
        ...(body != null ? { html: body } : {}),
      };
      if (!Object.keys(patch).length) throw new Error("provide at least one template field to update");
      const result = await requestJson(
        "PUT",
        `/api/email-templates/${encodeURIComponent(documentType)}/${encodeURIComponent(templateId)}`,
        { body: patch },
      );
      console.log(JSON.stringify(result.template, null, 2));
      return;
    }

    throw new Error("usage: field email-templates <list|show|update> ...");
  },

  async "create-job"(args) {
    const [address] = collectPositionals(args);
    const result = await requestJson("POST", "/api/jobs/manual", {
      body: { siteAddress: address || null },
    });
    console.log(`Created job: ${result.id}`);
    console.log(`  status: ${result.status}`);
    if (result.meta?.title) console.log(`  title: ${result.meta.title}`);
  },

  async "list-jobs"() {
    const result = await requestJson("GET", "/api/jobs");
    const jobs = Array.isArray(result) ? result : (result.recordings || result.data || []);
    console.log(`${jobs.length} jobs`);
    for (const job of jobs.slice(0, 50)) {
      const stage = job.pipelineStage || job.status || "?";
      const total = job.quoteTotal != null ? formatMoney(job.quoteTotal) : "";
      console.log(`- ${job.id} | ${stage} | ${total || "n/a"} | ${job.title || job.label || job.id}`);
    }
  },

  async "get-job"(args) {
    const versionSelector = parseFlag(args, "--version");
    const [id] = collectPositionals(args, { flagsWithValue: ["--version"] });
    if (!id) throw new Error("usage: get-job <id> [--version latest|customer|vNNN]");
    const detail = await getJobDetail(id, { versionSelector });
    console.log(JSON.stringify(detail, null, 2));
  },

  async "get-quote"(args) {
    const versionSelector = parseFlag(args, "--version");
    const [id] = collectPositionals(args, { flagsWithValue: ["--version"] });
    if (!id) throw new Error("usage: get-quote <id> [--version latest|customer|vNNN]");
    const detail = await getJobDetail(id, { versionSelector });
    if (!detail?.quote) throw new Error("quote not generated");
    console.log(JSON.stringify(detail.quote, null, 2));
  },

  async "get-quote-markdown"(args) {
    const versionSelector = parseFlag(args, "--version");
    const [id, outPath] = collectPositionals(args, { flagsWithValue: ["--version"] });
    if (!id) throw new Error("usage: get-quote-markdown <id> [output.md] [--version latest|customer|vNNN]");
    const version = await resolveVersionSelector(id, versionSelector);
    const markdown = await requestText("GET", `${jobPath(id, "/quote")}${buildQuery({ version })}`);
    await saveTextOutput(outPath, markdown);
  },

  async "get-pdf"(args) {
    const versionSelector = parseFlag(args, "--version");
    const milestoneIndex = parseMilestoneNumber(parseFlag(args, "--milestone"));
    const documentType = trimText(parseFlag(args, "--document"));
    const [id, outPath] = collectPositionals(args, {
      flagsWithValue: ["--version", "--milestone", "--document"],
    });
    if (!id) {
      throw new Error("usage: get-pdf <id> [output.pdf] [--version latest|customer|vNNN] [--document quote|invoice|receipt] [--milestone 1]");
    }

    const version = documentType === "invoice" || documentType === "receipt"
      ? null
      : await resolveVersionSelector(id, versionSelector);
    const preview = await requestJson("POST", `${jobPath(id)}/quote-pdf-preview`, {
      body: {
        ...(documentType ? { documentType } : {}),
        ...(version ? { version: String(version) } : {}),
        ...(milestoneIndex != null ? { milestoneIndex } : {}),
      },
    });
    const buffer = await requestBuffer("GET", preview.url);
    const destination = outPath || preview.fileName || `document-${id}.pdf`;
    await writeFile(resolve(destination), buffer);
    console.log(`PDF saved: ${destination} (${(buffer.length / 1024).toFixed(1)} KB)`);
  },

  async "send-document"(args) {
    // --attach doc_… (repeatable): another issued document of the job, by uid.
    const attach = args.flatMap((value, index) => (value === "--attach" && args[index + 1] ? [args[index + 1]] : []));
    const versionSelector = parseFlag(args, "--version");
    const milestoneIndex = parseMilestoneNumber(parseFlag(args, "--milestone"));
    const requestedDocumentType = trimText(parseFlag(args, "--document"));
    const paidAmountRaw = parseFlag(args, "--paid");
    const [id, email] = collectPositionals(args, {
      flagsWithValue: ["--version", "--milestone", "--document", "--paid", "--body", "--body-file", "--attach"],
    });
    if (!id || !email) {
      throw new Error("usage: send-document <id> <email> [--document quote|invoice|receipt] [--version latest|customer|vNNN] [--milestone 1] [--paid 100] [--body text | --body-file file] [--attach doc_… ...]");
    }

    const detail = await getJobDetail(id);
    const defaultDocumentType = String(detail?.meta?.pipelineStage || detail?.meta?.deliveryStatus || "").toLowerCase() === "landed"
      ? "invoice"
      : "quote";
    const documentType = requestedDocumentType || defaultDocumentType;
    const version = documentType === "invoice" || documentType === "receipt"
      ? null
      : await resolveVersionSelector(id, versionSelector);
    const customBody = await readOptionalBody(args);
    const invoicePaidAmount = paidAmountRaw != null
      ? Number(paidAmountRaw)
      : null;
    if (paidAmountRaw != null && !Number.isFinite(invoicePaidAmount)) {
      throw new Error("paid amount must be numeric");
    }

    const response = await requestJson("POST", `${jobPath(id)}/email-quote`, {
      body: {
        to: email,
        customBody,
        documentType,
        ...(version ? { version: String(version) } : {}),
        ...(milestoneIndex != null ? { milestoneIndex } : {}),
        ...(invoicePaidAmount != null ? { invoicePaidAmount } : {}),
        ...(attach.length ? { documents: attach.map((uid) => ({ uid })) } : {}),
      },
    });

    console.log(`Sent: ${response?.result?.subject || documentType}`);
    console.log(`  to: ${response?.result?.to || email}`);
  },

  async "set-details"(args) {
    const [id, ...pairs] = collectPositionals(args);
    if (!id || !pairs.length) throw new Error("usage: set-details <id> key=value [key=value ...]");
    for (const pair of pairs) {
      const index = pair.indexOf("=");
      if (index < 1) throw new Error(`invalid detail pair: ${pair}`);
      const key = pair.slice(0, index);
      const value = pair.slice(index + 1);
      await requestJson("PATCH", `${jobPath(id)}/details`, { body: { key, value } });
      console.log(`Updated: ${key}=${value}`);
    }
  },

  async "set-quote-inputs"(args) {
    const [id, source] = collectPositionals(args);
    if (!id || !source) throw new Error("usage: set-quote-inputs <id> <json-file-or-inline-json>");
    const quoteInputs = await parseJsonSource(source);
    const result = await requestJson("PUT", `${jobPath(id)}/quote-inputs`, { body: quoteInputs });
    const quote = result?.quote || {};
    console.log("Quote inputs updated");
    console.log(`  quote: ${quote.quoteNumber || "n/a"}`);
    console.log(`  total: ${formatMoney(quote?.totals?.total)}`);
  },

  async "update-quote"(args) {
    const lockStatus = parseFlag(args, "--lock");
    const rawJson = parseFlag(args, "--json");
    const [id, ...patchParts] = collectPositionals(args, { flagsWithValue: ["--lock", "--json"] });
    if (!id) throw new Error("usage: update-quote <id> [--lock final|draft] [--json '{...}']");

    let patch = {};
    if (rawJson) {
      patch = JSON.parse(rawJson);
    } else if (lockStatus) {
      patch = { lockStatus };
    } else if (patchParts.length) {
      patch = JSON.parse(patchParts.join(" "));
    }

    const result = await requestJson("POST", `${jobPath(id)}/quote-update`, { body: patch });
    const quote = result?.quote || {};
    console.log("Quote updated");
    if (quote?.totals) console.log(`  total: ${formatMoney(quote.totals.total)}`);
    if (quote?.delivery?.status) console.log(`  lock: ${quote.delivery.status}`);
  },

  async "status"(args) {
    const versionSelector = parseFlag(args, "--version");
    const [id] = collectPositionals(args, { flagsWithValue: ["--version"] });
    if (!id) throw new Error("usage: status <id> [--version latest|customer|vNNN]");

    const detail = await getJobDetail(id, { versionSelector });
    const meta = detail?.meta || {};
    const quote = detail?.quote || null;
    const policy = detail?.quoteEditPolicy || null;
    const versionView = detail?.versionView || null;
    const lifecycle = detail?.quoteLifecycle || null;
    const defaultDocumentType = String(meta?.pipelineStage || meta?.deliveryStatus || "").toLowerCase() === "landed"
      ? "invoice"
      : "quote";

    console.log(`Job: ${meta.title || meta.label || id}`);
    console.log(`  id: ${meta.id || id}`);
    console.log(`  stage: ${meta.pipelineStage || meta.deliveryStatus || meta.status || "unknown"}`);
    console.log(`  default document: ${defaultDocumentType}`);
    if (quote) {
      console.log(`  quote: ${quote.quoteNumber || "n/a"} | total=${formatMoney(quote?.totals?.total)}`);
    }
    if (versionView) {
      console.log(`  selected version: ${formatVersionLabel(versionView.selectedVersion)}`);
      console.log(`  latest version: ${formatVersionLabel(versionView.latestVersion)}`);
    }
    if (lifecycle?.lastSentQuoteVersion) {
      console.log(`  customer version: ${formatVersionLabel(lifecycle.lastSentQuoteVersion)}`);
    }
    if (policy) {
      console.log(`  editable selected: ${policy.canEditSelectedVersion ? "yes" : "no"}`);
      if (policy.lockReason) console.log(`  lock reason: ${policy.lockReason}`);
    }
    if (Array.isArray(meta?.milestoneInvoices) && meta.milestoneInvoices.length) {
      console.log(`  milestones: ${meta.milestoneInvoices.length}`);
      for (const milestone of meta.milestoneInvoices) {
        console.log(`    ${summarizeMilestone(milestone)}`);
      }
    }
  },

  async "set-stage"(args) {
    const [id, stage] = collectPositionals(args);
    if (!id || !stage) throw new Error("usage: set-stage <id> <draft|sent|landed|lost>");
    await requestJson("POST", `${jobPath(id)}/pipeline-stage`, { body: { stage } });
    console.log(`Pipeline stage set: ${stage}`);
  },

  async "internal-breakdown"(args) {
    const versionSelector = parseFlag(args, "--version");
    const [id, outPath] = collectPositionals(args, { flagsWithValue: ["--version"] });
    if (!id) throw new Error("usage: internal-breakdown <id> [output.md] [--version latest|customer|vNNN]");
    const version = await resolveVersionSelector(id, versionSelector);
    const markdown = await requestText("GET", `${jobPath(id, "/internal-breakdown")}${buildQuery({ version, format: "md" })}`);
    await saveTextOutput(outPath, markdown);
  },

  async "get-rate-card"() {
    const result = await requestJson("GET", "/api/rate-card");
    console.log(`Source: ${result?.source || "unknown"}`);
    console.log(JSON.stringify(result?.data ?? result, null, 2));
  },

  async "get-presentation"(args) {
    const versionSelector = parseFlag(args, "--version");
    const [id] = collectPositionals(args, { flagsWithValue: ["--version"] });
    if (!id) throw new Error("usage: get-presentation <id> [--version latest|customer|vNNN]");
    const detail = await getJobDetail(id, { versionSelector });
    const quote = detail?.quote || {};
    const organizer = quote?.presentation?.organizer || { root: [], nodes: {} };
    console.log(`Presentation for ${quote.quoteNumber || id}`);
    console.log(`  scope text: ${trimText(quote?.presentation?.scopeText || quote?.presentation?.scopeOfWorks) || "(default)"}`);
    console.log(`  validity days: ${quote?.presentation?.validityDays || quote?.presentation?.validForDays || quote?.delivery?.validForDays || "n/a"}`);
    console.log(`  nodes: ${Object.keys(organizer.nodes || {}).length}`);
    console.log(`  root nodes: ${(organizer.root || []).length}`);
    printPresentationTree(organizer, organizer.root || []);
  },

  async "refresh-presentation"(args) {
    const [id] = collectPositionals(args);
    if (!id) throw new Error("usage: refresh-presentation <id>");
    const result = await requestJson("POST", `${jobPath(id)}/quote-update`, {
      body: { presentation: {} },
    });
    console.log(`Presentation refreshed: total=${formatMoney(result?.quote?.totals?.total ?? result?.meta?.quoteTotal)}`);
  },

  async "set-scope-text"(args) {
    const [id, ...textParts] = collectPositionals(args);
    if (!id || !textParts.length) throw new Error('usage: set-scope-text <id> "<scope text>"');
    const scopeText = textParts.join(" ");
    const result = await requestJson("POST", `${jobPath(id)}/quote-update`, {
      body: { presentation: { scopeText } },
    });
    console.log(`Scope text set (${scopeText.length} chars)`);
    if (result?.quote?.totals) console.log(`  total: ${formatMoney(result.quote.totals.total)}`);
  },

  async "set-validity-days"(args) {
    const [id, daysRaw] = collectPositionals(args);
    const days = Number(daysRaw);
    if (!id || !Number.isFinite(days) || days <= 0) throw new Error("usage: set-validity-days <id> <days>");
    const result = await requestJson("POST", `${jobPath(id)}/quote-update`, {
      body: { presentation: { validityDays: Math.round(days) } },
    });
    console.log(`Validity set: ${Math.round(days)} days`);
    if (result?.quote?.totals) console.log(`  total: ${formatMoney(result.quote.totals.total)}`);
  },

  async "add-manual-item"(args) {
    const parentId = trimText(parseFlag(args, "--parent")) || "root";
    const [id, label, priceRaw, costRaw] = collectPositionals(args, { flagsWithValue: ["--parent"] });
    const price = Number(priceRaw);
    const cost = costRaw != null ? Number(costRaw) : 0;
    if (!id || !label || !Number.isFinite(price)) {
      throw new Error('usage: add-manual-item <id> "<label>" <price> [cost] [--parent <nodeId|root>]');
    }
    if (costRaw != null && !Number.isFinite(cost)) {
      throw new Error("manual cost must be numeric");
    }

    const nodeId = `manual:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    const sourceCode = `manual-item-${Date.now().toString(36)}`;
    const result = await mutateOrganizer(id, async (organizer) => {
      organizer.nodes[nodeId] = {
        kind: "source",
        sourceKind: "manual",
        origin: "manual",
        pricingMode: "manual",
        sourceCode,
        labelOverride: label,
        amountVisible: true,
        collapsed: false,
        children: [],
        manualPrice: price,
        manualCost: costRaw != null ? cost : 0,
      };
      attachNode(organizer, nodeId, parentId);
    });
    console.log(`Manual item added: ${nodeId}`);
    console.log(`  label: ${label}`);
    console.log(`  total: ${formatMoney(result?.quote?.totals?.total)}`);
  },

  async "add-group"(args) {
    const parentId = trimText(parseFlag(args, "--parent")) || "root";
    const [id, label] = collectPositionals(args, { flagsWithValue: ["--parent"] });
    if (!id || !label) throw new Error('usage: add-group <id> "<label>" [--parent <nodeId|root>]');

    const groupId = `group:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
    const result = await mutateOrganizer(id, async (organizer) => {
      organizer.nodes[groupId] = {
        kind: "group",
        label,
        amountVisible: true,
        collapsed: false,
        children: [],
      };
      attachNode(organizer, groupId, parentId);
    });
    console.log(`Group added: ${groupId}`);
    console.log(`  label: ${label}`);
    console.log(`  total: ${formatMoney(result?.quote?.totals?.total)}`);
  },

  async "move-node"(args) {
    const [id, nodeId, targetParentId] = collectPositionals(args);
    if (!id || !nodeId || !targetParentId) {
      throw new Error("usage: move-node <id> <nodeId> <parentId|root>");
    }

    await mutateOrganizer(id, async (organizer) => {
      if (!organizer.nodes?.[nodeId]) throw new Error(`node not found: ${nodeId}`);
      detachNode(organizer, nodeId);
      attachNode(organizer, nodeId, targetParentId);
    });
    console.log(`Moved ${nodeId} -> ${targetParentId}`);
  },

  async "reorder"(args) {
    const [id, parentId, ...nodeIds] = collectPositionals(args);
    if (!id || !parentId || !nodeIds.length) {
      throw new Error("usage: reorder <id> <root|parentNodeId> <nodeId1> <nodeId2> ...");
    }

    await mutateOrganizer(id, async (organizer) => {
      for (const nodeId of nodeIds) {
        if (!organizer.nodes?.[nodeId]) throw new Error(`node not found: ${nodeId}`);
      }
      const container = getContainerForParent(organizer, parentId);
      container.splice(0, container.length, ...nodeIds);
    });
    console.log(`Reordered ${nodeIds.length} node(s) under ${parentId}`);
  },

  async "rename-node"(args) {
    const [id, nodeId, ...labelParts] = collectPositionals(args);
    if (!id || !nodeId || !labelParts.length) {
      throw new Error('usage: rename-node <id> <nodeId> "<new label>"');
    }
    const label = labelParts.join(" ");
    await mutateOrganizer(id, async (organizer) => {
      const node = organizer.nodes?.[nodeId];
      if (!node) throw new Error(`node not found: ${nodeId}`);
      if (node.kind === "group") {
        node.label = label;
      } else {
        node.labelOverride = label;
      }
    });
    console.log(`Renamed ${nodeId} -> ${label}`);
  },

  async "hide-amount"(args) {
    const [id, nodeId] = collectPositionals(args);
    if (!id || !nodeId) throw new Error("usage: hide-amount <id> <nodeId>");
    await mutateOrganizer(id, async (organizer) => {
      const node = organizer.nodes?.[nodeId];
      if (!node) throw new Error(`node not found: ${nodeId}`);
      node.amountVisible = false;
    });
    console.log(`Amount hidden for ${nodeId}`);
  },

  async "show-amount"(args) {
    const [id, nodeId] = collectPositionals(args);
    if (!id || !nodeId) throw new Error("usage: show-amount <id> <nodeId>");
    await mutateOrganizer(id, async (organizer) => {
      const node = organizer.nodes?.[nodeId];
      if (!node) throw new Error(`node not found: ${nodeId}`);
      node.amountVisible = true;
    });
    console.log(`Amount shown for ${nodeId}`);
  },

  async "exclude-node"(args) {
    const [id, nodeId] = collectPositionals(args);
    if (!id || !nodeId) throw new Error("usage: exclude-node <id> <nodeId>");
    await mutateOrganizer(id, async (organizer) => {
      const node = organizer.nodes?.[nodeId];
      if (!node) throw new Error(`node not found: ${nodeId}`);
      node.excludedFromPrice = true;
    });
    console.log(`Excluded ${nodeId} from pricing`);
  },

  async "include-node"(args) {
    const [id, nodeId] = collectPositionals(args);
    if (!id || !nodeId) throw new Error("usage: include-node <id> <nodeId>");
    await mutateOrganizer(id, async (organizer) => {
      const node = organizer.nodes?.[nodeId];
      if (!node) throw new Error(`node not found: ${nodeId}`);
      node.excludedFromPrice = false;
    });
    console.log(`Included ${nodeId} in pricing`);
  },

  async "remove-node"(args) {
    const [id, nodeId] = collectPositionals(args);
    if (!id || !nodeId) throw new Error("usage: remove-node <id> <nodeId>");
    await mutateOrganizer(id, async (organizer) => {
      if (!organizer.nodes?.[nodeId]) throw new Error(`node not found: ${nodeId}`);
      removeNodeAndPromoteChildren(organizer, nodeId);
    });
    console.log(`Removed ${nodeId}`);
  },

  async "list-milestones"(args) {
    const [id] = collectPositionals(args);
    if (!id) throw new Error("usage: list-milestones <id>");
    const result = await requestJson("GET", `${jobPath(id)}/milestones`);
    const milestones = result?.milestones || [];
    const source = summarizeScheduleSource(result?.paymentSchedule?.source);
    if (source) console.log(`Schedule: ${source}`);
    if (!milestones.length) {
      console.log("No milestone invoices");
      return;
    }
    console.log(`Milestone invoices: ${milestones.length}`);
    for (const milestone of milestones) {
      console.log(`- ${summarizeMilestone(milestone)}`);
    }
  },

  async "generate-milestones"(args) {
    const scheduleSource = parseFlag(args, "--schedule");
    const applyAccountRule = hasFlag(args, "--account-rule");
    const [id] = collectPositionals(args, { flagsWithValue: ["--schedule"] });
    if (!id || (scheduleSource && applyAccountRule)) throw new Error("usage: generate-milestones <id> [--schedule <file-or-inline-json> | --account-rule]");
    const paymentSchedule = scheduleSource ? await parseJsonSource(scheduleSource) : null;
    const result = await requestJson("POST", `${jobPath(id)}/milestones/generate`, {
      body: paymentSchedule ? { paymentSchedule } : applyAccountRule ? { applyAccountRule: true } : {},
    });
    console.log(`Milestone schedule saved: ${(result?.milestones || []).length} milestone(s)`);
    const source = summarizeScheduleSource(result?.paymentSchedule?.source);
    if (source) console.log(`  schedule: ${source}`);
    for (const milestone of result?.milestones || []) {
      console.log(`- ${summarizeMilestone(milestone)}`);
    }
  },

  // Milestone rules (#29): the organisation's default milestones and caps by
  // region and contract value. Reading is for everyone; `set` and
  // `business-region` need an owner's key.
  async "milestone-rules"(args) {
    const [action, ...rest] = args;
    if (action === "list" || !action) {
      const result = await requestJson("GET", "/api/settings/milestone-rules");
      if (hasFlag(rest, "--json")) {
        console.log(JSON.stringify({ rules: result.rules, version: result.version }, null, 2));
        return;
      }
      console.log(`Business region: ${describeRegionText(result.businessRegion)}${result.businessRegion?.from ? ` (from ${result.businessRegion.from})` : ""}`);
      console.log(`Milestone rules: ${result.rules.length} (version ${result.version})`);
      for (const rule of result.rules) console.log(`- ${summarizeRule(rule)}`);
      return;
    }
    if (action === "set") {
      const file = parseFlag(rest, "--file");
      const expectedVersion = trimText(parseFlag(rest, "--expect-version"));
      if (!file) throw new Error("usage: milestone-rules set --file <rules.json> [--expect-version V]");
      const parsed = await parseJsonSource(file);
      const rules = Array.isArray(parsed) ? parsed : parsed?.rules;
      const result = await requestJson("PUT", "/api/settings/milestone-rules", {
        body: { rules, ...(expectedVersion ? { expectedVersion } : {}) },
      });
      console.log(`Milestone rules saved: ${result.rules.length} (version ${result.version})`);
      for (const rule of result.rules) console.log(`- ${summarizeRule(rule)}`);
      return;
    }
    if (action === "business-region") {
      const [country, region] = collectPositionals(rest);
      if (!country) throw new Error("usage: milestone-rules business-region <country|none> [region]");
      const clear = country.toLowerCase() === "none";
      const result = await requestJson("PUT", "/api/settings/invoicing", {
        body: { country: clear ? null : country, region: clear ? null : region || null },
      });
      console.log(`Business region: ${describeRegionText(result)}`);
      return;
    }
    if (action === "check") {
      const [id] = collectPositionals(rest);
      if (!id) throw new Error("usage: milestone-rules check <job-id>");
      const result = await requestJson("GET", `${jobPath(id)}/milestone-rules`);
      if (!result.hasRules) {
        console.log("No milestone rules: Field's default schedule, no caps");
        return;
      }
      console.log(`Region: ${describeRegionText(result.region)}${result.region?.from ? ` (from ${result.region.from})` : ""}`);
      console.log(`Rule: ${result.rule ? `${result.rule.name}, contract value ${formatMoney(result.contractValue)}` : "none applies"}`);
      const source = summarizeScheduleSource(result.scheduleSource);
      if (source) console.log(`Schedule: ${source}`);
      for (const milestone of result.milestones || []) {
        const state = milestone.blocked ? "BLOCKED" : milestone.findings.length ? "alert" : "ok";
        console.log(`- M${milestone.milestoneIndex + 1} ${milestone.label} (${milestone.kind}) ${formatMoney(milestone.total)} ${state}`);
        for (const finding of milestone.findings) console.log(`    ${finding.mode} cap: ${finding.message}`);
      }
      return;
    }
    throw new Error("usage: milestone-rules list [--json] | set --file <rules.json> [--expect-version V] | check <job-id> | business-region <country|none> [region]");
  },

  async "list-invoice-revisions"(args) {
    const [id, milestoneNumberRaw] = collectPositionals(args);
    if (!id || !milestoneNumberRaw) {
      throw new Error("usage: list-invoice-revisions <id> <milestone-number>");
    }
    const milestoneIndex = parseMilestoneNumber(milestoneNumberRaw);
    const result = await requestJson("GET", `${jobPath(id)}/milestones/${milestoneIndex}/revisions`);
    const revisions = result?.revisions || [];
    console.log(`Invoice revisions for M${milestoneIndex + 1}: ${revisions.length}`);
    for (const revision of revisions) {
      console.log(`- ${summarizeInvoiceRevision(revision)}`);
    }
  },

  // Step 4b (#28): an issued invoice is credited with a credit note and
  // reissued, never revised in place. `revise-invoice` is the older name.
  async "credit-invoice"(args) {
    const reason = trimText(parseFlag(args, "--reason"));
    const version = trimText(parseFlag(args, "--version"));
    const expectedRevision = trimText(parseFlag(args, "--expect-revision"));
    const [id, milestoneNumberRaw] = collectPositionals(args, {
      flagsWithValue: ["--reason", "--version", "--expect-revision"],
    });
    if (!id || !milestoneNumberRaw || !reason) {
      throw new Error("usage: credit-invoice <id> <milestone-number> --reason \"why\" [--version vNNN] [--expect-revision N]");
    }
    const milestoneIndex = parseMilestoneNumber(milestoneNumberRaw);
    const result = await requestJson("POST", `${jobPath(id)}/milestones/${milestoneIndex}/credit-and-reissue`, {
      body: {
        reason,
        ...(version ? { quoteVersion: version } : {}),
        ...(expectedRevision ? { expectedRevisionNumber: expectedRevision } : {}),
      },
    });
    const invoice = result?.invoice || result?.revision || {};
    const creditNote = result?.creditNote || null;
    if (creditNote) console.log(`Credited ${invoice.supersedesInvoiceNumber || "-"} with ${creditNote.number} (${formatMoney(creditNote.total)})`);
    console.log(`Issued ${invoice.invoiceNumber} in its place`);
    console.log(`  total: ${formatMoney(invoice.supersededTotal)} -> ${formatMoney(invoice.total)}`);
    console.log(`  reason: ${creditNote?.reason || invoice.revisionReason || reason}`);
  },

  async "revise-invoice"(args) {
    console.error("revise-invoice is now credit-invoice: the invoice is credited with a credit note and reissued");
    return commands["credit-invoice"](args);
  },

  async "update-milestone"(args) {
    const status = trimText(parseFlag(args, "--status"));
    const dueDate = trimText(parseFlag(args, "--due-date"));
    const [id, milestoneNumberRaw] = collectPositionals(args, { flagsWithValue: ["--status", "--due-date"] });
    if (!id || !milestoneNumberRaw) {
      throw new Error("usage: update-milestone <id> <milestone-number> [--status draft|authorised|paid] [--due-date YYYY-MM-DD]");
    }
    if (!status && !dueDate) {
      throw new Error("update-milestone needs at least one of --status or --due-date");
    }
    const milestoneIndex = parseMilestoneNumber(milestoneNumberRaw);
    const result = await requestJson("PUT", `${jobPath(id)}/milestones/${milestoneIndex}`, {
      body: {
        ...(status ? { status } : {}),
        ...(dueDate ? { dueDate } : {}),
      },
    });
    console.log(`Updated milestone M${milestoneIndex + 1}`);
    console.log(`  ${summarizeMilestone(result?.milestone)}`);
  },

  async "record-milestone-payment"(args) {
    const date = trimText(parseFlag(args, "--date"));
    const reference = trimText(parseFlag(args, "--reference"));
    const method = trimText(parseFlag(args, "--method"));
    const [id, milestoneNumberRaw, amountRaw] = collectPositionals(args, {
      flagsWithValue: ["--date", "--reference", "--method"],
    });
    const amount = Number(amountRaw);
    if (!id || !milestoneNumberRaw || !Number.isFinite(amount) || !(amount > 0)) {
      throw new Error("usage: record-milestone-payment <id> <milestone-number> <amount> [--date YYYY-MM-DD] [--reference text] [--method text]");
    }
    const milestoneIndex = parseMilestoneNumber(milestoneNumberRaw);
    const result = await requestJson("POST", `${jobPath(id)}/milestones/${milestoneIndex}/payment`, {
      body: {
        amount,
        ...(date ? { date } : {}),
        ...(reference ? { reference } : {}),
        ...(method ? { method } : {}),
      },
    });
    console.log(`Recorded payment on M${milestoneIndex + 1}`);
    console.log(`  amount: ${formatMoney(result?.payment?.amount ?? amount)}`);
    console.log(`  ${summarizeMilestone(result?.milestone)}`);
  },

  async "mark-milestone-unpaid"(args) {
    const [id, milestoneNumberRaw] = collectPositionals(args);
    if (!id || !milestoneNumberRaw) {
      throw new Error("usage: mark-milestone-unpaid <id> <milestone-number>");
    }
    const milestoneIndex = parseMilestoneNumber(milestoneNumberRaw);
    const result = await requestJson("POST", `${jobPath(id)}/milestones/${milestoneIndex}/unpaid`, {
      body: {},
    });
    console.log(`Reset milestone M${milestoneIndex + 1} to draft from paid`);
    console.log(`  ${summarizeMilestone(result?.milestone)}`);
  },

  async "mark-milestone-unsent"(args) {
    const [id, milestoneNumberRaw] = collectPositionals(args);
    if (!id || !milestoneNumberRaw) {
      throw new Error("usage: mark-milestone-unsent <id> <milestone-number>");
    }
    const milestoneIndex = parseMilestoneNumber(milestoneNumberRaw);
    const result = await requestJson("POST", `${jobPath(id)}/milestones/${milestoneIndex}/unsent`, {
      body: {},
    });
    console.log(`Reset milestone M${milestoneIndex + 1} to draft from sent`);
    console.log(`  ${summarizeMilestone(result?.milestone)}`);
  },

  async "upload-moasure"(args) {
    const [id, csvPath] = collectPositionals(args);
    if (!id || !csvPath) throw new Error("usage: upload-moasure <id> <csv-path>");
    const result = await uploadFile(`${jobPath(id)}/moasure-upload`, "files", csvPath);
    console.log(`Uploaded ${result?.savedFiles?.length || 0} file(s)`);
    if (result?.batchId) console.log(`  batch: ${result.batchId}`);
  },

  async "scan-moasure"(args) {
    const [id] = collectPositionals(args);
    if (!id) throw new Error("usage: scan-moasure <id>");
    const result = await requestJson("POST", `${jobPath(id)}/moasure-scan`);
    const data = result?.data || result;
    console.log(`Moasure: ${data?.status || "unknown"}`);
    for (const entry of data?.imports || []) {
      console.log(`- ${entry.label || entry.batchId}: ${entry.totalPointCount || 0} points | perimeter=${entry.perimeter || 0}m`);
    }
  },

  async "set-design"(args) {
    const [id, source] = collectPositionals(args);
    if (!id || !source) throw new Error("usage: set-design <id> <json-file-or-inline-json>");
    const design = await parseJsonSource(source);
    await requestJson("PUT", `${jobPath(id)}/wall-design`, { body: design });
    console.log(`Design set for ${id}`);
  },

  async "get-design"(args) {
    const [id] = collectPositionals(args);
    if (!id) throw new Error("usage: get-design <id>");
    const result = await requestJson("GET", `${jobPath(id)}/wall-design`);
    console.log(JSON.stringify(result?.data ?? result, null, 2));
  },

  async "extract-heights"(args) {
    const [id] = collectPositionals(args);
    if (!id) throw new Error("usage: extract-heights <id>");
    const result = await requestJson("POST", `${jobPath(id)}/wall-measurement`);
    const data = result?.data || {};
    console.log(`Extracted ${data?.n_bays || 0} bays | perimeter=${data?.perimeter_m || 0}m`);
    for (const bay of data?.bayHeights || []) {
      const suffix = bay.source === "override"
        ? " [override]"
        : bay.source === "interpolated"
          ? " [interpolated]"
          : "";
      console.log(`- B${bay.bay_id}: ${Number(bay.height_m || 0).toFixed(2)}m${suffix}`);
    }
  },

  async "build-model"(args) {
    const [id] = collectPositionals(args);
    if (!id) throw new Error("usage: build-model <id>");
    const result = await requestJson("POST", `${jobPath(id)}/wall-build`);
    const model = result?.data?.model || null;
    const quote = result?.data?.quote || null;
    if (model) {
      console.log("Bay model built");
      console.log(`  active bays: ${model.total_active_bays}`);
      console.log(`  sleepers: ${model.total_sleepers}`);
      console.log(`  holes: ${model.total_holes}`);
      console.log(`  total charge: ${formatMoney(model.total_charge)}`);
    }
    if (quote) {
      console.log(`  quote: ${quote.quoteNumber || "n/a"} | total=${formatMoney(quote?.totals?.total)}`);
    }
  },

  async "get-model"(args) {
    const [id] = collectPositionals(args);
    if (!id) throw new Error("usage: get-model <id>");
    const result = await requestJson("GET", `${jobPath(id)}/wall-model`);
    if (!result?.data) {
      console.log("No model built");
      return;
    }
    console.log(JSON.stringify(result.data, null, 2));
  },
};

const aliases = {
  help: "__help__",
  "field-cli": "__help__",
  "create-group": "add-group",
  "move-item": "move-node",
  "move-to-group": "move-node",
  "rename-item": "rename-node",
  "rename-presentation-item": "rename-node",
  "exclude-item": "exclude-node",
  "include-item": "include-node",
  "remove-item": "remove-node",
  "remove-manual-item": "remove-node",
  templates: "email-templates",
};

function printHelp() {
  console.log(`
Field CLI

Usage:
  field <command> [options]
  node scripts/field-cli.js <command> [options]

Version selectors:
  --version v003       exact revision
  --version latest     newest draft/current revision
  --version customer   locked customer-seen revision

Core:
  auth login [--url URL] [--token-stdin | --token-file PATH]
  auth status
  auth logout
  create-job [address]
  list-jobs
  get-job <id> [--version ...]
  get-quote <id> [--version ...]
  get-quote-markdown <id> [output.md] [--version ...]
  get-pdf <id> [output.pdf] [--version ...] [--document quote|invoice|receipt] [--milestone 1]
  send-document <id> <email> [--document quote|invoice|receipt] [--version ...] [--milestone 1] [--paid 100] [--attach doc_… ...]
  set-details <id> key=value [key=value ...]
  set-quote-inputs <id> <file-or-inline-json>
  update-quote <id> [--lock final|draft] [--json '{...}']
  internal-breakdown <id> [output.md] [--version ...]
  get-rate-card
  status <id> [--version ...]
  set-stage <id> <draft|sent|landed|lost>

Email templates:
  email-templates list [email|quote|invoice|receipt]
  email-templates show <document-type> <template-id>
  email-templates update <document-type> <template-id> [--name text] [--description text] [--subject text] [--body text | --body-file path]

Presentation:
  get-presentation <id> [--version ...]
  refresh-presentation <id>
  set-scope-text <id> "<text>"
  set-validity-days <id> <days>
  add-manual-item <id> "<label>" <price> [cost] [--parent <nodeId|root>]
  add-group <id> "<label>" [--parent <nodeId|root>]
  move-node <id> <nodeId> <parentId|root>
  reorder <id> <root|parentNodeId> <nodeId1> <nodeId2> ...
  rename-node <id> <nodeId> "<label>"
  hide-amount <id> <nodeId>
  show-amount <id> <nodeId>
  exclude-node <id> <nodeId>
  include-node <id> <nodeId>
  remove-node <id> <nodeId>

Milestones:
  list-milestones <id>
  generate-milestones <id> [--schedule <file-or-inline-json> | --account-rule]
                       a schedule given here is an override of the account rule;
                       --account-rule puts the rule's schedule back
  update-milestone <id> <milestone-number> [--status draft|authorised|paid] [--due-date YYYY-MM-DD]
  list-invoice-revisions <id> <milestone-number>
  credit-invoice <id> <milestone-number> --reason "why" [--version vNNN] [--expect-revision N]
                       credit an issued invoice with a credit note and issue its replacement
                       (revise-invoice is the older name)
  record-milestone-payment <id> <milestone-number> <amount> [--date YYYY-MM-DD] [--reference text] [--method text]
  mark-milestone-unpaid <id> <milestone-number>
  mark-milestone-unsent <id> <milestone-number>

Milestone rules (default milestones and caps by region and contract value):
  milestone-rules list [--json]
  milestone-rules set --file <rules.json> [--expect-version V]   (owner)
  milestone-rules check <job-id>     the rule for a job, and the caps each milestone is over
  milestone-rules business-region <country|none> [region]   (owner), e.g. AU SA

Wall:
  upload-moasure <id> <csv-path>
  scan-moasure <id>
  set-design <id> <file-or-inline-json>
  get-design <id>
  extract-heights <id>
  build-model <id>
  get-model <id>

Installable bins:
  npm run install:cli
  field --help
`);
}

const [rawCommand, ...rawArgs] = process.argv.slice(2);
const resolvedCommand = aliases[rawCommand] || rawCommand;

if (!rawCommand || rawCommand === "--help" || rawCommand === "-h" || resolvedCommand === "__help__") {
  printHelp();
  process.exit(0);
}

if (!commands[resolvedCommand]) {
  console.error(`Unknown command: ${rawCommand}`);
  console.error("Run with --help for usage.");
  process.exit(1);
}

try {
  await commands[resolvedCommand](rawArgs);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
