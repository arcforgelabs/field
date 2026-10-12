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
   user. Uses `googleOAuth.users[<signed-in email>].refreshToken`, falling back
   to a legacy global `googleOAuth.refreshToken`.

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
delegation as active only when `mail.gmailUser` is explicitly set. The two
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
