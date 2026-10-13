// Milestone rules over HTTP (#29, step 4c), on the real server (PGlite, the
// synthetic verification catalogue, the proof harness's offline Gmail):
//
//   - an owner stores rules as rows, and a bad rule is refused by name;
//   - a landed job's first milestones come from the rule for its region;
//   - a schedule set in the quote editor is marked as an override;
//   - GET /api/jobs/:id/milestone-rules shows the hard cap before issue,
//     and sending the invoice is refused with a message naming the rule;
//   - `applyAccountRule` puts the rule's schedule back, and the invoice
//     then sends.
//
// No customer data: the verification fixtures and @example.invalid only.
import test from "node:test";
import assert from "node:assert/strict";
import { VERIFICATION_FIXTURES } from "../scripts/verification/fixtures.js";
import { boot, CUSTOMER } from "../scripts/quote-invoice-proof/email-test-server.mjs";

const RULES = [{
  name: "SA deposit limit, any value",
  country: "AU",
  region: "SA",
  note: "Synthetic test rule",
  milestones: [{ label: "Deposit", percentage: 5 }, { label: "Progress payment", percentage: 35 }, { label: "Final payment", percentage: 60 }],
  caps: [{ kind: "deposit", maxPercent: 5, mode: "hard" }, { kind: "progress", maxPercent: 30, mode: "soft" }],
}];

test("milestone rules: stored by an owner, applied when a job lands, overrides marked, hard caps refuse the issue", { timeout: 600_000 }, async (t) => {
  const { api, output } = await boot(t);
  const ok = (result, label) => assert.ok(result.status >= 200 && result.status < 300, `${label}: ${result.status} ${JSON.stringify(result.body)}\n${output.join("").slice(-3000)}`);

  const empty = await api("/api/settings/milestone-rules");
  ok(empty, "list rules");
  assert.deepEqual(empty.body.rules, []);
  assert.equal(empty.body.version, "none");
  assert.deepEqual(empty.body.options.capModes, ["hard", "soft"]);

  const bad = await api("/api/settings/milestone-rules", { method: "PUT", body: { rules: [{ name: "Broken", region: "SA" }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /rules\[0\]: a region needs its country/);

  const saved = await api("/api/settings/milestone-rules", { method: "PUT", body: { rules: RULES, expectedVersion: "none" } });
  ok(saved, "save rules");
  assert.equal(saved.body.rules[0].name, RULES[0].name);
  assert.match(saved.body.rules[0].uid, /^mrl_/);

  const created = await api("/api/jobs/manual", { method: "POST", body: { quoteCatalogId: "field-verification", siteAddress: VERIFICATION_FIXTURES[0].siteAddress } });
  ok(created, "create job");
  const id = created.body.id;
  ok(await api(`/api/jobs/${id}/quote-inputs`, { method: "PUT", body: VERIFICATION_FIXTURES[0].quoteInputs }), "inputs");
  ok(await api(`/api/jobs/${id}/quote-update`, { method: "POST", body: { lockStatus: "final" } }), "lock");
  ok(await api(`/api/jobs/${id}/email-quote`, { method: "POST", body: { to: CUSTOMER } }), "send quote");

  const preview = await api(`/api/jobs/${id}/milestone-rules`);
  ok(preview, "check before landing");
  assert.equal(preview.body.rule.name, RULES[0].name);
  assert.deepEqual(preview.body.region, { country: "AU", region: "SA", from: "site-address" });
  assert.deepEqual(preview.body.proposedSchedule.milestones.map((milestone) => milestone.percentage), [5, 35, 60]);

  ok(await api(`/api/jobs/${id}/landed`, { method: "POST" }), "land");
  const landed = await api(`/api/jobs/${id}/milestones`);
  assert.equal(landed.body.paymentSchedule.source.kind, "rule");
  assert.equal(landed.body.paymentSchedule.source.ruleName, RULES[0].name);
  assert.deepEqual(landed.body.milestones.map((milestone) => milestone.percentage), [5, 35, 60]);

  // An override with a 50 % deposit, through the typed API.
  const overridden = await api(`/api/jobs/${id}/milestones/generate`, { method: "POST", body: { paymentSchedule: { milestones: [{ label: "Deposit", percentage: 50 }, { label: "Final payment", percentage: 50 }] } } });
  ok(overridden, "override");
  assert.equal(overridden.body.paymentSchedule.source.kind, "override");
  assert.equal(overridden.body.detail.meta.paymentSchedule.source.kind, "override", "the job detail shows it");

  const check = await api(`/api/jobs/${id}/milestone-rules`);
  ok(check, "check");
  assert.equal(check.body.scheduleSource.kind, "override");
  assert.equal(check.body.milestones[0].blocked, true);
  assert.equal(check.body.milestones[0].kind, "deposit");

  const refused = await api(`/api/jobs/${id}/email-quote`, { method: "POST", body: { to: CUSTOMER, documentType: "invoice", milestoneIndex: 0 } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /The rule "SA deposit limit, any value" \(South Australia, AU, any contract value\) allows a deposit of at most 5 % of the contract value/);
  assert.equal(refused.body.findings[0].mode, "hard");
  const marked = await api(`/api/jobs/${id}/milestones/0`, { method: "PUT", body: { status: "authorised" } });
  assert.equal(marked.status, 409);
  assert.equal(marked.body.code, "MILESTONE_CAP_EXCEEDED");
  const documents = await api(`/api/jobs/${id}/documents`);
  assert.equal(documents.body.documents.filter((document) => document.documentType === "invoice").length, 0, "nothing was issued");

  const restored = await api(`/api/jobs/${id}/milestones/generate`, { method: "POST", body: { applyAccountRule: true } });
  ok(restored, "back to the rule");
  assert.equal(restored.body.paymentSchedule.source.kind, "rule");
  const sent = await api(`/api/jobs/${id}/email-quote`, { method: "POST", body: { to: CUSTOMER, documentType: "invoice", milestoneIndex: 0 } });
  ok(sent, "send the deposit");
  const revisions = await api(`/api/jobs/${id}/milestones/0/revisions`);
  ok(revisions, "revisions");
  assert.equal(revisions.body.revisions[0].milestoneRule.scheduleSource, "rule", "the invoice history says where its schedule came from");
});
