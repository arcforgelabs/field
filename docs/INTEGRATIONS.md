# Integrations

Field connects to other systems a business already uses. Xero is the first
(`docs/XERO.md`). This page is the part every integration shares: where its
credentials are entered, how Field stores them, who may change them, and how
to rotate the key that protects them.

This guide uses `https://<your-field-host>` for your installation's address.
Settings, Integrations shows your real values.

## Who sees what

- Everyone who can open Settings sees **Settings, Integrations**: whether
  each integration is set up and connected. Who changed it, when, and the
  recent changes are shown to owners only.
- Only the people allowed to manage the organisation's integrations (owners
  today) can enter credentials, connect, replace or disconnect. The server
  enforces this on every route that changes anything. Everyone else sees the
  same screen read-only.
- API and MCP tokens (service accounts, and personal tokens with Clerk
  sign-in) get no integration settings at all, and can never change them. A
  token whose permissions include `integrations:read` may read the status,
  as a non-owner sees it.

## Credentials are entered in Settings

An integration's own credentials, for example a Xero app's client id and
client secret, are entered on its screen in Settings, Integrations.

- They are **write-only**. Field never shows them again. The screen shows only
  "Set · last changed by <person> on <date>", with **Replace** and
  **Remove**.
- They never reach the browser, a log, Sentry or the MCP server.
- Every change writes an audit event with who and when, never the value:
  credentials entered, replaced or removed, connected, disconnected. The
  screen lists the recent ones under "Recent changes".
- They are stored per organisation (`integration_credentials`, with the
  organisation's `org_uid` and row-level security). Another installation, or
  another organisation in one installation, stores its own.

A self-hoster can still put an integration's credentials in the deployment
environment, for Xero `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`. When both are
set they override the ones entered in Settings, and the screen says so. The
Settings screen is the default path.

## The key: FIELD_SECRETS_KEY

Field encrypts every stored credential and OAuth token with one key, the
deployment secret `FIELD_SECRETS_KEY`.

- It is its own secret: never `SESSION_SECRET`, and never derived from an
  integration's credentials. Rotating a Xero app's client secret therefore
  loses nothing.
- **Make it with your password manager.** In Bitwarden, open the password
  generator and make a password of 40 characters or more, with upper case,
  lower case and numbers. Any random string of at least 40 characters works;
  Field turns it into its 32-byte key with HKDF-SHA256. Use a generated
  string, never a phrase you made up: the key is only as strong as the
  string. Leave commas out, because `FIELD_SECRETS_KEY_PREVIOUS` separates
  keys with commas.
- A key of 32 random bytes in base64, or 64 hex characters, also works, and
  is used as it is. To make one on a computer with Node.js:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```

- Anything shorter than 40 characters that is not such a key is refused
  (`SECRETS_KEY_INVALID`), and the screen says so.

  Put the key in the deployment's secrets (on Replit, Secrets), then restart or
  republish Field. Never paste it into chat, an issue, a pull request or a
  file in the repository. Keep a copy in your password manager: without it,
  the stored credentials and tokens cannot be read.
- Field uses AES-256-GCM with a fresh nonce for every value, and binds each
  value to its organisation, integration and field. Each value records the
  id of the key that wrote it (a hash of the key, never the key).
  `server/secrets/` is the module every integration uses.
- **It fails closed.** If `FIELD_SECRETS_KEY` (or a value in
  `FIELD_SECRETS_KEY_PREVIOUS`) is missing, is too short, or cannot read a
  stored value, nothing is stored or sent. The screen says which, and a
  connected integration shows "Connect again". Field does not store that
  state: once the key is fixed, the integration is connected again by
  itself.

## Rotating the key

1. Make a new key (above), for example a new 40-character password from the generator.
2. Set `FIELD_SECRETS_KEY_PREVIOUS` to the current key, and
   `FIELD_SECRETS_KEY` to the new one. Several previous keys can be listed,
   separated by commas.
3. Restart or republish Field. At boot it reads every stored value with the
   key that wrote it and writes it again with the new key. Xero tokens are
   re-encrypted the same way, under a lock, so a refresh on another server
   is never lost. A credential an owner replaces during this is kept.
4. Check Settings, Integrations: each integration is still set up and
   connected.
5. Remove `FIELD_SECRETS_KEY_PREVIOUS` and restart again.

If you set the new key without keeping the old one in
`FIELD_SECRETS_KEY_PREVIOUS`, nothing is lost yet: integrations show
"Connect again" until you add the old key, then recover. If the old key is
lost for good, the stored values cannot be read: enter the credentials again
and connect again.

## Upgrading from the first Xero release

The first Xero release (#94) read the Xero app's credentials only from
`XERO_CLIENT_ID` and `XERO_CLIENT_SECRET`, and encrypted its tokens with a key
derived from `XERO_CLIENT_SECRET`. At boot, Field moves those tokens under
`FIELD_SECRETS_KEY`:

- with both `FIELD_SECRETS_KEY` and the old `XERO_CLIENT_SECRET` set, it
  re-encrypts them, and Xero stays connected;
- otherwise it forgets them, and the connection shows "Connect again"
  (`LEGACY_TOKENS_UNREADABLE`).

Either way, an audit event records it. After the upgrade, the owner can
enter the credentials in Settings and remove `XERO_CLIENT_ID` and
`XERO_CLIENT_SECRET` from the deployment, or keep them as the override.

## Adding an integration

Use `server/secrets/credentials.js` for its credentials (status, write-only
set, remove, audit) and `server/secrets/box.js` for any tokens, with the
integration's name as the binding. Give it a screen under Settings,
Integrations that follows the Xero one: write-only fields, owner-only
changes, read-only for everyone else.
