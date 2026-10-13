// Milestone rules (#29, pricing engine phase 3 step 4c): the organisation's
// default milestones and caps, by contract value band and region, as rows
// (milestone_rules, milestone_rule_milestones, milestone_rule_caps;
// migration 0020).
//
//   - A rule is one band of contract value ("from $20,000", "under
//     $20,000") in one region: every region, a country, or a state of it.
//   - A job takes the rule of the most specific region whose band holds its
//     contract value: its state, else its country, else every region. The
//     job's region comes from its site address, else the business's.
//   - The rule's milestones become the job's schedule when its milestones
//     are first created. A rule with none leaves Field's default schedule.
//   - The rule's caps apply to every invoice the job issues, by milestone
//     kind (deposit, progress, final, variation), whatever schedule the job
//     has: an override changes the split, never the caps. A hard cap refuses
//     the issue; a soft cap alerts, and the alert is recorded with the
//     invoice.
//
// Nothing about a jurisdiction is in code. The operator enters the rules
// that apply to them, in Settings. Only an owner changes them.
import { asc } from "drizzle-orm";
import { schema } from "../db-runtime/index.js";
import { orgScope } from "../db-runtime/tenancy.js";
import { ulid } from "../documents/uid.js";
import { describeRegion, normalizeCountryCode, normalizeRegionCode, regionFromAddress } from "../../shared/regions.js";
import { invoiceKind } from "./from-milestones.js";

const { milestoneRules: rulesTable, milestoneRuleMilestones: milestonesTable, milestoneRuleCaps: capsTable, businessSettings } = schema;

export const MILESTONE_RULE_VALUE_BASES = Object.freeze(["inc-gst", "ex-gst"]);
export const MILESTONE_CAP_MODES = Object.freeze(["hard", "soft"]);
export const MILESTONE_CAP_KINDS = Object.freeze(["deposit", "progress", "final", "variation"]);

const RULE_UID = /^mrl_[0-9A-HJKMNP-TV-Z]{26}$/;

