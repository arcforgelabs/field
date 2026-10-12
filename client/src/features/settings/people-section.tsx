// Settings › People (Clerk sign-in, owners only): approve people waiting for
// access, change roles and turn access off. The server enforces all of it
// (an owner with a verified owner sign-in); this only shows what it says.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { FieldUser, FieldUserRole } from "@/lib/types";
import { Button, Cell, DataTable, HeaderCell, Label, StatusBadge, type BadgeTone } from "@/components/field";

const STATUS_TONE: Record<string, BadgeTone> = { pending: "brand", active: "success", disabled: "neutral" };

export function PeopleSection({ selfId }: { selfId: string | null }) {
  const [people, setPeople] = useState<FieldUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listFieldUsers()
      .then((res) => {
        setPeople(res.users);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load people."));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(id: string, work: () => Promise<unknown>) {
    setBusy(id);
    try {
      await work();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  const approve = (person: FieldUser, role: FieldUserRole) => act(person.id, () => api.approveFieldUser(person.id, role));
  const update = (person: FieldUser, patch: Parameters<typeof api.updateFieldUser>[1]) => act(person.id, () => api.updateFieldUser(person.id, patch));

  return (
    <div>
      <Label muted style={{ display: "block", marginBottom: 10 }}>People</Label>
      {error && (
        <p role="alert" style={{ fontSize: 13, color: "var(--t-danger)", margin: "0 0 10px" }}>
          {error}
        </p>
      )}
      {!people && !error && <p style={{ fontSize: 13, color: "var(--t-dim)", margin: 0 }}>Loading…</p>}
      {people && (
        <DataTable caption="People with Field access">
          <thead>
            <tr>
              <HeaderCell>Name</HeaderCell>
              <HeaderCell>Email</HeaderCell>
              <HeaderCell>Role</HeaderCell>
              <HeaderCell>Status</HeaderCell>
              <HeaderCell style={{ textAlign: "right" }}>Actions</HeaderCell>
            </tr>
          </thead>
          <tbody>
          {people.map((person) => {
            const self = person.id === selfId;
            const disabled = busy === person.id;
            return (
              <tr key={person.id} data-testid={`person-${person.email}`} className="f-row">
                <Cell style={{ fontWeight: 600 }}>{person.name}{self ? " (you)" : ""}</Cell>
                <Cell muted style={{ overflowWrap: "anywhere" }}>{person.email}</Cell>
                <Cell style={{ textTransform: "capitalize" }}>{person.role}</Cell>
                <Cell>
                  <StatusBadge tone={STATUS_TONE[person.status] || "neutral"}>{person.status}</StatusBadge>
                  {person.linked ? null : <div style={{ fontSize: 11, color: "var(--t-dim)", marginTop: 2 }}>not signed in yet</div>}
                </Cell>
                <Cell>
                  <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, padding: "4px 0" }}>
                {!self && person.status === "pending" && (
                  <>
                    <Button size="sm" variant="primary" disabled={disabled} onClick={() => approve(person, "staff")}>
                      Approve as staff
                    </Button>
                    <Button size="sm" disabled={disabled} onClick={() => approve(person, "owner")}>
                      Approve as owner
                    </Button>
                    <Button size="sm" variant="danger" disabled={disabled} onClick={() => update(person, { status: "disabled" })}>
                      Decline
                    </Button>
                  </>
                )}
                {!self && person.status === "active" && (
                  <>
                    <Button
                      size="sm"
                      disabled={disabled}
                      onClick={() => update(person, { role: person.role === "owner" ? "staff" : "owner" })}
                    >
                      {person.role === "owner" ? "Make staff" : "Make owner"}
                    </Button>
                    <Button size="sm" variant="danger" disabled={disabled} onClick={() => update(person, { status: "disabled" })}>
                      Turn off access
                    </Button>
                  </>
                )}
                {!self && person.status === "disabled" && (
                  <Button size="sm" disabled={disabled} onClick={() => update(person, { status: "active" })}>
                    Restore access
                  </Button>
                )}
                  </div>
                </Cell>
              </tr>
            );
          })}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
