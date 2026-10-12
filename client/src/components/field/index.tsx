// Field's shared components (issue #161), first built for the Site theme
// (formerly Field Crew), as React primitives. Styles are in ./field-ui.css and read the
// [data-theme="field"] tokens, so screens compose these instead of inline
// styles. Built for dense desktop screens (the price book grid and drawer,
// the quote builder) that still work on a phone.
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";
import "./field-ui.css";

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}

// ── Brand ────────────────────────────────────────────────────────────────

/**
 * The Field mark: three angled stripes. The outer two are ink (off-white in
 * dark mode); the middle one is the active theme's brand colour, so it is
 * yellow only on a yellow theme (Site) while branding is settled.
 */
export function FieldMark({ size = 28, title = "Field" }: { size?: number; title?: string }) {
  return (
    <svg
      className="f-logo__mark"
      viewBox="56 100 400 308"
      width={size * (400 / 308)}
      height={size}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
    >
      <path fill="var(--t-mark-ink, #202328)" d="M214 100H456L392 162H230L134 256H56Z" />
      <path fill="var(--fx-mark-accent, var(--t-brand, #fdc901))" d="M230 191H436L372 250H238L146 336H78Z" />
      <path fill="var(--t-mark-ink, #202328)" d="M238 280H354L298 332H250L164 408H136V372Z" />
    </svg>
  );
}

/** The mark beside the FIELD wordmark. */
export function FieldLogo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span className={cx("f-logo", className)}>
      <FieldMark size={size} title="" />
      <span className="f-logo__word" style={{ fontSize: Math.round(size * 0.78) }}>FIELD</span>
    </span>
  );
}

/** The heavy ink rule under the logo on Site-theme screens. */
export function Rule({ className }: { className?: string }) {
  return <hr className={cx("f-rule", className)} />;
}

// ── Type ─────────────────────────────────────────────────────────────────

/** Spaced uppercase label ("EMAIL ADDRESS"). */
export function Label({ muted, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { muted?: boolean }) {
  return <span className={cx("f-label", muted && "f-label--muted", className)} {...rest} />;
}

/** The bold display heading. */
export function DisplayHeading({ as: Tag = "h1", size = 34, className, style, ...rest }: HTMLAttributes<HTMLHeadingElement> & {
  as?: "h1" | "h2" | "h3";
  size?: number;
}) {
  return <Tag className={cx("f-display", className)} style={{ fontSize: size, ...style }} {...rest} />;
}

// ── Buttons ──────────────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  block?: boolean;
}>(function Button({ variant = "secondary", size = "md", block, className, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("f-btn", `f-btn--${variant}`, size !== "md" && `f-btn--${size}`, block && "f-btn--block", className)}
      {...rest}
    />
  );
});

/** A square icon-only button. `label` is required: it is the accessible name and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: "sm" | "md";
  tone?: "default" | "danger";
}>(function IconButton({ label, size = "md", tone = "default", className, type = "button", children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx("f-icon-btn", size === "sm" && "f-icon-btn--sm", tone === "danger" && "f-icon-btn--danger", className)}
      {...rest}
    >
      {children}
    </button>
  );
});

// ── Fields ───────────────────────────────────────────────────────────────

/** A labelled field wrapper: label above, hint or error below. */
export function Field({ label, hint, error, htmlFor, children, className }: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("f-field", className)}>
      {label ? <label className="f-label" htmlFor={htmlFor}>{label}</label> : null}
      {children}
      {error ? <span className="f-field__error" role="alert">{error}</span> : hint ? <span className="f-field__hint">{hint}</span> : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { numeric?: boolean }>(
  function TextInput({ numeric, className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cx("f-input", numeric && "f-input--num", className)}
        inputMode={numeric ? "decimal" : rest.inputMode}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return <select ref={ref} className={cx("f-select", className)} {...rest} />;
  },
);

/**
 * Search box with a clear button. Escape clears it; `shortcut` (e.g. "/")
 * focuses it from anywhere on the page that is not already typing.
 */
export function SearchField({ value, onChange, placeholder = "Search", label = "Search", shortcut, className, autoFocus }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  shortcut?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== shortcut || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);

  return (
    <div className={cx("f-search", className)}>
      <Search className="f-search__icon" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        className="f-input"
        aria-label={label}
        placeholder={shortcut ? `${placeholder}  ( ${shortcut} )` : placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
        }}
      />
      {value ? (
        <IconButton label="Clear search" size="sm" className="f-search__clear" onClick={() => { onChange(""); inputRef.current?.focus(); }}>
          <X />
        </IconButton>
      ) : null}
    </div>
  );
}

// ── Segmented control and filter chips ───────────────────────────────────

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

