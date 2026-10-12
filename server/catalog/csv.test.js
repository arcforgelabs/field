import assert from "node:assert/strict";
import test from "node:test";

import { decodePriceListBytes, guessColumnMap, parseCsv, parseMoney, validateColumnMap } from "./csv.js";

test("parseCsv reads quotes, doubled quotes, CRLF, a BOM and blank lines", () => {
  const text = "﻿SKU,Description,Price\r\nA1,\"Gravel, 20mm\",\"$1,234.50\"\r\n\r\nB2,\"Say \"\"hi\"\"\",12\n";
  const parsed = parseCsv(text);
  assert.equal(parsed.delimiter, ",");
  assert.deepEqual(parsed.headers, ["SKU", "Description", "Price"]);
  assert.deepEqual(parsed.rows, [["A1", "Gravel, 20mm", "$1,234.50"], ["B2", "Say \"hi\"", "12"]]);
});

test("parseCsv detects semicolon and tab delimiters and makes headers unique", () => {
  assert.deepEqual(parseCsv("code;price;price\nx;1;2").headers, ["code", "price", "price (2)"]);
  assert.equal(parseCsv("code\tprice\nx\t1").delimiter, "\t");
});

test("parseCsv refuses an unclosed quote and an empty file", () => {
  assert.throws(() => parseCsv("a,b\n\"x,1"), { code: "INVALID" });
  assert.throws(() => parseCsv("\n\n"), { code: "INVALID" });
});

test("decodePriceListBytes refuses an Excel workbook and binary data", () => {
  assert.throws(() => decodePriceListBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2])), /Excel/);
  assert.throws(() => decodePriceListBytes(Buffer.from([0x41, 0x00, 0x42])), /not a text/);
});

test("parseMoney reads currency text, blanks as null and junk as NaN", () => {
  assert.equal(parseMoney("$1,234.50"), 1234.5);
  assert.equal(parseMoney("AUD 12.5"), 12.5);
  assert.equal(parseMoney("(4.00)"), -4);
  assert.equal(parseMoney("-$3"), -3);
  assert.equal(parseMoney(""), null);
  assert.ok(Number.isNaN(parseMoney("call us")));
});

test("parseMoney with decimalComma (a ;-separated file) reads 12,75 as 12.75 and refuses ambiguous commas", () => {
  assert.equal(parseMoney("12,75", { decimalComma: true }), 12.75);
  assert.equal(parseMoney("EUR 1.234,50", { decimalComma: true }), 1234.5);
  assert.equal(parseMoney("$1,234.50", { decimalComma: true }), 1234.5);
  assert.equal(parseMoney("12.75", { decimalComma: true }), 12.75);
  assert.ok(Number.isNaN(parseMoney("1,275", { decimalComma: true })), "thousands or three decimals: not guessed");
  assert.equal(parseMoney("12,75"), 1275, "a ,-separated file keeps the comma as a thousands separator");
});

test("guessColumnMap and validateColumnMap", () => {
  const headers = ["Supplier Code", "Description", "UOM", "Unit Price", "RRP"];
  const map = guessColumnMap(headers);
  assert.deepEqual(map, { supplier_code: "Supplier Code", name: "Description", unit: "UOM", cost: "Unit Price", sell: "RRP" });
  assert.deepEqual(validateColumnMap(map, headers), map);
  assert.throws(() => validateColumnMap({ name: "Description" }, headers), /cost/);
  assert.throws(() => validateColumnMap({ cost: "Unit Price" }, headers), /supplier code, item code or name/);
  assert.throws(() => validateColumnMap({ cost: "Nope", name: "Description" }, headers), /not in the file/);
  assert.throws(() => validateColumnMap({ cost: "Unit Price", colour: "UOM" }, headers), /Unknown column map field/);
});
