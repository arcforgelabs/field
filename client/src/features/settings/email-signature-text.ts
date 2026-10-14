// The signature panel edits plain lines; the server keeps the signature as
// HTML. The browser's own parser reads it, so each entity is decoded exactly
// once (`&amp;lt;` stays the text `&lt;`) and no tag survives as text.

const SKIPPED = new Set(["script", "style", "template", "noscript", "textarea", "title"]);

export function signatureToText(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let out = "";
  // Whitespace after a `</p>` waits: a following `<p>` replaces it with a
  // blank line.
  let afterParagraph = false;
  let pending = "";
  const flush = () => {
    out += pending;
    pending = "";
    afterParagraph = false;
  };
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const value = child.textContent ?? "";
        if (afterParagraph && /^[\t\n\f\r ]*$/.test(value)) pending += value;
        else {
          flush();
          out += value;
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const name = (child as Element).localName;
      if (SKIPPED.has(name)) continue;
      if (name === "p" && afterParagraph) {
        pending = "";
        afterParagraph = false;
        out += "\n\n";
      } else flush();
      if (name === "br") out += "\n";
      walk(child);
      flush();
      if (name === "p") afterParagraph = true;
    }
  };
  walk(doc.body);
  return out.trim();
}

export function textToSignature(text: string) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.trim()
    ? text.trim().split(/\n{2,}/).map((block) => `<p>${block.split("\n").map(escape).join("<br/>")}</p>`).join("")
    : "";
}
