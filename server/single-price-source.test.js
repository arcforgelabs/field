// Guard: the price catalogue is Field's only source of prices and sold units.
// Quote catalogs carry none (a rule declares only the unit its
// quantity is measured in), and the pricing code carries no
// fallback rates, markups or item-code tables that could quietly become a
// second authority.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import JSON5 from "json5";

import { WALL_RATE_CARD_ITEMS } from "./retaining-wall-items.js";

const ROOT = join(import.meta.dirname, "..");
const QUOTE_CATALOGS = join(ROOT, "quote-catalogs");

function serverSources(dir = join(ROOT, "server")) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "fixtures", "test"].includes(entry.name)) continue;
      out.push(...serverSources(path));
    } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js") && !entry.name.startsWith("test-")) {
      out.push(path);
    }
  }
  return out;
}

test("quote catalogs carry no prices and no sold units, only the unit each rule measures in", () => {
  for (const file of readdirSync(QUOTE_CATALOGS).filter((name) => name.endsWith(".json5"))) {
    const catalog = JSON5.parse(readFileSync(join(QUOTE_CATALOGS, file), "utf8"));
    for (const rule of catalog.rules || []) {
      for (const field of ["unitPrice", "unit", "buyPrice", "sellPrice"]) {
        assert.equal(Object.prototype.hasOwnProperty.call(rule, field), false, `${file} rule ${rule.code} has ${field}`);
      }
      assert.equal(typeof rule.quantityUnit, "string", `${file} rule ${rule.code} declares no quantityUnit`);
    }
    for (const assembly of catalog.assemblies || []) {
      for (const component of assembly.components || []) {
        for (const field of ["price", "cost", "sell", "unitPrice", "buyPrice", "sellPrice"]) {
          assert.equal(Object.prototype.hasOwnProperty.call(component, field), false, `${file} assembly ${assembly.code} ${component.key} has ${field}`);
        }
      }
    }
  }
});

test("pricing code has no fallback rates, markups, rate-card cache or item tables", () => {
  const forbidden = [
    [/buildDefaultRateCard|default_rate_card/, "a default rate card"],
    [/DEFAULT_RECIPE|FALLBACK_MARKUP|inferCostFromCharge/, "built-in recipe rates or a fallback markup"],
    [/rate-card\.json/, "the rate-card.json cache"],
    [/INTERNAL_ITEM_META|\bITEM_META\b/, "an item name/unit table"],
    [/\/ 1\.2\b|\* 0\.83\b/, "a hardcoded margin"],
    [/rule\??\.unitPrice/, "a quote-catalog rule price"],
  ];
  const offences = [];
  for (const path of serverSources()) {
    const source = readFileSync(path, "utf8");
    for (const [pattern, what] of forbidden) {
      if (pattern.test(source)) offences.push(`${relative(ROOT, path)}: ${what} (${pattern})`);
    }
  }
  assert.deepEqual(offences, []);
});

test("the pricing engines name no catalogue item codes outside the wall engine's one table", () => {
  // Upper-case catalogue codes such as "LABOURER-HOUR". The wall engine's
  // bill of materials is declared once, in server/retaining-wall-items.js.
  const code = /"[A-Z]{2,}(?:-[A-Z0-9]+)+"/g;
  const allowed = new Set(['"FIELD-ADJUSTMENT"']);
  const offences = [];
  for (const path of serverSources()) {
    if (path.endsWith("retaining-wall-items.js")) continue;
    const source = readFileSync(path, "utf8");
    for (const match of source.match(code) || []) {
      if (!allowed.has(match)) offences.push(`${relative(ROOT, path)}: ${match}`);
    }
  }
  assert.deepEqual(offences, []);
  assert.ok(Object.values(WALL_RATE_CARD_ITEMS).includes("SLEEPER-KENSINGTON"));
});
