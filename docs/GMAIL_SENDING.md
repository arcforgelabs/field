# Gmail sending

How Field sends quote and invoice email, which credential path wins, and how to
re-establish sending when it breaks.

Instance-specific values (project IDs, client IDs, service account
identities) live in the installation's secret store, never here.

## Two credential paths, and which one wins

`resolveGmailTransport` in `server/send-quote-email.js` chooses in this order:

1. **Service-account delegation.** Taken whenever a service-account key file is
   configured (`googleServiceAccountKey` / `GOOGLE_SERVICE_ACCOUNT_KEY`) **and**
   a delegated user resolves. Mints a send-only JWT impersonating that user.
2. **Per-user OAuth.** Only reached when there is no key file or no delegated
   user. Uses the signed-in user's refresh token: one granted in the app
   (`GET /api/auth/gmail`, stored in `FIELD_DATA/gmail-oauth-users.json`,
   mode 0600), else `googleOAuth.users[<signed-in email>].refreshToken`,
   falling back to a legacy global `googleOAuth.refreshToken`.
   `GOOGLE_OAUTH_REFRESH_TOKEN`, when set, outranks all of them, and
   `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` outrank the client
   in config.

The delegated user comes from `resolveExpectedGmailUser`, which resolves:

```
FIELD_MAIL_GMAIL_USER  →  user.settings.gmail.email  →  user.email (human)  →  mail.gmailUser
```

Two consequences that are easy to get wrong:

- **A signed-in human always supplies a delegated user**, so a deployment with a
  service-account key never reaches the OAuth path in normal use. Configuring an
  OAuth client does nothing on its own.
- **The signed-in user outranks `mail.gmailUser`.** Sending therefore only works
  for accounts inside the Workspace domain that authorised delegation. A session
  as an outside account fails no matter what the configured default sender says.

`GET /api/auth/gmail` (`server/index.js`) uses a *different* test — it treats
delegation as active only when `FIELD_MAIL_GMAIL_USER` or `mail.gmailUser` is
explicitly set. The two
disagree. That disagreement concealed a live outage once; if you touch
this area, reconcile them.

Drive uploads (`server/drive-upload.js`) prefer the same service-account key and
fall back to OAuth independently. Removing a stale `googleOAuth.refreshToken`
does not affect Drive when a key file is present.

## Choosing a path for a deployment

**Service-account delegation** is the default for a single-tenant customer
install. No user consent, no refresh tokens, nothing that expires. Requires a
Workspace super admin to authorise the service account's client ID for
`https://www.googleapis.com/auth/gmail.send` and
`https://www.googleapis.com/auth/gmail.readonly` under Security → Access and
data control → API controls → Domain-wide delegation. The readonly grant is
required to reconcile a pending stable Message-ID in Sent Mail before retrying.
Costs a long-lived key on the host.

The workstation OAuth helper requests the same `gmail.send` + `gmail.readonly` +
`userinfo.email` set used by Field at runtime. After this set changes, revoke
the old consent and rerun `npm run auth:gmail` so the refresh token carries the
reconciliation scope; existing tokens are not silently upgraded.

**Per-user OAuth** suits deployments where each operator sends from their own
mailbox and no key file exists. The OAuth client **must** live in a Cloud
project inside the customer's own Workspace organisation with the consent screen
set to **Internal**:

- Internal is only offered for projects that belong to a Cloud organisation, and
  admits only users of that organisation. A project created under a consumer
  Google account has no organisation and can never be Internal.
- An External client left in **Testing** expires its refresh token every 7 days.
  Sending dies silently a week after setup.
- Publishing an External client to production instead requires Google
  verification, because `gmail.send` is a sensitive scope.

## Failure signatures

| Symptom | Meaning |
| --- | --- |
| `invalid_grant: Bad Request` on token refresh | The stored refresh token is dead — expired (Testing-mode 7-day clock), revoked, or issued by a client that no longer exists. |
| `invalid_grant: Invalid email or User ID` | Delegation problem, not a token problem. The impersonated subject is outside the domain that authorised delegation, or the service account was never authorised. |
| `Gmail API has not been used in project …` | Gmail API not enabled on the project owning the credential. |
| Transport resolves to `null` | No usable credential at all; Field reports email as unconfigured. |

## Probing without sending

Verify delegation from the host without generating customer mail — a successful
`authorize()` proves the grant, a failure prints the reason:

```js
const jwt = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
  ],
  subject: "<mailbox to impersonate>",
});
await jwt.authorize();
```

Successful sends are recorded per job in `sent-emails.jsonl` beside the job data,
including `authMode`, `gmailUser`, and the Gmail `messageId`. That archive, not
the UI toast, is the evidence to cite. Failures are logged by the service as
`[email-quote] <jobId> failed: …`; successes are not logged, so read the archive.

## Attachments

An email carries the document it is for, any other issued documents of the
same job, and uploads, in that order.

- **Field documents by uid.** `POST /api/jobs/:id/email-quote` and
  `POST /api/jobs/:id/email` take `documents: [{ "uid": "doc_…" }]`
  (`field send-document … --attach doc_…`). The bytes always come from the
  issued-document store, hash-checked, and are named by the document's number
  (`server/documents/email-attachments.js`). Field never renders a document
  again to attach it and takes no file path. A document of another job (409),
  an unknown uid (404), a uid named twice or the email's own document again
  (409), and bytes that fail their hash (410) are refused before anything is
  prepared or sent. Without a database the picker is not offered and a
  `documents` list is refused (503).
