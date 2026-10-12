import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "../../server/storage/fs-promises.js";
import { join, relative } from "node:path";

// These stores are created or mutated by the long-running app (password
// hashes/session tokens, SQLite journals, and the agent session directory).
// They remain boundary-scanned; they are excluded only from the canonical
// synthetic fixture hash so startup and authenticated smoke do not make the
// semantic fixture proof time-dependent.
const DEFAULT_EXCLUDES = new Set([
  ".field-verification-fixture-marker.json",
  "users.json",
  "field.db",
  "agent-integrations.json",
  ".sessions",
  "price-catalog",
]);

export async function hashVerificationTree(root, { excludes = DEFAULT_EXCLUDES } = {}) {
  const hash = createHash("sha256");
  const excluded = new Set([...DEFAULT_EXCLUDES, ...excludes]);
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      const name = relative(root, path).split("\\").join("/");
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error(`verification state contains an unsafe tree entry: ${name}`);
      }
      hash.update(`${name}\0`);
      if (info.isDirectory()) {
        await walk(path);
      } else {
        hash.update(await readFile(path));
      }
      hash.update("\0");
    }
  }
  await walk(root);
  return hash.digest("hex");
}
