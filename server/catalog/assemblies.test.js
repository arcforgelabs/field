import assert from "node:assert/strict";
import test from "node:test";

import { assertAssemblyModeContract } from "../assembly-modes.js";
import { getQuoteCatalog } from "../quote-catalogs.js";
import { evaluateAssembly, loadAssemblies, normalizeAssemblyDefinition, runAssemblyTests } from "./assemblies.js";

const invalid = (pattern) => (error) => error.code === "INVALID_ASSEMBLY" && pattern.test(error.message);

const base = {
  code: "test-kit",
  params: [
    { name: "area_m2", required: true, min: 0 },
    { name: "option", type: "enum", options: ["a", "b"], default: "a" },
  ],
  vars: [{ name: "hours_per_m2", expr: "3 / 60" }],
  components: [
    { key: "turf", itemCode: "TURF", unit: "m2", qty: "area_m2" },
    { key: "labour", itemCode: "LABOUR", unit: "hour", qty: "area_m2 * hours_per_m2" },
    { key: "only_b", itemCode: "B-ITEM", unit: "each", qty: "option_b", omitWhenZero: true },
    { key: "delivery", itemCode: "VEHICLE", unit: "hour", balance: true },
  ],
};

test("an assembly evaluates params, vars and component quantities in each component's unit", () => {
  const definition = normalizeAssemblyDefinition(base);
  const a = evaluateAssembly(definition, { area_m2: 80 });
  assert.equal(a.params.option, "a");
  assert.equal(a.vars.hours_per_m2, 0.05);
  assert.deepEqual(a.components.map((c) => [c.key, c.itemCode, c.unit, c.quantity]), [
    ["turf", "TURF", "m2", 80],
    ["labour", "LABOUR", "hour", 4],
    ["delivery", "VEHICLE", "hour", null],
  ]);
  const b = evaluateAssembly(definition, { area_m2: 10, option: "b" });
  assert.equal(b.byKey.only_b.quantity, 1);
  assert.throws(() => evaluateAssembly(definition, {}), invalid(/needs a value for area_m2/));
  assert.throws(() => evaluateAssembly(definition, { area_m2: -1 }), invalid(/at least 0/));
  assert.throws(() => evaluateAssembly(definition, { area_m2: 1, option: "c" }), invalid(/one of a, b/));
});

test("definitions are validated: names, references, keys, items and units", () => {
  const broken = (patch) => () => normalizeAssemblyDefinition({ ...base, ...patch });
  assert.throws(broken({ code: "" }), invalid(/code is required/));
  assert.throws(broken({ vars: [{ name: "x", expr: "missing * 2" }] }), invalid(/reads "missing", which is not a param or an earlier var/));
  assert.throws(broken({ vars: [{ name: "x", expr: "y" }, { name: "y", expr: "1" }] }), invalid(/reads "y"/));
  assert.throws(broken({ vars: [{ name: "x", expr: "eval('1')" }] }), invalid(/unexpected character/));
  assert.throws(broken({ components: [{ key: "a", itemCode: "A", unit: "m", qty: "1" }, { key: "a", itemCode: "B", unit: "m", qty: "1" }] }), invalid(/declared twice/));
  assert.throws(broken({ components: [{ key: "a", unit: "m", qty: "1" }] }), invalid(/needs an itemCode/));
  assert.throws(broken({ components: [{ key: "a", itemCode: "A", qty: "1" }] }), invalid(/needs the unit/));
  assert.throws(broken({ components: [{ key: "a", itemCode: "A", unit: "m", qty: "nope" }] }), invalid(/reads "nope"/));
  assert.throws(broken({ components: [] }), invalid(/at least one component/));
  assert.throws(broken({ match: "(" }), invalid(/match is not a valid pattern/));
});

test("the version is a content hash of what decides quantities, not of the worked examples", () => {
  const one = normalizeAssemblyDefinition(base);
  const same = normalizeAssemblyDefinition({ ...base, tests: [{ name: "x", params: { area_m2: 1 }, expected: { turf: 1 } }] });
  const changed = normalizeAssemblyDefinition({ ...base, vars: [{ name: "hours_per_m2", expr: "4 / 60" }] });
  assert.match(one.version, /^asm-[0-9a-f]{16}$/);
  assert.equal(one.version, same.version);
  assert.notEqual(one.version, changed.version);
});

test("worked examples run when a quote catalog loads, and a failing one refuses the catalog", () => {
  const definition = normalizeAssemblyDefinition({
    ...base,
    tests: [
      { name: "ok", params: { area_m2: 80 }, expected: { turf: 80, labour: 4, only_b: 0 } },
      { name: "wrong", params: { area_m2: 80 }, expected: { labour: 5 } },
    ],
  });
  assert.deepEqual(runAssemblyTests(definition).map((result) => [result.name, result.ok]), [["ok", true], ["wrong", false]]);
  assert.throws(
    () => loadAssemblies([{ ...base, tests: [{ name: "wrong", params: { area_m2: 80 }, expected: { labour: 5 } }] }]),
    invalid(/worked example\(s\) failed .*labour: expected 5, got 4/),
  );
  assert.throws(() => loadAssemblies([base, base]), invalid(/declared twice/));
});

test("an assembly must provide what its engine mode reads", () => {
  assert.throws(() => assertAssemblyModeContract(normalizeAssemblyDefinition({ ...base, mode: "drainage_bundle" })), /must define param length_m/);
  assert.throws(() => assertAssemblyModeContract(normalizeAssemblyDefinition({ ...base, mode: "nope" })), /unknown mode/);
  assert.doesNotThrow(() => assertAssemblyModeContract(normalizeAssemblyDefinition(base)));
});

test("the embark-default recipes are assemblies whose worked examples pass", () => {
  const catalog = getQuoteCatalog("embark-default");
  assert.deepEqual(catalog.assemblies.map((assembly) => [assembly.code, assembly.mode]), [
    ["lawn-bundle", "lawn_bundle"],
    ["irrigation-bundle", "irrigation_bundle"],
    ["drainage-bundle", "drainage_bundle"],
  ]);
  for (const assembly of catalog.assemblies) {
    assert.ok(assembly.tests.length > 0, `${assembly.code} has worked examples`);
    assert.ok(runAssemblyTests(assembly).every((result) => result.ok), assembly.code);
  }
});
