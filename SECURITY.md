# Security Policy

If you believe you've found a security issue in Field, report it privately
first.

Field holds a business's quotes, invoices, customer contacts, sent email and
site evidence, and the credentials it uses to send them. Each installation
serves one business, and that business is one trusted operator boundary.

## Report a Security Issue

Use GitHub's private vulnerability reporting: the **Security** tab of this
repository, then **Report a vulnerability**. Do not open a public issue for a
security problem, and do not paste an exploit payload, customer data or a
credential value anywhere public.

### What We Need

- What you found and why it is security-relevant.
- The affected route, file or configuration.
- What boundary was crossed, and the impact you can show.
- The version (commit) you tested.
- For an exposed credential: its name and location. **Never its value**, in
  full or in part.

### What Usually Is Not a Security Bug

- Prompt injection against an AI system that drives Field, without a bypass of
  Field's sign-in, token scope or approval. Field calls no models, and a model
  is not a trusted principal.
- A trusted operator of an installation using an intentional feature of it.

## Trust Model

- **One installation per business.** Each installation runs with its own
  database, data directory, configuration and secrets. Installations never
  share data or credentials.
- **People.** With `FIELD_AUTH=clerk`, people sign in with Clerk, and Field's
  PostgreSQL holds their role (`owner` or `staff`) and approval. Without it,
  they sign in with email and password. Owner-only actions need a verified
  owner sign-in (`docs/CLERK_SIGN_IN.md`).
- **Machine access.** A CLI/API bearer token, or the owner break-glass key
  (`authToken`, `FIELD_TOKEN`), acts as an operator of that installation;
  whoever holds one is trusted. AI agents connect through OAuth MCP, limited
  to the scopes the approving person holds (`docs/REMOTE_MCP.md`).
- **Sent documents are records.** A quote or invoice a customer has been sent
  is never changed in place; a change produces a new version. Tampering with
  that history is a security issue.

## Rules Held Hard

- Never commit customer production data, credentials, raw private messages or
  runtime state (`data/`, a job directory, the database). Tests and demos use
  sanitized fixtures such as `scripts/verification/fixtures.js`.
- Secrets live in the installation's secret store (for example Replit Secrets:
  `FIELD_CONFIG_JSON`, `DATABASE_URL`, and the others in `docs/REPLIT.md`),
  never in the repository, a log, an issue or a pull request. Name the
  variable, never its value.
- Credentials Field stores at runtime, such as Gmail OAuth refresh tokens, stay
  inside the installation's data directory, written with mode `0600`.
- Surveyor artifacts (`.artifacts/`) are customer data. Never commit them, and
  never attach raw evidence to an issue.
- Error reports to Sentry pass through `shared/sentry-scrub.js` on the server
  and in the browser, and session replays mask all text and inputs
  (`docs/REPLIT.md`, "Error monitoring (Sentry)"). A change that sends more
  to Sentry extends that scrubbing and its tests in the same pull request.
- CI runs gitleaks on every push and pull request
  (`.github/workflows/secret-scan.yml`).

## Out of Scope

- Vulnerabilities in a third-party service Field connects to (Clerk, Google,
  Replit, Sentry): report them to that vendor.
