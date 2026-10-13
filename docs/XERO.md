# Xero

Field can create a matching invoice in your own Xero organisation for every
invoice it issues (#93). Each installation connects through a Xero app that
its owner creates. There is no shared Field Xero app, so no one else ever
holds your Xero sign-in.

This guide uses `https://<your-field-host>` for your installation's address.
Settings, Integrations, Xero shows your real values: the redirect address to
paste into Xero, and whether each secret is set. Copy them from that screen,
not from this page.

## Set up your Xero app

You need a Xero login that can manage the organisation, and owner access to
Field.

1. Sign in at [developer.xero.com/app/manage](https://developer.xero.com/app/manage)
   with your Xero login, and create a new app.
2. Choose **Web app**: the authorization code flow, with a client secret. Do
   not choose a PKCE (mobile or desktop) app or a custom connection.
3. Give it a name, for example "Field", and your company's website.
4. For the redirect address, paste the one that Settings, Integrations, Xero
   shows. It has this form:

   ```text
   https://<your-field-host>/api/integrations/xero/callback
   ```

   Field builds it from the `publicUrl` in its configuration (on Replit, in
   `FIELD_CONFIG_JSON`). Field never builds it from the address a request
   came to, because a client controls that. Until `publicUrl` is set, the
   screen asks for it and Connect stays off.
5. In the app's configuration, copy the client id and generate a client
   secret. Xero shows the secret once.
6. Add both as deployment secrets, then restart Field. On Replit, add them in
   Secrets and republish (`docs/REPLIT.md`, "Configuration"):

   | Secret | Value |
   | --- | --- |
   | `XERO_CLIENT_ID` | The app's client id |
   | `XERO_CLIENT_SECRET` | The app's client secret |

7. In Field, open Settings, Integrations, Xero. Both secrets show **Set**.
   Press **Connect to Xero**, sign in to Xero, and allow access for your
   organisation.
8. If your Xero sign-in reaches more than one organisation, choose the one
   Field writes to.

Never paste the client secret into chat, an issue, a pull request or a file in
the repository. Name the secret, never its value (`SECURITY.md`).

A new Xero app starts on Xero's free Starter plan. Starter allows 5
connections and 1,000 API calls a day for each organisation. Field uses one
connection, and a few calls for each invoice.

## What the screen does

Settings, Integrations, Xero is for owners only. Every route behind it checks
the owner on the server.

- **Connection.** Connect, the organisation, Connect again, and Disconnect.
  Disconnect revokes Field's sign-in at Xero and forgets it. Invoices already
  in Xero stay there. The settings are kept.
- **Create in Xero:**
  - **Off.** Field creates nothing in Xero.
  - **Draft invoice.** This is the default. Xero status `DRAFT`.
  - **Approved invoice.** Xero status `AUTHORISED`. Xero does not email it:
    customers get Field's own invoice email.

  Email from Xero is a later phase. It is not built.
- **Account and tax.** The sales account code (default `200`, "Sales" in
  Xero's standard chart) and the GST tax type (default `OUTPUT`, "GST on
  Income" in Australia). Change them to match your chart of accounts. Lines
  without GST use `EXEMPTOUTPUT` ("GST Free Income").

Only invoices issued after Create in Xero is turned on go to Xero by
themselves. Invoices issued before that, or while it was Off, go only when an
owner sends them.

## How Field keeps the sign-in

- The client id and client secret come only from the deployment secrets.
  They are never stored in the database or sent to the browser.
- Field asks Xero for these scopes: `offline_access` (for the refresh token),
  `accounting.invoices`, `accounting.contacts`, `accounting.attachments` and
  `accounting.settings.read`. Apps created from 2 March 2026 get Xero's
  granular scopes, and cannot ask for the older `accounting.transactions`.
- The tokens are stored in PostgreSQL (`xero_connections`, migration
  `0017_xero_connection`), encrypted with AES-256-GCM
  (`server/xero/token-crypto.js`). The key is derived from
  `XERO_CLIENT_SECRET` with HKDF, so a database dump or backup alone does not
  give the tokens. Each value is bound to its organisation and column.
- Before this, Field encrypted no stored credential: Gmail refresh tokens are
  a mode-0600 file in the data directory (`server/gmail-oauth-store.js`).
  The Xero tokens follow the target in `docs/PRICING_ENGINE.md`, "Everything
  else moves to tables too": tokens in PostgreSQL, encrypted at rest.
- Access tokens last 30 minutes. Field refreshes one shortly before it
  expires. Xero rotates the refresh token on each refresh, so Field stores
  the new one in the same transaction, under a row lock: two servers never
  spend the same refresh token.
- The sign-in in progress is kept only as a hash of its random state, for 10
  minutes. The callback acts only on that state, once. A callback with any
  other state is refused and leaves the sign-in in progress as it was.
- Logs and Sentry get codes, never a token, a code or a secret.
  `shared/sentry-scrub.js` also removes bearer tokens, JSON web tokens and
  OAuth values from any free text.

## When the owner must connect again

The screen shows **Connect again**, with the reason:

| Code | Why | What to do |
| --- | --- | --- |
| `XERO_REFRESH_REJECTED` | Xero refused the refresh token: it was revoked at Xero, or was not used for 60 days | Connect again |
| `XERO_CLIENT_REJECTED` | Xero did not accept `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` | Check both secrets, restart Field, then connect again |
| `CLIENT_SECRET_CHANGED` | `XERO_CLIENT_SECRET` changed after Xero was connected, so the stored tokens cannot be decrypted | Connect again |
| `XERO_FORBIDDEN`, `XERO_SCOPE_MISSING` | Xero refused the organisation, or the sign-in lacks a scope | Connect again, and allow access |

## When connecting fails

The callback returns to Settings, Integrations, Xero with a code:

| Code | Why |
| --- | --- |
| `XERO_STATE_INVALID` | The sign-in was not started here, was used already, or took longer than 10 minutes. Press Connect again. A wrong state changes nothing, so a guessed request cannot cancel a sign-in in progress |
| `XERO_ACCESS_DENIED` | You cancelled at Xero. Nothing changed |
| `XERO_AUTHORISE_REFUSED` | Xero refused the request. Check the redirect address in your Xero app |
| `XERO_NO_ORGANISATION` | No organisation was connected. Choose one at Xero |
| `XERO_CLIENT_REJECTED` | Xero did not accept the client id and secret |

## Invoice numbers

Field numbers its invoices (`INV-YYYY-M-N`, #39). `xero_connections` has an
`invoice_numbering` column for a later owner setting, "Invoice numbers come
from: Field / Xero". Only `field` is allowed now.

## Tests

The tests never call Xero. `server/xero/fake-xero.js` is a fake Xero on
127.0.0.1 that behaves as Xero's documentation says. The server uses it only
when `FIELD_XERO_FAKE_BASE_URL` is a loopback `http` address; Field refuses
any other value.

## Xero's documentation

What Field relies on, as read on 2026-10-13:

- Authorization code flow, token lifetimes (access token 30 minutes, refresh
  token 60 days), refresh-token rotation with a 30-minute grace period for
  the previous token, `GET /connections`, `DELETE /connections/{id}` and
  revocation:
  [auth flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow),
  [OAuth 2.0 FAQ](https://developer.xero.com/faq/oauth2),
  [troubleshooting](https://developer.xero.com/documentation/guides/oauth2/troubleshooting).
- PKCE is for apps that cannot keep a client secret:
  [PKCE flow](https://developer.xero.com/documentation/guides/oauth2/pkce-flow).
  A web app uses the code flow with its secret.
- Scopes, and the granular scopes for apps created from 2 March 2026:
  [scopes](https://developer.xero.com/documentation/guides/oauth2/scopes),
  [granular scopes FAQ](https://developer.xero.com/faq/granular-scopes).
- Plans and limits (Starter: 5 connections, 1,000 calls a day for each
  organisation; 60 calls a minute; 5 at a time; HTTP 429 with
  `Retry-After`):
  [pricing](https://developer.xero.com/pricing),
  [limits](https://developer.xero.com/documentation/guides/oauth2/limits).
- Tax types (`OUTPUT`, `EXEMPTOUTPUT`):
  [types](https://developer.xero.com/documentation/api/accounting/types).

Not confirmed in Xero's documentation:

- Whether a web app with a client secret may also send a PKCE
  `code_challenge`. Xero's identity server advertises `S256`, but no page
  says which apps may use it. Field does not send one.
- That account `200` is "Sales" in every Australian organisation. Xero's own
  examples use it. Check your chart of accounts and change the setting if it
  differs.
- The labels on developer.xero.com's app form. The portal needs a login. The
  steps above use plain words for that reason.
