import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoRemovedIntegrationConfig,
  findRemovedIntegrationConfigKeys,
} from "./config-guard.js";

test("findRemovedIntegrationConfigKeys returns removed integration blocks", () => {
  assert.deepEqual(
    findRemovedIntegrationConfigKeys({
      port: 19200,
      erpnext: { url: "https://example.invalid" },
      twenty: { url: "https://example.invalid" },
      twentyCrm: { url: "https://example.invalid" },
    }),
    ["erpnext", "twenty", "twentyCrm"]
  );
});

test("assertNoRemovedIntegrationConfig allows current Field config", () => {
  assert.doesNotThrow(() => {
    assertNoRemovedIntegrationConfig({
      port: 19200,
      dataDir: "/opt/apps/field/data",
      deploymentTheme: "gohub",
    });
  });
});

test("assertNoRemovedIntegrationConfig rejects stale external integration config", () => {
  assert.throws(
    () => assertNoRemovedIntegrationConfig({ erpnext: {}, "20crm": {} }, "config.json"),
    (err) => {
      assert.equal(err.code, "FIELD_REMOVED_INTEGRATION_CONFIG");
      assert.deepEqual(err.keys, ["erpnext", "20crm"]);
      assert.match(err.message, /config\.json contains removed integration config: erpnext, 20crm/i);
      return true;
    }
  );
});
