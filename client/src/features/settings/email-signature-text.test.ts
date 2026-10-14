import { describe, expect, it } from "vitest";
import { signatureToText, textToSignature } from "./email-signature-text";

// [stored signature HTML, the text the panel showed for it before (main 5c84bb0)]
const RECORDED: Array<[string, string]> = [
  ["<p>Regards,<br/>{{senderName}}<br/>{{businessName}}</p>", "Regards,\n{{senderName}}\n{{businessName}}"],
  ['<p style="margin:0 0 12px;">Regards,<br/>{{senderName}}<br/>{{businessName}}</p>', "Regards,\n{{senderName}}\n{{businessName}}"],
  ['<p>Regards,<br/><span data-merge="senderName">Jess Harlow</span><br/><span data-merge="businessName">Harlow &amp; Co &lt;Earthworks&gt;</span></p>', "Regards,\nJess Harlow\nHarlow & Co <Earthworks>"],
  ['<p style="margin:0 0 12px;">Regards,<br/><span>Jess Harlow</span><br/><span>Harlow &amp; Co &lt;Earthworks&gt;</span></p>', "Regards,\nJess Harlow\nHarlow & Co <Earthworks>"],
  ["<p>Cheers &amp; thanks,<br/>Pat &lt;Office&gt;</p><p>Mobile 0400 000 000<br/>\"Earthworks\" O'Brien</p>", "Cheers & thanks,\nPat <Office>\n\nMobile 0400 000 000\n\"Earthworks\" O'Brien"],
  ['<p style="margin:0 0 12px;">Cheers &amp; thanks,<br/>Pat &lt;Office&gt;</p><p style="margin:0 0 12px;">Mobile 0400 000 000<br/>"Earthworks" O\'Brien</p>', "Cheers & thanks,\nPat <Office>\n\nMobile 0400 000 000\n\"Earthworks\" O'Brien"],
  ['<p style="margin:0 0 12px;">Jess</p>', "Jess"],
];

describe("signature text", () => {
  it("shows each stored signature as it did before", () => {
    for (const [html, text] of RECORDED) expect(signatureToText(html)).toBe(text);
  });

  it("round-trips the panel's own text", () => {
    for (const text of ["Regards,\n{{senderName}}\n{{businessName}}", "Cheers & thanks,\nPat <Office>\n\nMobile &amp; 0400"]) {
      expect(signatureToText(textToSignature(text))).toBe(text);
    }
  });

  it("decodes each entity once and keeps no tag or script as text", () => {
    expect(signatureToText("<p>&amp;lt;script&amp;gt;</p>")).toBe("&lt;script&gt;");
    expect(signatureToText("<p>O&#039;Brien &quot;Co&quot;</p>")).toBe("O'Brien \"Co\"");
    expect(signatureToText("<p>a</p><script>alert(1)</script><style>p{}</style><p>b</p>")).toBe("a\n\nb");
    expect(signatureToText("<scr<script>ipt>alert(1)</script>")).toBe("ipt>alert(1)");
    expect(signatureToText("<P>a</P>\n<P>b<BR>c</P>")).toBe("a\n\nb\nc");
  });
});
