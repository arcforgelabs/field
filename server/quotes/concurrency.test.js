// Optimistic concurrency for quote saves (#10): If-Match against the quote
// rows' version.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestDb } from "../db-runtime/index.js";
import { DEFAULT_ORG_UID } from "../db-runtime/tenancy.js";
import { assertQuoteRowsIfMatch, currentQuoteRowsTag } from "./concurrency.js";
import { mapQuoteArtifact } from "./from-artifact.js";
import { createQuoteRowService } from "./quote-rows.js";
import { FIXTURE_META, sectionedQuote } from "./test-fixtures.js";

let t;
let service;
before(async () => {
  t = await createTestDb();
  service = createQuoteRowService({ db: t.db, orgUid: DEFAULT_ORG_UID });
});
after(() => t.close());

test("a save with the current tag passes; a stale or unknown one is refused with 412; none is not checked", async () => {
  assert.equal(await currentQuoteRowsTag({ jobId: "job-c", version: 1, service }), null);
  await service.writeVersion({ jobId: "job-c", version: 1, mapped: mapQuoteArtifact({ quote: sectionedQuote(), meta: FIXTURE_META }), sourceDigest: "a" });
  const tag = await currentQuoteRowsTag({ jobId: "job-c", version: 1, service });
  assert.equal(tag, '"q1-1"');
  await assertQuoteRowsIfMatch({ jobId: "job-c", version: 1, ifMatch: tag, service });
  await assertQuoteRowsIfMatch({ jobId: "job-c", version: 1, ifMatch: `W/${tag}`, service });
  await assertQuoteRowsIfMatch({ jobId: "job-c", version: 1, ifMatch: "*", service });
  await assertQuoteRowsIfMatch({ jobId: "job-c", version: 1, ifMatch: null, service });

  // Someone else saves: the rows move on.
  const edited = sectionedQuote();
  edited.presentation.organizer.nodes["manual:fee"].manualPrice = 175;
  await service.writeVersion({ jobId: "job-c", version: 1, mapped: mapQuoteArtifact({ quote: edited, meta: FIXTURE_META }), sourceDigest: "b" });
  await assert.rejects(
    assertQuoteRowsIfMatch({ jobId: "job-c", version: 1, ifMatch: tag, service }),
    (error) => error.statusCode === 412 && error.code === "QUOTE_ROWS_CHANGED" && error.current === '"q1-2"',
  );
  await assert.rejects(assertQuoteRowsIfMatch({ jobId: "job-c", version: 2, ifMatch: tag, service }), { statusCode: 412 });
});
