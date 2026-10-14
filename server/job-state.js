import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "./storage/fs.js";
import { appendFile, mkdir, readFile, writeFile } from "./storage/fs-promises.js";
import { dirname, join } from "node:path";
import { queueStagedPostCommit } from "./job-generation.js";

const JOB_STATE_DIR = "job-state";
const DETAILS_FILE = join(JOB_STATE_DIR, "details.json");
const GAPS_FILE = join(JOB_STATE_DIR, "gaps.json");
const ACTIVITY_FILE = join(JOB_STATE_DIR, "activity.jsonl");

const OPEN_GAP_STATES = new Set(["open", "in_progress"]);
const CLOSED_GAP_STATES = new Set(["accepted", "confirmed", "rejected", "cleared"]);

export async function ensureJobState({
  jobDir,
  meta,
  transcript = null,
  quoteInputs = null,
  quote = null,
  defaults = {},
}) {
  await mkdir(join(jobDir, JOB_STATE_DIR), { recursive: true });

  const hadDetails = existsSync(join(jobDir, DETAILS_FILE));
  const hadGaps = existsSync(join(jobDir, GAPS_FILE));
  const hadActivity = existsSync(join(jobDir, ACTIVITY_FILE));

  const details = hadDetails
    ? await readJson(join(jobDir, DETAILS_FILE), buildDefaultDetails({ meta, defaults }))
    : buildDefaultDetails({ meta, defaults });

  if (!hadDetails) {
    await writeJson(join(jobDir, DETAILS_FILE), details);
  }

  const existingGaps = hadGaps ? await readJson(join(jobDir, GAPS_FILE), []) : [];
  const candidates = deriveGapCandidates({ quoteInputs, quote });
  const synced = syncGapEntries({
    existing: existingGaps,
    candidates,
    nowIso: new Date().toISOString(),
  });

  if (!hadGaps || synced.changed) {
    await writeJson(join(jobDir, GAPS_FILE), synced.gaps);
  }

  const activity = hadActivity ? await readActivity(jobDir) : [];
  const activityEvents = [];
  if (!hadActivity || activity.length === 0) {
    activityEvents.push(...buildSeedActivity({ meta, transcript, gaps: synced.gaps }));
  } else {
    activityEvents.push(...buildGapLifecycleEvents({
      detected: synced.detected,
      cleared: synced.cleared,
    }));
  }

  if (activityEvents.length) {
    await appendActivityEntries(jobDir, activityEvents);
  }

  const nextActivity = activityEvents.length
    ? sortActivityDesc([...activityEvents, ...activity])
    : activity;

  return {
    details,
    gaps: synced.gaps,
    activity: nextActivity,
  };
}

export async function previewJobState({
  jobDir,
  meta,
  transcript = null,
  quoteInputs = null,
  quote = null,
  defaults = {},
}) {
  await mkdir(join(jobDir, JOB_STATE_DIR), { recursive: true });

  const hadDetails = existsSync(join(jobDir, DETAILS_FILE));
  const hadGaps = existsSync(join(jobDir, GAPS_FILE));
  const hadActivity = existsSync(join(jobDir, ACTIVITY_FILE));

  const details = hadDetails
    ? await readJson(join(jobDir, DETAILS_FILE), buildDefaultDetails({ meta, defaults }))
    : buildDefaultDetails({ meta, defaults });

  const existingGaps = hadGaps ? await readJson(join(jobDir, GAPS_FILE), []) : [];
  const candidates = deriveGapCandidates({ quoteInputs, quote });
  const synced = syncGapEntries({
    existing: existingGaps,
    candidates,
    nowIso: new Date().toISOString(),
  });

  const activity = hadActivity ? await readActivity(jobDir) : [];
  const activityEvents = !hadActivity || activity.length === 0
    ? buildSeedActivity({ meta, transcript, gaps: synced.gaps })
    : buildGapLifecycleEvents({
        detected: synced.detected,
        cleared: synced.cleared,
      });

  return {
    details,
    gaps: synced.gaps,
    activity: activityEvents.length
      ? sortActivityDesc([...activityEvents, ...activity])
      : activity,
  };
}

