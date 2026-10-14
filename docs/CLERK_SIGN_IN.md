# Clerk sign-in: runbook and cutover

People sign in to Field with Clerk, through Replit's managed Clerk
integration. It is off until
`FIELD_AUTH=clerk` is set. With `FIELD_AUTH` unset, Field signs people in with
email and password exactly as before, so local development, tests and the
quote/invoice proof harness need nothing from Clerk.

## What changes with `FIELD_AUTH=clerk`

| | Password sign-in (unset) | Clerk sign-in (`FIELD_AUTH=clerk`) |
| --- | --- | --- |
| How people sign in | Email and password; Field mints a browser token | Clerk's sign-in, in Field's colours, with Google only (Google Workspace accounts); Clerk keeps sessions |
| Who they are in Field | `users.json` | The PostgreSQL `users` table (the person) and their `org_memberships` row in the deployment's organisation (role `owner` or `staff`, status `active`, `pending` or `disabled`) |
| Someone new | An admin creates them with a password | They sign up or sign in with Clerk, land as `pending` with no access, and an owner approves them in Settings > People |
| Owner-only actions (people, tokens, connecting MCP clients) | Any admin token | An owner signed in with Clerk with a **verified owner sign-in** (below): Google Workspace with no password, or a recent second factor |
| CLI/API bearer tokens | Work | Still work, unchanged. Issuing or revoking them needs an owner signed in as above |
| MCP client OAuth | Approved with email and password | Approved by an owner already signed in with a verified owner sign-in; existing grants keep working |
| `/api/auth/login` | Works | `410 password_login_retired` |
| `authToken` / `FIELD_TOKEN` | Bootstrap password | Owner break-glass key only (below) |

Clerk only proves who someone is. Roles and approval live in Field's
PostgreSQL, never only in Clerk metadata.

### Linking people to their Clerk sign-in

- On the first boot with Clerk sign-in, while the organisation has no
  members, Field copies the people in `users.json` into it, keeping their ids (so their
  tokens and MCP grants still point at them). `admin` becomes `owner`,
  `user` becomes `staff`, all `active`. Service accounts stay in `users.json`
  only. It never imports again: after that, PostgreSQL is the record.
- The first time someone signs in with Clerk, Field links them to the row with
  the same email, but only if Clerk has **verified** that email and it is
  their primary address. An unverified address gets no access and links
  nothing. Field emails are plain ASCII: a non-ASCII address (accents,
  look-alike characters) is refused at sign-in and when adding people.
- A Clerk user whose email Field does not know gets a `pending` row: signed
  in, no access, shown first in Settings > People for an owner to approve,
  decline or ignore.
- Owners can also add someone ahead of time (`POST /api/users` with `email`,
  `name`, `role`); they link on their first verified sign-in.
- Field always keeps at least one active owner, and an owner cannot change
  their own role or turn off their own access.
- Removing someone deletes their membership, and their person row unless
  another organisation still holds them. Someone removed who comes back is a
  new row with a new id, so nothing keyed to the old id returns.
- Owners see and manage only the members of their own organisation
  (row-level security, `docs/PRICING_ENGINE.md` "Tenancy").

### Owner sign-in: Google Workspace (the second factor lives in Google)

Replit's managed Clerk does not support MFA (it is listed under "What's not
supported" in Replit's Clerk Auth docs, and the Clerk dashboard is not
exposed). So owners get their second factor from your Google Workspace,
which enforces 2-Step Verification, and Field checks that the owner really
signed in through it. An owner-only action is allowed when **either**:

- **(a) a second factor in this session**: Clerk's `fva` claim shows a second
  factor, at most `FIELD_OWNER_MFA_MAX_AGE` ago (default `12h`). Kept so that
  if Clerk ever offers MFA here it counts too; or
- **(b) Google Workspace sign-in**: Field asks Clerk's backend API for the
  owner's Clerk user (cached for a minute) and requires all of:
  - a **verified Google** external account whose email equals the owner's
    Field email;
  - that email's domain is listed in `FIELD_OWNER_GOOGLE_DOMAINS`;
  - the Clerk user has **no password** (`passwordEnabled` is false), so
    Google, and its 2-Step Verification, is the only way into that account.

  With `FIELD_OWNER_GOOGLE_DOMAINS` unset, path (b) is off. If Clerk's API
  cannot be reached, the action is refused (`503 owner_check_unavailable`),
  never allowed.

