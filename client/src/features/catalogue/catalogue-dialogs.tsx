// Small dialogs the catalogue asks with: confirm a change, or ask for one value.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function ConfirmBox({ title, children, confirmLabel, tone, busy = false, onConfirm, onCancel }: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  return createPortal(
    <div className="fx-scrim" onMouseDown={() => { if (!busy) onCancel(); }}>
      <div
        className="fx-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onCancel(); } }}
      >
        <div className="fx-dialog__h" id={titleId}>{title}</div>
        <div className="fx-dialog__b">{children}</div>
        <div className="fx-dialog__f">
          <button type="button" className="fx-btn fx-btn--ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className={`fx-btn ${tone === "danger" ? "fx-btn--danger" : "fx-btn--primary"}`} onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Ask for one value (a markup, a tag, a category name). `options` offers existing values. */
export function PromptBox({ title, label, hint, initial = "", placeholder, options, suffix, numeric, submitLabel, validate, onSubmit, onCancel }: {
  title: string;
  label: string;
  hint?: ReactNode;
  initial?: string;
  placeholder?: string;
  options?: string[];
  suffix?: string;
  numeric?: boolean;
  submitLabel: string;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const listId = useId();
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  function submit() {
    const problem = validate?.(value) ?? (value.trim() ? null : `Enter ${label.toLowerCase()}`);
    if (problem) { setError(problem); return; }
    onSubmit(value.trim());
  }
  return createPortal(
    <div className="fx-scrim" onMouseDown={onCancel}>
      <form
        className="fx-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }}
        onSubmit={(event) => { event.preventDefault(); submit(); }}
      >
        <div className="fx-dialog__h" id={titleId}>{title}</div>
        <div className="fx-dialog__b">
          <label className="fx-label">
            {label}
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                ref={input}
                className={`fx-input${numeric ? " fx-input--num" : ""}`}
                value={value}
                placeholder={placeholder}
                inputMode={numeric ? "decimal" : undefined}
                list={options?.length ? listId : undefined}
                onChange={(event) => { setValue(event.target.value); setError(null); }}
                aria-invalid={Boolean(error)}
              />
              {suffix && <span className="fx-dim">{suffix}</span>}
            </span>
          </label>
          {options?.length ? <datalist id={listId}>{options.map((option) => <option key={option} value={option} />)}</datalist> : null}
          {error ? <p className="fx-hint" role="alert" style={{ color: "var(--t-danger)" }}>{error}</p> : hint ? <p className="fx-hint">{hint}</p> : null}
        </div>
        <div className="fx-dialog__f">
          <button type="button" className="fx-btn fx-btn--ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="fx-btn fx-btn--primary">{submitLabel}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