export async function readJobState(jobDir) {
  return {
    details: await readJson(join(jobDir, DETAILS_FILE), null),
    gaps: await readJson(join(jobDir, GAPS_FILE), []),
    activity: await readActivity(jobDir),
  };
}

export async function updateJobDetailField({
  jobDir,
  meta,
  key,
  value,
  actor = defaultActor("user", "User"),
}) {
  const details = (await readJson(join(jobDir, DETAILS_FILE), null)) || buildDefaultDetails({ meta, defaults: {} });
  const previous = getByPath(details, key);
  const nextDetails = structuredClone(details);
  setByPath(nextDetails, key, value);
  await writeJson(join(jobDir, DETAILS_FILE), nextDetails);

  const nextMeta = applyDetailsToMeta(meta, nextDetails);

  // Auto-sync meta.title when siteAddress changes and title looks auto-generated
  if (key === "siteAddress") {
    const oldAddress = previous || "";
    const newAddress = value || "";
    if (newAddress && newAddress !== oldAddress) {
      const currentTitle = nextMeta.title || "";
      if (!currentTitle || currentTitle.includes(oldAddress) || currentTitle === nextMeta.label) {
        const customerName = nextMeta.contactName || nextMeta.customerName || "";
        nextMeta.title = customerName
          ? `${customerName} · ${newAddress}`
          : newAddress;
        nextMeta.label = nextMeta.title;
      }
    }
  }

  const entry = createActivityEntry({
    kind: "detail.updated",
    ts: new Date().toISOString(),
    actor,
    title: "Detail updated",
    body: `${humanizeDetailKey(key)} changed to ${formatActivityValue(value)}.`,
    field: key,
    before: previous ?? null,
    after: value ?? null,
  });
  await appendActivityEntries(jobDir, [entry]);

  return {
    details: nextDetails,
    meta: nextMeta,
    activityEntry: entry,
  };
}

export async function mergeJobDetails({
  jobDir,
  meta,
  patch,
  actor = defaultActor("system", "Field"),
  activity = null,
}) {
  const details = (await readJson(join(jobDir, DETAILS_FILE), null)) || buildDefaultDetails({ meta, defaults: {} });
  const nextDetails = mergeObjects(structuredClone(details), patch);
  await writeJson(join(jobDir, DETAILS_FILE), nextDetails);

  const nextMeta = applyDetailsToMeta(meta, nextDetails);

  // Auto-sync meta.title when siteAddress changes and title looks auto-generated
  const oldAddress = details.siteAddress || "";
  const newAddress = nextDetails.siteAddress || "";
  if (newAddress && newAddress !== oldAddress) {
    const currentTitle = nextMeta.title || "";
    if (!currentTitle || currentTitle.includes(oldAddress) || currentTitle === nextMeta.label) {
      const customerName = nextMeta.contactName || nextMeta.customerName || "";
      nextMeta.title = customerName
        ? `${customerName} · ${newAddress}`
        : newAddress;
      nextMeta.label = nextMeta.title;
    }
  }

  let activityEntry = null;
  if (activity !== false) {
    activityEntry = createActivityEntry({
      kind: activity?.kind || "details.synced",
      ts: new Date().toISOString(),
      actor,
      title: activity?.title || "Details synced",
      body: activity?.body || "Structured job details were synchronized.",
      field: activity?.field || null,
      before: activity?.before ?? null,
      after: activity?.after ?? null,
    });
    await appendActivityEntries(jobDir, [activityEntry]);
  }

  return {
    details: nextDetails,
    meta: nextMeta,
    activityEntry,
  };
}

export async function addJobNote({
  jobDir,
  text,
  actor = defaultActor("user", "User"),
}) {
  const content = String(text || "").trim();
  if (!content) {
    throw new Error("note text required");
  }

  const entry = createActivityEntry({
    kind: "note.manual",
    ts: new Date().toISOString(),
    actor,
    title: "Manual note",
    body: content,
  });
  await appendActivityEntries(jobDir, [entry]);
  return entry;
}

export async function appendJobActivity({
  jobDir,
  activity,
}) {
  const entry = createActivityEntry(activity);
  if (queueStagedPostCommit(jobDir, (operationalJobDir) => (
    appendActivityEntries(operationalJobDir, [entry])
  ))) {
    return entry;
  }
  await appendActivityEntries(jobDir, [entry]);
  return entry;
}

