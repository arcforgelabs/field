# Public Repo Checklist

This repository was published as a single-commit snapshot of Field on
2026-10-12, sanitised from the private development repository. No history was
carried over. This file records what was removed or changed so a reviewer can
check it, and what a new installation must supply itself. It replaces the
April 2026 pre-publication audit; every open item from that audit is closed
below.

## Customer data

- No customer quotes, PDFs, screenshots, measurements or job data are in the
  repository. Test fixtures and sample scripts that carried real customer
  names, street addresses or quote numbers now use fictional ones
  ("12 Sample Street, Exampleton", "Casey", "Sam Sample").
- `docs/lessons-learned.md` no longer names the customers whose quotes
  reported a bug.

## Business and commercial data

- The production quote catalogue's contents are replaced by a **sample**.
  The file and its id stay `quote-catalogs/embark-default.json5` /
  `embark-default`, because stored quotes and job records name that id. It
  keeps the rule, quantity-rule and assembly
  structure the quote engine and its tests depend on. It never held prices
  (every rate comes from the PostgreSQL price catalogue); its productivity
  factors are illustrative.
- Business-profile fallbacks (`server/quote-artifacts.js`,
  `server/quote-email-template.js`, `server/retaining-wall-commercial.js`,
  `generate-landscaping-quote.js`, email sign-offs and subjects) are generic
  placeholders: "Your Business", "Your Business Pty Ltd", a blank ABN, "Your
  business address", `quotes@example.com`, and a dummy bank account
  (`000-000` / `00000000`). The real ABN, address, email and bank details are
  gone.
- The price book clean-up plan (`server/data-migrations/price-book-cleanup.plan.json`),
  which was built from one business's production catalogue, is removed. The
  data-migration framework stays; with no plan file the clean-up migration
  is reported as `deferred` and not recorded, so an installation can still
  supply its plan later.
- Applied migrations are unchanged byte for byte, so migration `0005_tenancy`
  still seeds the first organisation as "Embark Earthworks" with slug
  `embark` (the `FIELD_ORG` default). Only the constant's name changed, to
  `DEFAULT_ORG_UID`; its value is the same.
- Other identifiers that stored data names are unchanged: theme ids (the
  legacy `gohub` alias included), the `EQ`/`EI`/`ER` number prefixes,
  data-migration ids, storage paths, and the `@arcforge.local` domain of
  outgoing Message-IDs, which pending sends are reconciled by.
- People's names and emails in config examples, tests and docs are replaced
  by `example.com` addresses and fictional names.

## Infrastructure, deployment and secrets

- Removed: the scripts and config that only deployed to the original
  operators' own servers (`deploy.sh`, `migrate-data-root.sh`,
  `scripts/deploy-demo.sh`, `scripts/deploy-verification.sh`,
  `scripts/publish-release.sh`, `ops/production/Caddyfile`,
  `FIELD-VERIFICATION-CONTRACT.yaml`, the release/verification workflow and
  its gate scripts under `scripts/verification/`), with their SSH host
  aliases, server paths, public IP and port, and runner labels.
- `scripts/setup-gmail-oauth.js` takes `--host` (or `FIELD_VPS`), `--email`
  and `GOOGLE_CLOUD_QUOTA_PROJECT`; it no longer names any host, project or
  person, and derives the remote user's runtime directory instead of
  assuming UID 1000.
- There is no implicit bootstrap user: an installation lists its
  `bootstrapUsers` in config, and no placeholder admin is ever created. A Clerk installation's first
  owner comes from those `bootstrapUsers` or from break-glass approval
  (README "First owner").
- The synthetic verification runtime (`FIELD_ENV=field-verification`) is kept
  because the server validates it at boot; its contract no longer names any
  real host, domain, path or image repository.
- `.replit` is unchanged: it is Embark's own Replit deployment file, and keeps
  `FIELD_OWNER_GOOGLE_DOMAINS = "embarkearthworks.au"`, which restricts owner
  sign-in. Production URLs, DNS and workspace names are gone from
  `docs/REPLIT.md` and the other docs.
- Removed Sentry trace-propagation targets for the original production
  domains.
- No `.env` files, keys, tokens or OAuth client secrets are committed. The
  only Google client id present is the public Google Cloud SDK id, used as a
  deny-list check. gitleaks runs in CI.

## Private repositories and internal tooling

- Removed: workflows that need secrets or private reusable workflows
  (Barnacle, labeler, maintainer command reactions, ClawSweeper dispatch,
  release verification) and their tests; the org-consistency skill and agent
  skill tied to private tooling; internal planning and episode documents;
  the OpenClaw plugin package (the MCP pricing core it carried is now
  `server/mcp/quoting-core.js`); historical concept labs and design briefs.
- `.github/workflows/` keeps CI (server tests against PostgreSQL, client
  typecheck/tests/build, Docker build), the PR-context check (now
  `.github/scripts/pr-context-check.py`, standalone) and gitleaks. None need
  repository secrets.
- Issue forms are Field's own.

## Kept on purpose

- The design-system theme families are ported from the OpenClaw Control UI
  themes (MIT). `shared/theme-palettes.js`, `scripts/port-openclaw-themes.mjs`
  and `DESIGN.md` keep that attribution, as the MIT licence requires.
- `earthworks` appears as industry vocabulary (rule stages, section labels,
  identifiers such as `earthworkPlan`).
- Quote numbers in tests (`EQ-YYMM-NN`) are synthetic examples of the number
  format.
- Default port 19200, `/opt/apps/field` in examples, and `field.service` are
  generic defaults an operator would change.

## What a new installation needs

- A PostgreSQL database (`DATABASE_URL`), or PGlite for local development.
- A price catalogue with at least one active item before first boot (see
  `README.md` "Getting started").
- Its own business profile and payment details, set as `businessProfile` in
  config (`FIELD_CONFIG_JSON`; README "Business profile"), and its own quote
  rules in place of the sample catalogue's.
- Its own sign-in, email and MCP configuration (`docs/CLERK_SIGN_IN.md`,
  `docs/GMAIL_SENDING.md`, `docs/REMOTE_MCP.md`).
