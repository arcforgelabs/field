// Email body HTML: the one allowlist sanitiser for what an operator, a
// template or a signature puts in an email, and the one conversion of that
// HTML to the email's plain text. Both read the HTML with htmlparser2,
// never a regular expression, so a tag split or nested to slip
// past a pattern (`<scr<script>ipt>`, `</script >`, `<SCRIPT>`) is just a
// tag the allowlist does not hold. Output is rebuilt from the tokens:
// attributes are decoded once by the parser, vetted, and escaped once;
// text is escaped so it can never open a tag.
import { Parser } from "htmlparser2";

// Dropped with everything inside them. Every other tag outside the allowlist
// is dropped and its text kept.
const DROPPED_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template", "textarea", "title",
  "svg", "math", "xmp", "noembed", "noframes", "select", "plaintext",
]);
const TEXT_TAGS = new Set(["p", "br", "strong", "em", "b", "i", "u", "a", "span", "ul", "ol", "li"]);
const BARE_TAGS = new Set(["strong", "em", "b", "i", "u"]);
const STYLED_TAGS = new Set(["p", "span", "li"]);

// The email body (quote, invoice and receipt emails, templates and
// signatures) keeps vetted images and gives paragraphs and lists the spacing
// the MJML layout expects; a job email's body (wrapGenericEmailHtml) keeps
// neither.
const EMAIL_BODY = { images: true, defaultStyles: true };
const GENERIC_BODY = { images: false, defaultStyles: false };
const DEFAULT_STYLES = {
  p: "margin:0 0 12px;",
  li: "margin:0 0 6px;",
  ul: "margin:0 0 12px;padding-left:22px;",
  ol: "margin:0 0 12px;padding-left:22px;",
};
const IMAGE_STYLE = "max-width:100%;height:auto;border:0;";

// A character reference kept as the author wrote it when it stands for the
// character the parser decoded, so the HTML Field itself writes
// (shared/email-templates.js writes `&#039;` and `&quot;`, the composer
// writes `'` and `"`) comes out byte for byte as it went in.
const KEPT_REFERENCES = new Map([
  ["&", ["&amp;"]],
  ["<", ["&lt;"]],
  [">", ["&gt;"]],
  ['"', ["&quot;", "&#34;"]],
  ["'", ["&#039;", "&#39;"]],
  ["\u00a0", ["&nbsp;"]],
]);

export function sanitizeEmailBodyHtml(html) {
  return sanitizeHtml(html, EMAIL_BODY);
}

export function sanitizeGenericBodyHtml(html) {
  return sanitizeHtml(html, GENERIC_BODY);
}

function sanitizeHtml(html, policy) {
  const source = String(html || "");
  let out = "";
  let dropDepth = 0;
  const parser = new Parser({
    onopentag(name, attribs) {
      if (DROPPED_WITH_CONTENT.has(name)) dropDepth += 1;
      if (dropDepth) return;
      out += openTag(name, attribs, source.slice(parser.startIndex, parser.endIndex + 1), policy);
    },
    ontext(text) {
      if (dropDepth) return;
      const raw = source.slice(parser.startIndex, parser.endIndex + 1);
      out += KEPT_REFERENCES.get(text)?.includes(raw) ? raw : escapeText(text);
    },
    onclosetag(name) {
      if (DROPPED_WITH_CONTENT.has(name)) {
        dropDepth = Math.max(0, dropDepth - 1);
        return;
      }
      if (dropDepth || name === "br" || name === "img") return;
      if (TEXT_TAGS.has(name)) out += `</${name}>`;
    },
  }, { decodeEntities: true });
  parser.end(source);
  return out;
}

function openTag(name, attribs, raw, policy) {
  if (name === "br") return /\s\/\s*>$/.test(raw) ? "<br />" : /\/\s*>$/.test(raw) ? "<br/>" : "<br>";
  if (name === "img") {
    if (!policy.images) return "";
    const src = sanitizeImageSrc(attribute(attribs, "src"));
    if (!src) return "";
    return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(attribute(attribs, "alt") || "Image")}" style="${IMAGE_STYLE}" />`;
  }
  if (!TEXT_TAGS.has(name)) return "";
  if (BARE_TAGS.has(name)) return `<${name}>`;
  if (name === "a") {
    const href = sanitizeHref(attribute(attribs, "href"));
    return href ? `<a href="${escapeAttribute(href)}">` : "<a>";
  }
  const style = STYLED_TAGS.has(name) ? sanitizeInlineStyle(attribute(attribs, "style")) : "";
  if (style) return `<${name} style="${escapeAttribute(style)}">`;
  const defaultStyle = policy.defaultStyles ? DEFAULT_STYLES[name] : null;
  return defaultStyle ? `<${name} style="${defaultStyle}">` : `<${name}>`;
}

/**
 * The plain text of email body HTML: entities decoded once, a line break
 * for `<br>`, a blank line between paragraphs and "- " before each list
 * item. Script and style content is not text.
 */
export function emailHtmlToText(html) {
  const source = String(html || "");
  let out = "";
  let dropDepth = 0;
  // A `</p>` or `</li>` followed only by whitespace so far: the whitespace
  // waits, since the next `<p>` or `<li>` replaces it with its separator.
  let afterClose = null;
  let pending = "";
  const flush = () => {
    out += pending;
    pending = "";
    afterClose = null;
  };
  const parser = new Parser({
    onopentag(name) {
      if (DROPPED_WITH_CONTENT.has(name)) dropDepth += 1;
      if (dropDepth) return;
      const joined = (name === "li" && afterClose === "li") || (name === "p" && afterClose === "p");
      if (joined) {
        pending = "";
        afterClose = null;
      } else flush();
      if (name === "br") out += "\n";
      else if (name === "li") out += joined ? "\n- " : "- ";
      else if (name === "p" && joined) out += "\n\n";
    },
    ontext(text) {
      if (dropDepth) return;
      if (afterClose && /^[\t\n\f\r ]*$/.test(text)) {
        pending += text;
        return;
      }
      flush();
      out += text.replaceAll("\u00a0", " ");
    },
    onclosetag(name, isImplied) {
      if (DROPPED_WITH_CONTENT.has(name)) {
        dropDepth = Math.max(0, dropDepth - 1);
        return;
      }
      if (dropDepth || name === "br") return;
      flush();
      if (!isImplied && (name === "p" || name === "li")) afterClose = name;
    },
  }, { decodeEntities: true });
  parser.end(source);
  flush();
  return out.trim();
}

function attribute(attribs, name) {
  return Object.hasOwn(attribs, name) ? String(attribs[name]) : "";
}

function sanitizeInlineStyle(style) {
  const allowed = [];
  for (const declaration of String(style || "").split(";")) {
    const [rawProp, ...rawValueParts] = declaration.split(":");
    const prop = String(rawProp || "").trim().toLowerCase();
    const value = rawValueParts.join(":").trim();
    if (!prop || !value) continue;
    if (prop === "font-size" && /^\d{1,2}(?:\.\d)?px$/.test(value)) {
      allowed.push(`${prop}:${value}`);
    }
    if (prop === "font-family" && /^[\w\s'",.-]+$/.test(value)) {
      allowed.push(`${prop}:${value}`);
    }
  }
  return allowed.join(";");
}

function sanitizeHref(href) {
  const value = String(href || "").trim();
  if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
  return "";
}

function sanitizeImageSrc(src) {
  const value = String(src || "").trim();
  if (/^https:\/\//i.test(value)) return value;
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
  return "";
}

function escapeText(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