Otherwise the action gets `403 owner_mfa_required`, with a message naming
both ways in. Everyday quoting and invoicing needs neither. Settings shows an
owner whether their sign-in qualifies.

Why this is enough: Field only trusts Google sign-in for owners whose Field
email is on the Workspace domain, Google Workspace enforces 2-Step
Verification for that domain, and with email/password, email codes and
magic links disabled in the Auth pane and no password on the account nobody
can reach it another way.

### Machine access

- **CLI and API tokens** (`field_...`, held in `users.json`) keep working for
  the person or service account they belong to. A token is bound to the id of
  the person it was issued to (never matched by email), so removing someone
  and adding the same email again, or approving them again after they sign in,
  never revives their old tokens. Machine tokens can never do owner-only
  actions. A person and a service account never share an email, whichever
  was added first.
- **Settings, Team, Access** shows owners every command-line token and
  connected agent (MCP installation), one row per person or service account:
  each token's name, when it was created and last used, and what it acts as;
  each agent's client name, who approved it and when, when it was last used
  and its scopes. Never a token's value. Revoke and Disconnect take effect on
  the token's or agent's next request, and each writes an access audit event
  (who, which token or installation and its name, whose, when), listed under
  "Recent changes". An owner revoking their own command-line token stops only
  that token: the `field` command needs `field auth login` again, and their
  sign-in to Field carries on. With password sign-in the browser itself holds
  a token; revoking that one needs `?confirm=current` and signs the browser
  out.
- **Every use of a token or MCP grant is checked** against the person's access
  now: their membership of the deployment's organisation, its status and its
  role in PostgreSQL, and, once they have signed in with Clerk, their Clerk
  account. Removing someone, setting them back to `pending`, turning their
  access off, taking them out of the organisation, or removing, banning or
  locking their account in Clerk stops their tokens and MCP grants at once. A
  demoted owner keeps only what a staff member may do. Field also revokes the
  tokens and MCP installations of someone removed, `pending` or turned off,
  and removing them deletes their `users.json` record. Field asks Clerk about
  the account at most once a minute per person. If Clerk cannot be asked, the
  last good answer stands for up to an hour, then the credential is refused
  with `503`.
- **Tokens go in the `Authorization` header only.** Field never reads a token
  from a URL (`?token=`): URLs end up in logs, browser history and `Referer`
  headers. The app fetches PDFs with the header; with Clerk sign-in a link the
  browser opens directly (an emailed document's PDF, a preview) is authorized
  by the Clerk session cookie, for reads only. A `?token=` on a link is
  ignored.
- **MCP clients (OAuth)** stays Field-issued: client registration, PKCE, scopes,
  tokens and `/mcp` are unchanged, and existing grants carry over. The
  approval page no longer asks for a password: an owner with a verified owner
  sign-in sees "Signed in as ..." and clicks Authorize. Anyone else gets a
  page linking to Field's sign-in, which returns to the approval page
  afterwards; a form submitted after signing out goes back to the same
  request. The `/oauth/*` pages cannot be framed by other sites. An MCP grant
  only ever works within what the person who approved it may do now (above).

## Turning it on in Replit

Replit's Agent provisions the Clerk tenant. Tell it to **provision only**:
Field's auth code already reads `CLERK_SECRET_KEY` and
`CLERK_PUBLISHABLE_KEY`, and the Agent must not rewrite it (no new sign-in
pages, middleware or routes). If it insists on a change, it opens a pull
request instead.

1. In the Replit workspace, open **Tools > Users & Auth** and add Clerk
   authentication. Replit creates the app's Clerk instances (development and
   production are separate) and stores their keys as secrets, so nobody copies
   keys by hand. They are test keys in the workspace and live keys when
   published.
