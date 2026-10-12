import { existsSync } from "./storage/fs.js";
import { mkdir, readFile, rm, writeFile } from "./storage/fs-promises.js";
import { dirname, join } from "node:path";
import {
  MILESTONE_INVOICE_DIR,
  applyMilestoneInvoiceCompatFields,
  normalizePaymentSchedule,
  normalizeStoredMilestoneInvoices,
} from "./job-documents.js";
import { resolveActiveJobGeneration, resolveWritableJobGeneration } from "./job-generation.js";

export const MILESTONE_INVOICE_STATE_FILE = join(MILESTONE_INVOICE_DIR, "state.json");
const MILESTONE_INVOICE_STATE_VERSION = 1;

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeMilestoneInvoiceState({ meta = null, state = null } = {}) {
  const paymentScheduleSource = hasOwn(state, "paymentSchedule")
    ? state?.paymentSchedule
    : meta?.paymentSchedule;
  let paymentSchedule = null;
  try {
    paymentSchedule = normalizePaymentSchedule(paymentScheduleSource, { allowNull: true });
  } catch {
    paymentSchedule = null;
  }

  const milestoneInvoicesSource = hasOwn(state, "milestoneInvoices")
    ? state?.milestoneInvoices
    : meta?.milestoneInvoices;

  return {
    version: Number(state?.version || MILESTONE_INVOICE_STATE_VERSION),
    paymentSchedule,
    milestoneInvoices: normalizeStoredMilestoneInvoices(milestoneInvoicesSource || []),
  };
}

function buildHydratedMeta(meta = null, milestoneState = null) {
  const baseMeta = meta && typeof meta === "object" ? meta : {};
  return applyMilestoneInvoiceCompatFields({
    ...baseMeta,
    ...(milestoneState?.paymentSchedule ? { paymentSchedule: milestoneState.paymentSchedule } : {}),
    milestoneInvoices: milestoneState?.milestoneInvoices || [],
  });
}

function stripHydratedMetaForStorage(meta = null) {
  if (!meta || typeof meta !== "object") return meta;
  const {
    milestoneInvoices: _omittedMilestoneInvoices,
    totalInvoicePaidAmount: _omittedTotalInvoicePaidAmount,
    ...rest
  } = meta;
  return rest;
}

async function writeMilestoneInvoiceState(jobDir, milestoneState) {
  const statePath = join(jobDir, MILESTONE_INVOICE_STATE_FILE);
  if (!milestoneState?.paymentSchedule && !(milestoneState?.milestoneInvoices || []).length) {
    await rm(statePath, { force: true }).catch(() => {});
    return;
  }

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({
    version: MILESTONE_INVOICE_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    ...(milestoneState.paymentSchedule ? { paymentSchedule: milestoneState.paymentSchedule } : {}),
    milestoneInvoices: milestoneState.milestoneInvoices || [],
  }, null, 2));
}

export async function readMilestoneInvoiceState(jobDir, { meta = null } = {}) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const statePath = join(jobDir, MILESTONE_INVOICE_STATE_FILE);
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      return normalizeMilestoneInvoiceState({ meta, state: parsed });
    } catch {
      return normalizeMilestoneInvoiceState({ meta });
    }
  }
  return normalizeMilestoneInvoiceState({ meta });
}

export async function hydrateJobMeta(jobDir, meta = null) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const milestoneState = await readMilestoneInvoiceState(jobDir, { meta });
  return buildHydratedMeta(meta, milestoneState);
}

export async function readJobMeta(jobDir) {
  jobDir = await resolveActiveJobGeneration(jobDir);
  const metaPath = join(jobDir, "meta.json");
  if (!existsSync(metaPath)) return null;
  const rawMeta = JSON.parse(await readFile(metaPath, "utf8"));
  return await hydrateJobMeta(jobDir, rawMeta);
}

export async function writeJobMeta(jobDir, meta = null) {
  jobDir = await resolveWritableJobGeneration(jobDir);
  const currentMilestoneState = await readMilestoneInvoiceState(jobDir);
  const nextMilestoneState = normalizeMilestoneInvoiceState({
    state: {
      paymentSchedule: hasOwn(meta, "paymentSchedule")
        ? meta?.paymentSchedule
        : currentMilestoneState.paymentSchedule,
      milestoneInvoices: hasOwn(meta, "milestoneInvoices")
        ? meta?.milestoneInvoices
        : currentMilestoneState.milestoneInvoices,
    },
  });
  const hydratedMeta = buildHydratedMeta(meta, nextMilestoneState);
  const persistedMeta = stripHydratedMetaForStorage(hydratedMeta);
  await writeMilestoneInvoiceState(jobDir, nextMilestoneState);
  await writeFile(join(jobDir, "meta.json"), JSON.stringify(persistedMeta, null, 2));
  return hydratedMeta;
}
