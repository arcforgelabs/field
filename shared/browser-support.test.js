import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// The client bundles shared/, and older browsers (Chrome before 93) have no
// Object.hasOwn: the theme provider threw on the home page (#199).
test("shared browser code does not call Object.hasOwn", async () => {
  const dir = new URL("./", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"));
  const offenders = [];
  for (const name of files) {
    if ((await readFile(new URL(name, dir), "utf8")).includes("Object.hasOwn(")) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});

test("themes and email templates work without Object.hasOwn", async () => {
  const original = Object.hasOwn;
  delete Object.hasOwn;
  try {
    const { isThemeFamily, themeId, DEFAULT_FAMILY } = await import(`./themes.js?no-hasown=${Date.now()}`);
    assert.equal(isThemeFamily(DEFAULT_FAMILY), true);
    assert.equal(isThemeFamily("toString"), false);
    assert.equal(themeId("unknown", "dark"), `${DEFAULT_FAMILY}-dark`);
    const { renderEmailTemplate } = await import(`./email-templates.js?no-hasown=${Date.now()}`);
    const rendered = renderEmailTemplate({ subject: "{{greeting}}{{missing}}", html: "<p>{{clientName}}</p>" }, { clientName: "Dana" });
    assert.equal(rendered.subject, "Hi Dana,");
    assert.equal(rendered.html, "<p>Dana</p>");
  } finally {
    Object.hasOwn = original;
  }
});