export async function setGapState({
  jobDir,
  gapId,
  status,
  reason = null,
  reasonCode = null,
  actor = defaultActor("user", "User"),
  note = null,
}) {
  const gaps = await readJson(join(jobDir, GAPS_FILE), []);
  const nextStatus = normalizeGapStatus(status);
  const nextGaps = gaps.map((gap) => {
    if (gap.id !== gapId) return gap;
    return {
      ...gap,
      status: nextStatus,
      resolution: nextStatus === "open" || nextStatus === "in_progress"
        ? null
        : {
            mode: nextStatus,
            reason: reason || null,
            reasonCode: reasonCode || null,
            note: note || null,
            at: new Date().toISOString(),
            by: actor,
          },
    };
  });
  const gap = nextGaps.find((item) => item.id === gapId);
  if (!gap) throw new Error("gap not found");
  await writeJson(join(jobDir, GAPS_FILE), nextGaps);

  const title = nextStatus === "accepted"
    ? "Gap accepted"
    : nextStatus === "confirmed"
      ? "Gap confirmed"
    : nextStatus === "rejected"
      ? "Gap rejected"
      : nextStatus === "in_progress"
        ? "Gap in progress"
        : nextStatus === "cleared"
          ? "Gap cleared"
          : "Gap reopened";
  const bodyParts = [gap.field || gap.title || "Gap"];
  if (reason) bodyParts.push(reason);
  if (note) bodyParts.push(note);
  const entry = createActivityEntry({
    kind: "gap.state_changed",
    ts: new Date().toISOString(),
    actor,
    title,
    body: bodyParts.join(" — "),
    gapId: gap.id,
    gapStatus: nextStatus,
    reason: reason || null,
    reasonCode: reasonCode || null,
  });
  await appendActivityEntries(jobDir, [entry]);
  return { gap, activityEntry: entry, gaps: nextGaps };
}

export async function archiveJob({
  jobDir,
  meta,
  reason = null,
  actor = defaultActor("user", "User"),
}) {
  const details = (await readJson(join(jobDir, DETAILS_FILE), null)) || buildDefaultDetails({ meta, defaults: {} });
  const archivedAt = new Date().toISOString();
  const nextDetails = {
    ...details,
    archivedAt,
    archivedReason: reason || details.archivedReason || null,
  };
  await writeJson(join(jobDir, DETAILS_FILE), nextDetails);

  const entry = createActivityEntry({
    kind: "job.archived",
    ts: archivedAt,
    actor,
    title: "Job archived",
    body: reason ? `Archived with reason: ${reason}.` : "Archived from the active jobs list.",
  });
  await appendActivityEntries(jobDir, [entry]);

  return {
    details: nextDetails,
    meta: {
      ...applyDetailsToMeta(meta, nextDetails),
      archivedAt,
      archivedReason: reason || null,
    },
    activityEntry: entry,
  };
}

export function getOpenGapCount(gaps = []) {
  return gaps.filter((gap) => OPEN_GAP_STATES.has(gap.status)).length;
}

export function listOpenGaps(gaps = []) {
  return gaps.filter((gap) => OPEN_GAP_STATES.has(gap.status));
}

export function gapBlocksSend(gap) {
  return OPEN_GAP_STATES.has(gap?.status) && gap?.presentInCurrentContext !== false && gap?.blocksSend !== false;
}

export function gapBlocksHandoff(gap) {
  return OPEN_GAP_STATES.has(gap?.status) && gap?.presentInCurrentContext !== false && gap?.blocksHandoff !== false;
}

export function listOpenSendBlockingGaps(gaps = []) {
  return gaps.filter((gap) => gapBlocksSend(gap));
}

export function listOpenHandoffBlockingGaps(gaps = []) {
  return gaps.filter((gap) => gapBlocksHandoff(gap));
}

export function normalizeGapStatus(status) {
  const value = String(status || "open").trim().toLowerCase();
  if (OPEN_GAP_STATES.has(value) || CLOSED_GAP_STATES.has(value)) return value;
  return "open";
}

