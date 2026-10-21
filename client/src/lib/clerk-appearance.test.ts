import { afterEach, describe, expect, it } from "vitest";
import { fieldClerkAppearance } from "./clerk-appearance";

describe("fieldClerkAppearance", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--t-control");
  });

  it("draws input and Google button edges in --t-control, not a bare drop shadow", () => {
    document.documentElement.style.setProperty("--t-control", "#949494");
    const { elements } = fieldClerkAppearance();
    for (const element of [elements.formFieldInput, elements.socialButtonsBlockButton]) {
      expect(element.boxShadow).toMatch(/^0 0 0 1px #949494, /);
      expect(element["&:hover"].boxShadow).toMatch(/^0 0 0 1px /);
    }
    expect(elements.formFieldInput['&[data-feedback="error"]'].boxShadow).toMatch(/^0 0 0 1px /);
  });

  it("gives Clerk an opaque border base and draws the badge text in --t-dim", () => {
    document.documentElement.style.setProperty("--t-text", "#0d4e5f");
    document.documentElement.style.setProperty("--t-dim", "#4e6365");
    const { variables, elements } = fieldClerkAppearance();
    // Clerk fades colorBorder again for every shade; a pre-faded base left
    // the "Primary" badge near 1:1.
    expect(variables.colorBorder).toBe("#0d4e5f");
    expect(elements.badge["&&"].color).toBe("#4e6365");
    document.documentElement.style.removeProperty("--t-text");
    document.documentElement.style.removeProperty("--t-dim");
  });
});
