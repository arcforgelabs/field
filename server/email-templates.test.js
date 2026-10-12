import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderEmailTemplate } from "../shared/email-templates.js";
import { initEmailTemplates, listEmailTemplates, updateEmailTemplate } from "./email-templates.js";

test("email templates persist safe overrides and retain defaults", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-email-templates-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await initEmailTemplates(dataDir);

  const initial = listEmailTemplates();
  assert.equal(initial.templates.invoice.find((row) => row.id === "standard").name, "Standard invoice");

  await updateEmailTemplate("invoice", "standard", {
    name: "Alex invoice",
    subject: "Invoice for {{jobTitle}}",
    html: '<p onclick="alert(1)">Hello {{clientName}}</p><script>alert(1)</script>',
  }, { id: "alex-agent", name: "Alex AI" });

  const updated = listEmailTemplates().templates.invoice.find((row) => row.id === "standard");
  assert.equal(updated.name, "Alex invoice");
  assert.match(updated.html, /Hello \{\{clientName\}\}/);
  assert.doesNotMatch(updated.html, /onclick|script/i);
  assert.equal(updated.updatedBy.name, "Alex AI");

  const onDisk = JSON.parse(await readFile(join(dataDir, "email-templates.json"), "utf8"));
  assert.equal(onDisk.overrides.invoice.standard.name, "Alex invoice");
});

test("email template renderer escapes job data and preserves allowed template markup", () => {
  const rendered = renderEmailTemplate({
    id: "standard",
    name: "Standard",
    description: "",
    subject: "{{defaultSubject}}",
    html: "<p>{{greeting}}</p><p>Invoice{{jobTitleFor}}</p>",
  }, {
    clientName: '<img src=x onerror="bad">',
    jobTitle: "Smith & Sons",
    defaultSubject: "Invoice - EI-1",
  });

  assert.equal(rendered.subject, "Invoice - EI-1");
  assert.match(rendered.html, /Hi &lt;img/);
  assert.match(rendered.html, /<strong>Smith &amp; Sons<\/strong>/);
  assert.doesNotMatch(rendered.html, /<img/i);
});

test("email template updates reject unknown document types and template ids", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-email-templates-errors-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await initEmailTemplates(dataDir);
  await assert.rejects(() => updateEmailTemplate("contract", "standard", {}), /documentType must be one of/);
  await assert.rejects(() => updateEmailTemplate("invoice", "missing", {}), /unknown invoice email template/);
});