function buildDefaultDetails({ meta, defaults }) {
  return {
    siteAddress: meta.siteAddress || null,
    gps: meta.gps || null,
    customer: {
      name: meta.customerName || meta.contactName || null,
    },
    contact: {
      name: meta.contactName || null,
      phone: meta.contactPhone || null,
      email: meta.contactEmail || null,
    },
    quotedBy: {
      name: meta.quotedBy || defaults.operatorName || null,
      completedAt: meta.createdAt || null,
      method: meta.captureMode === "manual" ? "manual quote" : "field recording",
    },
    soilDump: null,
    archivedAt: meta.archivedAt || null,
    archivedReason: meta.archivedReason || null,
    captureCount: Number(meta.captureCount || 1),
  };
}

function deriveGapCandidates({ quoteInputs, quote }) {
  const candidates = new Map();
  const quoteAssumptions = Array.isArray(quote?.assumptionInputs) ? quote.assumptionInputs : [];
  const missingInputs = [
    ...(Array.isArray(quoteInputs?.missingInputs) ? quoteInputs.missingInputs : []),
    ...(Array.isArray(quote?.missingInputs) ? quote.missingInputs.map((field) => ({ field })) : []),
  ];

  for (const raw of missingInputs) {
    const field = String(raw?.field || raw?.label || raw || "Gap").trim();
    const key = normalizeKey(field);
    const assumption = quoteAssumptions.find((item) => normalizeKey(item.field) === key) || null;
    if (assumption?.source === "derived") continue;
    const title = field;
    const reason = String(raw?.reason || raw?.description || assumption?.reason || "Needs confirmation").trim();
    const description = reason;
    candidates.set(key, {
      id: `gap_${createHash("sha1").update(key).digest("hex").slice(0, 12)}`,
      key,
      kind: "missing_input",
      field,
      title,
      description,
      severity: inferGapSeverity(field, reason),
      status: "open",
      presentInCurrentContext: true,
      blocksSend: true,
      blocksHandoff: true,
      assumption: assumption ? {
        available: true,
        value: assumption.value || assumption.defaultValue || null,
        defaultValue: assumption.defaultValue || assumption.value || null,
        quoteNote: assumption.quoteNote || assumption.note || null,
      } : {
        available: false,
        value: null,
        defaultValue: null,
        quoteNote: null,
      },
      evidence: dedupeEvidence([
        ...(raw?.evidence || []),
        ...(assumption?.evidence || []),
      ]).slice(0, 4),
      firstSeenAt: null,
      lastSeenAt: null,
      resolution: null,
    });
  }

  const optionFamilies = Array.isArray(quote?.selectionState?.optionFamilies) ? quote.selectionState.optionFamilies : [];
  const handoffReady = quote?.selectionState?.handoffReady !== false;
  if (optionFamilies.length && !handoffReady) {
    for (const family of optionFamilies) {
      if (family.acceptedOptionCode) continue;
      const defaultOption = (family.options || []).find((option) => option.sourceLineItemCode === family.defaultOptionCode) || null;
      const displayOption = (family.options || []).find((option) => option.sourceLineItemCode === family.displayOptionCode) || defaultOption;
      const field = `${family.label} option selection`;
      const key = normalizeKey(field);
      candidates.set(key, {
        id: `gap_${createHash("sha1").update(`option:${family.id}`).digest("hex").slice(0, 12)}`,
        key,
        kind: "option_selection_pending",
        field,
        title: `${family.label} selection`,
        description: displayOption
          ? `Defaulted to ${displayOption.sourceLineItemLabel}. Confirm or change this option before project handoff or invoicing.`
          : "A required option family still needs a confirmed selection before project handoff or invoicing.",
        severity: "gap",
        status: "open",
        presentInCurrentContext: true,
        blocksSend: false,
        blocksHandoff: true,
        assumption: {
          available: Boolean(displayOption),
          value: displayOption?.sourceLineItemLabel || null,
          defaultValue: defaultOption?.sourceLineItemLabel || displayOption?.sourceLineItemLabel || null,
          quoteNote: displayOption
            ? `Current default selection: ${displayOption.sourceLineItemLabel}.`
            : null,
        },
        selection: {
          familyId: family.id,
          familyLabel: family.label,
          defaultOptionCode: family.defaultOptionCode || null,
          displayOptionCode: family.displayOptionCode || null,
          acceptedOptionCode: family.acceptedOptionCode || null,
        },
        evidence: [],
        firstSeenAt: null,
        lastSeenAt: null,
        resolution: null,
      });
    }
  }

  return [...candidates.values()];
}

