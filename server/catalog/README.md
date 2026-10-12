# Price catalogue (`server/catalog/`)

Field's price catalogue lives in PostgreSQL, in the tables of
`server/db/src/schema.ts` (migration `server/db/drizzle/0003_price_catalogue.sql`).
The SQLite `data/price-catalog/catalog.db` is no longer read at runtime; it is
an import source only (`legacy-import.js`).

| Module | What it does |
| --- | --- |
| `index.js` | Entry point. `openCatalogStore()` is the server's store on `getDb()`. |
| `store.js` | `createCatalogStore({ db })`: every read and write. |
| `state.js` | `loadCatalogState(db)`: one consistent, immutable snapshot of the whole catalogue. |
| `rollup.js` | The one kit roll-up (`effectivePrices`), `currentPrice`, `priceKey`, `kitSnapshot`. |
| `price.js` | `price(state, item)`, the design's one price function over the roll-up; `capturePrices` and `comparePrices`, the price-equality gate. |
| `units.js` | Typed units and conversions; `UNIT_MISMATCH` when there is no conversion. |
| `views.js` | The API row shapes (the SQLite catalogue's field names plus the new ones). |
| `health.js` | The health report: data problems, reported, never fixed. |
| `legacy-import.js` | `importLegacyCatalog(db, path, { dryRun, replace })`, verified, one transaction. |
| `export.js` | `exportCatalog(db)`: every catalogue table as one JSON document. |
| `reference-data.js` | Units, unit aliases, tax codes and the version row (idempotent). |
| `expression.js` | The safe quantity-expression language: numbers, names, `+ - * /`, parentheses, `ceil/floor/round/min/max`. Hand-parsed; no `eval`/`Function`. |
| `assemblies.js` | Assembly (recipe) definitions: `normalizeAssemblyDefinition`, `evaluateAssembly`, `assemblyVersion`, `runAssemblyTests`, `loadAssemblies`. |
| `price-book.js` | The price-book grid (`listPriceBook`), bulk edits (`previewBulk`/`applyBulk`), suppliers and item ↔ supplier links. |
| `price-import.js` | Supplier price-list imports: `inspectPriceList`, `stageImport`, `applyImport`, `discardImport`. |
| `csv.js` | The CSV reader, money parsing and column-map guessing/validation for imports. |
| `price-book-health.js` | Health checks for stale prices, scheduled price changes and staged imports. |
| `price-book-http.js` | The price book's HTTP routes (grid, bulk edits, suppliers, imports), mounted under `/api/price-catalog`. The other catalogue routes are in `server/price-catalog/catalog-api.js`. |
| `refs.js` | `resolveItemRef`: an item named by uid, else by legacy code. |
| `item-codes.js` | `omitItemCodes` and the `Prefer: field-item-codes=omit` handling. |
| `usage.js` | "Used on N quotes": which quotes use each item. |

Pricing projections over a snapshot (price maps, the quote-catalog overlay,
the quote pricing snapshot, recipe pricing, the wall rate card) stay in
`server/price-catalog/` and take a snapshot, not a database handle.

## The only source of prices and units

Every price Field quotes, and the unit each item is sold in, comes from this
catalogue. Quote catalogs (`quote-catalogs/*.json5`) carry no prices and no
sold units: a rule names the item it prices from, and the overlay
(`price-catalog/catalog-pricing.js`) sets its rate from that item; a rule that
still carries `unitPrice`, `unit`, `buyPrice` or `sellPrice` is refused at
load. What a rule does declare is structure: `quantityUnit`, the unit its
quantity is measured in (an area rule in m2, a volume rule in m3), checked
against its `quantitySource` at load. Lines keep that unit; the item's price is
converted to it through the catalogue's conversions (min to hour, an item's
own conversion). When the catalogue has none (an item sold per m behind an
area rule), the rule has no rate and its lines are refused naming the item;
they are never relabelled into the item's unit, which would silently change
the quantity. There is no fallback rate, markup, default rate card or
`rate-card.json` cache anywhere in the server
(`server/single-price-source.test.js` guards it). A rule, recipe or wall line
whose item is missing, archived, unpriced or sold in a unit that cannot
convert fails closed with the item named, and `health()` lists it
(`missing_referenced_item`, `archived_item_in_use`, `recipe_unit_mismatch`,
`rule_unit_mismatch`).

