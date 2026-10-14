// Business settings: the update-check switch (migration 0023), on a throwaway
// PGlite database.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { createBusinessSettingsService } from "./business-settings.js";

let t;
before(async () => { t = await createTestDb(); });
after(async () => { await t?.close(); });

test("the update check is on until an owner turns it off, and other settings keep their values", async () => {
  const settings = createBusinessSettingsService({ db: t.db, orgUid: DEFAULT_ORG_UID });
  assert.equal((await settings.get()).updateCheck, true);
  await settings.update({ creditNoteOnReissue: "always" }, { actor: "owner-1" });
  assert.equal((await settings.get()).updateCheck, true);
  const off = await settings.update({ updateCheck: false }, { actor: "owner-1" });
  assert.equal(off.updateCheck, false);
  assert.equal(off.creditNoteOnReissue, "always");
  assert.equal((await settings.get()).updateCheck, false);
  assert.equal((await settings.update({ updateCheck: true })).updateCheck, true);
});

test("updateCheck must be true or false", async () => {
  const settings = createBusinessSettingsService({ db: t.db, orgUid: DEFAULT_ORG_UID });
  for (const value of ["false", 0, null]) {
    await assert.rejects(settings.update({ updateCheck: value }), /updateCheck must be true or false/);
  }
});
