import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAuthorizationPage } from "./authorization-page.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures/oauth-authorize.html");

const FIXTURE_INPUT = {
  clientName: "Example MCP client",
  scopes: ["catalog.read", "catalog.write", "quote.read", "quote.draft"],
  requestId: "request-fixture",
  csrf: "csrf-fixture",
};

test("authorization page matches the Field-styled HTML fixture", async () => {
  const html = renderAuthorizationPage(FIXTURE_INPUT);
  const fixture = await readFile(fixturePath, "utf8");
  assert.equal(html, fixture);
  assert.match(html, /<style>/);
  assert.match(html, /data-theme="field"/);
  assert.match(html, /--t-brand:\s*#f4c518/);
  assert.match(html, /<h1><img src="\/field-mark.svg" alt="" width="36" height="28"> FIELD<\/h1>/);
  assert.match(html, /method="post" action="\/oauth\/approve"/);
  assert.match(html, /name="request"/);
  assert.match(html, /name="csrf"/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="password"/);
  assert.match(html, />Authorize<\/button>/);
  for (const scope of FIXTURE_INPUT.scopes) {
    assert.match(html, new RegExp(`<code>${scope}</code>`));
  }
  assert.doesNotMatch(html, /<title>Authorize Example<\/title><body><main>/);
});

test("authorization page escapes client-controlled values", () => {
  const html = renderAuthorizationPage({
    clientName: "<script>alert(1)</script>",
    scopes: ["quote.read"],
    requestId: '"><iframe>',
    csrf: "&",
  });
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes('value=""><iframe>"'), false);
  assert.match(html, /\u0026lt;script\u0026gt;alert\(1\)\u0026lt;\/script\u0026gt;/);
  assert.match(html, /name="request" value="\u0026quot;\u0026gt;\u0026lt;iframe\u0026gt;"/);
  assert.match(html, /name="csrf" value="\u0026amp;"/);
});
