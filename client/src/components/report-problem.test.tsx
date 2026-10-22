import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({ getFeedback: vi.fn() }));
vi.mock("@sentry/react", () => sentry);

import { ReportProblem } from "./report-problem";

describe("Report a problem button", () => {
  beforeEach(() => {
    sentry.getFeedback.mockReset();
  });

  it("is added while a signed-in screen shows it, and removed after", () => {
    const widget = { removeFromDom: vi.fn() };
    const createWidget = vi.fn(() => widget);
    sentry.getFeedback.mockReturnValue({ createWidget });
    const view = render(<ReportProblem />);
    expect(createWidget).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(widget.removeFromDom).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the feedback form is off", () => {
    sentry.getFeedback.mockReturnValue(undefined);
    expect(() => render(<ReportProblem />).unmount()).not.toThrow();
  });
});