function syncGapEntries({ existing, candidates, nowIso }) {
  const existingById = new Map(existing.map((gap) => [gap.id, gap]));
  const next = [];
  const detected = [];
  const cleared = [];

  for (const candidate of candidates) {
    const previous = existingById.get(candidate.id);
    if (!previous) {
      const created = {
        ...candidate,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
      };
      detected.push(created);
      next.push(created);
      continue;
    }

    next.push({
      ...previous,
      ...candidate,
      status: previous.status || "open",
      firstSeenAt: previous.firstSeenAt || nowIso,
      lastSeenAt: nowIso,
      resolution: previous.resolution || null,
    });
    existingById.delete(candidate.id);
  }

  for (const gap of existingById.values()) {
    const isOpen = OPEN_GAP_STATES.has(gap.status);
    const nextGap = {
      ...gap,
      presentInCurrentContext: false,
      status: isOpen ? "cleared" : gap.status,
      resolution: isOpen
        ? {
            mode: "cleared",
            reason: "No longer present in the current quote context.",
            reasonCode: "context_refresh",
            note: null,
            at: nowIso,
            by: defaultActor("system", "Field"),
          }
        : gap.resolution || null,
    };
    if (isOpen) cleared.push(nextGap);
    next.push(nextGap);
  }

  next.sort((a, b) => {
    const aOpen = OPEN_GAP_STATES.has(a.status) ? 0 : 1;
    const bOpen = OPEN_GAP_STATES.has(b.status) ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return a.field.localeCompare(b.field);
  });

  const changed = JSON.stringify(existing) !== JSON.stringify(next);
  return { gaps: next, detected, cleared, changed };
}

function buildSeedActivity({ meta, transcript, gaps }) {
  const events = [
    createActivityEntry({
      kind: "job.opened",
      ts: meta.createdAt || new Date().toISOString(),
      actor: defaultActor("system", "Field"),
      title: "Job opened",
      body: meta.title || meta.label || meta.jobNumber || meta.id,
    }),
  ];

  for (const segment of (transcript?.segments || []).slice(0, 4)) {
    events.push(createActivityEntry({
      kind: "evidence.logged",
      ts: offsetIso(meta.createdAt, Number(segment.start || 0)),
      actor: defaultActor("system", "Field"),
      title: "Evidence",
      body: segment.snippet || segment.text || "Transcript evidence",
      evidence: {
        start: Number(segment.start || 0),
        end: Number(segment.end || segment.start || 0),
        text: segment.snippet || segment.text || "",
        speaker: segment.speaker || null,
      },
    }));
  }

  for (const gap of gaps.filter((item) => OPEN_GAP_STATES.has(item.status))) {
    events.push(createActivityEntry({
      kind: "gap.detected",
      ts: meta.createdAt || new Date().toISOString(),
      actor: defaultActor("system", "Field"),
      title: gap.severity === "critical" ? "Critical gap" : "Gap",
      body: `${gap.field} — ${gap.description}`,
      gapId: gap.id,
      gapStatus: gap.status,
    }));
  }

  return sortActivityDesc(events);
}

function buildGapLifecycleEvents({ detected, cleared }) {
  const entries = [];
  for (const gap of detected) {
    entries.push(createActivityEntry({
      kind: "gap.detected",
      ts: gap.firstSeenAt || new Date().toISOString(),
      actor: defaultActor("system", "Field"),
      title: gap.severity === "critical" ? "Critical gap" : "Gap",
      body: `${gap.field} — ${gap.description}`,
      gapId: gap.id,
      gapStatus: gap.status,
    }));
  }
  for (const gap of cleared) {
    entries.push(createActivityEntry({
      kind: "gap.state_changed",
      ts: gap.resolution?.at || new Date().toISOString(),
      actor: gap.resolution?.by || defaultActor("system", "Field"),
      title: "Gap cleared",
      body: `${gap.field} is no longer present in the current quote context.`,
      gapId: gap.id,
      gapStatus: gap.status,
      reasonCode: gap.resolution?.reasonCode || "context_refresh",
    }));
  }
  return entries;
}

