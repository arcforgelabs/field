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
- **Account and tax.** The sales account (default `200`, "Sales" in Xero's
  standard chart) and the GST tax type (default `OUTPUT`, "GST on Income" in
  Australia). Once Xero is connected, both are lists of the organisation's
  own active revenue accounts and active tax rates for sales, read from Xero
  (`accounting.settings.read`). A saved code is checked against them, so an
  account Xero would refuse is caught here, not on an invoice. When Field
  cannot read them, the screen says so and the codes are typed; they are then
  saved with a warning. Lines without GST use `EXEMPTOUTPUT` ("GST Free
  Income").

Only invoices issued after Create in Xero is turned on go to Xero by
themselves. Invoices issued before that, or while it was Off, go only when an
owner sends them.

## What Field creates in Xero

When Field issues an invoice, it does not wait for Xero. After the issue
commits, `server/xero/invoice-sync.js` sends the invoice to Xero. A tick
every minute picks up anything that is still waiting. Issuing and emailing
never wait on Xero, and never fail because of Xero.

For each invoice, Field creates one Xero sales invoice (`ACCREC`):

| Xero | From Field |
| --- | --- |
| `InvoiceNumber` | Field's number, for example `INV-2026-10-1` |
| `Reference` | The job and the accepted quote, for example `Job 2610-07 · Quote EQ-2610-07 v2` |
| `Status` | `DRAFT`. For Approved invoice, Field approves the draft (`AUTHORISED`) only after its totals match Field's |
| `Contact` | Found by the customer's email, else by name, else created. Archived contacts are not used |
| `Date`, `DueDate` | The issue date, and the due date (the issue date when Field has none) |
| `LineAmountTypes` | `Exclusive` |
| Lines | One for each line of Field's invoice, with the sales account code, the GST tax type and the GST that Field calculated |
| Attachment | Field's issued PDF, the exact stored bytes, shown online with the invoice |

Field sends the GST of each line, so Xero's totals equal Field's to the cent.
Field always creates the invoice as a draft first, then compares Xero's
subtotal, GST and total with its own. If they differ, the invoice stays a
draft and shows **In Xero, totals differ**, with both sets of figures. In
Approved mode, only a draft whose totals match is approved, and its totals
are checked again after.

The Xero invoice id, its organisation and its status are stored on Field's
invoice row (`invoices.xero_invoice_id`, `xero_tenant_id`, `xero_status`,
migration `0018_xero_invoice_sync`). Every Xero invoice an invoice has had is
also kept in `xero_invoice_links`, which is append-only. Each invoice's
progress is in `xero_invoice_syncs`, for one organisation.

### Another organisation

Each queued invoice belongs to the Xero organisation it was queued for. If
the owner disconnects and connects a different organisation:

- invoices still queued for the old one are **held**. They are never sent to
  the new organisation by themselves;
- invoices already in the old one show **In another Xero organisation**;
- an owner can send either kind to the new organisation with **Send to Xero**
  (after the preview). The old Xero id then counts as unknown, and the new
  one replaces it on the invoice row. The old one stays in
  `xero_invoice_links`; the database refuses to replace an id whose history
  is not recorded, or to change an id within one organisation.

### Two servers at once

A server claims an invoice with a five-minute lease before it sends it, and
every write it makes names that lease. During an overlapping republish, two
servers never send the same invoice, and a late one never overwrites the
other's result.

### No duplicates

- Each create call has an `Idempotency-Key` derived from Field's invoice uid,
  the organisation and the request (`field-<invoice uid>-invoice-<hash>`).
  Xero keeps keys per app, so the organisation is part of the hash: the same
  invoice sent to another organisation never reuses a key.
- Xero keeps idempotency keys for only 6 minutes. So before it creates an
  invoice, Field asks Xero whether an invoice with that number exists, and
  uses that invoice if it does.
- Field stores the Xero id as soon as Xero returns it. A retry then attaches
  the PDF or checks the totals. It does not create the invoice again.

### On the job's Invoices tab

Each issued invoice shows its Xero state:

| State | Meaning |
| --- | --- |
| Xero draft created, Approved in Xero | In Xero, with its PDF, and the totals match |
| Sending to Xero | Queued, or waiting to try again; the reason is shown |
| Waiting for Xero | The owner must connect Xero again |
| Xero failed | Xero refused it, or retries ran out. Xero's reason is shown |
| In Xero, totals differ | Created, but Xero's totals differ from Field's |
| Not sent to Xero | Issued before Xero was connected, or credited before it reached Xero |
| Held: another Xero organisation, In another Xero organisation | Queued for, or created in, the organisation connected before (above) |
| Void this in Xero | Credited or voided in Field after it reached Xero. Void or credit it in Xero; phase 2 does this itself |

Everyone signed in sees the state. Owners also get **Retry**, and **Send to
Xero** for an invoice that was not sent.

### Retries

- **Retryable:** Xero cannot be reached, answers 5xx or 429, or asks for a
  new sign-in. Field tries again after 1, 2, 4 … minutes, up to an hour, and
  never sooner than Xero's `Retry-After`. A `Retry-After` of 5 seconds or
  less is waited out at once. After 8 tries the invoice shows Xero failed,
  and an owner can retry it.
- **Not retryable:** Xero refused what was sent (validation), the PDF is over
  Xero's 10 MB limit, or the invoice has no customer name or email. The
  invoice shows Xero failed with the reason. Fix the cause, then press Retry.
- **Connect again:** while the owner must connect again, invoices wait. They
  go as soon as Xero is connected again.
- **A contact Xero refuses** (removed, archived or merged since Field found
  it) is forgotten and looked up again once in the same send. Retry and Send
  to Xero always look the contact up again.
- **Create in Xero Off:** invoices Field queued by itself wait, even ones
  waiting to retry. Invoices an owner sends or retries still go, as drafts.

### Invoices issued before the connection

Field does not send them by itself. In Settings, Integrations, Xero,
**Invoices issued before** previews the invoices issued in the last 30 days,
90 days or 12 months that are not in Xero yet. The owner chooses which ones
to send. On an invoice's row, **Send to Xero** does the same for one invoice.
Both show the preview before anything is sent.

### Not in phase 1

- Adjustment notes as Xero credit notes, and voids (phase 2). An invoice that
  is credited in Field before it reaches Xero is not sent. An invoice that is
  credited after it reached Xero stays in Xero as it was, and shows **Void
  this in Xero**.
- Payments recorded in Field as Xero payments (phase 3).
- Emailing from Xero (phase 4).

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

Field numbers its invoices (`INV-YYYY-M-N`, #39), and the Xero invoice takes
Field's number. `xero_connections` has an `invoice_numbering` column for a
later owner setting, "Invoice numbers come from: Field / Xero". Only `field`
is allowed now.

In the later Xero mode, issuing creates the Xero invoice first, without an
`InvoiceNumber`, so Xero allocates the number from its own sequence. Field
then draws its PDF with that number. If Xero cannot be reached, the issue is
refused, and Field never falls back to its own number. Xero's docs say that
an `ACCREC` invoice without an `InvoiceNumber` is numbered from the
organisation's invoice settings, and the create response carries
`InvoiceNumber` (links below).

The Reference names the job and the quote in Xero. Field's own PDF keeps the
reference it prints today, so Field's documents stay byte-identical. The
issue asks for the same reference on Field's PDF; that is a separate change.

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
- Invoices: `ACCREC`, `DRAFT` and `AUTHORISED`, `InvoiceNumber`
  ("when missing will auto-generate from your Organisation Invoice
  Settings"), `Reference` (up to 255 characters), `LineAmountTypes`,
  `AccountCode`, `TaxType`, an overridable `TaxAmount`, `unitdp=4`, and
  `Total = SubTotal + TotalTax`. Emailing is its own call
  (`POST /Invoices/{id}/Email`), which Field never makes:
  [invoices](https://developer.xero.com/documentation/api/accounting/invoices),
  [requests and responses](https://developer.xero.com/documentation/api/accounting/requests-and-responses),
  [response codes](https://developer.xero.com/documentation/api/accounting/responsecodes),
  [OpenAPI](https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero_accounting.yaml).
- `Idempotency-Key`: on POST, PUT and PATCH, up to 128 characters, kept for 6
  minutes, the cached answer replayed, and a different request with the same
  key refused:
  [idempotency](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency).
- Contacts: `searchTerm` across name and email; PUT creates and refuses a
  name that exists:
  [contacts](https://developer.xero.com/documentation/api/accounting/contacts).
- Attachments: `PUT /Invoices/{id}/Attachments/{FileName}` with the raw bytes,
  `IncludeOnline=true`, 10 attachments a document:
  [attachments](https://developer.xero.com/documentation/api/accounting/attachments).

Not confirmed in Xero's documentation:

- Whether a web app with a client secret may also send a PKCE
  `code_challenge`. Xero's identity server advertises `S256`, but no page
  says which apps may use it. Field does not send one.
- That account `200` is "Sales" in every Australian organisation. Xero's own
  examples use it. Check your chart of accounts and change the setting if it
  differs.
- The labels on developer.xero.com's app form. The portal needs a login. The
  steps above use plain words for that reason.
- That an update naming only `InvoiceID` and `Status` keeps the invoice's
  lines. Xero's docs say lines left out of an update are deleted, but give
  the approval of a draft without lines as the usual way. Field checks the
  totals in Xero's answer to the approval too, so a change would show as
  "totals differ".
- Whether `AUTHORISED` needs a `DueDate`. Xero's example of an approved
  invoice has one, so Field always sends one.
- Whether Xero refuses a duplicate `InvoiceNumber` or only warns. Field looks
  the number up before it creates an invoice, so it does not depend on the
  answer.
- The attachment size limit: the attachments page says 10 MB, the invoices
  page 25 MB. Field uses 10 MB.
- That a `DRAFT` invoice in particular is auto-numbered. The docs do not say
  the rule depends on the status. Check this against a Xero demo company
  before the Xero numbering mode is built.
- The exact values of `X-Rate-Limit-Problem`. Field shows the value as Xero
  sends it.
