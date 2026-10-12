// Express `trust proxy` for Field (#149).
//
// On Replit every request reaches Field through Replit's proxy, so the socket
// address is the proxy's, and without `trust proxy` req.ip is the same for
// everyone: the break-glass rate limit would be one shared bucket, letting
// anyone lock the owner out of break-glass. Replit's proxy appends the address
// it accepted the connection from to X-Forwarded-For, so trusting exactly one
// hop makes req.ip that address (the rightmost X-Forwarded-For entry).
//
// Why one hop and never `true`: Express walks X-Forwarded-For from the right
// and stops at the first untrusted hop. Trusting too few hops fails closed
// (clients share a bucket, as before). Trusting too many, or `true`, lets a
// client write its own X-Forwarded-For and pick a fresh bucket per attempt.
//
// FIELD_TRUST_PROXY overrides the default: a hop count ("0" turns it off), or
// an Express address list such as "loopback" or "10.0.0.0/8, 127.0.0.1".
// Unset: one hop on Replit (REPL_ID or REPLIT_DEPLOYMENT present), otherwise
// off, which is the right answer for local development and the tests.
export function resolveTrustProxy(env = process.env) {
  const raw = typeof env.FIELD_TRUST_PROXY === "string" ? env.FIELD_TRUST_PROXY.trim().toLowerCase() : "";
  if (raw) {
    if (raw === "true") {
      throw new Error("FIELD_TRUST_PROXY=true would trust any X-Forwarded-For a client sends; give a hop count (e.g. 1) instead");
    }
    if (raw === "false" || raw === "off") return { value: false, source: "FIELD_TRUST_PROXY" };
    if (/^\d+$/.test(raw)) {
      const hops = Number(raw);
      if (hops > 10) throw new Error("FIELD_TRUST_PROXY hop count must be between 0 and 10");
      return { value: hops === 0 ? false : hops, source: "FIELD_TRUST_PROXY" };
    }
    const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
    const named = new Set(["loopback", "linklocal", "uniquelocal"]);
    if (!parts.length || !parts.every((part) => named.has(part) || /^[0-9a-f:.]+(\/\d{1,3})?$/.test(part))) {
      throw new Error("FIELD_TRUST_PROXY must be a hop count or a comma-separated list of addresses/subnets (loopback, 10.0.0.0/8, ...)");
    }
    return { value: parts.join(", "), source: "FIELD_TRUST_PROXY" };
  }
  const onReplit = Boolean(env.REPL_ID || env.REPLIT_DEPLOYMENT);
  return onReplit ? { value: 1, source: "Replit default" } : { value: false, source: "default" };
}