2. Check the **Secrets** pane. Field reads:

   | Variable | Used for |
   | --- | --- |
   | `CLERK_SECRET_KEY` | Server: verifies sessions and looks up a new user's email (`sk_test_...` / `sk_live_...`) |
   | `CLERK_PUBLISHABLE_KEY` | Server hands it to the browser at runtime through `GET /api/auth/config` (`pk_test_...` / `pk_live_...`). `VITE_CLERK_PUBLISHABLE_KEY` is accepted if that is the name Replit uses |
   | `CLERK_PROXY_URL` | Set by Replit's managed Clerk on the published app (`/api/__clerk`). Field serves Clerk's Frontend API on that path (`server/auth/clerk-proxy.js`), so sign-in loads from the app's own origin. Unset: no proxy |
   | `DATABASE_URL` | Required: Field users live in PostgreSQL |

   The browser gets the publishable key from the server at runtime rather than
   from the Vite build, so one build serves both Clerk instances and the build
   step needs no Clerk secret. Field never prints either key; boot logs name
   the variables only.
3. In the Auth pane's **Configure** tab, enable **Google** sign-in only and
   **disable email/password, email verification code and email magic link**.
   The Google Workspace owner check below relies on Google being the only
   way into an owner's account: an email code or magic link is a way in
   without Google's 2-Step Verification. Staff sign in with their Google
   Workspace accounts. Sign-ups are safe either way, since Field gives new
   people no access until an owner approves them.
4. In Google Admin (owner action, on the owner's checklist): enforce **2-Step
   Verification** for your Workspace domain. Field's owner gate
   relies on it.
5. Set these as Replit **configuration** values (not secrets; they are not
   sensitive):

   | Variable | Value | Used for |
   | --- | --- | --- |
   | `FIELD_AUTH` | `clerk` | Turns Clerk sign-in on |
   | `FIELD_OWNER_GOOGLE_DOMAINS` | `example.com` | Owner path (b). Comma-separated; no default, unset turns path (b) off |
   | `FIELD_OWNER_MFA_MAX_AGE` | unset (`12h`) | How long a Clerk second factor counts (path a). Minutes, or `90m`, `12h` |
   | `FIELD_PUBLIC_ORIGIN` | the published `https://` origin | Published app only. Clerk accepts only session tokens minted for this origin (`authorizedParties`); also the MCP OAuth issuer. Leave unset in the workspace, whose preview origin differs |
   | `FIELD_TRUST_PROXY` | unset | `trust proxy` override; see below |

6. Restart. The boot log shows `[auth] owner actions: ... Google Workspace
   sign-in on <your domain> with no password; Clerk authorized parties:
   ...`, then `[auth] imported N user(s) from users.json ...` the first
   time, then `[auth] Clerk sign-in on (CLERK_SECRET_KEY,
   CLERK_PUBLISHABLE_KEY) ...`. Field refuses to start with `FIELD_AUTH=clerk` if a key is missing or
   malformed, a setting above is malformed, or there is no database.

### Client addresses behind Replit's proxy (`trust proxy`)

On Replit every request reaches Field through Replit's proxy. Field sets
Express's `trust proxy` to one hop when it sees Replit (`REPL_ID` or
`REPLIT_DEPLOYMENT`), so `req.ip` is the address Replit's proxy received the
request from, and the break-glass rate limit is per client. One hop, never
`true`: too few trusted hops fails safe (everyone shares one limit), too many
lets a client forge `X-Forwarded-For` and dodge the limit. Elsewhere it stays
off. Check it after publishing: a wrong break-glass attempt logs `from <ip>`;
that should be your address, not a proxy's. If it is always the same
Google/Replit address, set `FIELD_TRUST_PROXY=2`. `FIELD_TRUST_PROXY=0` turns
it off. `true`, and subnets that match every address (`0.0.0.0/0`, `::/0`),
are refused; so is anything that is not a hop count, `loopback`, `linklocal`,
`uniquelocal`, or an IP address or subnet.

## Cutover checklist

Before:

- [ ] The durable PostgreSQL storage and catalogue work has merged and
      `DATABASE_URL` is set; `users.json` is in it.
- [ ] Each person in `users.json` has a Google Workspace account with
      the same (ASCII) email.
- [ ] Google Workspace enforces 2-Step Verification (Google Admin, owner action).
- [ ] Re-check what Replit charges for Clerk Auth (listed as free with no
      monthly-active-user charge when this was built).