## Items named by uid (code retirement step 4)

Pricing configuration names catalogue items by uid, with the legacy code
beside it as the fallback (`refs.js` `resolveItemRef`: uid first, then the
code through the aliases):

- quote rules carry `authorityItemUid` (the item the rule prices from),
  recipe and quantity-rule components `itemUid`, and quantity rules
  `outputItemUid`, all for the sample catalogue's items in
  `quote-catalogs/embark-default.json5`;
- the wall rate card declares `WALL_RATE_CARD_ITEM_UIDS` beside its codes
  (`server/retaining-wall-items.js`);
- recipes are keyed by their kit's uid as well as its code
  (`catalog-recipes.js` `recipeUidKey`), and a recipe child carries its
  component's uid.

The rules engine and wall engine (removed in phase 4) still keep their
internal price maps keyed by each item's code: codes never change, so this
is the same item. The authority snapshot's digest and a recipe's version
leave the uid keys out, so declaring them changed neither. An installation
whose catalogue lacks those uids (the synthetic verification catalogue)
resolves by code. Health reports `reference_by_code` (an item named only by
its code anywhere in the configuration: 0 on the sample catalogue) and
`reference_uid_code_conflict` (a reference whose uid and code name
different items). Quote rows resolve by `catalogItemUid`, then `sourceUid`,
then the code (`server/quote-files.js` `rowItem`; the catalogue sync's
`resolveLinkedItem` and kit member matching were already uid first). The
pricing attestation's lineage keys on quote line codes (rule line ids such
as `retaining-wall__section-wall`, manual row ids), never on item codes, so
it is unaffected by codes retiring.

## Assemblies (recipes as data)

