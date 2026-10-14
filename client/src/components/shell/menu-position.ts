// Where the menu opens: below the trigger, or above when there's no room, lined up
// with the trigger's `align` edge. When that edge would push the menu past the left
// of the page's content pane (over the sidebar), it lines up with the other edge.
export function menuPosition(
  trigger: { top: number; bottom: number; left: number; right: number },
  menu: { width: number; height: number },
  view: { innerWidth: number; innerHeight: number; paneLeft: number },
  align: "start" | "end",
): { top: number; left: number } {
  const minLeft = view.paneLeft + 8;
  const maxLeft = view.innerWidth - menu.width - 8;
  let left = align === "end" ? trigger.right - menu.width : trigger.left;
  if (align === "end" && left < minLeft) left = trigger.left;
  if (align === "start" && left > maxLeft) left = trigger.right - menu.width;
  const below = trigger.bottom + 4;
  const top = below + menu.height > view.innerHeight - 8 ? Math.max(8, trigger.top - menu.height - 4) : below;
  return { top, left: Math.max(8, Math.min(left, maxLeft)) };
}