- [ ] Note the current `authToken` / `FIELD_TOKEN`: it becomes the break-glass key.

Cutover:

- [ ] Have Replit's Agent add Clerk (provision only; no auth code changes);
      confirm the secret names above.
- [ ] Configure tab: Google on; email/password, email code and magic link off.
- [ ] Set `FIELD_AUTH=clerk` and `FIELD_OWNER_GOOGLE_DOMAINS=<your domain>`
      (and `FIELD_PUBLIC_ORIGIN` for the published app), restart, read the
      boot log lines above.
- [ ] Each owner signs in with Google and opens Settings > People. If the
      People list loads, the owner gate works for them.
- [ ] Review roles. Today every `users.json` person is an admin, so all
      imported people start as owners: demote anyone who should be staff.
- [ ] Revoke browser tokens left over from password sign-in (labelled
      `session`) in Settings, Team, Access (or with
      `DELETE /api/users/:id/tokens/:tokenId`); CLI tokens keep their own
      labels and keep working.
- [ ] Reconnect nothing for MCP clients: check `GET /api/mcp/installations` still
      lists its grant and an MCP tool call works.

Rollback: unset `FIELD_AUTH` and restart. Password sign-in returns with the
same `users.json` (bootstrap passwords included); the PostgreSQL `users` table
is left alone and is used again when Clerk sign-in is turned back on.

## First owner

Field creates no account by default. A new installation gets its first owner
in one of two ways:

- **From config (recommended).** List them in `bootstrapUsers` with
  `"role": "admin"`. Field writes them to `users.json` at boot, and the first
  boot with Clerk sign-in, while the organisation has no members, copies them
  into PostgreSQL as `owner`. They link on their first verified Clerk sign-in.
- **With break-glass.** With nobody listed, the first person who signs in
  lands as `pending`. Approve them as owner with the break-glass key:

  ```bash
  read -rs FIELD_BREAK_GLASS   # the deployment's authToken / FIELD_TOKEN
  curl -sS -H "X-Field-Break-Glass: $FIELD_BREAK_GLASS" https://<field-host>/api/users        # find their id
  curl -sS -X POST -H "X-Field-Break-Glass: $FIELD_BREAK_GLASS" -H "Content-Type: application/json" \
    -d '{"role":"owner"}' https://<field-host>/api/users/<id>/approve
  unset FIELD_BREAK_GLASS
  ```

An installation that already has people (any upgrade, including one moving
from an older release that had a built-in default user) is unaffected: the
import never runs again, and PostgreSQL stays the record of who may sign in.

## Break-glass (owner emergency access)

If Clerk is down or no owner can get a verified owner sign-in, an owner can
act with the deployment's `authToken` (`FIELD_TOKEN`) in the
`X-Field-Break-Glass` header. It only works with Clerk sign-in on, never as a
Bearer token or URL parameter, and it acts as an owner for the API, including
the owner-only routes (people, tokens).

```bash
read -rs FIELD_BREAK_GLASS   # paste the key; it is not echoed or kept in history
curl -sS -H "X-Field-Break-Glass: $FIELD_BREAK_GLASS" https://<field-host>/api/users
unset FIELD_BREAK_GLASS
```

Every use is logged as `[auth] BREAK-GLASS OWNER ACCESS USED: <method> <path>
from <ip>` (the key never is), wrong keys as `BREAK-GLASS refused`, and each
client gets 5 attempts per 15 minutes (then `429`), per client address (see
`trust proxy` above). After using it, rotate `FIELD_TOKEN` and go back to
signing in with Clerk.

## Not verified yet

This was built and tested with Clerk mocked (no network) and booted with
dummy keys. Not yet exercised against a real Clerk instance:

- the exact secret names Replit's integration sets;
- the shape Clerk's backend API returns for a Google-only user (`provider`
  `oauth_google`, `passwordEnabled: false`) on Replit's managed tenant;
- how many proxy hops Replit puts in front of a published app (`trust proxy`);
- Clerk's session-cookie refresh on the MCP approval form (a stale cookie on
  the POST would send the owner back to sign in);
- Clerk's sign-in widget alongside Field's hash routes on a real phone.
