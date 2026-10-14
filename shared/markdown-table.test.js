import assert from "node:assert/strict";
import test from "node:test";
import { escapeMarkdownCell } from "./markdown-table.js";

test("a Markdown cell escapes the backslash before the pipe and keeps to one line", () => {
  assert.equal(escapeMarkdownCell("a\\|b"), "a\\\\\\|b");
  assert.equal(escapeMarkdownCell("a|b"), "a\\|b");
  assert.equal(escapeMarkdownCell("C:\\dump"), "C:\\\\dump");
  assert.equal(escapeMarkdownCell("one\ntwo\r\nthree\rfour"), "one two three four");
  assert.equal(escapeMarkdownCell(0), "0");
  assert.equal(escapeMarkdownCell(null), "");
  // Split on unescaped pipes, a row keeps its three cells.
  const row = `| ${["a\\|b", "c\\", "d"].map(escapeMarkdownCell).join(" | ")} |`;
  assert.equal(row.split(/(?<!\\)(?:\\\\)*\|/).length, 5);
});
