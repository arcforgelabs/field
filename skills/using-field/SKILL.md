---
name: using-field
description: Field app jobs, quotes, invoices, catalog, CLI/API, agents, and production state.
---

# Using Field

This is an operator/runbook skill for people and agents working on Field itself.

AI agents that drive a running Field installation should connect through its OAuth MCP surface (`docs/REMOTE_MCP.md`), not through the `field` CLI or a shared `FIELD_TOKEN`.

Use this skill when the task touches the Field product, repo, CLI, quote lifecycle, milestone invoicing, or organizer model.

## Environment

| | Dev workstation | Production (for example Replit) |
|---|---|---|
| App root | a checkout of this repository | the Replit workspace, or the container running the image |
| Config | `config.local.json` | Replit Secrets (`FIELD_CONFIG_JSON` and others, see `docs/REPLIT.md`) |
| Data | `data/` | PostgreSQL, rebuilt into the data directory on boot (`FIELD_STORAGE=postgres`) |
| Service | repo-local `./dev.sh` | the published app (a Reserved VM on Replit) |
| Base URL | `http://localhost:19200` | your installation's `https://` origin |

On Replit, deploy by merging to `main`, bringing the Replit workspace to `main` and building, then Republishing (`docs/REPLIT.md`).

## Source Of Truth

When docs and code disagree, trust the shipped code in this repo.

