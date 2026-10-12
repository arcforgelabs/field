import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isReplitRuntime, loadFieldConfig, resolveFieldPort } from "./runtime-config.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "field-runtime-config-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("FIELD_CONFIG_JSON supplies the config and wins over the config file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ authToken: "from-file" }));
    const { config, source } = loadFieldConfig({
      env: { FIELD_CONFIG_JSON: JSON.stringify({ authToken: "from-env", mail: { gmailUser: "a@example.com" } }), FIELD_CONFIG: path },
      defaultPath: path,
    });
    assert.deepEqual(config, { authToken: "from-env", mail: { gmailUser: "a@example.com" } });
    assert.equal(source, "FIELD_CONFIG_JSON");
  });
});

test("invalid FIELD_CONFIG_JSON fails fast without echoing the value", () => {
  const secretish = '{"authToken": "do-not-log-this-value",';
  assert.throws(
    () => loadFieldConfig({ env: { FIELD_CONFIG_JSON: secretish } }),
    (err) => {
      assert.match(err.message, /FIELD_CONFIG_JSON is set but is not valid JSON/);
      assert.ok(!err.message.includes("do-not-log-this-value"));
      return true;
    }
  );
});

test("FIELD_CONFIG_JSON must be an object", () => {
  for (const value of ["[]", "null", "42", '"text"']) {
    assert.throws(() => loadFieldConfig({ env: { FIELD_CONFIG_JSON: value } }), /must be a JSON object/);
  }
});

test("without FIELD_CONFIG_JSON the config file is read as before", async () => {
  await withTempDir(async (dir) => {
    const defaultPath = join(dir, "config.json");
    const overridePath = join(dir, "override.json");
    await writeFile(defaultPath, JSON.stringify({ port: 1 }));
    await writeFile(overridePath, JSON.stringify({ port: 2 }));

    assert.deepEqual(loadFieldConfig({ env: {}, defaultPath }), { config: { port: 1 }, source: defaultPath });
    assert.deepEqual(loadFieldConfig({ env: { FIELD_CONFIG_JSON: "  " }, defaultPath }).config, { port: 1 });
    assert.deepEqual(loadFieldConfig({ env: { FIELD_CONFIG: overridePath }, defaultPath }).config, { port: 2 });
    assert.deepEqual(loadFieldConfig({ env: {}, defaultPath: join(dir, "missing.json") }).config, {});
  });
});

test("port resolution prefers FIELD_PORT, then PORT, then config.port, then 19200", () => {
  assert.equal(resolveFieldPort({ env: { FIELD_PORT: "1001", PORT: "1002" }, config: { port: 1003 } }), 1001);
  assert.equal(resolveFieldPort({ env: { PORT: "1002" }, config: { port: 1003 } }), 1002);
  assert.equal(resolveFieldPort({ env: {}, config: { port: 1003 } }), 1003);
  assert.equal(resolveFieldPort({ env: {}, config: {} }), 19200);
});

test("isReplitRuntime reads FIELD_RUNTIME", () => {
  assert.equal(isReplitRuntime({ FIELD_RUNTIME: "replit" }), true);
  assert.equal(isReplitRuntime({ FIELD_RUNTIME: " Replit " }), true);
  assert.equal(isReplitRuntime({}), false);
  assert.equal(isReplitRuntime({ FIELD_RUNTIME: "vps" }), false);
});