/** One-of-many filter (e.g. Type: All · Materials · Labour). Arrow keys move the choice. */
export function SegmentedControl<T extends string>({ options, value, onChange, label, className }: {
  options: Array<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = options.length - 1;
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next < 0) return;
    event.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} className={cx("f-seg", className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="f-seg__item"
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
            {option.count != null ? <span className="f-seg__count">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** An on/off filter, or an applied filter with a remove button. */
export function FilterChip({ pressed, onToggle, onRemove, children }: {
  pressed?: boolean;
  onToggle?: () => void;
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="f-chip"
      aria-pressed={pressed ?? Boolean(onRemove)}
      onClick={onRemove ?? onToggle}
    >
      {children}
      {onRemove ? <span className="f-chip__remove" aria-hidden="true"><X size={12} /></span> : null}
    </button>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────

export type BadgeTone = "neutral" | "brand" | "ink" | "success" | "warn" | "danger";

export function StatusBadge({ tone = "neutral", className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cx("f-badge", `f-badge--${tone}`, className)} {...rest} />;
}

// ── Data table ───────────────────────────────────────────────────────────

/** Scroll container plus table. Header cells stick to the top while the body scrolls. */
export function DataTable({ dense, caption, className, maxHeight, children }: {
  dense?: boolean;
  caption?: string;
  className?: string;
  maxHeight?: number | string;
  children: ReactNode;
}) {
  return (
    <div className={cx("f-table-wrap", className)} style={maxHeight != null ? { maxHeight } : undefined}>
      <table className={cx("f-table", dense && "f-table--dense")}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

export type SortDirection = "asc" | "desc";

/**
 * Header cell. Numeric columns right-align. Pass `sort` and `onSort` to make
 * the header a sort toggle; `sort` is this column's direction or null.
 */
export function HeaderCell({ numeric, sort, onSort, className, children, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & {
  numeric?: boolean;
  sort?: SortDirection | null;
  onSort?: () => void;
}) {
  const ariaSort = sort === "asc" ? "ascending" : sort === "desc" ? "descending" : onSort ? "none" : undefined;
  const Icon = sort === "asc" ? ArrowUp : sort === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <th scope="col" aria-sort={ariaSort} className={cx("f-th", numeric && "f-th--num", className)} {...rest}>
      {onSort ? (
        <button type="button" className="f-th__sort" onClick={onSort}>
          {children}
          <Icon size={12} aria-hidden="true" style={{ opacity: sort ? 1 : 0.4 }} />
        </button>
      ) : children}
    </th>
  );
}

/**
 * Table row. With `onActivate` the row is focusable and opens on click,
 * Enter or Space; ArrowUp/ArrowDown move focus between interactive rows.
 */
export function Row({ selected, onActivate, className, children, ...rest }: HTMLAttributes<HTMLTableRowElement> & {
  selected?: boolean;
  onActivate?: () => void;
}) {
  const interactive = Boolean(onActivate);
  return (
    <tr
      className={cx("f-row", interactive && "f-row--interactive", className)}
      aria-selected={interactive ? Boolean(selected) : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onActivate}
      onKeyDown={interactive ? (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate?.();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const sibling = event.key === "ArrowDown" ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
          if (sibling instanceof HTMLElement && sibling.tabIndex >= 0) {
            event.preventDefault();
            sibling.focus();
          }
        }
      } : undefined}
      {...rest}
    >
      {children}
    </tr>
  );
}

/**
 * Body cell. `numeric`: right-aligned tabular mono (money, quantities).
 * `mono`: codes and ids. `muted`: secondary text. `shrink`: as narrow as its content.
 */
export function Cell({ numeric, mono, muted, shrink, className, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & {
  numeric?: boolean;
  mono?: boolean;
  muted?: boolean;
  shrink?: boolean;
}) {
  return (
    <td
      className={cx("f-td", numeric && "f-td--num", mono && "f-td--mono", muted && "f-td--muted", shrink && "f-td--shrink", className)}
      {...rest}
    />
  );
}

/** A full-width row for "No items match" and loading states. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="f-table-empty">{children}</td>
    </tr>
  );
}

// ── Side drawer ──────────────────────────────────────────────────────────

/**
 * Right-hand drawer for an item's detail. Escape closes it, focus moves into
 * it on open and back to where it was on close. `docked` renders it in the
 * page flow (a two-pane layout) instead of over the page.
 */
export function SideDrawer({ open, onClose, title, kicker, actions, footer, docked, width = 520, children }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  kicker?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  docked?: boolean;
  width?: number;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!docked) panelRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (!docked && previous && document.contains(previous)) previous.focus();
    };
  }, [open, docked, onClose]);

  if (!open) return null;

  const panel = (
    <aside
      ref={panelRef}
      role={docked ? "region" : "dialog"}
      aria-modal={docked ? undefined : true}
      aria-labelledby={titleId}
      tabIndex={-1}
      className={cx("f-drawer", docked && "f-drawer--docked")}
      style={{ ["--f-drawer-width" as string]: `${width}px` }}
    >
      <div className="f-drawer__head">
        <div className="f-drawer__titles">
          {kicker ? <Label muted>{kicker}</Label> : null}
          <h2 id={titleId} className="f-drawer__title">{title}</h2>
        </div>
        {actions}
        <IconButton label="Close" onClick={onClose}><X /></IconButton>
      </div>
      <div className="f-drawer__body">{children}</div>
      {footer ? <div className="f-drawer__foot">{footer}</div> : null}
    </aside>
  );

  if (docked) return panel;
  return (
    <>
      <div className="f-drawer-backdrop" onClick={onClose} />
      {panel}
    </>
  );
}

// ── Layout helpers ───────────────────────────────────────────────────────

export function Toolbar({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("f-toolbar", className)} {...rest} />;
}

export function ToolbarSpacer() {
  return <span className="f-toolbar__spacer" />;
}

export function Panel({ ink, className, ...rest }: HTMLAttributes<HTMLDivElement> & { ink?: boolean }) {
  return <div className={cx("f-panel", ink && "f-panel--ink", className)} {...rest} />;
}