export class MilestoneRulesError extends Error {
  constructor(message, { code = "MILESTONE_RULES_INVALID", statusCode = 400 } = {}) {
    super(message);
    this.name = "MilestoneRulesError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** A hard cap refused an issue. The message names the rule. */
export class MilestoneCapError extends Error {
  constructor(findings) {
    super(findings.map((finding) => finding.message).join(" "));
    this.name = "MilestoneCapError";
    this.code = "MILESTONE_CAP_EXCEEDED";
    this.statusCode = 409;
    this.findings = findings;
  }
}

const cents = (value) => Math.round(Number(value || 0) * 100);
const money = (value) => cents(value) / 100;
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const positive = (value) => value != null && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0;

function formatMoney(value) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(money(value));
}

function trimNumber(value) {
  return String(Math.round(Number(value) * 1000) / 1000);
}

// ---------------------------------------------------------------------------
// Validation: what an owner submits, as Field stores it.

function fail(path, message) {
  throw new MilestoneRulesError(`${path}: ${message}`);
}

function normalizeMilestone(input, path) {
  if (!input || typeof input !== "object") fail(path, "must be an object");
  const label = text(input.label);
  if (!label) fail(path, "needs a label");
  const percentage = positive(input.percentage) ? Math.round(Number(input.percentage) * 1000) / 1000 : 0;
  const fixedTotal = positive(input.fixedTotal) ? money(input.fixedTotal) : null;
  if (!percentage && !fixedTotal) fail(path, "needs a percentage or a fixed amount greater than zero");
  if (percentage > 100) fail(path, "percentage cannot be over 100");
  const dueDays = input.dueDays == null || input.dueDays === "" ? null : Number(input.dueDays);
  if (dueDays != null && !(Number.isInteger(dueDays) && dueDays > 0)) fail(path, "dueDays must be a whole number of days");
  return { label, percentage, ...(fixedTotal ? { fixedTotal } : {}), ...(dueDays ? { dueDays } : {}) };
}

function normalizeCap(input, path) {
  if (!input || typeof input !== "object") fail(path, "must be an object");
  const kind = text(input.kind);
  if (!MILESTONE_CAP_KINDS.includes(kind)) fail(path, `kind must be one of ${MILESTONE_CAP_KINDS.join(", ")}`);
  const mode = text(input.mode);
  if (!MILESTONE_CAP_MODES.includes(mode)) fail(path, "mode must be hard (blocks the issue) or soft (alerts)");
  const maxPercent = positive(input.maxPercent) ? Math.round(Number(input.maxPercent) * 1000) / 1000 : null;
  const maxAmount = positive(input.maxAmount) ? money(input.maxAmount) : null;
  if (!maxPercent && !maxAmount) fail(path, "needs maxPercent or maxAmount greater than zero");
  if (maxPercent && maxPercent > 100) fail(path, "maxPercent cannot be over 100");
  return { kind, mode, maxPercent, maxAmount };
}

function normalizeRule(input, index) {
  const path = `rules[${index}]`;
  if (!input || typeof input !== "object") fail(path, "must be an object");
  const name = text(input.name);
  if (!name) fail(path, "needs a name");
  const country = input.country == null || input.country === "" ? null : normalizeCountryCode(input.country);
  if (input.country != null && input.country !== "" && !country) fail(path, "country must be a two-letter country code, such as AU");
  const region = input.region == null || input.region === "" ? null : normalizeRegionCode(input.region);
  if (input.region != null && input.region !== "" && !region) fail(path, "region must be a state or province code, such as SA");
  if (region && !country) fail(path, "a region needs its country");
  const minValue = input.minValue == null || input.minValue === "" ? 0 : Number(input.minValue);
  if (!Number.isFinite(minValue) || minValue < 0) fail(path, "minValue must be zero or more");
  const maxValue = input.maxValue == null || input.maxValue === "" ? null : Number(input.maxValue);
  if (maxValue != null && !(Number.isFinite(maxValue) && maxValue > minValue)) fail(path, "maxValue must be more than minValue");
  const valueBasis = text(input.valueBasis) || "inc-gst";
  if (!MILESTONE_RULE_VALUE_BASES.includes(valueBasis)) fail(path, "valueBasis must be inc-gst or ex-gst");
  const milestones = (Array.isArray(input.milestones) ? input.milestones : [])
    .map((milestone, at) => normalizeMilestone(milestone, `${path}.milestones[${at}]`));
  if (milestones.length) {
    const percentTotal = Math.round(milestones.reduce((sum, milestone) => sum + milestone.percentage, 0) * 1000) / 1000;
    const hasFixed = milestones.some((milestone) => milestone.fixedTotal);
    if (!hasFixed && percentTotal !== 100) fail(path, "milestone percentages must add up to exactly 100");
    if (hasFixed && percentTotal > 100) fail(path, "milestone percentages cannot be over 100 beside fixed amounts");
  }
  const caps = (Array.isArray(input.caps) ? input.caps : []).map((cap, at) => normalizeCap(cap, `${path}.caps[${at}]`));
  const kinds = new Set();
  for (const cap of caps) {
    if (kinds.has(cap.kind)) fail(path, `has two ${cap.kind} caps; a rule has at most one cap per kind`);
    kinds.add(cap.kind);
  }
  const uid = text(input.uid);
  return {
    uid: uid && RULE_UID.test(uid) ? uid : null,
    name,
    country,
    region,
    minValue: money(minValue),
    maxValue: maxValue == null ? null : money(maxValue),
    valueBasis,
    note: text(input.note),
    milestones,
    caps,
  };
}

/** The rules as stored, in order, or a MilestoneRulesError naming the first problem. */
export function validateMilestoneRules(input) {
  if (!Array.isArray(input)) throw new MilestoneRulesError("rules must be a list");
  const rules = input.map(normalizeRule);
  // Two bands in one region may not overlap: a contract value would have two rules.
  for (let a = 0; a < rules.length; a += 1) {
    for (let b = a + 1; b < rules.length; b += 1) {
      const first = rules[a];
      const second = rules[b];
      if (first.country !== second.country || first.region !== second.region) continue;
      const firstEnd = first.maxValue ?? Infinity;
      const secondEnd = second.maxValue ?? Infinity;
      if (first.minValue < secondEnd && second.minValue < firstEnd) {
        throw new MilestoneRulesError(`rules "${first.name}" and "${second.name}" overlap in ${describeRegion(first)}: one contract value would match both`);
      }
    }
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Choosing the rule for a job.

/** "under $20,000", "from $20,000", "from $20,000 to under $50,000", "any contract value". */
export function describeBand({ minValue = 0, maxValue = null } = {}) {
  if (!(minValue > 0) && maxValue == null) return "any contract value";
  if (!(minValue > 0)) return `under ${formatMoney(maxValue)}`;
  if (maxValue == null) return `from ${formatMoney(minValue)}`;
  return `from ${formatMoney(minValue)} to under ${formatMoney(maxValue)}`;
}

/** The contract value a rule measures: the quote total with GST, or without. */
export function contractValueOf(financials, valueBasis = "inc-gst") {
  return money(valueBasis === "ex-gst" ? financials?.subtotal : financials?.total);
}

function scopeRank(rule, region) {
  if (rule.country && rule.region) return rule.country === region?.country && rule.region === region?.region ? 3 : 0;
  if (rule.country) return rule.country === region?.country ? 2 : 0;
  return 1;
}

/**
 * The rule that applies to a contract: of the rules whose band holds its
 * value, the one for the most specific region. Null when none does.
 */
export function selectMilestoneRule({ rules = [], region = null, financials = null } = {}) {
  let best = null;
  for (const rule of rules) {
    const rank = scopeRank(rule, region);
    if (!rank) continue;
    const value = contractValueOf(financials, rule.valueBasis);
    if (cents(value) < cents(rule.minValue)) continue;
    if (rule.maxValue != null && cents(value) >= cents(rule.maxValue)) continue;
    if (!best || rank > best.rank) best = { rank, rule, contractValue: value };
  }
  return best ? { rule: best.rule, contractValue: best.contractValue } : null;
}

/** The schedule a rule gives a job, or null for Field's default schedule. */
export function scheduleFromRule(rule) {
  if (!rule?.milestones?.length) return null;
  return { milestones: rule.milestones.map((milestone) => ({ ...milestone })) };
}

/**
 * Where a job is: its site address, else the business's country and region
 * (from Settings, else the business address). `from` says which.
 */
export function resolveJobRegion({ siteAddress = null, business = null } = {}) {
  const site = regionFromAddress(siteAddress);
  const fromBusiness = business?.country ? business : null;
  if (site.country && site.region) return { ...site, from: "site-address" };
  if (fromBusiness && (!site.country || site.country === fromBusiness.country)) {
    return { country: fromBusiness.country, region: fromBusiness.region || null, from: fromBusiness.from || "business" };
  }
  if (site.country) return { ...site, from: "site-address" };
  return { country: null, region: null, from: null };
}

// ---------------------------------------------------------------------------
// Caps.

function capLimit(cap, contractValue) {
  const limits = [];
  if (cap.maxAmount) limits.push(cents(cap.maxAmount));
  if (cap.maxPercent) limits.push(Math.round(cents(contractValue) * cap.maxPercent / 100));
  return Math.min(...limits) / 100;
}

function describeCap(cap, contractValue) {
  const parts = [];
  if (cap.maxAmount) parts.push(formatMoney(cap.maxAmount));
  if (cap.maxPercent) parts.push(`${trimNumber(cap.maxPercent)} % of the contract value (${formatMoney(Number(contractValue) * cap.maxPercent / 100)})`);
  return parts.length > 1 ? `the lower of ${parts.join(" and ")}` : parts[0];
}

function kindWord(kind) {
  return { deposit: "deposit", progress: "progress claim", final: "final claim", variation: "variation claim" }[kind] || kind;
}

/**
 * The caps a milestone is over. `milestone` is { index, label, count,
 * subtotal, total }; `match` is selectMilestoneRule's answer. Each finding
 * names the rule and says what it allows.
 */
export function evaluateMilestoneCaps({ match = null, milestone }) {
  if (!match?.rule?.caps?.length || !milestone) return [];
  const { rule, contractValue } = match;
  const kind = invoiceKind(milestone.label, milestone.index, milestone.count);
  const amount = money(rule.valueBasis === "ex-gst" ? milestone.subtotal : milestone.total);
  const findings = [];
  for (const cap of rule.caps) {
    if (cap.kind !== kind) continue;
    const limit = capLimit(cap, contractValue);
    if (cents(amount) <= cents(limit)) continue;
    const basis = rule.valueBasis === "ex-gst" ? " before GST" : " with GST";
    const said = `${milestone.label} is ${formatMoney(amount)}${basis}. The rule "${rule.name}" (${describeRegion(rule)}, ${describeBand(rule)}) allows a ${kindWord(kind)} of at most ${describeCap(cap, contractValue)}.`;
    findings.push({
      milestoneIndex: milestone.index,
      kind,
      mode: cap.mode,
      ruleUid: rule.uid || null,
      ruleName: rule.name,
      ...(rule.note ? { ruleNote: rule.note } : {}),
      valueBasis: rule.valueBasis,
      contractValue: money(contractValue),
      amount,
      limit,
      maxPercent: cap.maxPercent,
      maxAmount: cap.maxAmount,
      message: cap.mode === "hard"
        ? `${said} This is a hard cap, so Field does not issue the invoice. Change the milestone, or ask an owner to change the rule in Settings.`
        : `${said} This is a soft cap: Field issues the invoice and records this alert with it.`,
    });
  }
  return findings;
}

/** A rule as a job records it: enough to name it after the rule changes. */
export function ruleReference(rule) {
  if (!rule) return null;
  return {
    ruleUid: rule.uid || null,
    ruleName: rule.name,
    country: rule.country,
    region: rule.region,
    band: describeBand(rule),
  };
}

// ---------------------------------------------------------------------------
// Rows.

function ruleFromRows(row, milestones, caps) {
  return {
    uid: row.uid,
    name: row.name,
    country: row.country || null,
    region: row.region || null,
    minValue: money(row.minValue),
    maxValue: row.maxValue == null ? null : money(row.maxValue),
    valueBasis: row.valueBasis,
    note: row.note || null,
    milestones: milestones.map((milestone) => ({
      label: milestone.label,
      percentage: milestone.percent == null ? 0 : Number(milestone.percent),
      ...(milestone.amount != null ? { fixedTotal: money(milestone.amount) } : {}),
      ...(milestone.dueDays ? { dueDays: milestone.dueDays } : {}),
    })),
    caps: caps.map((cap) => ({
      kind: cap.kind,
      mode: cap.mode,
      maxPercent: cap.maxPercent == null ? null : Number(cap.maxPercent),
      maxAmount: cap.maxAmount == null ? null : money(cap.maxAmount),
    })),
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    updatedBy: row.updatedBy || null,
  };
}

async function readRules(tx) {
  const rows = await tx.select().from(rulesTable).orderBy(asc(rulesTable.sortOrder));
  const milestones = await tx.select().from(milestonesTable).orderBy(asc(milestonesTable.sortOrder));
  const caps = await tx.select().from(capsTable);
  return rows.map((row) => ruleFromRows(
    row,
    milestones.filter((milestone) => milestone.ruleUid === row.uid),
    MILESTONE_CAP_KINDS.flatMap((kind) => caps.filter((cap) => cap.ruleUid === row.uid && cap.kind === kind)),
  ));
}

/** A token that changes whenever the rules do, for a guarded replace. */
export function rulesVersion(rules) {
  if (!rules.length) return "none";
  const latest = rules.map((rule) => rule.updatedAt || "").sort().at(-1);
  return `${rules.length}:${latest}`;
}

export function createMilestoneRuleService({ db, orgUid = undefined, now = () => new Date() }) {
  if (!db) throw new Error("createMilestoneRuleService needs a database");
  const scope = db.isOrgScope ? db : orgScope(db, orgUid);
  return {
    async list() {
      return scope.transaction(async (tx) => {
        const rules = await readRules(tx);
        return { rules, version: rulesVersion(rules) };
      });
    },
    /**
     * Replace every rule. `expectedVersion` (from list) refuses a replace
     * when someone changed the rules in between.
     */
    async replace(input, { actor = null, expectedVersion = null } = {}) {
      const rules = validateMilestoneRules(input);
      return scope.transaction(async (tx) => {
        const current = await readRules(tx);
        if (expectedVersion != null && expectedVersion !== rulesVersion(current)) {
          throw new MilestoneRulesError("the milestone rules changed since you read them; reload and try again", { code: "MILESTONE_RULES_STALE", statusCode: 409 });
        }
        const at = now();
        await tx.delete(rulesTable);
        const seen = new Set();
        for (const [sortOrder, rule] of rules.entries()) {
          const uid = rule.uid && !seen.has(rule.uid) ? rule.uid : `mrl_${ulid(at.getTime())}`;
          seen.add(uid);
          await tx.insert(rulesTable).values({
            uid,
            name: rule.name,
            country: rule.country,
            region: rule.region,
            minValue: rule.minValue.toFixed(2),
            maxValue: rule.maxValue == null ? null : rule.maxValue.toFixed(2),
            valueBasis: rule.valueBasis,
            note: rule.note,
            sortOrder,
            createdAt: at,
            updatedAt: at,
            updatedBy: actor,
          });
          for (const [order, milestone] of rule.milestones.entries()) {
            await tx.insert(milestonesTable).values({
              uid: `mrm_${ulid(at.getTime())}`,
              ruleUid: uid,
              sortOrder: order,
              label: milestone.label,
              percent: milestone.percentage ? milestone.percentage.toFixed(3) : null,
              amount: milestone.fixedTotal ? milestone.fixedTotal.toFixed(2) : null,
              dueDays: milestone.dueDays || null,
            });
          }
          for (const cap of rule.caps) {
            await tx.insert(capsTable).values({
              uid: `mrc_${ulid(at.getTime())}`,
              ruleUid: uid,
              kind: cap.kind,
              mode: cap.mode,
              maxPercent: cap.maxPercent == null ? null : cap.maxPercent.toFixed(3),
              maxAmount: cap.maxAmount == null ? null : cap.maxAmount.toFixed(2),
            });
          }
        }
        const saved = await readRules(tx);
        return { rules: saved, version: rulesVersion(saved) };
      });
    },
    /** The business's country and region as set in Settings (nulls when not set). */
    async businessRegion() {
      return scope.transaction(async (tx) => {
        const [row] = await tx.select({ country: businessSettings.country, region: businessSettings.region }).from(businessSettings);
        return { country: row?.country || null, region: row?.region || null };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The service the job actions read, installed by the server like the invoice
// issuer. With none installed (no database, most unit tests) there are no
// rules: Field's default schedule and no caps, as before step 4c.

let installed = null;

export function installMilestoneRules(service) {
  installed = service || null;
}

export function installedMilestoneRules() {
  return installed;
}

/**
 * The business's region: Settings first, else the business address. `from`
 * says which.
 */
export async function resolveBusinessRegion({ service = installed, businessAddress = null } = {}) {
  const set = service ? await service.businessRegion() : { country: null, region: null };
  if (set.country) return { ...set, from: "settings" };
  const read = regionFromAddress(businessAddress);
  return read.country ? { ...read, from: "business-address" } : { country: null, region: null, from: null };
}

/**
 * The account rule for one job and quote: { region, rule, contractValue,
 * rules } with `rule` null when none applies, or null when the organisation
 * has no rules at all.
 */
export async function resolveJobMilestoneRule({ meta = null, financials = null, businessAddress = null, service = installed } = {}) {
  if (!service) return null;
  const { rules } = await service.list();
  if (!rules.length) return null;
  const business = await resolveBusinessRegion({ service, businessAddress });
  const region = resolveJobRegion({ siteAddress: meta?.siteAddress || null, business });
  const match = selectMilestoneRule({ rules, region, financials });
  return { region, rule: match?.rule || null, contractValue: match?.contractValue ?? null, match };
}
