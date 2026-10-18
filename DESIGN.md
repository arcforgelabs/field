---
project: field
surface: quote-and-invoice-app
updated: 2026-10-12
---

# Field Design System

## Intent

Field is a quote builder and invoicing app. Someone opens it to finish a quote, send it, see who has replied, and get invoices out and paid. The interface should feel like a modern business app (Stripe, HubSpot, Linear): clean, calm and quick, with white working surfaces, soft structure and one obvious next step on every screen. It is not a field-capture tool, a workbench or a dashboard of everything the system knows.

Principles every screen follows:

- **One next step.** Each page header has at most one filled primary button, and it is the job's next step: send the quote, mark it accepted, send the next invoice, record a payment.
- **Edit in place.** Quotes, job details and terms are edited where they're read. Drafts save themselves; there are no save buttons or edit modes for routine work.
- **Few clicks.** New quote is one field (the address). Adding an item is type, Enter, quantity, Enter. Paying an invoice is one dialog from the job, the board or the ledger.
- **Show status, not machinery.** Status is a small tinted pill (Draft, Quoted, Invoicing, Paid, Lost; Not sent, Sent, Overdue, Paid). Engine internals, evidence and review gaps don't appear.
- **Quiet structure.** Hairlines and white space separate things; cards are used only for things that move or stand alone (board cards, summary tiles).

## Design systems

Appearance is three choices, per browser, in Settings (`client/src/features/settings/appearance-section.tsx`):

