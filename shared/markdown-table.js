// A value as one Markdown table cell: a backslash is escaped first, so the
// `\|` that follows is the only escape a reader sees, and a line break
// becomes a space, since a cell is one line.
export function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, " ");
}
