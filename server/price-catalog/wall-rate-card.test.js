import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RETAINING_WALL_REQUIRED_PRICE_CODES, resolveWallRateCard } from "./wall-rate-card.js";

test("wall rate-card resolution has no cached or default card without the live catalogue", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-wall-rate-card-"));
  // A rate-card.json left behind by an older Field is never read.
  await writeFile(join(dataDir, "rate-card.json"), JSON.stringify({ _source: "cached", labour: { general_labourer: { charge_hr: 1 } } }));

  try {
    const result = await resolveWallRateCard({ priceCatalog: null });
    assert.equal(result.rateCard, null);
    assert.equal(result.source, "unavailable");
    assert.match(result.error, /catalog database is unavailable/i);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an unreachable live catalogue returns an unavailable source instead of a cache", async () => {
  const result = await resolveWallRateCard({
    priceCatalog: {
      async getState() {
        throw new Error("connect ECONNREFUSED");
      },
    },
  });

  assert.equal(result.rateCard, null);
  assert.equal(result.source, "unavailable");
  assert.match(result.error, /ECONNREFUSED/i);
});

test("partial live catalogue cannot produce a wall rate card, and the error names the missing items", async () => {
  const buyMap = { "LABOURER-HOUR": 50 };
  const sellMap = { "LABOURER-HOUR": 80 };
  const result = await resolveWallRateCard({
    priceCatalog: {},
    pricingSnapshot: {
      source: "price_catalog",
      fetchedAt: "2026-08-13T00:00:00.000Z",
      buyMap,
      sellMap,
    },
  });

  assert.equal(result.rateCard, null);
  assert.equal(result.source, "unavailable");
  assert.match(result.error, /incomplete|required item/i);
  assert.match(result.error, /SLEEPER-KENSINGTON is not an active item in the price catalogue/);
  assert.doesNotMatch(result.error, /LABOURER-HOUR/);
});

test("a complete live catalogue yields the rate card and writes no rate-card.json", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "field-wall-rate-card-"));
  const buyMap = Object.fromEntries(RETAINING_WALL_REQUIRED_PRICE_CODES.map((code) => [code, 10]));
  const sellMap = Object.fromEntries(RETAINING_WALL_REQUIRED_PRICE_CODES.map((code) => [code, 20]));
  try {
    const result = await resolveWallRateCard({
      priceCatalog: {},
      pricingSnapshot: {
        source: "price_catalog",
        fetchedAt: "2026-08-13T00:00:00.000Z",
        buyMap,
        sellMap,
      },
    });

    assert.equal(result.source, "price_catalog");
    assert.equal(result.rateCard?._source, "price_catalog");
    assert.equal(result.rateCard.labour.general_labourer.charge_hr, 20);
    // An item the card reads but the catalogue lacks is null, never a default.
    assert.equal(result.rateCard.machines.jackhammer.cost_hr, null);
    assert.equal(result.rateCard.vehicle.cost_km, null);
    assert.equal(existsSync(join(dataDir, "rate-card.json")), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
