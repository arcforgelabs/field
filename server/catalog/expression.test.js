import assert from "node:assert/strict";
import test from "node:test";

import { evaluateExpression, expressionNames, parseExpression } from "./expression.js";

const invalid = (pattern) => (error) => error.code === "INVALID_EXPRESSION" && pattern.test(error.message);

test("arithmetic follows the usual precedence, with unary minus and parentheses", () => {
  assert.equal(evaluateExpression("1 + 2 * 3"), 7);
  assert.equal(evaluateExpression("(1 + 2) * 3"), 9);
  assert.equal(evaluateExpression("10 - 4 - 3"), 3);
  assert.equal(evaluateExpression("12 / 4 / 3"), 1);
  assert.equal(evaluateExpression("-2 * -3"), 6);
  assert.equal(evaluateExpression("- (2 + 3)"), -5);
  assert.equal(evaluateExpression(".5 + 1.25e1"), 13);
  assert.equal(evaluateExpression(4), 4);
});

test("params and vars are read from the scope", () => {
  const scope = { area_m2: 80, install_hours_per_m2: 4 / 23 };
  assert.equal(evaluateExpression("area_m2 * install_hours_per_m2", scope), 80 * (4 / 23));
  assert.deepEqual(expressionNames("max(1, ceil(length_m / pit_spacing_m)) + length_m"), ["length_m", "pit_spacing_m"]);
});

test("ceil, floor, round (to whole or n places), min and max", () => {
  assert.equal(evaluateExpression("ceil(2.01)"), 3);
  assert.equal(evaluateExpression("floor(2.99)"), 2);
  assert.equal(evaluateExpression("round(2.5)"), 3);
  assert.equal(evaluateExpression("round(80 * 0.15, 4)"), 12);
  assert.equal(evaluateExpression("round(1.23456, 4)"), 1.2346);
  assert.equal(evaluateExpression("min(3, 1, 2)"), 1);
  assert.equal(evaluateExpression("max(1, ceil(25.5 / 10))"), 3);
});

test("unknown names, unknown functions and wrong arity are refused", () => {
  assert.throws(() => evaluateExpression("area_m2 * 2", {}), invalid(/unknown name "area_m2"/));
  assert.throws(() => evaluateExpression("sqrt(4)"), invalid(/unknown function "sqrt"/));
  assert.throws(() => evaluateExpression("ceil(1, 2)"), invalid(/takes 1 argument/));
  assert.throws(() => evaluateExpression("round(1.5, 0.5)"), invalid(/whole number of digits/));
  assert.throws(() => evaluateExpression("x", { x: "12" }), invalid(/no numeric value/));
});

test("nothing but arithmetic parses: no property access, strings, calls on objects or assignment", () => {
  for (const source of [
    "constructor.constructor('return process')()",
    "process.exit(1)",
    "area_m2.toString",
    "'1' + 2",
    "x = 1",
    "a[0]",
    "1; 2",
    "`${1}`",
  ]) {
    assert.throws(() => parseExpression(source), (error) => error.code === "INVALID_EXPRESSION", source);
  }
  // A name that happens to be an Object.prototype property is still unknown.
  assert.throws(() => evaluateExpression("constructor + 1", {}), invalid(/unknown name "constructor"/));
  assert.throws(() => evaluateExpression("this", {}), invalid(/unknown name "this"/));
  assert.throws(() => evaluateExpression("toString(1)"), invalid(/unknown function "toString"/));
});

test("division by zero and non-finite results are refused, never Infinity or NaN", () => {
  assert.throws(() => evaluateExpression("1 / 0"), invalid(/division by zero/));
  assert.throws(() => evaluateExpression("x / (y - y)", { x: 1, y: 2 }), invalid(/division by zero/));
  assert.throws(() => evaluateExpression("1e308 * 10"), invalid(/not a finite number/));
});

test("malformed, empty, over-long and over-nested expressions are refused", () => {
  assert.throws(() => parseExpression(""), invalid(/empty/));
  assert.throws(() => parseExpression("1 +"), invalid(/unexpected end/));
  assert.throws(() => parseExpression("(1 + 2"), invalid(/expected "\)"/));
  assert.throws(() => parseExpression("1 2"), invalid(/expected end of expression/));
  assert.throws(() => parseExpression("1 + ".repeat(200) + "1"), invalid(/longer than/));
  assert.throws(() => parseExpression(`${"(".repeat(40)}1${")".repeat(40)}`), invalid(/nested too deeply/));
});
