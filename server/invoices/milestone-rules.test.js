// Milestone rules (#29, step 4c): validation, choosing the rule for a job,
// the caps, and the rows (on a throwaway PGlite database).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sql } from "drizzle-orm";
import { createTestDb, queryRows } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID, withOrg } from "../db-runtime/tenancy.js";
import { createBusinessSettingsService } from "./business-settings.js";
import {
  createMilestoneRuleService,
  describeBand,
  evaluateMilestoneCaps,
  resolveBusinessRegion,
  resolveJobMilestoneRule,
  resolveJobRegion,
  selectMilestoneRule,
  validateMilestoneRules,
} from "./milestone-rules.js";
import { SA_RULES } from "./milestone-rules-fixtures.js";

const financials = (total) => ({ subtotal: Math.round((total / 1.1) * 100) / 100, total });

describe("validating rules", () => {
  test("normalizes a rule set, with every default", () => {
    const [rule] = validateMilestoneRules([{ name: " Everywhere ", milestones: [], caps: [{ kind: "deposit", maxPercent: "10", mode: "soft" }] }]);
    assert.deepEqual(rule, {
      uid: null, name: "Everywhere", country: null, region: null, minValue: 0, maxValue: null, valueBasis: "inc-gst", note: null,
      milestones: [], caps: [{ kind: "deposit", mode: "soft", maxPercent: 10, maxAmount: null }],
    });
  });

  test("refuses what Field could not apply, naming the rule", () => {
    const cases = [
      [[{ name: "" }], /rules\[0\]: needs a name/],
      [[{ name: "A", region: "SA" }], /a region needs its country/],
      [[{ name: "A", country: "Australia" }], /two-letter country code/],
      [[{ name: "A", minValue: 100, maxValue: 50 }], /maxValue must be more than minValue/],
      [[{ name: "A", valueBasis: "net" }], /valueBasis must be inc-gst or ex-gst/],
      [[{ name: "A", milestones: [{ label: "Deposit", percentage: 40 }] }], /add up to exactly 100/],
      [[{ name: "A", caps: [{ kind: "deposit", mode: "warn", maxAmount: 1 }] }], /mode must be hard/],
      [[{ name: "A", caps: [{ kind: "deposit", mode: "hard" }] }], /needs maxPercent or maxAmount/],
      [[{ name: "A", caps: [{ kind: "deposit", mode: "hard", maxAmount: 1 }, { kind: "deposit", mode: "soft", maxPercent: 2 }] }], /two deposit caps/],
      [[{ name: "Low", country: "AU", maxValue: 20000 }, { name: "High", country: "AU", minValue: 19000 }], /"Low" and "High" overlap in AU/],
      ["not a list", /rules must be a list/],
    ];
    for (const [input, pattern] of cases) assert.throws(() => validateMilestoneRules(input), pattern);
  });

  test("bands in different regions may cover the same values", () => {
    assert.equal(validateMilestoneRules([{ name: "SA", country: "AU", region: "SA" }, { name: "AU", country: "AU" }, { name: "All" }]).length, 3);
  });
});

describe("choosing the rule", () => {
  const rules = validateMilestoneRules([
    ...SA_RULES,
    { name: "Australia", country: "AU", caps: [{ kind: "deposit", maxPercent: 20, mode: "soft" }] },
    { name: "Everywhere", caps: [{ kind: "deposit", maxPercent: 30, mode: "soft" }] },
  ]);
  const sa = { country: "AU", region: "SA" };

  test("the band holds the contract value: from is inclusive, under is not", () => {
    assert.equal(selectMilestoneRule({ rules, region: sa, financials: financials(19999.99) }).rule.name, "SA domestic, under $20,000");
    assert.equal(selectMilestoneRule({ rules, region: sa, financials: financials(20000) }).rule.name, "SA domestic, from $20,000");
  });

  test("the most specific region wins: state, then country, then every region", () => {
    assert.equal(selectMilestoneRule({ rules, region: { country: "AU", region: "VIC" }, financials: financials(5000) }).rule.name, "Australia");
    assert.equal(selectMilestoneRule({ rules, region: { country: "NZ", region: null }, financials: financials(5000) }).rule.name, "Everywhere");
    assert.equal(selectMilestoneRule({ rules, region: { country: null, region: null }, financials: financials(5000) }).rule.name, "Everywhere");
    assert.equal(selectMilestoneRule({ rules: rules.slice(0, 2), region: { country: "NZ" }, financials: financials(5000) }), null);
  });

  test("a rule measures with or without GST, as it says", () => {
    const exGst = validateMilestoneRules([{ name: "Ex", maxValue: 20000, valueBasis: "ex-gst" }]);
    // $21,000 with GST is $19,090.91 before it: under $20,000 ex GST.
    assert.equal(selectMilestoneRule({ rules: exGst, region: sa, financials: financials(21000) }).contractValue, 19090.91);
  });

  test("the job's region: its site address, else the business's", () => {
    const business = { country: "AU", region: "SA", from: "settings" };
    assert.deepEqual(resolveJobRegion({ siteAddress: "1 Example St, Sampleton VIC 3000", business }), { country: "AU", region: "VIC", from: "site-address" });
    assert.deepEqual(resolveJobRegion({ siteAddress: "Lot 4, the back paddock", business }), { country: "AU", region: "SA", from: "settings" });
    assert.deepEqual(resolveJobRegion({ siteAddress: "12 Example Road, New Zealand", business }), { country: "NZ", region: null, from: "site-address" });
    assert.deepEqual(resolveJobRegion({ siteAddress: null, business: null }), { country: null, region: null, from: null });
  });

  test("bands read in plain words", () => {
    assert.equal(describeBand({ minValue: 0, maxValue: 20000 }), "under $20,000.00");
    assert.equal(describeBand({ minValue: 20000, maxValue: null }), "from $20,000.00");
    assert.equal(describeBand({ minValue: 0, maxValue: null }), "any contract value");
  });
});