Current invariants:
- Non-draft jobs default read surfaces to the locked customer-seen quote revision, not the latest internal draft.
- Explicit latest-draft selection is still possible when an operator intentionally wants to preview or send a newer revision.
- `GET /api/jobs/:id/quote-pdf` accepts `?documentType=quote|invoice|receipt`; landed jobs default to invoice, and callers pass `documentType=quote` to download the locked customer quote PDF or `documentType=receipt` to read a paid milestone receipt.
- Invoice documents, receipt documents, milestone invoice artifacts, and milestone receipt artifacts always anchor to the customer-facing revision, never the latest internal draft.
- Receipt documents only exist for paid milestone invoices.
- Invoice numbers are `INV-YYYY-M-N`, from one sequence, allocated when the invoice is issued (authorised or sent); the job number is its reference. A draft has no number yet (its preview says "Draft, not yet issued"). Invoices issued before the sequence keep their `EI-...-M<n>` numbers. Receipt numbers are `RCT-YYYY-M-N`, issued when a milestone is paid; each receipt names the invoice it pays. Receipts issued before the series keep their `ER-...-M<n>` numbers.
- `server/job-document-context.js` is the backend source of truth for quote/invoice/receipt document selection, prepared milestone payment documents, and customer-vs-latest revision resolution.
- `server/job-meta-store.js` is the backend source of truth for hydrated job meta. Canonical milestone invoice state lives in `milestone-invoices/state.json`; raw `meta.json` may omit `milestoneInvoices`.
- `meta.invoicePaidAmount` is the **next-open milestone** paid amount (contextual). Use `meta.totalInvoicePaidAmount` for job-level running totals.
- Marking a milestone as sent or paid makes that milestone prefix immutable for schedule edits. Later milestones can still be reshaped against the remaining percentage until they are also sent or paid.
- `mark unsent` and `mark unpaid` are explicit undo paths. Both return the milestone to `draft`, clear the sent/paid lock fields, and release that milestone prefix for schedule edits again.
- An issued invoice is never revised in place. To correct one after an approved change, credit and reissue it (`field credit-invoice`, or "Credit and reissue" in the job's invoices): a credit note (`CN-YYYY-M-N`, an adjustment note PDF with the reason) credits it in full and a new invoice is issued in its place; payments move to the new invoice. `revise-invoice` is the older name of the same command. An invoice marked not sent or unpaid and then issued again with different content is credited first only as the account setting says (Settings, "Quotes and invoices": by default only if Field emailed it). When emailing the replacement, the operator can tick "Also attach the adjustment note".
- Milestone defaults come from the organisation's milestone rules (#29), entered in Settings, "Quotes and invoices", by an owner: one rule per region (every region, a country, or a state) and contract value band ("under $20,000", "from $20,000"), with default milestones and caps by milestone kind (deposit, progress, final, variation). A job's region is its site address, else the business region. The rule's milestones become a job's schedule the first time its milestones are created (`paymentSchedule.source.kind: "rule"`). A schedule set on the job (quote editor, `generate-milestones --schedule`, MCP `patch.paymentSchedule`) is an override (`source.kind: "override"`), marked on the job and on the invoices it issues; `generate-milestones --account-rule` puts the rule's schedule back. Caps follow the rule in force when an invoice is issued, whatever the schedule: a **hard** cap refuses the issue (409 `MILESTONE_CAP_EXCEEDED`, a message naming the rule, `findings`); a **soft** cap alerts and the alert is kept with the invoice (`issuedRevision.milestoneRule.capAlerts`). Check before issuing with `field milestone-rules check <jobId>` or `GET /api/jobs/:id/milestone-rules`. Field holds no legal limits of its own, and an issued invoice never changes when rules do.
- The presentation organizer is one persisted tree with `group` and `source` nodes.
- Every source node carries a canonical `origin` (`engine` | `manual` | `generated`) and `pricingMode` (`engine` | `manual` | `allocated`). The legacy `sourceKind` field (`customer_schedule_item` | `manual` | `generated_component`) is kept in lock-step for backward compatibility. New code should prefer `origin` / `pricingMode`.
- Generated sub-items are materialized into standard `source` nodes with `origin: "generated"`, `pricingMode: "allocated"`.
- Manual rows are `origin: "manual"`, `pricingMode: "manual"`.
- Groups and source rows can both roll up descendants and both can carry manual price and cost overrides.
- Visual origin matters in the UI: user/manual rows stay warm/yellow; system-generated rows stay cool/grey.
- The local Field price catalog is the commercial pricing authority. Do not create new quote or catalog pricing behavior that depends on external pricing systems.
- Catalog entries are all items. `catalog_type` is either `goods_service` for customer-facing sellable work or `component` for internal build-up rows such as labour, materials, equipment, disposal, or allowances. Legacy `item` means `component`; legacy `product` or `service` means `goods_service`.
- A catalog item is its opaque `uid` and its name. A legacy `code` still finds the item (codes are permanent aliases and never change), but name items by uid; send `Prefer: field-item-codes=omit` to get catalogue answers without codes.
- Categories are short filter metadata, not pricing authority. Keep category names succinct and reusable.
- UI labels use `SELLING` and `COST`. Database/API fields may still expose `sell_price` and `buy_price`; treat `buy_price` as cost price in user-facing language.
- Computed catalog pricing comes from child rows: child quantity times child cost/selling prices roll up to the parent. `entry_quantity` and `entry_unit` preserve a user-friendly input unit, while `quantity` is the canonical math quantity in the child item's unit.
- Adding a catalog item to a quote materializes an editable quote `source` node. If the catalog item has children, those children are copied into nested quote source rows so the quote can be customized without hard-coding a detached parent total.
- ERPNext, Twenty/20CRM and Cal.com are not Field runtime dependencies.
- Field startup rejects stale external integration config keys: `erpnext`, `twenty`, `twentyCrm`, `twentyCRM`, and `20crm`.
- Do not reintroduce ERPNext CLI surfaces, Twenty/20CRM references or Cal.com booking dependencies into Field workflows without an explicit product/spec change.

## CLI Contract

Preferred installed bins:

```bash
field --help
```

Install from the repo root:

```bash
npm run install:cli
```

Install behavior:
- The installer keeps the default npm prefix when it is writable.
- If the host default prefix points at a protected system path such as `/usr`, it falls back to a user-local prefix such as `~/.local`.
- On Linux VPS hosts, login shells typically expose `~/.local/bin`; non-login shells may need that path added explicitly.

Fallback direct script entrypoints:

```bash
node scripts/field-cli.js <command> [options]
```

Auth and targeting:
- For production operator setup, run `field auth login --url https://<your-field-host>` in
  the operator's terminal. The hidden prompt stores the service key in `~/.config/field/token` with
  user-only permissions.
- Verify persisted authentication with `field auth status`; remove it with `field auth logout`.
- Never put a service key in chat, argv, source control, shell history, or a task tracker.
- `FIELD_URL`, `FIELD_TOKEN`, and `FIELD_TOKEN_FILE` remain supported for managed runtimes. Without
  explicit targeting, development and on-host installs default to `http://localhost:19200`.
- Installed CLI bins resolve managed environment credentials first, then the persisted credential,
  then legacy config sources relative to the repo or deployed app root.

### Email templates

```bash
field email-templates list [email|quote|invoice|receipt]
field email-templates show <document-type> <template-id>
field email-templates update <document-type> <template-id> [--subject text] [--body-file path]
```

Read with `show` before an update, preserve required placeholders, and use `--body-file` for
non-trivial HTML. Read the template back after changing it.

## Pricing Catalog

Use the Field UI or API for catalog edits; there is no separate catalog CLI surface to treat as canonical.

Admin surfaces:
- `/pricing`: the catalogue table (search, status, category and tag filters, sortable columns, bulk changes). `?item=<uid>` opens an item in a side sheet (`?item=new` for a new one); the item's whole edit, kit parts and price history live there.
- `/pricing?manage=categories` (also `tags`, `units`, `suppliers`): the collection managers. `/pricing/categories` redirects here.
- `/pricing?health=1`: items with catalogue health warnings (missing price or category, duplicate active names, cost above sell, computed kits without parts, inactive parts, unit problems), each with its reason. `/pricing/health` redirects here.

Item model:
- `goods_service`: client-facing item that can appear as the top-level sellable line on a quote.
- `component`: internal item used to build goods/services or other components.
- Both types can have child rows; do not assume only components can nest.
- Units are normalized centrally. Examples: `lm` folds to `m`; count-like plant/tree units fold to `each`.
- Manual price overrides belong to the quote presentation layer. Catalog records should keep reusable base prices and child recipes.

When editing catalog data directly, prefer the `/api/price-catalog/*` routes so UID generation, unit normalization, category handling, and computed-price recalculation stay consistent.

## Canonical Field CLI Surface

Treat `field --help` as authoritative. Current high-value commands:

### Core

```bash
field create-job "12 Sample Street, Exampleton"
field list-jobs
field get-job <jobId> [--version latest|customer|v003]
field get-quote <jobId> [--version latest|customer|v003]
field get-quote-markdown <jobId> [out.md] [--version ...]
field get-pdf <jobId> [out.pdf] [--version ...] [--document quote|invoice|receipt] [--milestone 2]
field send-document <jobId> client@example.com [--document quote|invoice|receipt] [--version ...] [--milestone 2] [--paid 100] [--attach doc_… ...]
field set-details <jobId> key=value [key=value ...]
field set-quote-inputs <jobId> <file-or-inline-json>
field update-quote <jobId> [--lock final|draft] [--json '{...}']
field internal-breakdown <jobId> [out.md] [--version ...]
field get-rate-card
field status <jobId> [--version ...]
field set-stage <jobId> <draft|sent|landed|lost>
```

### Presentation Organizer

```bash
field get-presentation <jobId> [--version latest|customer|v003]
field refresh-presentation <jobId>
field set-scope-text <jobId> "Scope of works..."
field set-validity-days <jobId> 30
field add-manual-item <jobId> "Poly pipe allowance" 350 [cost] [--parent <nodeId|root>]
field add-group <jobId> "Earthworks" [--parent <nodeId|root>]
field move-node <jobId> <nodeId> <parentId|root>
field reorder <jobId> <root|parentNodeId> <nodeId1> <nodeId2> ...
field rename-node <jobId> <nodeId> "New label"
field hide-amount <jobId> <nodeId>
field show-amount <jobId> <nodeId>
field exclude-node <jobId> <nodeId>
field include-node <jobId> <nodeId>
field remove-node <jobId> <nodeId>
```

Important organizer rule:
- Mutation commands intentionally load the latest editable organizer, not the default locked customer view. This avoids editing the wrong revision on non-draft jobs that also have a newer draft.

### Milestones

```bash
field list-milestones <jobId>
field generate-milestones <jobId> [--schedule <file-or-inline-json> | --account-rule]
field update-milestone <jobId> <milestone-number> [--status draft|authorised|paid] [--due-date YYYY-MM-DD]
field record-milestone-payment <jobId> <milestone-number> <amount> [--date YYYY-MM-DD] [--reference text] [--method text]
field mark-milestone-unpaid <jobId> 2
field mark-milestone-unsent <jobId> 2
field credit-invoice <jobId> 2 --reason "approved variation" [--version vNNN] [--expect-revision N]
```

### Milestone rules

```bash
field milestone-rules list [--json]
field milestone-rules check <jobId>
field milestone-rules set --file rules.json [--expect-version V]   # owner
field milestone-rules business-region AU SA                          # owner
```

`rules.json` is a list (or `{ "rules": [...] }`) of rules: `name`,
`country` and `region` (null for every region or the whole country),
`minValue` (inclusive) and `maxValue` (exclusive, null for no upper end),
`valueBasis` (`inc-gst` or `ex-gst`), `note`, `milestones` (as a payment
schedule) and `caps` (`kind`, `maxPercent` and/or `maxAmount`, `mode`
`hard` or `soft`). `set` replaces every rule; `--expect-version` (from
`list`) refuses it if someone changed them in between.

Milestone numbering in the CLI is human-facing:
- `1` or `M1` means the first milestone invoice.
- The API stores zero-based `milestoneIndex`, but the CLI hides that.
- `field list-milestones` prints the receipt number once a milestone is fully paid.

### Moasure / Wall

Moasure measurement files and the retaining-wall engine feed quote pricing. Wall geometry comes from `wall-zones.json` (or the legacy single-wall fallback from `bay-model.json`) and renders per zone at `GET /api/jobs/:id/wall-zones/:zoneId/render?format=html`. The site map, site plan, sketch extraction and photo visualisation were removed.

```bash
field upload-moasure <jobId> measurements.csv
field scan-moasure <jobId>
field set-design <jobId> wall-design.json
field get-design <jobId>
field extract-heights <jobId>
field build-model <jobId>
field get-model <jobId>
```

## Quote Revision And Document Rules

Version selectors accepted by the CLI:
- `--version v003`
- `--version latest`
- `--version customer`

Meaning:
- `latest` = newest internal draft/current revision.
- `customer` = locked customer-seen revision (`lastSentQuoteVersion` when present).

Current document behavior:
- `get-job`, `get-quote`, `get-quote-markdown`, `internal-breakdown`, and `status` respect `--version`.
- `get-pdf` and `send-document` respect `--version` for quote documents.
- Payment documents (`invoice`, `receipt`) ignore draft version overrides and always resolve from the customer-facing revision.
- Landed jobs default `get-pdf` and `send-document` to invoice behavior unless `--document quote` or `--document receipt` is passed where supported.
- `--document receipt` requires a paid milestone. If `--milestone` is omitted, the backend resolves the latest paid milestone receipt.
- Sending `--version customer` on a non-draft job resends the locked customer-facing revision without replacing a newer draft.
- Sending `--version latest` on a non-draft job intentionally promotes that newer draft as the next customer-facing revision.

## API Surface Agents Actually Need

Auth:
- `Authorization: Bearer <token>`

Most useful routes:
- `GET /api/jobs/:id?version=<n>`: full detail, selected quote revision, edit policy, milestone state. Pass `version=latest` to bypass the customer-locked default and force the actual newest version (use this after creating, promoting, or regenerating a draft).
- `GET /api/jobs/:id/quote?version=<n>`: quote markdown for the selected revision.
- `GET /api/jobs/:id/quote-pdf`: direct quote, invoice, or receipt PDF read, using the same backend document resolver as preview/send flows.
- `POST /api/jobs/:id/quote-pdf-preview`: explicit document preview surface for quote/invoice/receipt, milestone, and version-aware PDF generation.
- `POST /api/jobs/:id/email-quote`: quote, invoice, or receipt email send, including `version`, `documentType`, `milestoneIndex`, and `invoicePaidAmount` for invoice compatibility.
- `GET /api/jobs/:id/internal-breakdown?version=<n>`: version-aware internal breakdown. Default response is markdown; pass `format=json` for the raw quote+meta payload, or `format=html` to get a 302 redirect to the SPA. The previous implicit HTML fallthrough is gone — API callers no longer get an SPA shell when they expected data.
- `GET /api/jobs/:id/milestones`
- `POST /api/jobs/:id/milestones/generate`
- `PUT /api/jobs/:id/milestones/:index`
- `POST /api/jobs/:id/milestones/:index/payment`
- `POST /api/jobs/:id/milestones/:index/unpaid`
- `POST /api/jobs/:id/milestones/:index/unsent`
- `POST /api/jobs/:id/versions/:version/promote`: promote an archived quote version to current.

Price catalog routes:
- `GET /api/price-catalog/health`
- `GET /api/price-catalog/categories`
- `POST /api/price-catalog/categories`
- `PATCH /api/price-catalog/categories/:id`
- `DELETE /api/price-catalog/categories/:id`
- `GET /api/price-catalog/items?status=active|draft|archived|all&category=<name>&search=<text>`. The deprecated `kind=component` filter returns only items with kit parts; `kind=item` returns only items without them.
- `GET /api/price-catalog/items/:codeOrUid`
- `POST /api/price-catalog/items`
- `PATCH /api/price-catalog/items/:codeOrUid`
- `DELETE /api/price-catalog/items/:codeOrUid` deletes the item and removes it from every kit that uses it. To archive an item, `PATCH` its `status` to `archived`.
- `GET /api/price-catalog/items/:codeOrUid/children`
- `POST /api/price-catalog/items/:codeOrUid/children`
- `PATCH /api/price-catalog/items/:codeOrUid/children/:childCodeOrUid`
- `DELETE /api/price-catalog/items/:codeOrUid/children/:childCodeOrUid`

## Operational Notes

- Local dev boot path: `./dev.sh`
- Production deploy path on Replit: Republish the app after the workspace is on `main` (`docs/REPLIT.md`)
- Production health: `GET https://<your-field-host>/health` reports durable storage state
- If you inspect persisted job files directly, do not treat raw `meta.json` as authoritative for milestone invoices. Use the API, the CLI, or `server/job-meta-store.js` semantics.

## Practical Workflows

Inspect locked customer quote vs latest draft:

```bash
field status <jobId>
field get-job <jobId> --version customer
field get-job <jobId> --version latest
```

Send the newest draft as the new customer-facing quote:

```bash
field send-document <jobId> client@example.com --document quote --version latest
```

Send milestone invoice `M2` on a landed job:

```bash
field send-document <jobId> client@example.com --document invoice --milestone 2
field get-pdf <jobId> invoice-m2.pdf --document invoice --milestone 2
```

Read or send the receipt for the latest paid milestone:

```bash
field get-pdf <jobId> receipt.pdf --document receipt
field send-document <jobId> client@example.com --document receipt --milestone 1
```

Undo a paid milestone and remove its receipt artifact:

```bash
field mark-milestone-unpaid <jobId> 1
field mark-milestone-unsent <jobId> 1
```

Re-shape the organizer on the editable latest draft:

```bash
field add-group <jobId> "Stormwater Works"
field add-manual-item <jobId> "Temporary fencing" 850 --parent root
field move-node <jobId> <manualNodeId> <groupNodeId>
field get-presentation <jobId> --version latest
```

Check catalog health and inspect a catalog item:

```bash
curl -s -H "Authorization: Bearer $FIELD_TOKEN" "$FIELD_URL/api/price-catalog/health"
curl -s -H "Authorization: Bearer $FIELD_TOKEN" "$FIELD_URL/api/price-catalog/items?status=active&search=labour"
```

Create a component and attach it to a goods/service recipe:

```bash
curl -s -X POST -H "Authorization: Bearer $FIELD_TOKEN" -H "Content-Type: application/json" \
  "$FIELD_URL/api/price-catalog/items" \
  -d '{"name":"General labour","catalog_type":"component","category":"Labour","unit":"hour","buy_price":55,"sell_price":82.5}'

curl -s -X POST -H "Authorization: Bearer $FIELD_TOKEN" -H "Content-Type: application/json" \
  "$FIELD_URL/api/price-catalog/items/<parent-code-or-uid>/children" \
  -d '{"child_code":"<child-code-or-uid>","entry_quantity":30,"entry_unit":"minute"}'
```
