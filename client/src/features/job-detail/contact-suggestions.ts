import type { GoogleContact } from "@/lib/api";

export function suggestGoogleContacts(contacts: GoogleContact[], query: string, selectedEmails: string[]) {
  const normalizedQuery = query.trim().toLowerCase();
  const selected = new Set(selectedEmails.map((email) => email.trim().toLowerCase()));
  return contacts
    .filter((contact) => !selected.has(contact.email.toLowerCase()))
    .filter((contact) => !normalizedQuery
      || contact.name.toLowerCase().includes(normalizedQuery)
      || contact.email.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => {
      if (!normalizedQuery) return a.name.localeCompare(b.name, "en-AU", { sensitivity: "base" });
      const aStarts = a.name.toLowerCase().startsWith(normalizedQuery) || a.email.toLowerCase().startsWith(normalizedQuery);
      const bStarts = b.name.toLowerCase().startsWith(normalizedQuery) || b.email.toLowerCase().startsWith(normalizedQuery);
      return Number(bStarts) - Number(aStarts)
        || a.name.localeCompare(b.name, "en-AU", { sensitivity: "base" });
    })
    .slice(0, 8);
}
