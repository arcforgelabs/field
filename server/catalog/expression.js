// The safe quantity-expression language for assemblies (#148 section 4).
//
// An expression is arithmetic over numbers and named values (an assembly's
// params and vars): + - * /, unary minus, parentheses, and the functions
// ceil(x), floor(x), round(x) or round(x, digits), min(a, b, ...) and
// max(a, b, ...). Nothing else: no property access, no strings, no
// comparisons, and no eval/Function. It is parsed by hand into a small tree
// and evaluated over a plain scope object, so data in a quote catalog or the
// database can never run code.
import { CatalogError } from "./errors.js";

const MAX_LENGTH = 500;
const MAX_DEPTH = 32;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const FUNCTIONS = Object.freeze({
  ceil: { min: 1, max: 1, apply: ([x]) => Math.ceil(x) },
  floor: { min: 1, max: 1, apply: ([x]) => Math.floor(x) },
  round: {
    min: 1,
    max: 2,
    apply: ([x, digits = 0]) => {
      if (!Number.isInteger(digits) || digits < 0 || digits > 10) {
        throw invalid("round(x, digits) needs a whole number of digits between 0 and 10");
      }
      const factor = 10 ** digits;
      return Math.round(x * factor) / factor;
    },
  },
  min: { min: 1, max: Infinity, apply: (args) => Math.min(...args) },
  max: { min: 1, max: Infinity, apply: (args) => Math.max(...args) },
});

function invalid(message, source = null) {
  return new CatalogError("INVALID_EXPRESSION", source == null ? message : `${message} in "${source}"`, { path: "expr", status: 400 });
}

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i += 1; continue; }
    if ((ch >= "0" && ch <= "9") || (ch === "." && /[0-9]/.test(source[i + 1] || ""))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
      tokens.push({ type: "number", value: Number(match[0]), at: i });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      tokens.push({ type: "name", value: match[0], at: i });
      i += match[0].length;
      continue;
    }
    if ("+-*/(),".includes(ch)) {
      tokens.push({ type: ch, at: i });
      i += 1;
      continue;
    }
    throw invalid(`unexpected character "${ch}" at position ${i + 1}`, source);
  }
  tokens.push({ type: "end", at: source.length });
  return tokens;
}

/**
 * Parse an expression into a tree. Throws CatalogError INVALID_EXPRESSION.
 * Grammar:
 *   expr   := term (("+" | "-") term)*
 *   term   := unary (("*" | "/") unary)*
 *   unary  := "-" unary | atom
 *   atom   := number | name | name "(" expr ("," expr)* ")" | "(" expr ")"
 */
export function parseExpression(source) {
  if (typeof source === "number" && Number.isFinite(source)) return { type: "number", value: source };
  const text = String(source ?? "").trim();
  if (!text) throw invalid("expression is empty");
  if (text.length > MAX_LENGTH) throw invalid(`expression is longer than ${MAX_LENGTH} characters`);
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (type) => {
    const token = tokens[pos];
    if (token.type !== type) {
      throw invalid(`expected ${type === "end" ? "end of expression" : `"${type}"`} at position ${token.at + 1}`, text);
    }
    pos += 1;
    return token;
  };

  const parseExpr = (depth) => {
    if (depth > MAX_DEPTH) throw invalid("expression is nested too deeply", text);
    let node = parseTerm(depth);
    while (peek().type === "+" || peek().type === "-") {
      const op = tokens[pos++].type;
      node = { type: "binary", op, left: node, right: parseTerm(depth) };
    }
    return node;
  };
  const parseTerm = (depth) => {
    let node = parseUnary(depth);
    while (peek().type === "*" || peek().type === "/") {
      const op = tokens[pos++].type;
      node = { type: "binary", op, left: node, right: parseUnary(depth) };
    }
    return node;
  };
  const parseUnary = (depth) => {
    if (peek().type === "-") {
      pos += 1;
      if (depth + 1 > MAX_DEPTH) throw invalid("expression is nested too deeply", text);
      return { type: "negate", operand: parseUnary(depth + 1) };
    }
    return parseAtom(depth);
  };
  const parseAtom = (depth) => {
    const token = peek();
    if (token.type === "number") {
      pos += 1;
      return { type: "number", value: token.value };
    }
    if (token.type === "name") {
      pos += 1;
      if (peek().type !== "(") return { type: "name", name: token.value };
      const fn = FUNCTIONS[token.value];
      if (!fn || !Object.prototype.hasOwnProperty.call(FUNCTIONS, token.value)) {
        throw invalid(`unknown function "${token.value}" (allowed: ${Object.keys(FUNCTIONS).join(", ")})`, text);
      }
      take("(");
      const args = [parseExpr(depth + 1)];
      while (peek().type === ",") {
        pos += 1;
        args.push(parseExpr(depth + 1));
      }
      take(")");
      if (args.length < fn.min || args.length > fn.max) {
        throw invalid(`${token.value}() takes ${fn.min === fn.max ? fn.min : `${fn.min} or more`} argument(s)`, text);
      }
      return { type: "call", name: token.value, args };
    }
    if (token.type === "(") {
      pos += 1;
      const node = parseExpr(depth + 1);
      take(")");
      return node;
    }
    throw invalid(`unexpected ${token.type === "end" ? "end of expression" : `"${token.type}"`} at position ${token.at + 1}`, text);
  };

  const tree = parseExpr(0);
  take("end");
  return Object.freeze({ type: "expression", source: text, tree });
}

/** The names an expression reads (params and vars), in first-use order. */
export function expressionNames(expression) {
  const parsed = expression?.type === "expression" ? expression : parseExpression(expression);
  const names = [];
  const visit = (node) => {
    if (node.type === "name") { if (!names.includes(node.name)) names.push(node.name); return; }
    if (node.type === "binary") { visit(node.left); visit(node.right); return; }
    if (node.type === "negate") { visit(node.operand); return; }
    if (node.type === "call") node.args.forEach(visit);
  };
  visit(parsed.tree || parsed);
  return names;
}

/**
 * Evaluate an expression over `scope` (name -> finite number). An unknown
 * name, a division by zero or any non-finite result throws
 * INVALID_EXPRESSION; quantities are never silently NaN or Infinity.
 */
export function evaluateExpression(expression, scope = {}) {
  const parsed = expression?.type === "expression" ? expression : parseExpression(expression);
  const source = parsed.source;
  const evaluate = (node) => {
    switch (node.type) {
      case "number":
        return node.value;
      case "name": {
        if (!IDENTIFIER.test(node.name) || !Object.prototype.hasOwnProperty.call(scope, node.name)) {
          throw invalid(`unknown name "${node.name}"`, source);
        }
        const value = scope[node.name];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw invalid(`"${node.name}" has no numeric value`, source);
        }
        return value;
      }
      case "negate":
        return -evaluate(node.operand);
      case "binary": {
        const left = evaluate(node.left);
        const right = evaluate(node.right);
        if (node.op === "+") return left + right;
        if (node.op === "-") return left - right;
        if (node.op === "*") return left * right;
        if (right === 0) throw invalid("division by zero", source);
        return left / right;
      }
      case "call":
        return FUNCTIONS[node.name].apply(node.args.map(evaluate));
      default:
        throw invalid(`unsupported node ${node.type}`, source);
    }
  };
  const result = evaluate(parsed.tree || parsed);
  if (!Number.isFinite(result)) throw invalid("result is not a finite number", source);
  return result;
}