- **Events.** After Gmail accepts, each attached document gets an `emailed`
  event with the Gmail message id and `role: "attachment"`, idempotency key
  `emailed:<messageId>:<uid>`. The email's own document keeps its own
  `emailed` event as before.
- **Limits.** At most 10 attachments, 10 MB per upload and 18 MB in total
  across the email's document, Field documents and uploads. Base64 adds a
  third, so 18 MB is about 24 MB on the wire, under Gmail's 25 MB message
  limit. Over a limit is a 413 with the size and the limit, before Gmail is
  called.
- **Large messages.** `messages.send` takes the message in its JSON `raw`
  field only up to about 5 MB (Google's simple-request limit). A message
  over 4 MB of encoded text goes through the media upload form
  (`/upload/gmail/v1/users/me/messages/send`, `message/rfc822`, up to
  35 MB); smaller ones keep the JSON form.
- **Queued and pending sends** (the schedule queue, drafts and the delivery
  outbox) keep each document's uid, number, SHA-256, size and status, never
  its bytes. At dispatch Field reads the bytes again: if they no longer hash
  to the recorded SHA-256, or the document was credited or voided since, the
  send fails for review instead of going out.
- `GET /api/jobs/:id/documents` lists each issued document with `byteLength`
  and `status` (issued, accepted, paid, credited, superseded, void), and
  `notIssued`: the job's draft milestone invoices, which cannot be attached
  until they are issued.

## The composer

The email page (`/jobs/:id/email-editor`) keeps no defaults of its own. It
reads `GET /api/jobs/:id/email-context`: the templates (with their
placeholders), the merge-field values, the default subject, the signed-in
person's signature, the job's own people for the To, Cc and Bcc suggestions
(its contact, then everyone the job already emailed; Google Contacts follow),
the sender and the delivery policy.

- **Merge fields** are defined once, in `shared/email-templates.js`
  (`EMAIL_MERGE_FIELDS`), and their values are worked out by the server
  (`server/email-merge-fields.js`): customer name, job, site address,
  document number, amount due, due date, the invoice a replacement replaces,
  the adjustment note number, the attachment list, the sender's name and the
  business name. In the body a field is `<span data-merge="key">`. When the
  email is built, the server fills every field again with its own value, so
  an invoice issued by the send carries the number it was just given, and a
  field with no value is left empty rather than sent as a placeholder.
- **Signatures** belong to each person (Settings > Email, `GET`/`PUT
  /api/settings/email-signature`, kept in `email-signatures.json` in the data
  directory). Without one the default sign-off is used. Templates end before
  the sign-off.
- **Preview.** `POST /api/jobs/:id/email-preview` takes the same body as a
  send and returns the subject, HTML and attachment list the send would
  produce, from the same functions (`composeDocumentEmail`,
  `composeJobEmail`). It calls no Gmail and issues nothing. A draft invoice's
  number shows as "[number when issued]" until the send issues it.

## Message-ID

Every document send carries a stable `Message-ID: <field-<attempt>@<host>>`,
stored with the delivery attempt when it is prepared, so an interrupted send
can be found in Sent Mail before any retry. The host is `mail.messageIdHost`
(or `FIELD_MAIL_MESSAGE_ID_HOST`) when set, else the domain of the address
Field sends from, else `field.invalid`. An attempt prepared before this host
changed keeps the Message-ID it was stored with (the old host was
`arcforge.local`), so reconciliation still finds it.

## Scheduled sending

The Gmail API exposes immediate message and draft sends but no public operation
equivalent to Gmail's consumer **Schedule send** control. Field therefore owns
the schedule and calls the existing Gmail send path only when an item is due.

Queued records and uploaded attachment bytes live under
`$FIELD_DATA/.scheduled-emails/` with owner-only permissions. A quote send pins
the selected quote version. Invoice and receipt sends also pin the selected
milestone identity and fail for review if it changes before the due time.

Email delivery follows a durable **Draft → Scheduled → Sent** lifecycle.
Cancelling a schedule removes only the delivery time and returns the same record
to Draft with recipients, subject, body, sender/document context, pinned
revision, and attachments intact. Editing a scheduled email performs that same
unschedule operation before opening the draft. Re-scheduling updates the same
record, so an edit cannot leave a duplicate active queue item. Once the worker
has claimed an email, cancellation and editing fail with a conflict rather than
racing Gmail delivery.

The worker claims a record before calling Gmail. If Field restarts while that
call is in progress, it marks the record failed and does not retry
automatically: Gmail's send-only API has no idempotency key, so an uncertain
delivery must be checked in Sent Mail before anyone schedules it again. Only
failures explicitly known to have happened before dispatch are eligible for
bounded retry.

## Google Contacts autocomplete

The email editor loads the signed-in user's Google Contacts through the People API and filters
them locally for the To, Cc, and Bcc autocomplete. Field does not copy contacts
into job data or persist them in the browser. The server keeps an in-memory
five-minute cache per Google identity to avoid repeatedly listing the same
address book.

For the production service-account path, enable `people.googleapis.com` in the
credential's Google Cloud project and add this scope to the existing domain-wide
delegation entry without removing `gmail.send`:

```text
https://www.googleapis.com/auth/contacts.readonly
```

For per-user OAuth, Field requests the same read-only scope alongside
`gmail.send`. Existing refresh tokens must be re-authorized once when this scope
is added. Contact lookup is exposed only to authenticated human Field users;
service tokens cannot read the address book.

## Verification installation

A synthetic verification installation (`FIELD_ENV=field-verification`) runs
under a synthetic identity with native secret lookup disabled, so it holds no
Google credentials by design and cannot exercise the send path. Do not point
the workstation helper (`scripts/setup-gmail-oauth.js`) at it.
