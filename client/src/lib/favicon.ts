// The tab icon follows the active design system: the Field mark with its
// middle stripe in the theme's brand colour (see FieldMark), redrawn when the
// theme, mode or accent changes. The static field-mark.svg stays the fallback.

const MARK = (ink: string, accent: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="56 100 400 308">`
  + `<path fill="${ink}" d="M214 100H456L392 162H230L134 256H56Z"/>`
  + `<path fill="${accent}" d="M230 191H436L372 250H238L146 336H78Z"/>`
  + `<path fill="${ink}" d="M238 280H354L298 332H250L164 408H136V372Z"/></svg>`;

export function updateFavicon(root: HTMLElement = document.documentElement) {
  if (typeof document === "undefined") return;
  const styles = getComputedStyle(root);
  const ink = styles.getPropertyValue("--t-mark-ink").trim() || "#202328";
  const accent = styles.getPropertyValue("--t-brand").trim() || "#fdc901";
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = `data:image/svg+xml,${encodeURIComponent(MARK(ink, accent))}`;
}
