// A small popover menu anchored to its trigger: Escape and outside clicks close it.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type MenuItem =
  | { kind?: "item"; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; tone?: "danger" }
  | { kind: "separator" };

export function Menu({ trigger, items, label, align = "end" }: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu"; ref: (el: HTMLButtonElement | null) => void }) => ReactNode;
  items: MenuItem[];
  label: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // The trigger element, kept in state so it can be handed to the trigger as its ref.
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const toggle = useCallback(() => {
    if (open || !anchor) { setOpen(false); return; }
    // Place it below the trigger, or above when there's no room.
    const rect = anchor.getBoundingClientRect();
    const width = 240;
    const height = items.reduce((sum, item) => sum + (item.kind === "separator" ? 9 : 32), 8);
    const left = align === "end" ? rect.right - width : rect.left;
    const below = rect.bottom + 4;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
    setPos({ top, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
    setOpen(true);
  }, [open, anchor, items, align]);

  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus();
    function onDown(event: MouseEvent) {
      if (menu.current?.contains(event.target as Node) || anchor?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.stopPropagation(); setOpen(false); anchor?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onScroll);
    document.querySelector(".fx-main")?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onScroll);
      document.querySelector(".fx-main")?.removeEventListener("scroll", onScroll);
    };
  }, [open, anchor]);

  return (
    <>
      {trigger({ onClick: toggle, "aria-expanded": open, "aria-haspopup": "menu", ref: setAnchor })}
      {open && createPortal(
        <div ref={menu} className="fx-menu" role="menu" aria-label={label} style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: 240 }}>
          {items.map((item, index) => item.kind === "separator"
            ? <hr key={`sep-${index}`} />
            : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                data-tone={item.tone}
                onClick={() => { setOpen(false); item.onSelect(); }}
              >
                {item.icon}{item.label}
              </button>
            ))}
        </div>,
        document.body,
      )}
    </>
  );
}
