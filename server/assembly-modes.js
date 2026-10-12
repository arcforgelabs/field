// The quote engine's assembly modes: which params, vars and component keys
// each recipe builder in server/quote-quantity-rules.js reads from its
// assembly (server/catalog/assemblies.js). The quantities, item codes and
// operational constants are data; the builder supplies the parameters it
// parses from a line (area, length, controller option, stated pit count),
// the line descriptions, and the delivery balance. A quote catalog whose
// assembly does not provide what its mode reads is refused at load.
export const ASSEMBLY_MODE_CONTRACTS = Object.freeze({
  lawn_bundle: Object.freeze({
    params: ["area_m2", "loam_depth_m"],
    vars: ["install_hours_per_m2", "reprep_hours_per_m2", "loam_allowance", "loam_base_m3"],
    components: ["turf", "install_labour", "reprep_labour", "delivery", "admin", "loam"],
    balance: ["delivery"],
  }),
  irrigation_bundle: Object.freeze({
    params: ["area_m2", "controller"],
    vars: ["conduit_hours", "pipe_install_hours_per_m2"],
    components: ["battery_controller", "mains_controller", "pipe_fixings", "conduit_labour", "pipe_labour", "wiring_labour", "delivery", "admin"],
    balance: ["delivery"],
    enums: Object.freeze({ controller: ["battery", "mains", "mains_no_install"] }),
  }),
  drainage_bundle: Object.freeze({
    params: ["length_m", "explicit_pits", "stated_pit_count"],
    vars: ["pit_spacing_m", "excavator_hours_per_m", "labour_hours_per_m"],
    components: ["pipe", "pit", "gravel", "disposal", "excavator", "labour", "delivery", "admin"],
    balance: ["delivery"],
  }),
});

/** Throw when an assembly cannot serve the engine mode it names. */
export function assertAssemblyModeContract(definition) {
  if (!definition?.mode) return;
  const contract = ASSEMBLY_MODE_CONTRACTS[definition.mode];
  if (!contract) {
    throw new Error(`assembly ${definition.code}: unknown mode "${definition.mode}" (known: ${Object.keys(ASSEMBLY_MODE_CONTRACTS).join(", ")})`);
  }
  const params = new Map(definition.params.map((param) => [param.name, param]));
  const vars = new Set(definition.vars.map((entry) => entry.name));
  const components = new Map(definition.components.map((component) => [component.key, component]));
  const missing = [
    ...contract.params.filter((name) => !params.has(name)).map((name) => `param ${name}`),
    ...contract.vars.filter((name) => !vars.has(name)).map((name) => `var ${name}`),
    ...contract.components.filter((key) => !components.has(key)).map((key) => `component ${key}`),
  ];
  for (const key of contract.balance || []) {
    if (components.has(key) && !components.get(key).balance) missing.push(`component ${key} as a balance`);
  }
  for (const [name, options] of Object.entries(contract.enums || {})) {
    const param = params.get(name);
    if (param && (param.type !== "enum" || options.some((option) => !param.options.includes(option)))) {
      missing.push(`enum param ${name} with options ${options.join(", ")}`);
    }
  }
  if (missing.length) {
    throw new Error(`assembly ${definition.code} (mode ${definition.mode}) must define ${missing.join(", ")}`);
  }
}
