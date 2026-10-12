const REMOVED_INTEGRATION_CONFIG_KEYS = new Map([
  ["erpnext", "ERPNext"],
  ["twenty", "Twenty CRM"],
  ["twentyCrm", "Twenty CRM"],
  ["twentyCRM", "Twenty CRM"],
  ["20crm", "Twenty CRM"],
]);

export function findRemovedIntegrationConfigKeys(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [];
  }

  return [...REMOVED_INTEGRATION_CONFIG_KEYS.keys()].filter((key) =>
    Object.prototype.hasOwnProperty.call(config, key)
  );
}

export function assertNoRemovedIntegrationConfig(config, source = "Field config") {
  const keys = findRemovedIntegrationConfigKeys(config);
  if (keys.length === 0) {
    return;
  }

  const labels = [...new Set(keys.map((key) => REMOVED_INTEGRATION_CONFIG_KEYS.get(key)))];
  const err = new Error(
    `${source} contains removed integration config: ${keys.join(", ")}. ` +
      `${labels.join(" and ")} are no longer Field runtime dependencies; remove these blocks before starting Field.`
  );
  err.code = "FIELD_REMOVED_INTEGRATION_CONFIG";
  err.keys = keys;
  throw err;
}
