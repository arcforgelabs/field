import { describe, expect, it } from "vitest";
import type { QuoteVersion } from "@/lib/types";
import { describeVersions } from "./quote-versions";

const at = (day: number) => new Date(2026, 9, day, 10, 0).toISOString();
const version = (number: number, day: number, status: string | null = null): QuoteVersion =>
  ({ version: number, label: `v00${number}`, createdAt: at(day), status });

describe("describeVersions", () => {
  it("lists nothing for a quote that has never been revised", () => {
    expect(describeVersions([], null)).toEqual([]);
    expect(describeVersions([version(1, 11, "final")], 1)).toEqual([]);
  });

  it("names a revised quote's draft and the sent version, newest first", () => {
    const rows = describeVersions([version(1, 11, "final"), version(2, 12, "draft")], 1);
    expect(rows.map(({ state, detail }) => [state, detail])).toEqual([["Draft", "Editing"], ["Sent", "11 Oct"]]);
    expect(rows[1].phrase).toBe("the quote sent on 11 Oct");
  });

  it("marks older sent versions superseded and never-sent ones as earlier drafts", () => {
    const rows = describeVersions([version(1, 2), version(2, 3, "final"), version(3, 11, "final"), version(4, 12)], 3);
    expect(rows.map(({ version: number, state, detail }) => [number, state, detail])).toEqual([
      [4, "Draft", "Editing"],
      [3, "Sent", "11 Oct"],
      [2, "Superseded", "Sent 3 Oct"],
      [1, "Earlier draft", "2 Oct"],
    ]);
    expect(rows[2].phrase).toBe("the quote sent on 3 Oct, since revised");
  });

  it("trusts the job's last sent version when a version carries no status", () => {
    const rows = describeVersions([version(1, 3), version(2, 11)], 2);
    expect(rows.map(({ state }) => state)).toEqual(["Sent", "Earlier draft"]);
  });
});
