// Redirect `googleapis` to the offline fake for the proof harness.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const fakeUrl = pathToFileURL(join(import.meta.dirname, "fake-googleapis.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "googleapis") return { url: fakeUrl, shortCircuit: true, format: "module" };
    return nextResolve(specifier, context);
  },
});
