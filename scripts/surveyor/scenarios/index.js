import { serverBootSmoke } from "./server-boot-smoke.js";

/**
 * Scenario registry.
 *
 * Keep every field of a scenario declaration explicit: a
 * scenario that does not say what its oracle is cannot produce trustworthy proof.
 */

export const REQUIRED_SCENARIO_FIELDS = [
  "id",
  "title",
  "transport",
  "requiredCredentials",
  "baselineExpectation",
  "candidateExpectation",
  "timeoutMs",
  "run",
];

export function validateScenario(scenario) {
  const missing = REQUIRED_SCENARIO_FIELDS.filter((field) => scenario?.[field] === undefined);
  if (missing.length) {
    throw new Error(`scenario ${scenario?.id ?? "<unknown>"} is missing: ${missing.join(", ")}`);
  }
  if (typeof scenario.run !== "function") throw new Error(`scenario ${scenario.id}.run must be a function`);
  return scenario;
}

const SCENARIOS = [serverBootSmoke].map(validateScenario);

export function listScenarios() {
  return SCENARIOS.map(({ id, title, transport }) => ({ id, title, transport }));
}

export function getScenario(id) {
  const scenario = SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`unknown scenario: ${id} (known: ${SCENARIOS.map((s) => s.id).join(", ")})`);
  }
  return scenario;
}