The lawn, irrigation and drainage recipes are assemblies in the quote catalog
(`assemblies` in `quote-catalogs/embark-default.json5`), in the shape of the
dropped `assembly_*` tables: typed `params` (a lawn's area, a controller option),
`vars` computed from them (install hours per m2), and `components`: an item
by code, the unit its quantity is in, and a quantity expression. A `balance`
component takes the charge left over on the quoted line (the delivery
allowance), computed by the engine. `tests` are worked examples, run when
the catalog loads; a failing one refuses the catalog. Each assembly's
`version` (`asm-<16 hex>`) is a content hash of its params, vars and
components, so quote lines can record which recipe produced them.

`price-catalog/recipe-pricing.js` prices every component from one catalogue
snapshot (`snapshot.recipePricing`): the item's effective price (the one
roll-up) converted from the item's unit to the component's unit where the
catalogue allows (min ↔ hour, mm ↔ m, an item's own conversion), else a
problem (`missing_item`, `inactive_item`, `unpriced_item`, `unit_mismatch`,
`unknown_unit`) naming the item. A recipe line with a problem is not priced;
its pricing issue carries the message. Golden fixtures
(`fixtures/assembly-golden.json`, captured from the hardcoded recipes, before
they became assembly data, by `fixtures/assembly-golden.capture.mjs`) prove the assemblies give
the same quantities, and at the same rates the same prices.

The engine modes that read assemblies (`lawn_bundle`, `irrigation_bundle`,
`drainage_bundle`) and the params, vars and keys each reads are in
`server/assembly-modes.js`. The retaining-wall engine stays code: it walks a
bay model per bay, picks stocked steel per post and derives delivery trips,
which the expression language cannot express, so no assembly could be shown
identical. Its items are declared once (`server/retaining-wall-items.js`) and
its rate card (`server/retaining-wall-rate-card.js`) reads only catalogue
prices.

## Model

- **Identity is `items.uid`.** Every link keys on it: kit components, prices,
  conversions, suppliers, evidence, history and (for the quote work) quote
  lines. A code is only a legacy alias: the rules engine, json5 recipes,
  scripts and older quote rows still name items by code, so every code an
  item has had is a row in `item_code_aliases` (org, code, item uid), unique
  per organisation case-insensitively (code retirement step 2, migration 0006).
  `findItem` resolves an identity by uid, then by alias. A code never changes:
  a `code` edit is refused with `CODE_READ_ONLY` (repeating the current code
  is accepted), and the database refuses one too (`items_code_immutable`).
  A new item's code is recorded as an alias by the `items_code_alias_insert`
  trigger; one created or duplicated without a code gets its uid as its code
  (`cat_…`). The price book never shows or asks for a code. Renaming an item
  never changes its uid or code. `variant_of_uid` links a variant to its
  original instead of a `-copy` code. Health reports an item whose own code
  has no alias row (`code_alias_missing`).
- **Prices are append-only `item_prices` rows** (`cost_per_unit`, `markup_pct`,
  `sell_price`, `effective_from`, `source`, `changed_by`, `reason`). The current
  price is the latest row with `effective_from <= now` (ties: highest id); its
  id is the `priceId`. Rows are never updated or deleted by the app. A price
  edit appends a row with the unchanged side carried over. A manual edit may be
  back-dated (`effective_from` in the past, not before the current row) but
  not future-dated: that is refused with `FUTURE_PRICE_UNSUPPORTED` (400),
  because a scheduled row copies every price field as it stands when written
  and would silently undo any edit made before its date. Scheduled prices
  come from a future-dated supplier import, which defines what a pending row
  carries (see "Price book and supplier imports"). A scheduled row blocks a
  price edit to that item with `PENDING_PRICE_CHANGE` (409) and becomes
  current on its date; the catalogue ETag moves when it does.
- **Price modes.** `cost_mode` is `manual` (the row's cost) or `rollup`.
  `sell_mode` is `fixed` (the row's sell), `markup` (cost × (1 + markup_pct/100))
  or `rollup`. The legacy API fields map onto them: `buy_price_mode` /
  `sell_price_mode` `computed` is `rollup`, `manual` is `manual` / `fixed`.
  `rollup` is an addition to the catalogue design's `markup|fixed`: the SQLite catalogue's
  computed kits (99 of 182 production items) need it to carry over as-is.
- **One roll-up.** `rollup.js effectivePrices(state)` prices every item; every
  reader uses it. A kit's components are its `kit_components` rows (summed in
  insertion order), else a quote-catalog recipe for its code. A component that
  is missing, archived or unpriced, or whose quantity cannot be resolved, makes
  the kit unpriced (`null`), never zero. A `listed_only` component is shown,
  not summed. A child contributes its own effective price, whatever its mode.
- **Units are typed.** `units(code, dimension, to_base)` and `unit_aliases` are
  seeded from `shared/catalog-units.js`. Units convert only within a dimension
  when both have a base factor (min ↔ hour, mm ↔ m), or through an item's own
  `item_unit_conversions` row. A disposal item's `pricing_basis` factor is
  such a row: `per_tonne` is 1 m3 = *density* tonne, `per_load` is
  1 load = *capacity* m3. A kit component entered in a unit that cannot
  convert to the child's unit is refused (`UNIT_MISMATCH`). An item's unit is
  stored as its canonical code; when it was entered as an alias (`plant` for
  `each`), `unit_label` keeps the text so documents print what they did.
- **Concurrency.** Every item has a `version`; a write may name the version it
  was based on (`expectedVersion`, or `If-Match` with the item's ETag
  `W/"item-<uid>-v<version>@<catalogue tag>"`, the bare `W/"item-<uid>-v<version>"`
  or the bare version; only the item part is compared) and is refused with
  `VERSION_CONFLICT` (409) when it is stale. The catalogue tag is in the item
  ETag because an item's served prices move without its version moving (a kit
  child's price, a dated price taking effect, a deploy's recipes), so a
  conditional GET answers 304 only when the whole catalogue is unchanged; the
  bare version is also sent as `X-Field-Item-Version`. Category and kit-component writes
  may name the catalogue version instead (`expectedCatalogVersion`); the MCP
  tools pass these, so an edit landing between their re-read and their write
  is refused, not overwritten. Every catalogue write locks the `catalog_meta`
  row, so writes are serialised, and bumps `catalog_meta.version` in the same
  transaction. A write reads the clock only once it holds that lock, so a
  write that queued behind another is dated after it: the other write's price
  is current to it, not scheduled, and its own price lands on top. A write's response is read after its own commit. The catalogue
  ETag is `W/"catalog-<version>-<priceEpoch>"`; over HTTP it also carries the
  build revision (`FIELD_REVISION`, else one id per boot), because item rows
  depend on the recipes a deploy ships.
- **History.** `catalog_history` records field-level changes (the SQLite
  catalogue's field names, plus `code`, `variant_of_uid`, `markup_pct`,
  `sell_mode`, ...), by uid, with the code at the time. It is not a foreign
  key, so it outlives a deleted item.
- **Timestamps** are written from the JavaScript clock, never `now()`, so the
  verification harness's frozen clock freezes catalogue writes too.

The measured-assembly tables (`assembly_params`, `assembly_vars`,
`assembly_components`, `assembly_tests`, `assembly_versions`) were never
written and migration 0007 dropped them; measured formulas are deferred
(`docs/PRICING_ENGINE.md` "`kit_components`"), and the recipes that need them stay in
the quote catalog until phase 4.

- **Type, sold, pricing method** (pricing engine phase 1, migration 0007). `items.type`
  says what an item is: `material`, `labour`, `equipment`, `subcontract`,
  `fee` or `kit` (null until set; never a category). Adding a component makes
  an item a `kit`. Item rows also carry `is_sold` (the quote picker offers it:
  `visibility = sellable`) and `pricing_method` (`fixed`, `markup` or
  `rollup`, from `sell_mode`). `kind`, `catalog_type`, `visibility` and the
  `*_mode` fields stay for older clients.
- **Notes** (`items.notes`, migration 0007) are internal: what estimators
  need to know about an item. They are never printed; `description` is the
  customer-facing wording a quote may show.
- **Kit components** are the `kit_components` table (`kit_uid`,
  `component_uid`; it was `item_components` until 0007). The store and schema
  keep their older names (`itemComponents`, `parentUid`, `childUid`). `suppliers`, `item_suppliers`, `price_imports` and
`price_import_rows` are the price book's (below).

## Store API (`createCatalogStore({ db, clock?, dataDir?, catalogId? })`)

Reads: `getState()`, `listItems(filters)`, `getItem(codeOrUid)`,
`getItemsByUids(uids)`, `getCurrentPrice(codeOrUid)`, `getCurrentPrices(uids)`,
`getKitSnapshot(codeOrUid)`, `listChildren`, `getPriceMaps()`,
`catalogVersion()`, `listCategories()`, `health({ catalogId })`,
`getItemHistory`, `getPriceHistory`, `getCatalogAtPointInTime(iso)`,
`listEvidence`.

Writes (each one transaction): `createItem(input, { author, reason })`,
`updateItem(codeOrUid, patch, { author, reason, expectedVersion, effectiveFrom })`,
`archiveItem`, `deleteItem`, `duplicateItem`, `addChild`, `updateChild`,
`removeChild`, `createCategory`, `updateCategory`, `deleteCategory`,
`attachEvidence`, `removeEvidence`.

Errors are `CatalogError { code, path, message, statusCode }`: `NOT_FOUND`,
`CODE_CONFLICT`, `CODE_READ_ONLY`, `CATEGORY_CONFLICT`, `NAME_CONFLICT` (`CatalogNameConflictError`, with `conflict`),
`VERSION_CONFLICT`, `CYCLE`, `UNIT_MISMATCH`, `UNKNOWN_UNIT`, `UNKNOWN_REF`,
`PRICING_BASIS`, `INVALID`, `INVALID_QUANTITY`, `FUTURE_PRICE_UNSUPPORTED`,
`PENDING_PRICE_CHANGE`.

### For quote lines

- `getCurrentPrice(uid)` →
  `{ itemUid, code, name, unit, unitCode, status, costMode, sellMode, cost, sell, markupPct, priceId, priceRowId, effectiveFrom, priceKey, rolledUp, priced, problems, catalogVersion, etag }`.
  `priceId` is the current `item_prices.id`; it is `null` for a kit priced by
  roll-up (no single row holds its price). `priceKey` changes whenever anything
  behind the price changes (the item's row and modes, and for a kit every
  component's quantity, contribution and key), so comparing a line's stored
  `priceKey`/`priceId` with the current one says whether it changed.
- `getCurrentPrices(uids)` → `{ [uid]: currentPrice | null }`.
- `getItemsByUids(uids)` → item details (missing uids are left out).
- `getKitSnapshot(uid)` → `currentPrice` plus `components: [{ componentId,
  source, quantity, entryQuantity, entryUnit, applicationMode,
  pricingContribution, balance, recipeCode, item: <kitSnapshot of the child> }]`.
- `catalogVersion()` → `{ version, etag, priceEpoch }`.

`server/quote-catalog-sync.js` builds on these: `buildCatalogQuoteLine(state,
codeOrUid)` is the row a quote adds, served uncached at `GET /api/price-catalog/items/:codeOrUid/quote-line`, and
the draft diff and apply compare quote rows with it. A kit is expanded into
component rows (in their entry units) only when it is built from
`kit_components` rows and those rows reproduce the kit's cost and sell to
the cent; a quote prices an expanded kit from its rows. Recipe-derived kits
(including those with a balance "allowance" remainder), kits priced by hand
or markup, and kits with a masterline or missing child go on the quote as one
row at the kit's own price (`componentsWithheld` says why).

An item's detail (`GET /items/:codeOrUid`) also lists `used_in`, the kits that
contain it, from the same snapshot. `POST /categories/reorder { ids }` sets the
category order (the catalogue's filter chips follow it) in one write.

HTTP (`/api/price-catalog`): `GET /version`, `GET /items` (sends `ETag`,
answers `If-None-Match` with 304), `POST /current-prices { uids }`,
`GET /items/:codeOrUid/current-price`, `GET /items/:codeOrUid/kit`,
`GET /items/:codeOrUid/prices`, `GET /export`, plus the existing routes.

"Used on N quotes" (`usage.js`): `GET /items/:codeOrUid/usage?limit=5`
answers `{ item_uid, quote_count, version_count, jobs: [{ job_id,
quote_number, title, versions, latest_version, on_current_quote, sent,
updated_at }], scanned_at }` (newest first) and `GET /usage` answers
`{ items: { <uid>: { quote_count, version_count } }, scanned_at }` for every
item a quote uses, for a grid column. Rows are matched by uid (`catalogItemUid`,
`sourceUid`), else by legacy code through the aliases; only direct rows
count (an item inside a kit is the kit's). One scan of every job's current
quote and saved versions serves both, cached for 30 seconds.

## Price book and supplier imports

The pricing page's grid, bulk edits and supplier imports.
Every write runs in the store's write transaction (`store.write`), so it is
serialised with other catalogue writes, bumps the catalogue version once and
records field-level history.

- **Grid** (`GET /grid?q&status&category&tag&supplier&sort&dir&offset&limit`):
  one page of rows with effective cost, sell, markup, margin and margin
  warnings, the current `price_id` and any scheduled price, the default
  supplier and code, and category/tag facet counts. `q` matches code, name,
  category, unit, tags, supplier name and supplier code. Inline edits use the
  existing `PATCH /items/:code` with `expectedVersion`.
- **Bulk edits** (`POST /bulk/preview`, `POST /bulk/apply`, body
  `{ uids, op, expectedVersions }`): `op` is one of `setMarkupPct` (switches
  fixed-sell items to markup), `adjustCostPct`, `adjustSellPct` (fixed-sell
  items only), `setCategory`, `archive`. The preview writes nothing and says
  per item what changes, what is skipped and why (kits that roll up, items
  with a scheduled price), and warns on negative or below-10% margins, mode
  changes and archiving items still in use; a percentage that changes nothing
  is skipped. Costs keep four decimal places, sells two. Apply requires the
  preview's `expectedVersions` (400 without them) and refuses the whole batch
  (`VERSION_CONFLICT`) when an item changed since the preview or an item it
  would change is not in them; price changes append `item_prices` rows with
  `source = 'bulk'`, `source_ref` the batch id.
- **Suppliers** (`GET/POST /suppliers`, `PATCH /suppliers/:uid`) and links
  (`GET/POST /items/:code/suppliers`, `DELETE /items/:code/suppliers/:id`):
  a supplier code belongs to one item per supplier; a pack quantity divides
  the supplier's price; one link per item is the default.
- **Imports**: `POST /imports/inspect` (multipart `file`, or JSON `csv`)
  reads the headers, first rows and a column map (the supplier's saved one,
  else a guess). `POST /imports` stages it: every row is classified against
  the catalogue as `changed`, `unchanged`, `new`, `missing` (linked to the
  supplier but not in the file), `ambiguous` (a code in the file twice, a
  supplier code and item code that disagree, several items with the name) or
  `invalid` (no or bad cost, unknown unit, a unit with no conversion to the
  item's, a kit priced by roll-up, a scheduled price), with old → new cost,
  delta % and notes. Rows match on the supplier code (via `item_suppliers`),
  then Field's code, then an exact active name. Costs are converted per the
  item's unit (pack quantity, unit conversions). In a `;`-separated file a
  decimal comma is read as such (`12,75` is 12.75) and an ambiguous `1,275`
  is invalid. A changed row is staged as `apply` unless it matched only by
  name or its cost moves more than 15%; those are staged as `skip` and
  flagged, to be applied only when chosen. The column map is saved on the
  supplier. Staging changes no prices. An import staged without a date takes
  effect when it is applied (`effective_from` is null until then, then set
  to the apply time).
  `POST /imports/:uid/apply { decisions? }` applies the chosen rows in one
  transaction: `apply` appends an `item_prices` row (`source = 'import'`,
  `source_ref` the import uid) effective from the import's date, `create`
  makes a **draft** item (marked up by the supplier's default markup when it
  has one), `archive` archives a missing item. Nothing is ever deleted, and
  missing items are kept unless someone chooses to archive them. Apply is
  refused, and nothing changes, when the import is no longer staged
  (`IMPORT_NOT_STAGED`, 409: two applies, or an apply and a discard, never both
  win), when a row's item was re-priced after staging, or its unit, price
  modes, supplier pack or unit conversion changed so the staged cost no
  longer means the same thing (`VERSION_CONFLICT`: stage the file again), or
  when the date is before an item's current price.
  `POST /imports/:uid/discard` closes it without touching the catalogue.
- **Scheduled prices.** An import may be dated in the future. Its rows carry
  the new cost, the item's current markup and (fixed-sell items) the file's
  sell price or the current one; until the date, manual price edits and
  unit, pricing-basis or price-mode changes to those items are refused with
  `PENDING_PRICE_CHANGE`, and a new import marks them invalid.
- **Health** (`GET /health`) adds `stale_price` (a manual price unchanged for
  365 days), `scheduled_price_change` and `staged_import` to the report.

## Moving a SQLite catalogue in

```bash
npm run catalog:import-legacy -- /path/to/catalog.db --dry-run   # verify, report, roll back
npm run catalog:import-legacy -- /path/to/catalog.db             # import (catalogue must be empty)
npm run catalog:import-legacy -- /path/to/catalog.db --replace   # DESTRUCTIVE: replace what is there
```

The target is the server's database (`DATABASE_URL`/`FIELD_DB_URL`).
Migrations are applied first. The file is opened read-only. The import is one
transaction that verifies itself before committing: row counts per table,
every uid, item field and component link preserved, every stored price carried
over, and every active item's effective buy and sell price equal to what the
SQLite catalogue computed. Any failure rolls back and nothing is imported
(exit 2). Each item's stored prices become one `item_prices` row,
`source = 'migration'`, effective from the item's `updated_at`.

`--replace` deletes every current item first, and with them their PostgreSQL-era
price rows (`item_prices` cascades), components, evidence and the whole
`catalog_history` audit trail. Only the database's point-in-time restore brings
those back.

Field refuses to boot on an empty catalogue, so import before first start (or
boot with `FIELD_PRICE_CATALOG_ALLOW_UNAVAILABLE=1`, which keeps the catalogue
editor available but blocks pricing).

## Codes in outputs (code retirement step 6)

An item is its uid and its name. Every input that names an item (a URL's
`:code`, `child_code`, `variant_of`, MCP `item`/`code`) still takes a legacy
code and resolves it through the aliases.

- **MCP:** catalogue tools take `item`, `parentItem` and `childItem` (uids;
  `code`, `parentCode` and `childCode` are kept as deprecated names for the
  same inputs) and never return codes (`item-codes.js` `omitItemCodes`).
- **HTTP:** with `Prefer: field-item-codes=omit` every catalogue JSON answer
  comes without codes (`Preference-Applied` says so; a row that names
  something only by code, such as a health issue for a missing item, keeps
  the text as `reference`). Without it, answers still carry `code` for the
  browser app and say `Field-Item-Codes: deprecated`. The default flips to
  omitting codes once the app no longer reads them.
- The MCP tools (`server/mcp/`) name items by uid.

## The price-equality gate

`price(state, item)` (`price.js`) returns `{ unit_cost, unit_sell,
markup_pct, margin_pct, price_uid, price_key, pricing_method, problems }` from
the one roll-up: the number every screen, PDF and API already shows. A sell
is returned exactly as it stands; rounding sells to cents is not done,
because it would change prices. `capturePrices(state)` records every item's
cost and sell and `comparePrices(before, after)` lists every item whose cost
or sell moved by a cent or more (or by more than a millionth), went missing,
or stopped being active without being meant to. A structural change to the
catalogue (a rename, a kit flattened, a duplicate merged) is kept only when
the gate passes.

```bash
npm run catalog:price-gate -- --capture before.json   # read-only
npm run catalog:price-gate -- --compare before.json   # exit 1 if any item prices differently
```

## The price book clean-up (code retirement step 5)

`server/data-migrations/price-book-cleanup.js` applies
`price-book-cleanup.plan.json` once, at boot, in one catalogue transaction.
The plan is built from an installation's own catalogue export and review,
and is not in this repository: with no plan file the migration is deferred,
changes nothing and is not recorded. What it applies:
names, types and categories (a two-level tree by what an item is), kits made
of one resource or sitting below a sold kit's second level folded into the
kits that use them (quantities multiplied through, rows with the same
component and settings added together; never across a `fixed` row), a
duplicate merged, four per-metre wall kits added (half a 2.0 m bay), and items
no kit and no pricing rule uses archived. A change applies only where the item
still matches the review; the price-equality gate runs inside the transaction
and any moved price rolls everything back. The plan holds no prices. A kit
archived together with its parts no longer rolls up (archived parts never
price); the gate lists that as retired, not as a price change.

## Backups

The catalogue is ordinary PostgreSQL data: restore it with the database's
point-in-time restore (Replit). `npm run catalog:export -- --out file.json`
(or `GET /api/price-catalog/export`) writes every catalogue table as one JSON
document to keep or diff. The SQLite-only backup scheduler, leases and restore
CLI are gone with the file they protected.
