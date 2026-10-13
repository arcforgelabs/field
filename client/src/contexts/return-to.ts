// The MCP OAuth approval page sends signed-out owners to /?return_to=/oauth/authorize?...
// Only that same-origin path is honoured.
export function safeReturnTo(search: string): string | null {
  const value = new URLSearchParams(search).get("return_to");
  if (!value || !value.startsWith("/oauth/authorize?") || value.startsWith("//")) return null;
  return value;
}
