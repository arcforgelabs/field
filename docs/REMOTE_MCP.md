# Remote MCP connection

Field exposes an opt-in, OAuth-protected Streamable HTTP MCP resource at `https://FIELD_ORIGIN/mcp`. This is how AI agents and other systems drive Field. Do not connect agents with `field` CLI, `using-field`, `FIELD_TOKEN`, or the HTTP plugin `tokenEnv` bearer path. A public Field app plugin must authenticate the user against their own Field origin through this OAuth MCP surface. This maintained document owns the runtime contract.

## Field configuration

Set an HTTPS public origin with no path, query, credentials, or fragment:

```json
{
  "mcp": {
    "enabled": true,
    "publicOrigin": "https://field.example.com"
  }
}
```

`FIELD_PUBLIC_ORIGIN` overrides `mcp.publicOrigin`. A synthetic verification installation (`FIELD_ENV=field-verification`) is also an explicit opt-in: when `fieldVerification.enabled` is true and `mcp.enabled` is not explicitly false, Field enables MCP at `fieldVerification.publicUrl`, so a release can prove the integration without editing its synthetic config; setting `mcp.enabled` to false always wins. Every other installation requires the explicit `mcp.enabled: true` configuration above.

Production must terminate trusted HTTPS at this origin and route the discovery, `/oauth/*`, and `/mcp` paths to the same Field process. OAuth state is stored under Field's existing data boundary at `mcp/as-state.json` with mode `0600`; authorization codes and access/refresh tokens are random, returned only in protocol responses, and stored only as SHA-256 hashes. The on-disk path deliberately avoids the verification boundary marker `oauth`. Back up and restrict the data directory as customer authentication data.

The approval page is same-origin and authenticates through the existing Field human email/password authenticator. With Clerk sign-in (`FIELD_AUTH=clerk`, `docs/CLERK_SIGN_IN.md`) it asks for no password: only an owner already signed in to Field with a verified owner sign-in (Google Workspace, or a recent second factor) can approve, from that session; anyone else gets a link to Field's sign-in that returns to the approval page. Its HTML matches Field's default login visual language: Field. brand, email/password, listed scopes, and Authorize. Do not regress it to unstyled markup. Authentication and scope authorization are separate injected boundaries. Administrators may authorize every MCP scope; a non-admin may authorize only scope strings present exactly in that Field user's `permissions` array, and the complete requested set must be allowed. A later Google OIDC login may replace only the human authenticator/approval ceremony: Field is not currently an OpenID Provider and deliberately publishes no `/.well-known/openid-configuration`. Client registration, PKCE, redirect URIs, grants, scope authority, token formats, refresh rotation, and `/mcp` remain Field-owned.

## Connecting an MCP client

Any MCP client that supports OAuth for remote servers can connect: path-specific
RFC 9728 protected-resource discovery, RFC 8414 authorization-server discovery,
dynamic public-client registration, Authorization Code with PKCE S256,
resource indicators, refresh tokens, and Streamable HTTP.

Point the client at `https://field.example.com/mcp` with transport
`streamable-http` and OAuth auth, request the scopes it needs (for example
`catalog.read catalog.write quote.read quote.draft`), and limit it to the
`field_*` tools. The client registers itself with a loopback redirect URI such
as `http://127.0.0.1:8989/oauth/callback` (Field accepts `127.0.0.1` or
`localhost` when registered exactly), opens the Field approval URL, exchanges
the one-time code and stores and refreshes credentials in its own OAuth store.
Do not copy Field secrets into the client's config, and do not place the
callback URL or code in chat or logs.

## Tool and scope matrix

