// Recipient addresses: parsing, merging, checking and suggesting them.
export type Recipient = { email: string; name?: string | null };
export type ContactSuggestion = { email: string; name: string; source: "job" | "sent" | "google" };
export type RecipientPolicy = { mode: "live" | "allowlist" | "disabled"; allowedRecipients?: string[] };

const EMAIL_PATTERN = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[a-z]{2,}$/i;

export function normalizeEmail(value: string) {
  return value.trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
}

/** Why an address cannot be sent to, or null when it can. */
export function recipientProblem(email: string, policy?: RecipientPolicy | null) {
  if (!EMAIL_PATTERN.test(email)) return `${email} is not a complete address. Fix it or remove it before sending.`;
  if (policy?.mode === "disabled") return "This installation does not send email.";
  if (policy?.mode === "allowlist" && !(policy.allowedRecipients || []).includes(email)) {
    return `This installation only sends to ${(policy.allowedRecipients || []).join(", ") || "its test addresses"}. Remove ${email} to send.`;
  }
  return null;
}

/** "Dana Whitfield <dana@…>, accounts@…" → recipients, names kept. */
export function parseRecipients(text: string): Recipient[] {
  return text
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const named = part.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
      if (named) return { email: normalizeEmail(named[2]), name: named[1].trim() || null };
      return { email: normalizeEmail(part), name: null };
    })
    .filter((entry) => entry.email);
}

export function mergeRecipients(...groups: Recipient[][]) {
  const seen = new Map<string, Recipient>();
  for (const group of groups) {
    for (const entry of group) {
      const existing = seen.get(entry.email);
      if (!existing) seen.set(entry.email, entry);
      else if (!existing.name && entry.name) seen.set(entry.email, entry);
    }
  }
  return [...seen.values()];
}

/** Suggestions: the job's people first, then Google Contacts, not already chosen. */
export function suggestRecipients(contacts: ContactSuggestion[], query: string, chosen: string[]) {
  const needle = query.trim().toLowerCase();
  const taken = new Set(chosen);
  const rank = { job: 0, sent: 1, google: 2 } as const;
  const seen = new Set<string>();
  return contacts
    .filter((contact) => {
      const email = contact.email.toLowerCase();
      if (taken.has(email) || seen.has(email)) return false;
      seen.add(email);
      return !needle || contact.name.toLowerCase().includes(needle) || email.includes(needle);
    })
    .sort((a, b) => {
      const aStarts = Number(Boolean(needle) && (a.name.toLowerCase().startsWith(needle) || a.email.toLowerCase().startsWith(needle)));
      const bStarts = Number(Boolean(needle) && (b.name.toLowerCase().startsWith(needle) || b.email.toLowerCase().startsWith(needle)));
      return rank[a.source] - rank[b.source] || bStarts - aStarts || a.name.localeCompare(b.name, "en-AU", { sensitivity: "base" });
    })
    .slice(0, 8);
}
