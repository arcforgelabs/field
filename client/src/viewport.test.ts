import axe from "axe-core";
import { describe, expect, it } from "vitest";
import html from "../index.html?raw";

// People must be able to pinch-zoom on a phone (WCAG 1.4.4).
describe("index.html viewport", () => {
  it("passes axe's meta-viewport rules", async () => {
    document.head.innerHTML = new DOMParser().parseFromString(html, "text/html").head.innerHTML;
    const results = await axe.run(document, { runOnly: ["meta-viewport", "meta-viewport-large"] });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
    expect(results.passes.map((pass) => pass.id)).toContain("meta-viewport");
  });
});