function inferGapSeverity(field, reason) {
  const combined = `${field} ${reason}`.toLowerCase();
  return /(wall height|height|depth|width|length|quantity|measurement|footing)/.test(combined) ? "critical" : "gap";
}

function dedupeEvidence(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = `${value?.segmentId || ""}:${value?.start || ""}:${value?.end || ""}:${value?.snippet || value?.text || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function defaultActor(kind, label) {
  return { kind, label };
}

function createActivityEntry(value) {
  return {
    id: value.id || `evt_${randomUUID()}`,
    ts: value.ts || new Date().toISOString(),
    kind: value.kind || "system.event",
    actor: value.actor || defaultActor("system", "Field"),
    title: value.title || "Activity",
    body: value.body || "",
    field: value.field || null,
    before: value.before ?? null,
    after: value.after ?? null,
    gapId: value.gapId || null,
    gapStatus: value.gapStatus || null,
    reason: value.reason || null,
    reasonCode: value.reasonCode || null,
    evidence: value.evidence || null,
  };
}

async function appendActivityEntries(jobDir, entries) {
  if (!entries.length) return;
  await mkdir(join(jobDir, JOB_STATE_DIR), { recursive: true });
  const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await appendFile(join(jobDir, ACTIVITY_FILE), `${payload}\n`);
}

async function readActivity(jobDir) {
  const path = join(jobDir, ACTIVITY_FILE);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  return sortActivityDesc(raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line)));
}

function sortActivityDesc(values) {
  return [...values].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

function offsetIso(baseIso, seconds) {
  const base = new Date(baseIso || Date.now()).getTime();
  return new Date(base + Math.max(0, Number(seconds || 0)) * 1000).toISOString();
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function humanizeDetailKey(key) {
  return String(key || "")
    .split(".")
    .join(" ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatActivityValue(value) {
  if (value == null || value === "") return "blank";
  if (typeof value === "object") {
    if (value?.name) return String(value.name);
    return JSON.stringify(value);
  }
  return String(value);
}

export function applyDetailsToMeta(meta, details) {
  const customerName = resolveCustomerName(details, meta);
  return {
    ...meta,
    siteAddress: details.siteAddress || null,
    contactName: details.contact?.name || null,
    contactPhone: details.contact?.phone || null,
    contactEmail: details.contact?.email || null,
    customerName: customerName || null,
    quotedBy: (typeof details.quotedBy === "string" ? details.quotedBy : details.quotedBy?.name) || null,
    archivedAt: details.archivedAt || null,
    archivedReason: details.archivedReason || null,
    captureCount: Number(details.captureCount || 1),
    gps: details.gps || null,
  };
}

// A detail key or patch key that would reach an object's prototype
// instead of the details themselves.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function getByPath(value, key) {
  return String(key || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, segment) => (current && typeof current === "object" && Object.hasOwn(current, segment) ? current[segment] : undefined), value);
}

function setByPath(target, key, value) {
  const parts = String(key || "").split(".").filter(Boolean);
  if (!parts.length || parts.some((segment) => UNSAFE_KEYS.has(segment))) {
    const error = new Error(`detail key not allowed: ${key}`);
    error.statusCode = 400;
    throw error;
  }
  let cursor = target;
  for (const segment of parts.slice(0, -1)) {
    if (!Object.hasOwn(cursor, segment) || !cursor[segment] || typeof cursor[segment] !== "object") {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }
  cursor[parts[parts.length - 1]] = value;
}

function resolveCustomerName(details, meta) {
  const explicit = String(details?.customer?.name || "").trim();
  if (explicit) return explicit;
  const preserved = String(meta?.customerName || "").trim();
  if (preserved) return preserved;
  const contactName = String(details?.contact?.name || meta?.contactName || "").trim();
  return contactName || null;
}

function mergeObjects(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (
      value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.hasOwn(target, key)
      && target[key]
      && typeof target[key] === "object"
      && !Array.isArray(target[key])
    ) {
      mergeObjects(target[key], value);
      continue;
    }
    target[key] = value;
  }
  return target;
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}
