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
});
