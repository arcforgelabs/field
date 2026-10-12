import test from "node:test";
import assert from "node:assert/strict";
import { buildQuoteBreakdownSource, findBulkRemovalPlanForSection } from "./quote-breakdown-source.js";

const baseMeta = {
  id: "quote-breakdown-source-test",
};

test("buildQuoteBreakdownSource prefers parsed PDF cut/fill data and dedupes duplicate imports", () => {
  const breakdownSource = buildQuoteBreakdownSource({
    meta: baseMeta,
    evidencePack: {
      evidence: {
        segmentCount: 3,
        hasTimestampedSegments: true,
      },
    },
    quoteInputs: {
      lineItemCandidates: [
        {
          quoteCatalogItemCode: "soil-removal",
          label: "Site levelling spoil removal",
          quantity: 10,
          unit: "m3",
          section: "Earthworks — Site Levelling",
          rationale: "Manual cut/fill review found about 10 m3 net export.",
        },
        {
          quoteCatalogItemCode: "tip-truck",
          label: "Tip truck and driver",
          quantity: 2,
          unit: "load",
          section: "Earthworks — Soil Haulage",
          rationale: "Two loads cover the export.",
        },
      ],
      measurements: [],
      processReferences: [],
      siteConstraints: [],
    },
    moasureSummary: {
      imports: [
        {
          label: "Yard to be level",
          batchId: "A",
          csvFile: "Yard to be level.csv",
          area: 78.81,
          cutFillSummary: {
            title: "CUT/FILL VIEW",
            surfaceAreaM2: 78.81,
            cutVolumeM3: 23.38,
            fillVolumeM3: 1.6,
            netVolumeM3: -21.78,
            selectedLevelMm: 23,
          },
        },
        {
          label: "yard-to-be-level-alias",
          batchId: "B",
          csvFile: "Yard to be level.csv",
          area: 78.81,
          cutFillSummary: {
            title: "CUT/FILL VIEW",
            surfaceAreaM2: 78.81,
            cutVolumeM3: 23.38,
            fillVolumeM3: 1.6,
            netVolumeM3: -21.78,
            selectedLevelMm: 23,
          },
        },
        {
          label: "Rear yard retaining along fence line",
          batchId: "A",
          csvFile: "Rear yard retaining along fence line.csv",
          area: 0.39,
          cutFillSummary: {
            title: "CUT/FILL VIEW",
            surfaceAreaM2: 0.39,
            cutVolumeM3: 0,
            fillVolumeM3: -5.06,
            netVolumeM3: -5.06,
            selectedLevelMm: 0,
          },
        },
        {
          label: "Back left garden wall section",
          batchId: "A",
          csvFile: "Back left garden wall section.csv",
          area: 3.947,
          cutFillSummary: {
            title: "CUT/FILL VIEW",
            surfaceAreaM2: 3.95,
            cutVolumeM3: 1.97,
            fillVolumeM3: 0,
            netVolumeM3: -1.97,
            selectedLevelMm: 0,
          },
        },
      ],
    },
    details: {
      soilDump: {
        id: "woodside",
        name: "Adelaide Hills Recycling",
        drive: 20,
        dist: 15.2,
      },
    },
  });

  const plan = findBulkRemovalPlanForSection({
    breakdownSource,
    section: "Earthworks — Site Levelling",
  });

  assert.ok(plan, "expected a bulk removal plan");
  assert.equal(breakdownSource.evidence.moasureImportCount, 3);
  assert.equal(breakdownSource.evidence.moasurePdfCutFillCount, 3);
  assert.equal(plan.measurements?.source, "pdf_cut_fill");
  assert.equal(plan.measurements?.importCount, 3);
  assert.equal(plan.measurements?.grossCutVolumeM3, 25.35);
  assert.equal(plan.measurements?.fillVolumeM3, 1.6);
  assert.equal(plan.measurements?.netExportVolumeM3, 23.75);
  assert.equal(plan.explicit?.soilRemovalQuantityM3, 10);
  assert.equal(plan.explicit?.haulageLoads, 2);
  assert.equal(plan.chosen?.soilRemovalQuantityM3, 10);
  assert.equal(plan.chosen?.soilRemovalSource, "quote_input");
  assert.equal(plan.rawEvidence?.matchedImports?.length, 3);
  assert.equal(plan.rawEvidence?.matchedImports?.[0]?.duplicateCount, 2);
  assert.equal(
    plan.rawEvidence?.matchedImports?.find((item) => item.label === "Rear yard retaining along fence line")?.measurement?.netExportVolumeM3,
    0,
  );
});
