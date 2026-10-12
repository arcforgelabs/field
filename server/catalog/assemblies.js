// Assemblies (#148 section 4): a recipe as data. An assembly names typed
// parameters (a lawn's area, a drain's length), variables computed from them
// (labour hours per m2), and components: catalogue items by code, each with a
// quantity expression in the safe expression language (./expression.js) and
// the unit that quantity is in. Prices never live here; each component is
// priced from the catalogue (server/price-catalog/recipe-pricing.js), in its
// own unit, converted only where the catalogue allows.
//
// The definitions ship in the quote catalog (`assemblies` in
// quote-catalogs/<id>.json5), in the shape of the assembly_* tables, with
// worked examples (`tests`) that must pass when the catalog loads.
import { createHash } from "node:crypto";
import { CatalogError } from "./errors.js";
import { evaluateExpression, expressionNames, parseExpression } from "./expression.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMPONENT_ROLES = new Set(["line", "material_order"]);
const QUANTITY_TOLERANCE = 1e-9;

function invalid(code, message) {
  return new CatalogError("INVALID_ASSEMBLY", `assembly ${code || "(unnamed)"}: ${message}`, { path: "assemblies" });
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalNumber(value, label, code) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw invalid(code, `${label} must be a number`);
  return number;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function normalizeParam(raw, code) {
  const name = text(raw?.name);
  if (!NAME.test(name)) throw invalid(code, `param name "${name}" is not a valid name`);
  const type = text(raw?.type) || "number";
  if (type !== "number" && type !== "enum") throw invalid(code, `param ${name} has unsupported type "${type}"`);
  const options = type === "enum" ? (Array.isArray(raw?.options) ? raw.options.map(text).filter(Boolean) : []) : null;
  if (type === "enum") {
    if (!options.length) throw invalid(code, `enum param ${name} needs options`);
    for (const option of options) {
      if (!NAME.test(`${name}_${option}`)) throw invalid(code, `enum option "${option}" of ${name} is not a valid name`);
    }
  }
  const defaultValue = type === "enum"
    ? (raw?.default == null ? null : text(raw.default))
    : optionalNumber(raw?.default, `param ${name} default`, code);
  if (type === "enum" && defaultValue != null && !options.includes(defaultValue)) {
    throw invalid(code, `param ${name} default "${defaultValue}" is not one of its options`);
  }
  return {
    name,
    label: text(raw?.label) || null,
    type,
    unit: text(raw?.unit) || null,
    default: defaultValue,
    min: optionalNumber(raw?.min, `param ${name} min`, code),
    max: optionalNumber(raw?.max, `param ${name} max`, code),
    options,
    required: raw?.required === true,
  };
}

/** The names a param puts in scope: itself, or one 0/1 flag per enum option. */
function scopeNamesOfParam(param) {
  return param.type === "enum" ? param.options.map((option) => `${param.name}_${option}`) : [param.name];
}

/**
 * Validate and normalize one assembly definition. Every expression is parsed
 * and may only read params and earlier vars; unknown names, duplicate names
 * or keys, and components without an item code or unit are refused.
 */
export function normalizeAssemblyDefinition(raw) {
  const code = text(raw?.code);
  if (!code) throw invalid(null, "code is required");
  const mode = text(raw?.mode) || null;
  const params = (Array.isArray(raw?.params) ? raw.params : []).map((param) => normalizeParam(param, code));
  const known = new Set();
  for (const param of params) {
    for (const name of scopeNamesOfParam(param)) {
      if (known.has(name)) throw invalid(code, `name ${name} is declared twice`);
      known.add(name);
    }
  }
  const vars = (Array.isArray(raw?.vars) ? raw.vars : []).map((entry) => {
    const name = text(entry?.name);
    if (!NAME.test(name)) throw invalid(code, `var name "${name}" is not a valid name`);
    if (known.has(name)) throw invalid(code, `name ${name} is declared twice`);
    const expr = typeof entry?.expr === "number" ? String(entry.expr) : text(entry?.expr);
    try {
      parseExpression(expr);
    } catch (error) {
      throw invalid(code, `var ${name}: ${error.message}`);
    }
    for (const used of expressionNames(expr)) {
      if (!known.has(used)) throw invalid(code, `var ${name} reads "${used}", which is not a param or an earlier var`);
    }
    known.add(name);
    return { name, expr };
  });
  const keys = new Set();
  const components = (Array.isArray(raw?.components) ? raw.components : []).map((entry) => {
    const key = text(entry?.key);
    if (!NAME.test(key)) throw invalid(code, `component key "${key}" is not a valid name`);
    if (keys.has(key)) throw invalid(code, `component key ${key} is declared twice`);
    keys.add(key);
    const itemCode = text(entry?.itemCode);
    if (!itemCode) throw invalid(code, `component ${key} needs an itemCode`);
    const unit = text(entry?.unit);
    if (!unit) throw invalid(code, `component ${key} needs the unit its quantity is in`);
    const balance = entry?.balance === true;
    const qty = balance ? null : (typeof entry?.qty === "number" ? String(entry.qty) : text(entry?.qty));
    if (!balance) {
      try {
        parseExpression(qty);
      } catch (error) {
        throw invalid(code, `component ${key}: ${error.message}`);
      }
      for (const used of expressionNames(qty)) {
        if (!known.has(used)) throw invalid(code, `component ${key} reads "${used}", which is not a param or var`);
      }
    }
    const role = text(entry?.role) || "line";
    if (!COMPONENT_ROLES.has(role)) throw invalid(code, `component ${key} has unknown role "${role}"`);
    const itemUid = text(entry?.itemUid);
    return {
      key,
      itemCode,
      ...(itemUid ? { itemUid } : {}),
      label: text(entry?.label) || itemCode,
      unit,
      qty,
      balance,
      role,
      stock: entry?.stock === true,
      omitWhenZero: entry?.omitWhenZero === true,
    };
  });
  if (!components.length) throw invalid(code, "needs at least one component");
  const match = text(raw?.match) || null;
  if (match) {
    try {
      new RegExp(match, "i");
    } catch (error) {
      throw invalid(code, `match is not a valid pattern: ${error.message}`);
    }
  }
  const definition = {
    code,
    mode,
    label: text(raw?.label) || code,
    appliesToRuleCodes: (Array.isArray(raw?.appliesToRuleCodes) ? raw.appliesToRuleCodes : []).map(text).filter(Boolean),
    match,
    params,
    vars,
    components,
  };
  const tests = (Array.isArray(raw?.tests) ? raw.tests : []).map((entry, index) => ({
    name: text(entry?.name) || `example ${index + 1}`,
    params: { ...(entry?.params || {}) },
    expected: { ...(entry?.expected || {}) },
  }));
  return deepFreeze({ ...definition, version: assemblyVersion(definition), tests });
}

/**
 * A short content hash of everything that decides an assembly's quantities
 * (params, vars, components; not its worked examples). Quote lines record it
 * as `assemblyVersion`, so a change to a recipe is visible as a change.
 */
export function assemblyVersion(definition) {
  const { code, mode, params, vars } = definition;
  // A component's itemUid names the same item as its itemCode (codes are
  // permanent aliases): declaring it does not make a different recipe.
  const components = (definition.components || []).map(({ itemUid, ...component }) => component);
  const digest = createHash("sha256")
    .update(JSON.stringify(stable({ code, mode, params, vars, components })))
    .digest("hex");
  return `asm-${digest.slice(0, 16)}`;
}

function resolveParams(definition, input = {}) {
  const scope = {};
  const values = {};
  for (const param of definition.params) {
    const supplied = Object.prototype.hasOwnProperty.call(input, param.name) ? input[param.name] : undefined;
    let value = supplied === undefined || supplied === null || supplied === "" ? param.default : supplied;
    if (value === null || value === undefined) {
      if (param.required || param.type === "enum") {
        throw invalid(definition.code, `needs a value for ${param.label || param.name}`);
      }
      value = 0;
    }
    if (param.type === "enum") {
      const option = text(String(value));
      if (!param.options.includes(option)) {
        throw invalid(definition.code, `${param.name} must be one of ${param.options.join(", ")} (got "${option}")`);
      }
      values[param.name] = option;
      for (const each of param.options) scope[`${param.name}_${each}`] = each === option ? 1 : 0;
      continue;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw invalid(definition.code, `${param.name} must be a number`);
    if (param.min != null && number < param.min) throw invalid(definition.code, `${param.name} must be at least ${param.min}`);
    if (param.max != null && number > param.max) throw invalid(definition.code, `${param.name} must be at most ${param.max}`);
    values[param.name] = number;
    scope[param.name] = number;
  }
  return { scope, values };
}

/**
 * Evaluate an assembly for one set of params. Returns the resolved params,
 * every var, and each component's quantity in its own unit (null for a
 * balance component, whose quantity the engine derives from the remaining
 * charge). Components marked omitWhenZero with a zero quantity are left out.
 */
export function evaluateAssembly(definition, params = {}) {
  const { scope, values } = resolveParams(definition, params);
  const vars = {};
  for (const entry of definition.vars) {
    const value = evaluateExpression(entry.expr, scope);
    scope[entry.name] = value;
    vars[entry.name] = value;
  }
  const components = [];
  for (const component of definition.components) {
    const quantity = component.balance ? null : evaluateExpression(component.qty, scope);
    if (!component.balance && component.omitWhenZero && Math.abs(quantity) < QUANTITY_TOLERANCE) continue;
    if (quantity != null && quantity < 0) {
      throw invalid(definition.code, `component ${component.key} has a negative quantity (${quantity})`);
    }
    components.push({
      key: component.key,
      itemCode: component.itemCode,
      ...(component.itemUid ? { itemUid: component.itemUid } : {}),
      label: component.label,
      unit: component.unit,
      role: component.role,
      stock: component.stock,
      balance: component.balance,
      quantity,
    });
  }
  return {
    code: definition.code,
    version: definition.version,
    params: values,
    vars,
    components,
    byKey: Object.fromEntries(components.map((component) => [component.key, component])),
  };
}

/**
 * Run an assembly's worked examples. Each expects component quantities by
 * key (an omitted component expects 0 or absence); quantities compare to 4
 * decimal places, the precision quote lines carry.
 */
export function runAssemblyTests(definition) {
  return definition.tests.map((example) => {
    const failures = [];
    let result = null;
    try {
      result = evaluateAssembly(definition, example.params);
    } catch (error) {
      return { name: example.name, ok: false, failures: [error.message] };
    }
    for (const [key, expected] of Object.entries(example.expected)) {
      const actual = result.byKey[key]?.quantity ?? 0;
      if (Math.round(Number(actual) * 10000) !== Math.round(Number(expected) * 10000)) {
        failures.push(`${key}: expected ${expected}, got ${actual}`);
      }
    }
    return { name: example.name, ok: failures.length === 0, failures };
  });
}

/** Normalize a quote catalog's assemblies and fail on any failing example. */
export function loadAssemblies(rawAssemblies, { source = "quote catalog" } = {}) {
  const list = Array.isArray(rawAssemblies) ? rawAssemblies : [];
  const byCode = new Map();
  for (const raw of list) {
    const definition = normalizeAssemblyDefinition(raw);
    if (byCode.has(definition.code)) throw invalid(definition.code, `is declared twice in ${source}`);
    const failed = runAssemblyTests(definition).filter((result) => !result.ok);
    if (failed.length) {
      throw invalid(definition.code, `worked example(s) failed in ${source}: ${failed.map((f) => `${f.name} (${f.failures.join("; ")})`).join(", ")}`);
    }
    byCode.set(definition.code, definition);
  }
  return [...byCode.values()];
}