- **Mode**: Light, Dark or Auto (follow the device, the default). The sidebar has a quick light/dark switch.
- **Design system**: six lead **directions**, each a theme family plus its own structure (`client/src/lib/directions.ts`, styles under "Directions" in `client/src/components/shell/ui.css`). Then the rest of the theme families. Except Site, the families are ported from the [OpenClaw](https://github.com/openclaw/openclaw) Control UI themes (MIT licence, Copyright (c) 2026 OpenClaw Foundation) by `scripts/port-openclaw-themes.mjs`; the generated `shared/theme-palettes.js` keeps that attribution.
  - **Beacon** (default, *Maximum contrast*): OpenClaw's AAA theme. White and near-black in light with a bronze accent (`#6e4a00`, 8:1), pure black in dark with amber (`#ffc233`, 13:1). The amber is darkened in light because yellow can't reach 7:1 on white. Atkinson Hyperlegible Next.
  - **Tide** (*Calm*): white surfaces, slate type, teal-blue, IBM Plex Sans, soft cards and lanes.
  - **Claw** (*OpenClaw default*): OpenClaw's own look. A graphite sidebar around a light canvas, warm red, Instrument Sans, a tighter header.
  - **Knot** (*Precision*): neutral greys, a black primary with red kept for signal, hairlines instead of shadows, tighter corners, flat columns, Geist.
  - **Dash** (*Earth*): a deep clay sidebar, a sand canvas with white cards, softer corners, DM Sans.

  - **Site** (*Original*; theme id `field`, formerly Field Crew): Field's original look kept as an option. Paper and ink, square corners, ink frames on cards and tiles, yellow on filled buttons, spaced uppercase table headers.

  Settings › Appearance lists these six first, each with its tag and its sidebar in the preview, then every other family. ⌘K ("Switch look") switches between them.
- **Accent colour**: the family's own, one of upstream's presets (plus Field yellow), or any custom colour.

`shared/themes.js` is the one source of the `--t-*` tokens and the picker order. The client injects every family as `[data-theme][data-mode]` rules at startup, `index.html` puts the stored family and mode on `<html>` before first paint, and `client/src/lib/color-mode.ts` applies the choice and any accent override. Server-rendered pages (wall renders, the MCP authorization page) keep Site as their default (`DEFAULT_THEME`), so customer-facing renders don't change with the app's look. Screens use the tokens rather than literal colours, radii or strokes, so every family reaches every screen.

Clerk's widgets (sign-in, and the account screens embedded in Settings) are themed from the same tokens at render time (`client/src/lib/clerk-appearance.ts`), so they change with the design system and mode. Their inputs and the Google button take a 1px edge in `--t-control`, so a control's outline reads at 3:1 on the paper (WCAG 1.4.11).

## Logo

The Field mark is three angled stripes, ink, yellow, ink, beside the FIELD wordmark. The source is `client/public/field-mark.svg` (traced from the Field Crew prototype's `field-logo.png`, where the Site theme also comes from); `icon-192.svg` and `apple-touch-icon.png` are the app icon on paper. In React use `<FieldLogo />` or `<FieldMark />`. The mark's middle stripe takes the active theme's brand colour (`--t-brand`; yellow only on Site), and the favicon is redrawn to match (`client/src/lib/favicon.ts`); the static SVGs keep `#fdc901`; its ink stripes are `#202328` in light mode and off-white in dark (`--t-mark-ink`; `field-mark.svg` follows the device's scheme).

Customer PDFs carry the business's identity (the issuer's name and details from the quote catalog's `businessProfile`), not Field's: Field is the tool, not the sender.

## Core Tokens

These are Site's values (theme id `field`), shown as the reference; every family (Beacon, the default, included) defines the same set.

```css
[data-theme="field"][data-mode="light"] {
  --t-bg: #f5f3eb;      /* paper */
  --t-s1: #ebe9df;      /* raised surface, table header */
  --t-s2: #dedbd0;
  --t-paper: #fbfaf5;   /* inputs, tables, panels */
  --t-brd: rgba(17,17,13,.18);
  --t-brd-hi: #11110d;
  --t-text: #11110d;    /* ink */
  --t-dim: #65645d;
  --t-mute: #7a786f;
  --t-accent: #11110d;  /* ink: text, icons, filled buttons */
  --t-accent-bg: rgba(244,197,24,.24);
  --t-accent-brd: #d9ad0c;
  --t-brand: #f4c518;   /* yellow */
  --t-primary: #11110d; /* filled controls */
  --t-on-primary: #f4c518;
  --t-danger: #b8442a;
  --t-warn: #8a5a00;
  --t-success: #3f6b2a;
  --t-body: 'Inter Variable', system-ui, sans-serif;
  --t-data: 'Geist Mono Variable', 'JetBrains Mono', monospace;
  --t-display: 'Inter Variable', system-ui, sans-serif;
  --t-radius: 0px;          /* controls; --t-radius-lg for panels and tables */
  --t-stroke: 2px;          /* frame weight, in --t-stroke-color (ink) */
  --t-label-case: uppercase;
  --t-display-weight: 800;
  --t-ring: #f4c518;        /* focus */
}
```

Dark mode, `[data-theme="field"][data-mode="dark"]`, is Site's dark palette: background `#11110d`, surfaces `#1e1e18` / `#2b2b24`, text `#f5f3eb`, dim `#b8b7ae`, borders off-white, danger `#e36a4d`.

Yellow is too light to read on paper (1.5:1), so in light mode it is never text: `--t-accent` is ink, and the yellow is the logo, focus rings, highlights (`--t-accent-bg`) and the label on filled buttons. On near-black yellow reads at 11.6:1, so in dark mode `--t-accent` is yellow. Filled controls use `--t-primary` with `--t-on-primary` (ink with a yellow label in light, yellow with an ink label in dark), and anything filled with `--t-accent` is labelled with `--t-bg`, which works in both modes. The MCP authorization page carries its own copy of the Site palette and follows the device's scheme.

`--t-control` is the edge of an input or outlined button: the text colour faded toward `--t-paper` only as far as it still reads at 3:1 there. `shared/themes.js` derives it for every family and mode, and `shared/themes.test.js` checks it.

The same rule holds in every family and with any accent: `--t-accent` is text and reads at 4.5:1 or better on `--t-bg` (the converter and the accent override shift a colour just enough to get there; `shared/themes.test.js` checks every family and mode), while `--t-brand` is the colour as chosen, for fills, highlights and the focus ring.

## Shape and type

Use `--t-radius` for controls and `--t-radius-lg` for cards, tiles, dialogs and menus; never hard-code a radius. Status pills and progress bars are fully round. Structure is 1px hairlines in a soft mix of the text colour (`--fx-line`), not the family's frame stroke. Elevation is a light shadow on raised things only (cards, tiles, buttons, menus, dialogs).

Use `--t-body` for everything people read, including figures: money and quantities use the body face with tabular numerals (`.fx-num`), right-aligned in tables, always two decimals (`money()` in `client/src/lib/job-status.ts`). `--t-data` is for codes and references only where a monospace helps. Page titles are 20px, weight 650, slight negative tracking. Labels and table headers are sentence case, 12px, muted; spaced uppercase is reserved for the families that set `--t-label-case` and the older shared components.

## App structure

Every signed-in screen sits in the shell (`client/src/components/shell/app-shell.tsx`): a sidebar with search (⌘K or /), Jobs, Invoices, Catalogue, recent jobs and the account, beside one working surface. On phones the sidebar becomes a top bar.

- **Jobs** (the landing screen): four summary tiles that filter the view (Drafts to finish, Awaiting reply, Ready to invoice, Overdue), then the jobs as a **board** (Drafts, Quoted, Accepted · invoicing, Paid; Lost on request) or a sortable **list** with bulk archive. Dragging a quoted job to Invoicing asks to mark it accepted. The choice of board or list is remembered per browser.
- **Job**: the document column (tabs: Quote, Invoices, Email, Notes and activity; Email lists every email sent for the job, each opening exactly as it went out, and the ones waiting) and a sticky summary rail (total, GST, cost, margin, paid and outstanding, then customer, site and versions, each field editable in place).
- **Invoices**: summary tiles and a ledger of every milestone invoice, filtered by state, with Record payment and Send on the row.
- **Invoice amounts** (`/invoices/amounts`, owners only; `client/src/features/invoices/invoice-amounts-page.tsx`): old invoices whose milestone record and PDF show different amounts (#60). Each invoice is a card with every set of amounts Field holds as a choice card, the report's note and the emails; the owner picks one set, types a reason and confirms a dialog that states the total. Settled invoices show the decision, read-only. The Invoices page shows owners a notice with the count of invoices not settled yet.
- **Catalogue**: one table of items that open in place in a side sheet (see Catalogue below). **Settings** uses the same page header and spacing.
- **Settings › Team › Access** (owners only; `client/src/features/settings/access-section.tsx`): below People, one compact row per person or service account that holds command-line tokens or connected agents, with the count ("2 command-line tokens · 1 connected agent") and when it was last used. A row expands to each token (name, created, last used, what it acts as) and agent (client name, who approved it and when, last used, scopes as small code pills), each with Revoke or Disconnect behind a confirm dialog that names it and its holder. A search box finds a token, agent or person. Everyone with nothing is one muted line; with nothing at all it is an empty state. "Recent changes" is a closed disclosure of the audit events. A token's value never appears.

Every page starts with the page header (`.fx-ph`): breadcrumb or title, status, then actions on the right with the single primary last but one and an overflow menu (⋯) last.

## Components

`client/src/components/shell/ui.css` holds the app's primitives, prefixed `fx-`: page header, buttons (`fx-btn`, `--primary`, `--ghost`, `--danger`, `--sm`, `--icon`), segmented control (`fx-seg`, a raised white thumb on a tinted track, never a filled block), inputs, filter box, status pills (`fx-status--*`) and dots, summary tiles (`fx-strip`), board lanes and cards, tables, tabs, notices, the line editor (`fx-lines`, `fx-cell`), popovers and menus, dialogs, the palette and toasts, and the kit parts (sheet, bulk bar, badge, switch, affix input, skeleton). The catalogue adds filter chips (`fx-chip`) and the wide item sheet. `menu.tsx` is the anchored menu; `shell-context.ts` gives pages `newQuote()` and `toast(message, undo)`.

The older kit in `client/src/components/field/` (`Button`, `DataTable`, `SegmentedControl`, …) still serves the sign-in screen and the People and Appearance sections of Settings, and holds `<FieldLogo />`; its buttons and badges follow the same sentence-case, soft look. New screens use the `fx-` primitives.

Motion is short and informative: menus and dialogs fade up in about 120ms, board cards lift slightly on hover, a newly added quote row flashes the accent tint once. `prefers-reduced-motion` turns it off.

## Quote editor

The quote is a table: sections as header rows with their subtotal, items as rows (description, quantity, unit, rate, cost and margin when shown, amount), kits collapsed to one row with a disclosure for their parts. Each section ends with an add box: typing searches the catalogue, Enter adds the highlighted item and focuses its quantity; Enter on text with no match adds a one-off line. Row actions (move, move to section, fix the price, hide the price, leave out of the total, reset to catalogue, duplicate, remove) live in the row's ⋯ menu, which appears on hover. Removing shows an Undo toast; ⌘Z and ⇧⌘Z undo and redo.

A rate changed from the catalogue's shows in the warning colour with the catalogue rate on hover. Fixed prices, hidden prices and optional rows carry a small text tag. Scope of works, the payment schedule (share, amount, due days) and validity sit below the table. Drafts save about a second after the last change; the header shows Editing, Saving…, Saved or Not saved. A sent version is read-only with a single "Edit as new version" action.

## Email composer

`/jobs/:id/email-editor` (`client/src/features/job-detail/email-composer-page.tsx`) follows Gmail's patterns in Field's look. The composer is one card in the working column: From, then To with Cc and Bcc on request, as chips that show the name and the address (an incomplete address stays as a red chip with the reason under the row, and Send stays disabled), the subject, the body and the attachment tray. Send sits at the card's bottom left with a menu for Schedule send; Ctrl/⌘ Enter sends, Ctrl/⌘ Shift C and B add Cc and Bcc. The body is plain rich text only (bold, italic, underline, lists, links): no font pickers, because the business's identity is on the document. Merge fields show a dotted underline while composing and are plain in the sent email. The rail shows the customer preview, built by the server with the code that sends, and the job's email. The email saves itself as a draft on the server while it is written ("Draft saved 10:42 am" in the header). Send holds it for 10 seconds with an Undo toast, then the job's Email tab shows it Sending, then Sent; the Send menu also has Send a test to me. A failed send says what happened and how to fix it, and keeps everything. Each send type ticks its default attachments and offers the rest unticked in the tray (a replacement invoice ticks its adjustment note); a follow-up for the same document line goes into the earlier Gmail conversation by default, with a box under the recipients to start a new one. On a phone the composer is full-screen: Send is the round button in the top bar, the menu holds Schedule send, Preview and Discard, Cc and Bcc fold behind a chevron, attachments are a strip under the subject, formatting sits at the bottom and the attachment picker is a bottom sheet.

## Catalogue

The catalogue is one table (`client/src/features/catalogue/`): name first (with "kit · N" for an item built from parts, its tags muted beside it, and a health reason under it when it needs attention), then category, unit, cost, selling and margin, every header sortable. Above it sit the status control (Active, Draft when there are drafts, Archived, All), a "N need attention" chip that filters to items with a health warning, a tag filter and the category chips, in the managed category order. Search matches names, tags, categories and supplier codes. Items have no code a person sees or types: the name is theirs to choose and the uid never changes.

- **Open in place.** Clicking a row opens the item in a wide sheet over the table (`fx-sheet--wide`; the whole screen on a phone), addressed by the URL (`?item=<uid>`), so Back and links work and closing returns to the table with its filters and scroll. "New item" opens the same sheet empty, name first. The sheet holds everything: category and unit, what it is (sold on quotes or a component), cost and selling price with markup or margin shown as they're typed, "Built from" (parts added with the quote editor's type-to-search box, quantities in any unit that converts, a roll-up line), details (tags, notes), suppliers and supplier codes, the kits it's used in, and the dated price history.
- **Saving is deliberate here.** Unlike a quote draft, catalogue prices are history (each change is a new dated row), so edits collect and the sheet's foot shows "Unsaved changes" with Discard and Save changes; the receipt toast names the price change. Closing with unsaved edits asks first. Renaming never changes an item's identity.
- **Archive is not delete.** Archive (in the sheet's ⋯ menu, or for many items at once) hides an item from quotes and keeps everything; restore brings it back. Delete permanently removes the item and takes it out of every kit, after a confirm that says so.
- **Many at once.** Ticking rows docks a bulk bar at the bottom (`fx-bulk--dock`): category, tags, prices (set markup, change cost or fixed selling price by a percentage) and archive or restore. Anything that changes prices or archives shows a confirm with how many items move and the before and after selling and margin ranges.
- **Manage** (header) opens a sheet with Categories, Tags, Units and Suppliers: each entry with its item count and a link that filters the table to it; rename, merge and reorder categories; rename, merge and remove tags; add, rename and archive suppliers. Units are fixed by Field (they carry the conversions) and are listed read-only.

