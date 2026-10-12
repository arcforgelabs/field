import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node 25 exposes a partial localStorage global when --localstorage-file has no
// path. Avoid touching that warning-producing getter and install deterministic
// standards-shaped test storage before application modules are imported.
const values = new Map<string, string>();
const storage: Storage = {
  get length() { return values.size; },
  clear() { values.clear(); },
  getItem(key) { return values.has(String(key)) ? values.get(String(key))! : null; },
  key(index) { return Array.from(values.keys())[index] ?? null; },
  removeItem(key) { values.delete(String(key)); },
  setItem(key, value) { values.set(String(key), String(value)); },
};
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
});

afterEach(() => {
  cleanup();
});