describe("caps", () => {
  const rules = validateMilestoneRules(SA_RULES);
  const sa = { country: "AU", region: "SA" };
  const deposit = (total) => ({ index: 0, label: "Deposit", count: 3, subtotal: Math.round((total / 1.1) * 100) / 100, total });

  test("a deposit over $1,000 under $20,000 is refused by a hard cap that names the rule", () => {
    const match = selectMilestoneRule({ rules, region: sa, financials: financials(15000) });
    const [finding] = evaluateMilestoneCaps({ match, milestone: deposit(1500) });
    assert.equal(finding.mode, "hard");
    assert.equal(finding.kind, "deposit");
    assert.equal(finding.limit, 1000);
    assert.equal(finding.ruleName, "SA domestic, under $20,000");
    assert.match(finding.message, /Deposit is \$1,500\.00 with GST\. The rule "SA domestic, under \$20,000" \(South Australia, AU, under \$20,000\.00\) allows a deposit of at most \$1,000\.00\. This is a hard cap/);
    assert.deepEqual(evaluateMilestoneCaps({ match, milestone: deposit(1000) }), [], "at the limit is allowed");
  });

  test("from $20,000 the deposit is at most 5 % of the contract value", () => {
    const match = selectMilestoneRule({ rules, region: sa, financials: financials(40000) });
    assert.deepEqual(evaluateMilestoneCaps({ match, milestone: deposit(2000) }), []);
    const [finding] = evaluateMilestoneCaps({ match, milestone: deposit(2000.01) });
    assert.equal(finding.limit, 2000);
    assert.match(finding.message, /at most 5 % of the contract value \(\$2,000\.00\)/);
  });

  test("caps follow the milestone's kind, not its position or the rule's own milestones", () => {
    const match = selectMilestoneRule({ rules, region: sa, financials: financials(15000) });
    assert.deepEqual(evaluateMilestoneCaps({ match, milestone: { index: 1, label: "Progress payment", count: 3, subtotal: 5000, total: 5500 } }), []);
    // An override that renames the first milestone is still a deposit (from-milestones.js invoiceKind).
    assert.equal(evaluateMilestoneCaps({ match, milestone: { index: 0, label: "Start-up claim", count: 3, subtotal: 1500, total: 1650 } })[0].kind, "deposit");
  });

  test("a soft cap alerts", () => {
    const soft = validateMilestoneRules([{ name: "Guidance", caps: [{ kind: "deposit", maxPercent: 10, mode: "soft" }] }]);
    const match = selectMilestoneRule({ rules: soft, region: sa, financials: financials(10000) });
    const [finding] = evaluateMilestoneCaps({ match, milestone: deposit(1100) });
    assert.equal(finding.mode, "soft");
    assert.match(finding.message, /soft cap: Field issues the invoice and records this alert/);
  });

  test("no rule, no caps", () => {
    assert.deepEqual(evaluateMilestoneCaps({ match: null, milestone: deposit(99999) }), []);
  });
});

