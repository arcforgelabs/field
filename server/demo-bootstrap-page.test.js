import assert from "node:assert/strict";
import test from "node:test";
import { Parser } from "htmlparser2";
import { renderDemoBootstrapPage, scriptLiteral } from "./demo-bootstrap-page.js";

const HOSTILE = "</script><script>alert(1)</script><!--";

function scriptsOf(html) {
  const scripts = [];
  let current = null;
  const parser = new Parser({
    onopentag(name) { if (name === "script") current = ""; },
    ontext(text) { if (current !== null) current += text; },
    onclosetag(name) { if (name === "script") { scripts.push(current); current = null; } },
  });
  parser.end(html);
  return scripts;
}

test("the demo page writes no person's details into its script", () => {
  const page = renderDemoBootstrapPage({ token: "tok_demo", user: { id: "u1", name: HOSTILE, email: "demo@example.com" } });
  assert.doesNotMatch(page, /alert|demo@example\.com/);
  const [script, ...rest] = scriptsOf(page);
  assert.equal(rest.length, 0, "one script");
  assert.match(script, /localStorage\.setItem\("fr_token", token\)/);
  assert.match(script, /fetch\("\/api\/auth\/me"/);
});

test("the token is a script literal that cannot end the script", () => {
  const page = renderDemoBootstrapPage({ token: HOSTILE });
  const scripts = scriptsOf(page);
  assert.equal(scripts.length, 1, "one script");
  const literal = /const token = (.*);/.exec(scripts[0])[1];
  assert.equal(JSON.parse(literal), HOSTILE);
  assert.doesNotMatch(literal, /[<>&\u2028\u2029]/);
  assert.equal(JSON.parse(scriptLiteral("a\u2028b\u2029c")), "a\u2028b\u2029c");
  assert.equal(scriptLiteral("a\u2028b"), '"a\\u2028b"');
});
