import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Parser } from "htmlparser2";
import { DEFAULT_EMAIL_TEMPLATES, renderEmailTemplate } from "../shared/email-templates.js";
import { emailHtmlToText, sanitizeEmailBodyHtml, sanitizeGenericBodyHtml } from "./email-html.js";

const corpus = JSON.parse(readFileSync(new URL("./fixtures/email-html-corpus.json", import.meta.url), "utf8"));

// The tags and attributes the output may hold, read back with a parser.
const EMAIL_BODY_TAGS = {
  p: ["style"], br: [], strong: [], em: [], b: [], i: [], u: [], a: ["href"], span: ["style"],
  ul: ["style"], ol: ["style"], li: ["style"], img: ["src", "alt", "style"],
};
function tagsOf(html) {
  const tags = [];
  const parser = new Parser({ onopentag: (name, attribs) => tags.push({ name, attribs }) }, { decodeEntities: true });
  parser.end(html);
  return tags;
}
function assertAllowlisted(html, allowed = EMAIL_BODY_TAGS) {
  for (const { name, attribs } of tagsOf(html)) {
    assert.ok(Object.hasOwn(allowed, name), `tag <${name}> in ${JSON.stringify(html)}`);
    for (const attribute of Object.keys(attribs)) assert.ok(allowed[name].includes(attribute), `${name}[${attribute}] in ${JSON.stringify(html)}`);
    if (name === "a" && attribs.href) assert.match(attribs.href, /^(https?:|mailto:|tel:)/i);
    if (name === "img") assert.match(attribs.src, /^(https:\/\/|data:image\/)/i);
  }
}

test("stock templates, signatures and composer bodies sanitise byte for byte as before", () => {
  for (const entry of corpus.entries) {
    assert.equal(sanitizeEmailBodyHtml(entry.html), entry.emailBody, `email body: ${entry.name}`);
    assert.equal(sanitizeGenericBodyHtml(entry.html), entry.genericBody, `job email body: ${entry.name}`);
    assert.equal(emailHtmlToText(entry.html), entry.text, `plain text: ${entry.name}`);
  }
  // The recorded changes are only the outputs that were wrong.
  const changed = corpus.entries.filter((entry) => entry.changed).flatMap((entry) => Object.keys(entry.changed).map((kind) => `${kind}: ${entry.name}`));
  assert.deepEqual(changed.filter((row) => !row.startsWith("text: ")), ["emailBody: tiptap link with query", "genericBody: tiptap link with query"]);
});

