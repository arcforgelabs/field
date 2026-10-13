import { describe, expect, it } from "vitest";
import { menuPosition } from "./menu-position";

const menu = { width: 240, height: 112 };
// A 950x600 window with the 232px sidebar: the content pane starts at x=232.
const view = { innerWidth: 950, innerHeight: 600, paneLeft: 232 };
const button = (left: number, top: number) => ({ left, right: left + 32, top, bottom: top + 32 });

describe("menuPosition", () => {
  it("opens under the trigger, right edges lined up", () => {
    expect(menuPosition(button(870, 18), menu, view, "end")).toEqual({ top: 54, left: 662 });
  });

  it("lines up with the trigger's left edge when the right edge would put it over the sidebar", () => {
    // The job header's "..." button wrapped under the title (job quote page, 950x600).
    expect(menuPosition(button(385, 65), menu, view, "end")).toEqual({ top: 101, left: 385 });
  });

  it("opens above the trigger when there is no room below", () => {
    expect(menuPosition(button(870, 520), menu, view, "end")).toEqual({ top: 404, left: 662 });
  });

  it("start-aligned menus flip to the trigger's right edge near the window's right side", () => {
    expect(menuPosition(button(900, 18), menu, view, "start")).toEqual({ top: 54, left: 692 });
  });

  it("stays inside a phone-width window", () => {
    expect(menuPosition(button(8, 18), menu, { innerWidth: 200, innerHeight: 600, paneLeft: 0 }, "end")).toEqual({ top: 54, left: 8 });
  });
});
