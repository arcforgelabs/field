import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDocs, routeForFile } from "./docs-sync-publish.mjs";

// docs/ is published as the docs site (arcforgelabs/docs); the sync refuses
// a tree whose docs/docs.json names a missing page or leaves one out.
test("docs/docs.json lists every page once, and only pages that exist", () => {
  const { errors } = checkDocs();
  assert.deepEqual(errors, []);
});

test("page routes follow file names", () => {
  assert.equal(routeForFile("DATA_MODEL.md"), "data-model");
  assert.equal(routeForFile("releases/index.md"), "releases");
  assert.equal(routeForFile("index.md"), "");
});