describe("the rows", () => {
  let t;
  let rules;
  const ORG_B = "org_01TESTSECONDORGANISATION0";

  before(async () => {
    t = await createTestDb();
    await t.db.execute(sql`insert into organizations (uid, name, slug) values (${ORG_B}, 'Second Org', 'second')`);
    rules = createMilestoneRuleService({ db: t.db, orgUid: DEFAULT_ORG_UID, now: () => new Date("2026-10-13T00:00:00.000Z") });
  });
  after(() => t.close());

  test("an organisation starts with no rules, and a replace stores them as rows", async () => {
    assert.deepEqual(await rules.list(), { rules: [], version: "none" });
    const saved = await rules.replace(SA_RULES, { actor: "owner-1" });
    assert.equal(saved.rules.length, 2);
    assert.match(saved.rules[0].uid, /^mrl_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(saved.rules[0].caps, [{ kind: "deposit", mode: "hard", maxPercent: null, maxAmount: 1000 }]);
    assert.deepEqual(saved.rules[1].milestones.map((milestone) => [milestone.label, milestone.percentage]), [["Deposit", 5], ["Progress payment", 35], ["Final payment", 60]]);
    assert.equal(saved.rules[0].updatedBy, "owner-1");
    const counts = await withOrg(t.db, DEFAULT_ORG_UID, (tx) => queryRows(sql`select (select count(*) from milestone_rules) as rules, (select count(*) from milestone_rule_milestones) as milestones, (select count(*) from milestone_rule_caps) as caps`, tx));
    assert.deepEqual(counts[0], { rules: "2", milestones: "6", caps: "2" });
  });

  test("a replace keeps a rule's uid, and a stale one is refused", async () => {
    const before = await rules.list();
    const next = before.rules.map((rule) => ({ ...rule }));
    next[0].caps = [{ kind: "deposit", maxAmount: 1000, mode: "soft" }];
    const later = createMilestoneRuleService({ db: t.db, orgUid: DEFAULT_ORG_UID, now: () => new Date("2026-10-13T01:00:00.000Z") });
    const saved = await later.replace(next, { expectedVersion: before.version });
    assert.equal(saved.rules[0].uid, before.rules[0].uid);
    assert.equal(saved.rules[0].caps[0].mode, "soft");
    await assert.rejects(later.replace(next, { expectedVersion: before.version }), (error) => error.code === "MILESTONE_RULES_STALE" && error.statusCode === 409);
    await later.replace(SA_RULES);
  });

  test("the database refuses a cap that is neither hard nor soft, and another organisation sees none", async () => {
    await assert.rejects(withOrg(t.db, DEFAULT_ORG_UID, (tx) => queryRows(sql`update milestone_rule_caps set mode = 'warn'`, tx)), (error) => {
      let message = "";
      for (let inner = error; inner; inner = inner.cause) message += ` ${inner.message}`;
      return /milestone_rule_caps_mode_check/.test(message);
    });
    const other = createMilestoneRuleService({ db: t.db, orgUid: ORG_B });
    assert.deepEqual((await other.list()).rules, []);
  });

  test("the business region: Settings first, else the business address", async () => {
    assert.deepEqual(await resolveBusinessRegion({ service: rules, businessAddress: "1 Example St, Sampleton VIC 3000" }), { country: "AU", region: "VIC", from: "business-address" });
    const settings = createBusinessSettingsService({ db: t.db, orgUid: DEFAULT_ORG_UID });
    await settings.update({ country: "au", region: "sa" }, { actor: "owner-1" });
    assert.deepEqual(await resolveBusinessRegion({ service: rules, businessAddress: "1 Example St, Sampleton VIC 3000" }), { country: "AU", region: "SA", from: "settings" });
    assert.equal((await settings.get()).creditNoteOnReissue, "when-emailed", "a region change keeps the other settings");
    await assert.rejects(settings.update({ region: "SA", country: null }), /a region needs its country/);
    await settings.update({ country: null, region: null });
  });

  test("a job's rule, from its site address and contract value", async () => {
    const resolved = await resolveJobMilestoneRule({ service: rules, meta: { siteAddress: "3 Sample Rd, Exampleton SA 5000" }, financials: financials(25000) });
    assert.equal(resolved.rule.name, "SA domestic, from $20,000");
    assert.deepEqual(resolved.region, { country: "AU", region: "SA", from: "site-address" });
    assert.equal(resolved.contractValue, 25000);
    const elsewhere = await resolveJobMilestoneRule({ service: rules, meta: { siteAddress: "3 Sample Rd, Exampleton VIC 3000" }, financials: financials(25000) });
    assert.equal(elsewhere.rule, null, "no rule for Victoria");
    assert.equal(await resolveJobMilestoneRule({ service: null, meta: {}, financials: financials(1) }), null, "no service: no rules");
  });
});
