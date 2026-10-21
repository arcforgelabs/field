import { describe, expect, it } from "vitest";
import { buildPaymentScheduleFromDraftRows, createMilestoneDraftRow, moveMilestoneDraftRow } from "./payment-schedule";

const rows = () => [
  createMilestoneDraftRow("Deposit", "10"),
  createMilestoneDraftRow("Progress payment", "30"),
  createMilestoneDraftRow("Final payment", "60"),
];
const labels = (list: ReturnType<typeof rows>) => list.map((row) => row.label);

describe("moveMilestoneDraftRow", () => {
  it("moves a milestone up and down without changing its share", () => {
    const start = rows();
    const up = moveMilestoneDraftRow(start, 2, 1);
    expect(labels(up)).toEqual(["Deposit", "Final payment", "Progress payment"]);
    expect(buildPaymentScheduleFromDraftRows(up).milestones.map((milestone) => milestone.percentage)).toEqual([10, 60, 30]);
    expect(labels(moveMilestoneDraftRow(up, 0, 1))).toEqual(["Final payment", "Deposit", "Progress payment"]);
    expect(labels(start)).toEqual(["Deposit", "Progress payment", "Final payment"]);
  });

  it("leaves the rows as they are for a move past either end", () => {
    const start = rows();
    expect(moveMilestoneDraftRow(start, 0, -1)).toBe(start);
    expect(moveMilestoneDraftRow(start, 2, 3)).toBe(start);
  });
});
