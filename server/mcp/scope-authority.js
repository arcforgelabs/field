import { MCP_SCOPES } from "./scopes.js";

const KNOWN_SCOPES = new Set(MCP_SCOPES);

/**
 * Field administrators may authorize any MCP scope. Non-admin users may
 * authorize only scope strings present exactly in their Field permissions.
 */
export function authorizeFieldMcpScopes(user, requestedScopes) {
  const requested = [...new Set(requestedScopes)].filter((scope) => KNOWN_SCOPES.has(scope));
  if (user?.role === "admin") return requested;
  const permissions = new Set(Array.isArray(user?.permissions) ? user.permissions : []);
  return requested.filter((scope) => permissions.has(scope));
}