| Scope | Tools | Behaviour |
| --- | --- | --- |
| none after OAuth | `field_markup_preview` | Local calculation only. Required inputs are `cost`, `basis` (`markup` or `margin`), and `percent`. Do not expose XOR `markupPercent`/`marginPercent` fields; strict client schemas mark every property required. |
| `catalog.read` | `field_price_item_list`, `field_price_item_get`, `field_quote_catalog_list`, `field_pricing_review`, `field_catalog_structure` | Direct catalog reads |
| `catalog.read` + `catalog.write` | `field_price_item_update`, `field_catalog_structure_update` | Both scopes required, including dry-run; exact `APPLY` plus fresh `expectedVersion`; re-read race check; before/after audit |
| `quote.read` | `field_quote_list`, `field_quote_get`, `field_quote_validate` | Direct Field selection/read semantics. `field_quote_get` defaults to a focused `quote` view; pass `view=full` only when evidence/activity is required. |
| `quote.read` + `quote.draft` | `field_quote_draft_create`, `field_quote_draft_update`, `field_quote_recalculate` | Both scopes required, including dry-run; unsent drafts only; exact `APPLY`/version race guard/audit |

There are no send, email, publish, issue, invoice, payment, acceptance, deletion, evidence, or lifecycle-delivery tools.

Catalogue tools name an item by uid: `item` on `field_price_item_get`,
`field_price_item_update`, `field_pricing_review` and `field_catalog_structure`,
and `parentItem` / `childItem` on `field_catalog_structure_update`. A legacy
item code is still accepted in those fields, and `code`, `parentCode` and
`childCode` remain as deprecated names for them. Catalogue answers carry no
item codes.

List tools declare object output schemas and return records in both `structuredContent` and the JSON text content: `field_quote_list` as `{ "quotes": [...] }`, `field_price_item_list` as `{ "items": [...] }`, and `field_quote_catalog_list` as `{ "catalogs": [...] }`. MCP structured content must remain a top-level object so clients can validate it as a record.

## Security contract

- MCP rejects missing, unknown, expired, revoked, wrong-resource and insufficient-scope access credentials. Its access tokens are audience-, client-, subject- and scope-bound. A 403 insufficient-scope response includes the OAuth `error`, complete required `scope`, and RFC 9728 `resource_metadata` parameters in `WWW-Authenticate`; MCP clients parse those exact challenge fields.
- Authenticated Field users can list their own active installations at `GET /api/mcp/installations` and revoke one at `DELETE /api/mcp/installations/:id`. An administrator may list all, filter by `?subject=USER_ID`, and revoke any installation. Non-admin users cannot inspect or revoke another subject's grant.
- Every `/mcp` call and every refresh is checked against the approving person's access now (`currentScopes`): a grant works only within the scopes that person may authorize today. A person removed, `pending`, turned off, out of the organisation, or removed, banned or locked in Clerk gets `401 invalid_token` on `/mcp` and `invalid_grant` on refresh, and that refresh family is revoked. A demoted owner's grant drops to their staff permissions. If Field cannot check, `/mcp` answers `503`.
- Existing broad Field bearer tokens remain compatibility credentials for current UI/API routes only, in the `Authorization` header only (never `?token=`). `/mcp` never resolves them.
- Dynamic registration accepts public Authorization Code/refresh clients only, exact registered HTTPS redirects or HTTP loopback redirects, and no client secret. Redirects reject credentials and fragments, at most eight redirects of at most 2,048 characters are accepted, client names are limited to 128 characters, and registration returns `client_id_expires_at`.
- Authorization requires exact registered redirect URI, nonempty state, exact MCP resource, allowed scopes, and PKCE S256. Approval requests and codes expire and are one-time.
- Refresh tokens rotate. Replaying a rotated refresh token revokes its whole family. Revocation also invalidates the family.
- The approval POST uses a one-time request plus a separately generated CSRF secret; responses are `no-store`. Passwords and protocol credentials are never logged by this implementation.
- Production should add edge request-size/rate controls for discovery/DCR/authorization/token endpoints and monitor generic failure counts without recording request bodies or URLs.

## Deployment prerequisites

An installation requires an explicit MCP enablement and public origin. Before calling it complete: verify the final HTTPS origin and unrewritten discovery/OAuth/MCP paths, ensure the data directory is private and backed up, apply edge rate limits, then connect an external MCP client and run an authenticated initialize/list/call smoke test. Use the installation routes to prove subject visibility and revocation.
