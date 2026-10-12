import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  Cell,
  DataTable,
  HeaderCell,
  Row,
  SearchField,
  SegmentedControl,
  SideDrawer,
} from "./index";
import { formatMoney, formatPercent } from "./format";

describe("SegmentedControl", () => {
  function TypeFilter() {
    const [value, setValue] = useState<"all" | "materials" | "labour">("all");
    return (
      <SegmentedControl
        label="Type"
        value={value}
        onChange={setValue}
        options={[
          { value: "all", label: "All" },
          { value: "materials", label: "Materials", count: 12 },
          { value: "labour", label: "Labour" },
        ]}
      />
    );
  }

  it("is one tab stop and arrow keys move the choice, wrapping at the ends", () => {
    render(<TypeFilter />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

    fireEvent.keyDown(radios[0], { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: /Materials/ })).toHaveProperty("ariaChecked", "true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Materials/ }));

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "All" })).toHaveProperty("ariaChecked", "true");
  });
});

describe("Row", () => {
  it("opens on click, Enter and Space, and arrow keys move between rows", () => {
    const open = vi.fn();
    render(
      <DataTable caption="Items">
        <thead>
          <tr>
            <HeaderCell>Name</HeaderCell>
            <HeaderCell numeric sort="asc" onSort={() => {}}>Sell</HeaderCell>
          </tr>
        </thead>
        <tbody>
          <Row onActivate={() => open("a")}><Cell>Topsoil</Cell><Cell numeric>$45.00</Cell></Row>
          <Row onActivate={() => open("b")} selected><Cell>Gravel</Cell><Cell numeric>$60.00</Cell></Row>
        </tbody>
      </DataTable>,
    );
    const rows = screen.getAllByRole("row").slice(1);
    fireEvent.click(rows[0]);
    fireEvent.keyDown(rows[0], { key: "Enter" });
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: " " });
    expect(open.mock.calls).toEqual([["a"], ["a"], ["b"]]);
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("columnheader", { name: /Sell/ }).getAttribute("aria-sort")).toBe("ascending");
  });
});

describe("SearchField", () => {
  it("clears on Escape and on the clear button", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchField value="tops" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    expect(onChange).toHaveBeenLastCalledWith("");
    rerender(<SearchField value="tops" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("focuses from its shortcut key, but not while typing elsewhere", () => {
    render(
      <>
        <input aria-label="Other" />
        <SearchField value="" onChange={() => {}} shortcut="/" />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("Other"), { key: "/" });
    expect(document.activeElement).not.toBe(screen.getByRole("searchbox"));
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });
});

describe("SideDrawer", () => {
  it("takes focus, closes on Escape and gives focus back", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open item</button>
          <SideDrawer open={open} onClose={() => setOpen(false)} title="TS-01 Topsoil" kicker="Material">
            <p>Pricing</p>
          </SideDrawer>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open item" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "TS-01 Topsoil" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("number formats", () => {
  it("always shows money to two decimals and percentages to one", () => {
    expect(formatMoney(1654.5632)).toBe("$1,654.56");
    expect(formatMoney(132)).toBe("$132.00");
    expect(formatMoney(null)).toBe("–");
    expect(formatPercent(32.456)).toBe("32.5%");
    expect(formatPercent(undefined)).toBe("–");
  });
});
