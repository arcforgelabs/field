// To, Cc and Bcc as chips with names, as in Gmail.
//
// - Suggestions list the job's own people first (its contact and anyone this
//   job already emailed), then Google Contacts. Field stores no new contacts.
// - An entry that is not a complete address stays as a red chip with the
//   reason under the row; Send stays disabled until it is fixed or removed.
//   Clicking it puts the text back in the box to fix.
// - The installation's allowed-recipient policy is checked on the chip.
// - Duplicates merge. Pasting a list makes one chip per address. Backspace
//   in an empty box removes the last chip.
import { useId, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import { AlertCircle, X } from "lucide-react";
import { recipientProblem, parseRecipients, mergeRecipients, suggestRecipients, type Recipient, type ContactSuggestion, type RecipientPolicy } from "./recipients";

function initials(recipient: Recipient) {
  const source = (recipient.name || recipient.email.split("@")[0] || "?").trim();
  const words = source.split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] || "?") + (words[1]?.[0] || "")).toUpperCase();
}

export function RecipientField({
  label,
  recipients,
  onChange,
  contacts,
  policy,
  inputRef,
  trailing,
  autoFocus = false,
}: {
  label: "To" | "Cc" | "Bcc";
  recipients: Recipient[];
  onChange: (next: Recipient[]) => void;
  contacts: ContactSuggestion[];
  policy?: RecipientPolicy | null;
  inputRef?: Ref<HTMLInputElement>;
  trailing?: React.ReactNode;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const localInput = useRef<HTMLInputElement | null>(null);
  // The caller's ref (the composer focuses Cc and Bcc) gets the same input.
  useImperativeHandle(inputRef, () => localInput.current!);
  const suggestions = useMemo(
    () => (open ? suggestRecipients(contacts, draft, recipients.map((entry) => entry.email)) : []),
    [open, contacts, draft, recipients],
  );
  const problems = recipients.map((entry) => ({ entry, problem: recipientProblem(entry.email, policy) })).filter((item) => item.problem);
  const messageId = `${id}-problems`;
  const nameFor = (email: string) => contacts.find((contact) => contact.email.toLowerCase() === email)?.name || null;

  function commit(text: string) {
    const parsed = parseRecipients(text).map((entry) => ({ ...entry, name: entry.name || nameFor(entry.email) }));
    if (!parsed.length) return;
    onChange(mergeRecipients(recipients, parsed));
    setDraft("");
  }

  function pick(contact: ContactSuggestion) {
    onChange(mergeRecipients(recipients, [{ email: contact.email.toLowerCase(), name: contact.name || null }]));
    setDraft("");
    setActive(0);
    localInput.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (open && suggestions.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setActive((current) => (event.key === "ArrowDown" ? (current + 1) % suggestions.length : (current - 1 + suggestions.length) % suggestions.length));
      return;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      if (open && suggestions.length && draft.trim()) {
        event.preventDefault();
        pick(suggestions[Math.min(active, suggestions.length - 1)]);
        return;
      }
      if (draft.trim()) {
        event.preventDefault();
        commit(draft);
      }
      return;
    }
    if (event.key === "," || event.key === ";" || (event.key === "Tab" && draft.trim())) {
      if (draft.trim()) {
        event.preventDefault();
        commit(draft);
      }
      return;
    }
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === "Backspace" && !draft && recipients.length) {
      onChange(recipients.slice(0, -1));
    }
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (/[,;\n]/.test(text)) {
      event.preventDefault();
      commit(`${draft}${text}`);
    }
  }

  return (
    <div className="fx-rcpt">
      <div className="fx-rcpt__row" onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); localInput.current?.focus(); } }}>
        <label className="fx-rcpt__label" htmlFor={`${id}-input`}>{label}</label>
        <ul className="fx-rcpt__chips" aria-label={`${label} recipients`}>
          {recipients.map((entry) => {
            const problem = recipientProblem(entry.email, policy);
            const display = entry.name || entry.email;
            return (
              <li key={entry.email} className="fx-chip-r" data-invalid={problem ? "true" : undefined}>
                <button
                  type="button"
                  className="fx-chip-r__body"
                  aria-invalid={problem ? "true" : undefined}
                  aria-describedby={problem ? messageId : undefined}
                  title={problem || entry.email}
                  onClick={() => {
                    if (!problem) return;
                    onChange(recipients.filter((other) => other.email !== entry.email));
                    setDraft(entry.email);
                    localInput.current?.focus();
                  }}
                >
                  {problem ? <AlertCircle aria-hidden className="fx-chip-r__alert" /> : <span className="fx-chip-r__avatar" aria-hidden>{initials(entry)}</span>}
                  {entry.name ? <span className="fx-chip-r__name">{entry.name}</span> : null}
                  <span className="fx-chip-r__email">{entry.name ? entry.email : display}</span>
                </button>
                <button type="button" className="fx-chip-r__x" aria-label={`Remove ${display}`} onClick={() => onChange(recipients.filter((other) => other.email !== entry.email))}>
                  <X aria-hidden />
                </button>
              </li>
            );
          })}
          <li className="fx-rcpt__input">
            <input
              id={`${id}-input`}
              ref={localInput}
              type="text"
              inputMode="email"
              autoComplete="off"
              autoFocus={autoFocus}
              role="combobox"
              aria-expanded={open && suggestions.length > 0}
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={open && suggestions.length ? `${id}-opt-${Math.min(active, suggestions.length - 1)}` : undefined}
              aria-label={label}
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setOpen(true); setActive(0); }}
              onFocus={() => setOpen(true)}
              onBlur={() => { setOpen(false); if (draft.trim()) commit(draft); }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
          </li>
        </ul>
        {trailing}
      </div>
      {open && suggestions.length ? (
        <ul className="fx-rcpt__list" id={`${id}-list`} role="listbox" aria-label={`${label} suggestions`}>
          {suggestions.map((contact, index) => (
            <li
              key={contact.email}
              id={`${id}-opt-${index}`}
              role="option"
              aria-selected={index === Math.min(active, suggestions.length - 1)}
              onMouseDown={(event) => { event.preventDefault(); pick(contact); }}
            >
              <span className="fx-chip-r__avatar" aria-hidden>{initials(contact)}</span>
              <span className="fx-rcpt__opt">
                <span>{contact.name || contact.email}</span>
                <small>{contact.email}{contact.source === "job" ? " · this job's contact" : contact.source === "sent" ? " · emailed on this job" : ""}</small>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {problems.length ? (
        <div className="fx-rcpt__problems" id={messageId} role="alert">
          {problems.map(({ entry, problem }) => <p key={entry.email}>{problem}</p>)}
        </div>
      ) : null}
    </div>
  );
}
