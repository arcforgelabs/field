// Settings › Team › Access (#133, owners only): every command-line token and
// connected agent (MCP installation) that can act in Field, one row per
// person or service account. A row expands to its tokens and agents, each
// with Revoke or Disconnect behind a confirm that names it and its holder.
// The server enforces all of it (an owner signed in to Field, never a token)
// and never sends a token's value; this screen only shows what it says.
import { useCallback, useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { ChevronRight, KeyRound, Search, Bot } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/auth-context";
import { useShell } from "@/components/shell/shell-context";
import type { AccessEvent, AccessToken, FieldUser, McpInstallation, ServiceAccount } from "@/lib/types";

type Holder = {
  id: string;
  name: string;
  email: string | null;
  kind: "person" | "service";
  /** owner or staff: what its tokens act as. */
  role: "owner" | "staff";
  tokens: AccessToken[];
  agents: McpInstallation[];
};

type Pending =
  | { kind: "token"; holder: Holder; token: AccessToken }
  | { kind: "agent"; holder: Holder; agent: McpInstallation };

function when(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function day(iso: string | null) {
  const date = when(iso);
  return date ? format(date, "d MMM yyyy") : "unknown";
}

function lastUsed(iso: string | null) {
  const date = when(iso);
  return date ? `Last used ${formatDistanceToNowStrict(date, { addSuffix: true })}` : "Never used";
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function summary(holder: Pick<Holder, "tokens" | "agents">) {
  const parts = [];
  if (holder.tokens.length) parts.push(plural(holder.tokens.length, "command-line token", "command-line tokens"));
  if (holder.agents.length) parts.push(plural(holder.agents.length, "connected agent", "connected agents"));
  return parts.join(" · ");
}

function latest(holder: Holder) {
  const times = [...holder.tokens, ...holder.agents].map((item) => item.lastUsedAt).filter(Boolean) as string[];
  return times.sort().at(-1) ?? null;
}

const tokenName = (token: AccessToken) => token.label || "Unnamed token";
const agentName = (agent: McpInstallation) => agent.clientName || "Unnamed agent";

// Everyone's tokens and connected agents, and the access history. Pure: the
// component sets its state from the result.
async function fetchAccess(): Promise<{ holders: Holder[]; events: AccessEvent[]; agentsOff: boolean }> {
  const { users = [], serviceAccounts = [] } = await api.listFieldUsers();
  const [tokenLists, installations, history] = await Promise.all([
    Promise.all([...users, ...serviceAccounts].map((holder) => api.listUserTokens(holder.id).then((res) => res.tokens).catch(() => [] as AccessToken[]))),
    api.listMcpInstallations().then((res) => res.installations).catch((err: { status?: number }) => {
      // No MCP router: connected agents are off on this installation.
      if (err?.status === 404) return null;
      throw err;
    }),
    api.accessEvents().then((res) => res.events).catch(() => [] as AccessEvent[]),
  ]);
  const agents = installations ?? [];
  const people: Holder[] = users.map((user: FieldUser, index) => ({
    id: user.id, name: user.name, email: user.email, kind: "person", role: user.role,
    tokens: tokenLists[index], agents: agents.filter((agent) => agent.subject === user.id),
  }));
  const services: Holder[] = serviceAccounts.map((account: ServiceAccount, index) => ({
    id: account.id, name: account.name, email: account.email, kind: "service", role: account.role === "admin" ? "owner" : "staff",
    tokens: tokenLists[users.length + index], agents: agents.filter((agent) => agent.subject === account.id),
  }));
  const known = new Set([...people, ...services].map((holder) => holder.id));
  // An agent whose approver Field no longer knows still shows, so it can be disconnected.
  const orphans: Holder[] = [...new Set(agents.filter((agent) => !known.has(agent.subject)).map((agent) => agent.subject))].map((subject) => ({
    id: subject, name: "Someone no longer in Field", email: null, kind: "person", role: "staff", tokens: [], agents: agents.filter((agent) => agent.subject === subject),
  }));
  return { holders: [...people, ...services, ...orphans], events: history, agentsOff: installations === null };
}

export function AccessSection({ selfId }: { selfId: string | null }) {
  const shell = useShell();
  const { logout } = useAuth();
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [agentsOff, setAgentsOff] = useState(false);
  const [events, setEvents] = useState<AccessEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((result: Awaited<ReturnType<typeof fetchAccess>>) => {
    setAgentsOff(result.agentsOff);
    setHolders(result.holders);
    setEvents(result.events);
    setError(null);
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await fetchAccess());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Access could not be loaded.");
    }
  }, [apply]);

  // State is set in the request's callbacks, not in the effect itself, and
  // not after the section is gone.
  useEffect(() => {
    let live = true;
    fetchAccess().then(
      (result) => { if (live) apply(result); },
      (err) => { if (live) setError(err instanceof Error ? err.message : "Access could not be loaded."); },
    );
    return () => { live = false; };
  }, [apply]);

  const withAccess = useMemo(() => (holders ?? []).filter((holder) => holder.tokens.length || holder.agents.length), [holders]);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!needle) return withAccess;
    const hit = (value: string | null | undefined) => Boolean(value && value.toLowerCase().includes(needle));
    return withAccess.flatMap((holder) => {
      if (hit(holder.name) || hit(holder.email)) return [holder];
      const tokens = holder.tokens.filter((token) => hit(token.label));
      const agents = holder.agents.filter((agent) => hit(agent.clientName));
      return tokens.length || agents.length ? [{ ...holder, tokens, agents }] : [];
    });
  }, [withAccess, needle]);

  const toggle = (id: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === "token") {
        const current = Boolean(pending.token.current);
        const res = await api.revokeUserToken(pending.holder.id, pending.token.id, { current });
        setPending(null);
        if (res.signedOut) {
          logout();
          return;
        }
        shell.toast(`Token “${tokenName(pending.token)}” revoked.${res.audited === false ? " Its audit event could not be written." : ""}`);
      } else {
        const res = await api.disconnectMcpInstallation(pending.agent.id);
        setPending(null);
        shell.toast(`“${agentName(pending.agent)}” disconnected.${res.audited === false ? " Its audit event could not be written." : ""}`);
      }
      await load();
    } catch (err) {
      setPending(null);
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fx-access">
      {error && <div className="fx-notice fx-notice--bad" role="alert" style={{ margin: 0 }}><span>{error}</span></div>}
      {!holders && !error && <p className="fx-dim" style={{ margin: 0, fontSize: 13 }}>Loading…</p>}
      {holders && withAccess.length === 0 && (
        <div className="fx-empty">
          <span className="fx-empty__icon"><KeyRound aria-hidden /></span>
          <span className="fx-empty__t">No command-line tokens or connected agents</span>
          <p>Tokens issued for the field command, and AI agents an owner approves, appear here so you can revoke them.{agentsOff ? " Connected agents (MCP) are off on this installation." : ""}</p>
        </div>
      )}
      {holders && withAccess.length > 0 && (
        <>
          <label className="fx-access__search">
            <Search aria-hidden />
            <input className="fx-input" type="search" placeholder="Find a token, agent or person" aria-label="Find a token, agent or person" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          {shown.length === 0 && <p className="fx-dim" style={{ margin: 0, fontSize: 13 }}>Nothing matches “{query.trim()}”.</p>}
          <ul className="fx-access__list" aria-label="Who holds tokens and connected agents">
            {shown.map((holder) => {
              const expanded = open.has(holder.id) || Boolean(needle);
              const self = holder.id === selfId;
              const recent = latest(holder);
              return (
                <li key={holder.id} className="fx-access__holder" data-testid={`access-${holder.id}`}>
                  <button type="button" className="fx-access__row" aria-expanded={expanded} onClick={() => toggle(holder.id)}>
                    <ChevronRight className="fx-access__chev" aria-hidden />
                    <span className="fx-avatar" aria-hidden>{(holder.name || "·").slice(0, 1).toUpperCase()}</span>
                    <span className="fx-access__who">
                      <span className="fx-access__name">
                        {holder.name}{self ? " (you)" : ""}
                        <span className={`fx-badge${holder.kind === "service" ? " fx-badge--outline" : ""}`}>{holder.kind === "service" ? "Service account" : holder.role === "owner" ? "Owner" : "Staff"}</span>
                      </span>
                      <span className="fx-access__count">{summary(holder)}</span>
                    </span>
                    <span className="fx-access__used fx-mute">{lastUsed(recent)}</span>
                  </button>
                  {expanded && (
                    <div className="fx-access__detail">
                      {holder.tokens.length > 0 && (
                        <section aria-label={`${holder.name}'s command-line tokens`}>
                          <h4 className="fx-access__h">Command-line tokens</h4>
                          <ul className="fx-access__items">
                            {holder.tokens.map((token) => (
                              <li key={token.id} className="fx-access__item">
                                <KeyRound className="fx-access__icon" aria-hidden />
                                <div className="fx-access__body">
                                  <div className="fx-access__title">
                                    {tokenName(token)}
                                    {token.current && <span className="fx-badge fx-badge--brand">This session</span>}
                                  </div>
                                  <div className="fx-access__meta">Created {day(token.createdAt)} · {lastUsed(token.lastUsedAt)}</div>
                                  <div className="fx-access__meta">Acts as {holder.name} ({holder.role}), except owner-only actions</div>
                                </div>
                                <button type="button" className="fx-btn fx-btn--sm fx-btn--danger" onClick={() => setPending({ kind: "token", holder, token })} aria-label={`Revoke ${tokenName(token)}`}>Revoke</button>
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                      {holder.agents.length > 0 && (
                        <section aria-label={`Agents ${holder.name} connected`}>
                          <h4 className="fx-access__h">Connected agents</h4>
                          <ul className="fx-access__items">
                            {holder.agents.map((agent) => (
                              <li key={agent.id} className="fx-access__item">
                                <Bot className="fx-access__icon" aria-hidden />
                                <div className="fx-access__body">
                                  <div className="fx-access__title">{agentName(agent)}</div>
                                  <div className="fx-access__meta">Approved by {holder.name} on {day(agent.createdAt)} · {lastUsed(agent.lastUsedAt)}</div>
                                  <div className="fx-access__scopes" aria-label="Scopes">
                                    {agent.scopes.map((scope) => <code key={scope}>{scope}</code>)}
                                  </div>
                                </div>
                                <button type="button" className="fx-btn fx-btn--sm fx-btn--danger" onClick={() => setPending({ kind: "agent", holder, agent })} aria-label={`Disconnect ${agentName(agent)}`}>Disconnect</button>
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {holders.length > withAccess.length && !needle && (
            <p className="fx-mute" style={{ margin: 0, fontSize: 12 }}>Everyone else on the team holds no tokens or connected agents.{agentsOff ? " Connected agents (MCP) are off on this installation." : ""}</p>
          )}
        </>
      )}
      {events.length > 0 && (
        <details className="fx-access__history">
          <summary>Recent changes</summary>
          <ul>
            {events.map((event) => (
              <li key={event.id}>
                {event.actor.name || "Someone"} {event.action === "token_revoked" ? "revoked the token" : "disconnected"} “{event.target.name || event.target.id}”
                {event.holder.name ? ` (${event.holder.name})` : ""} <span className="fx-mute">· {format(new Date(event.at), "d MMM yyyy, h:mm a")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {pending && (
        <div className="fx-scrim" onMouseDown={() => { if (!busy) setPending(null); }}>
          <div
            className="fx-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="access-confirm-title"
            aria-describedby="access-confirm-body"
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => { if (event.key === "Escape" && !busy) setPending(null); }}
          >
            {pending.kind === "token" ? (
              <>
                <div className="fx-dialog__h" id="access-confirm-title">Revoke “{tokenName(pending.token)}”?</div>
                <div className="fx-dialog__b" id="access-confirm-body">
                  <p className="fx-dim" style={{ margin: 0, fontSize: 12.5 }}>
                    This command-line token belongs to <b>{pending.holder.name}</b>. Anything using it is refused from its next request. You can't undo this; issue a new token if it is still needed.
                  </p>
                  {pending.token.current ? (
                    <div className="fx-notice fx-notice--bad" style={{ margin: 0 }}><span>This is the token this browser is signed in with. Revoking it signs you out.</span></div>
                  ) : pending.holder.id === selfId ? (
                    <div className="fx-notice fx-notice--warn" style={{ margin: 0 }}><span>This is your own token. The field command that uses it stops working until you sign it in again with <code>field auth login</code>. Your sign-in here is not affected.</span></div>
                  ) : null}
                </div>
                <div className="fx-dialog__f">
                  <button type="button" className="fx-btn fx-btn--ghost" autoFocus disabled={busy} onClick={() => setPending(null)}>Cancel</button>
                  <button type="button" className="fx-btn fx-btn--danger" disabled={busy} onClick={() => void confirm()}>{busy ? "Revoking…" : pending.token.current ? "Revoke and sign out" : "Revoke token"}</button>
                </div>
              </>
            ) : (
              <>
                <div className="fx-dialog__h" id="access-confirm-title">Disconnect “{agentName(pending.agent)}”?</div>
                <div className="fx-dialog__b" id="access-confirm-body">
                  <p className="fx-dim" style={{ margin: 0, fontSize: 12.5 }}>
                    <b>{pending.holder.name}</b> approved this agent on {day(pending.agent.createdAt)}. It is refused from its next request, and someone has to approve it again to reconnect it.
                  </p>
                </div>
                <div className="fx-dialog__f">
                  <button type="button" className="fx-btn fx-btn--ghost" autoFocus disabled={busy} onClick={() => setPending(null)}>Cancel</button>
                  <button type="button" className="fx-btn fx-btn--danger" disabled={busy} onClick={() => void confirm()}>{busy ? "Disconnecting…" : "Disconnect agent"}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