test("a stock template's subject is plain text and its body keeps the escaped values", () => {
  for (const row of corpus.templates) {
    const [type, id] = row.template.split("/");
    const rendered = renderEmailTemplate(DEFAULT_EMAIL_TEMPLATES[type].find((template) => template.id === id), row.context);
    assert.equal(rendered.subject, row.subject, `subject: ${row.template}`);
    assert.equal(rendered.html, row.html, `body: ${row.template}`);
    assert.doesNotMatch(rendered.subject, /&(amp|lt|gt|quot|#0?39);|<\/?strong>/);
  }
});

test("script, style and their relatives go with their content, however the tags are written", () => {
  for (const sanitize of [sanitizeEmailBodyHtml, sanitizeGenericBodyHtml]) {
    assert.equal(sanitize("<script >alert(1)</script >ok"), "ok");
    assert.equal(sanitize("<SCRIPT>alert(1)</SCRIPT\n>ok"), "ok");
    assert.equal(sanitize("<STYLE>p{color:red}</STYLE >ok"), "ok");
    assert.equal(sanitize("<style>p{color:red}</style><p>ok</p>").replace(/ style="[^"]*"/, ""), "<p>ok</p>");
    assert.equal(sanitize("<textarea><p>x</p></textarea>ok"), "ok");
    assert.equal(sanitize('<svg><a href="https://x.example">s</a></svg>ok'), "ok");
    assert.equal(sanitize("<!-- <script>alert(1)</script> -->ok"), "ok");
    for (const tag of ["iframe", "object", "noscript", "template", "title", "math", "xmp", "noembed", "noframes", "select"]) {
      assert.equal(sanitize(`<${tag}><b>hidden</b></${tag}>ok`), "ok", tag);
    }
  }
});

test("split, nested and malformed tags come out as text, never as a tag", () => {
  for (const sanitize of [sanitizeEmailBodyHtml, sanitizeGenericBodyHtml]) {
    for (const input of [
      "<scr<script>ipt>alert(1)</script>",
      "<<script>script>alert(1)<</script>/script>",
      "<p/onclick=alert(1)>x</p>",
      '<a/href="javascript:alert(1)">x</a>',
      "<span/onmouseover=alert(1)>x</span>",
      '<img/src="https://a.example/b.png"/onerror=alert(1)>',
      "<div><b>bold</div>",
      "a < b > c",
    ]) {
      const out = sanitize(input);
      assertAllowlisted(out);
      assert.doesNotMatch(out, /<(?!\/?(p|br|strong|em|b|i|u|a|span|ul|ol|li|img)[\s/>])/i, `${input} -> ${out}`);
    }
    assert.equal(sanitize("<scr<script>ipt>alert(1)</script>"), "ipt&gt;alert(1)");
    assert.equal(sanitize("<div><b>bold</div>"), "<b>bold</b>");
    assert.equal(sanitize("a < b > c"), "a &lt; b &gt; c");
  }
  assert.equal(sanitizeEmailBodyHtml("<p/onclick=alert(1)>x</p>"), '<p style="margin:0 0 12px;">x</p>');
  assert.equal(sanitizeEmailBodyHtml("<P ONCLICK=alert(1)>x</P>"), '<p style="margin:0 0 12px;">x</p>');
  assert.equal(sanitizeGenericBodyHtml("<UL><LI>x</LI></UL>"), "<ul><li>x</li></ul>");
});

test("links keep only http, https, mailto and tel, decoded once", () => {
  for (const sanitize of [sanitizeEmailBodyHtml, sanitizeGenericBodyHtml]) {
    assert.equal(sanitize('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");
    assert.equal(sanitize('<a href=" jav&#x09;ascript:alert(1)">x</a>'), "<a>x</a>");
    assert.equal(sanitize('<a href="&#106;avascript:alert(1)">x</a>'), "<a>x</a>");
    assert.equal(sanitize('<a href="https://x.example/?a=1&amp;b=2">x</a>'), '<a href="https://x.example/?a=1&amp;b=2">x</a>');
    assert.equal(sanitize('<a href="https://x.example/" title="x&quot; onclick=&quot;alert(1)">y</a>'), '<a href="https://x.example/">y</a>');
    assert.equal(sanitize("<a href='https://x.example/\"onclick=\"alert(1)'>y</a>"), '<a href="https://x.example/&quot;onclick=&quot;alert(1)">y</a>');
  }
});

test("images keep a vetted source in the email body and none in a job email", () => {
  assert.equal(sanitizeEmailBodyHtml("<img src=x onerror=alert(1)>"), "");
  assert.equal(sanitizeEmailBodyHtml('<img src="javascript:alert(1)">'), "");
  const quoted = sanitizeEmailBodyHtml('<img src="https://a.example/b.png" alt="x&quot; onerror=&quot;alert(1)">');
  assertAllowlisted(quoted);
  assert.deepEqual(tagsOf(quoted)[0].attribs, { src: "https://a.example/b.png", alt: 'x" onerror="alert(1)', style: "max-width:100%;height:auto;border:0;" });
  assert.equal(sanitizeGenericBodyHtml('<p><img src="https://a.example/b.png"></p>'), "<p></p>");
});

test("the plain text decodes each entity once and drops script content", () => {
  assert.equal(emailHtmlToText("<p>&amp;lt;script&amp;gt;</p>"), "&lt;script&gt;");
  assert.equal(emailHtmlToText("<p>Pat O&#039;Brien &amp; Co</p>"), "Pat O'Brien & Co");
  assert.equal(emailHtmlToText("<p>a</p><script>alert(1)</script><p>b</p>"), "a\n\nb");
  assert.equal(emailHtmlToText("<p>a&nbsp;b<br>c</p>\n<p>d</p><ul><li>e</li> <li>f</li></ul>"), "a b\nc\n\nd- e\n- f");
});
