// Price-book checks added to the catalogue health report: prices nobody has
// touched for a long time, price changes scheduled for later, and supplier
// imports staged but neither applied nor discarded. Like the rest of the
// report they only describe the data; nothing here changes it.
import { sql } from "drizzle-orm";
import { selectRows, toIso } from "./state.js";

export const STALE_PRICE_DAYS = 365;

function check(key, label, severity, count) {
  return { key, label, severity, count, ok: count === 0 };
}

/** { checks, issues, summary } to merge into buildCatalogHealthReport's output. */
export async function priceBookHealth(db, state, { staleDays = STALE_PRICE_DAYS, now: at = state.now } = {}) {
  const nowIso = toIso(at);
  const now = Date.parse(nowIso);
  const cutoff = now - staleDays * 24 * 60 * 60 * 1000;
  const stale = [];
  for (const item of state.items.values()) {
    if (item.status !== "active" || item.costMode === "rollup") continue;
    const price = state.prices.get(item.uid);
    if (!price?.effectiveFrom) continue;
    if (Date.parse(price.effectiveFrom) < cutoff) stale.push({ item, price });
  }
  stale.sort((a, b) => Date.parse(a.price.effectiveFrom) - Date.parse(b.price.effectiveFrom));
  const scheduled = await selectRows(db, sql`
    select distinct on (item_uid) item_uid, id, effective_from, source, source_ref
    from item_prices where effective_from > ${nowIso}::timestamptz
    order by item_uid, effective_from, id`);
  const staged = await selectRows(db, sql`
    select i.uid, i.file_name, i.created_at, i.created_by, i.summary, s.name as supplier_name
    from price_imports i left join suppliers s on s.id = i.supplier_id
    where i.status = 'staged' order by i.created_at`);

  const issues = [
    ...stale.map(({ item, price }) => ({
      key: "stale_price",
      severity: "info",
      label: "Stale Price",
      code: item.code,
      uid: item.uid,
      name: item.name,
      status: item.status,
      priceEffectiveFrom: price.effectiveFrom,
      message: `Price unchanged since ${price.effectiveFrom.slice(0, 10)} (over ${staleDays} days).`,
    })),
    ...scheduled.map((row) => {
      const item = state.items.get(row.item_uid);
      return {
        key: "scheduled_price_change",
        severity: "info",
        label: "Scheduled Price Change",
        code: item?.code ?? null,
        uid: row.item_uid,
        name: item?.name ?? null,
        status: item?.status ?? null,
        priceEffectiveFrom: toIso(row.effective_from),
        message: `A ${row.source} price takes effect ${toIso(row.effective_from)}${row.source_ref ? ` (${row.source_ref})` : ""}; manual price edits wait until then.`,
      };
    }),
    ...staged.map((row) => ({
      key: "staged_import",
      severity: "info",
      label: "Staged Supplier Import",
      code: null,
      uid: null,
      name: row.file_name || row.uid,
      status: "staged",
      importUid: row.uid,
      message: `${row.supplier_name || "Supplier"} price list staged ${toIso(row.created_at)?.slice(0, 10)} by ${row.created_by}; apply or discard it.`,
    })),
  ];
  return {
    checks: [
      check("stale_price", "Stale Prices", "info", stale.length),
      check("scheduled_price_change", "Scheduled Price Changes", "info", scheduled.length),
      check("staged_import", "Staged Supplier Imports", "info", staged.length),
    ],
    issues,
    summary: {
      stalePriceCount: stale.length,
      scheduledPriceChangeCount: scheduled.length,
      stagedImportCount: staged.length,
      stalePriceDays: staleDays,
    },
  };
}

/** The catalogue health report with the price-book checks appended. */
export async function withPriceBookHealth(store, report) {
  const extra = await priceBookHealth(store.db, await store.getState(), { now: report.generatedAt });
  return {
    ...report,
    summary: { ...report.summary, ...extra.summary },
    checks: [...report.checks, ...extra.checks],
    issues: [...report.issues, ...extra.issues],
  };
}
