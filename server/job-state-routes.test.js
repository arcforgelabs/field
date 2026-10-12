// Boots the real server and drives the job-state routes over HTTP. A person's
// note and a detail edit are operational job-state: they must land in
// job-state/ at the job root, never inside a commercial generation (which
// rejects job-state and used to fail both routes with a 500).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JOB_GENERATIONS_DIR } from "./job-generation.js";

const ROOT = resolve(import.meta.dirname, "..");

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function bootServer(t) {
  const dir = await mkdtemp(join(tmpdir(), "field-job-state-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  const dataDir = join(dir, "data");
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    FIELD_CONFIG: configPath,
    FIELD_DATA: dataDir,
    FIELD_PGLITE_DIR: join(dir, "pglite"),
  };
  // A manual job prices against a catalogue, so seed the synthetic one the
  // quote/invoice proof uses into this run's PGlite database.
  execFileSync(process.execPath, ["scripts/quote-invoice-proof/seed.mjs", ROOT, dataDir], { cwd: ROOT, env, stdio: "ignore" });
  await writeFile(configPath, JSON.stringify({
    authToken: "job-state-routes-installation-token",
    quoteCatalogId: "field-verification",
    bootstrapUsers: [{ email: "owner@example.invalid", name: "Route Owner", password: "route-password" }],
  }));
  const port = await freePort();
  const output = [];
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...env, FIELD_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${output.join("")}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${output.join("")}`);
    await new Promise((wake) => setTimeout(wake, 200));
  }
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.invalid", password: "route-password" }),
  }).then((response) => response.json());
  return { base, dataDir, output, token: login.token };
}

async function findJobDir(dir, jobId) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    try {
      const meta = JSON.parse(await readFile(join(path, "meta.json"), "utf8"));
      if (meta.id === jobId) return path;
    } catch { /* not a job root */ }
    const nested = await findJobDir(path, jobId);
    if (nested) return nested;
  }
  return null;
}

async function readActivity(jobDir) {
  const raw = await readFile(join(jobDir, "job-state", "activity.jsonl"), "utf8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a person's note and a detail edit are written to job-state at the job root", async (t) => {
  const { base, dataDir, output, token } = await bootServer(t);
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const created = await call("POST", "/api/jobs/manual", { quoteCatalogId: "field-verification" });
  assert.equal(created.status, 200, `manual job failed: ${JSON.stringify(created.body)}\n${output.join("")}`);
  const jobId = created.body.id;
  const jobDir = await findJobDir(dataDir, jobId);
  assert.ok(jobDir, "job directory not found");

  const note = await call("POST", `/api/jobs/${jobId}/notes`, { text: "Gate code is on the fence" });
  assert.equal(note.status, 200, `note failed: ${JSON.stringify(note.body)}`);
  assert.equal(note.body.note.kind, "note.manual");
  assert.equal(note.body.note.body, "Gate code is on the fence");

  const activity = await readActivity(jobDir);
  assert.ok(activity.some((entry) => entry.id === note.body.note.id), "note missing from root job-state activity");

  const ledger = await call("GET", `/api/jobs/${jobId}/notes`);
  const row = ledger.body.notes.find((item) => item.id === note.body.note.id);
  assert.ok(row, "note missing from notes_ledger");
  assert.equal(row.text, "Gate code is on the fence");

  const detail = await call("PATCH", `/api/jobs/${jobId}/details`, { key: "siteAddress", value: "1 Route St" });
  assert.equal(detail.status, 200, `detail edit failed: ${JSON.stringify(detail.body)}`);
  const details = JSON.parse(await readFile(join(jobDir, "job-state", "details.json"), "utf8"));
  assert.equal(details.siteAddress, "1 Route St");
  assert.ok((await readActivity(jobDir)).some((entry) => entry.id === detail.body.activity.id));

  // Neither route left job-state inside a commercial generation.
  const generationsDir = join(jobDir, JOB_GENERATIONS_DIR);
  if (existsSync(generationsDir)) {
    for (const generation of await readdir(generationsDir)) {
      assert.equal(existsSync(join(generationsDir, generation, "job-state")), false);
    }
  }
});

const MOASURE_CSV = [
  '"Path","Point","X:m","Y:m","Z:m","Path-Type","Area:m²"',
  '"1","1","0","0","0","Boundary","12.5"',
  '"1","2","5","0","0.1","Boundary","12.5"',
  '"1","3","5","2.5","0.2","Boundary","12.5"',
  '"1","4","0","2.5","0.1","Boundary","12.5"',
  '"1","5","0","0","0","Boundary","12.5"',
].join("\n");

test("measurement upload, re-scan and detach keep Moasure evidence at the job root", async (t) => {
  const { base, dataDir, output, token } = await bootServer(t);
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { "content-type": "application/json" }) },
      body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const created = await call("POST", "/api/jobs/manual", { quoteCatalogId: "field-verification" });
  assert.equal(created.status, 200, `manual job failed: ${JSON.stringify(created.body)}\n${output.join("")}`);
  const jobId = created.body.id;
  const jobDir = await findJobDir(dataDir, jobId);
  assert.ok(jobDir, "job directory not found");

  const form = new FormData();
  form.append("files", new Blob([MOASURE_CSV], { type: "text/csv" }), "Front yard.csv");
  const uploaded = await call("POST", `/api/jobs/${jobId}/moasure-upload`, form);
  assert.equal(uploaded.status, 200, `upload failed: ${JSON.stringify(uploaded.body)}`);
  assert.equal(uploaded.body.moasure.status, "parsed");
  assert.equal(uploaded.body.moasure.imports.length, 1);
  const batchId = uploaded.body.moasure.latestBatchId;
  assert.ok(existsSync(join(jobDir, "moasure", "raw", batchId, "Front yard.csv")), "raw file missing from the job root");
  const ledger = JSON.parse(await readFile(join(jobDir, "ingestion-ledger.json"), "utf8"));
  assert.ok(ledger.files.some((file) => file.filePath === `moasure/raw/${batchId}/Front yard.csv`));
  assert.ok((await readActivity(jobDir)).some((entry) => entry.kind === "measurement.files_uploaded"));

  const scanned = await call("POST", `/api/jobs/${jobId}/moasure-scan`);
  assert.equal(scanned.status, 200, `scan failed: ${JSON.stringify(scanned.body)}`);
  assert.equal(scanned.body.moasure.imports.length, 1);
  assert.ok((await readActivity(jobDir)).some((entry) => entry.kind === "measurement.rescanned"));

  // Bay heights derive from the root Moasure evidence into the generation.
  const bays = await call("POST", `/api/jobs/${jobId}/wall-measurement`);
  assert.equal(bays.status, 200, `wall measurement failed: ${JSON.stringify(bays.body)}`);
  assert.ok(bays.body.data, "no bay heights returned");

  const detached = await call("DELETE", `/api/jobs/${jobId}/moasure-files/${encodeURIComponent(batchId)}/${encodeURIComponent("Front yard.csv")}`);
  assert.equal(detached.status, 200, `detach failed: ${JSON.stringify(detached.body)}`);
  assert.equal(detached.body.moasure.imports.length, 0);
  assert.ok((await readActivity(jobDir)).some((entry) => entry.kind === "measurement.file_removed"));
  // Detach hides the file from the draft; the raw evidence stays for history.
  assert.ok(existsSync(join(jobDir, "moasure", "raw", batchId, "Front yard.csv")));

  const generationsDir = join(jobDir, JOB_GENERATIONS_DIR);
  if (existsSync(generationsDir)) {
    for (const generation of await readdir(generationsDir)) {
      for (const entry of ["moasure", "ingestion-ledger.json", "parsed", "job-state", "raw"]) {
        assert.equal(existsSync(join(generationsDir, generation, entry)), false, `${entry} leaked into ${generation}`);
      }
    }
  }
});

test("measurement changes on a quoted job rebuild the draft and fork a quote the customer has seen", async (t) => {
  const { base, dataDir, output, token } = await bootServer(t);
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { "content-type": "application/json" }) },
      body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const upload = (name) => {
    const form = new FormData();
    form.append("files", new Blob([MOASURE_CSV], { type: "text/csv" }), name);
    return call("POST", `/api/jobs/${jobId}/moasure-upload`, form);
  };
  const { VERIFICATION_FIXTURES } = await import("../scripts/verification/fixtures.js");
  const fixture = VERIFICATION_FIXTURES[3];

  const created = await call("POST", "/api/jobs/manual", { quoteCatalogId: "field-verification", siteAddress: fixture.siteAddress });
  assert.equal(created.status, 200, `manual job failed: ${JSON.stringify(created.body)}\n${output.join("")}`);
  const jobId = created.body.id;
  const jobDir = await findJobDir(dataDir, jobId);
  const inputs = await call("PUT", `/api/jobs/${jobId}/quote-inputs`, fixture.quoteInputs);
  assert.equal(inputs.status, 200, `quote inputs failed: ${JSON.stringify(inputs.body)}`);
  // The transcript a rebuild needs is operational, so it lives at the root.
  assert.ok(existsSync(join(jobDir, "transcript.json")));

  // A draft quote is rebuilt in place against the new measurements.
  const draftUpload = await upload("Front yard.csv");
  assert.equal(draftUpload.status, 200, `draft upload failed: ${JSON.stringify(draftUpload.body)}`);
  assert.ok(draftUpload.body.quote, "draft quote was not rebuilt");
  assert.equal(draftUpload.body.meta.quoteVersion, 1);

  // Once the customer has seen it, a measurement change forks a new draft.
  const sent = await call("POST", `/api/jobs/${jobId}/pipeline-stage`, { stage: "sent" });
  assert.equal(sent.status, 200, `pipeline stage failed: ${JSON.stringify(sent.body)}`);
  const sentUpload = await upload("Back yard.csv");
  assert.equal(sentUpload.status, 200, `upload on a sent quote failed: ${JSON.stringify(sentUpload.body)}`);
  assert.equal(sentUpload.body.meta.quoteVersion, 2);
  assert.ok(sentUpload.body.quote, "forked quote was not rebuilt");
  assert.equal(sentUpload.body.moasure.imports.length, 2);

  // Detaching inside the same generation drops the file from the rebuild too.
  const batchId = sentUpload.body.moasure.latestBatchId;
  const detached = await call("DELETE", `/api/jobs/${jobId}/moasure-files/${encodeURIComponent(batchId)}/${encodeURIComponent("Back yard.csv")}`);
  assert.equal(detached.status, 200, `detach failed: ${JSON.stringify(detached.body)}`);
  assert.equal(detached.body.moasure.imports.length, 1);
  const rootSummary = JSON.parse(await readFile(join(jobDir, "moasure", "parsed", "latest.json"), "utf8"));
  assert.equal(rootSummary.imports.length, 1);

  const generationsDir = join(jobDir, JOB_GENERATIONS_DIR);
  for (const generation of await readdir(generationsDir)) {
    for (const entry of ["moasure", "ingestion-ledger.json", "parsed", "job-state", "raw", "transcript.json"]) {
      assert.equal(existsSync(join(generationsDir, generation, entry)), false, `${entry} leaked into ${generation}`);
    }
  }
});

// Versions archived by forkCurrentQuoteVersion keep only the commercial quote
// files: their transcript and measurements stay at the job root. Promoting one
// must rebuild from that root context instead of refusing or dropping the
// measurements.
test("promoting a version archived without its transcript or measurements rebuilds from the job root", async (t) => {
  const { base, dataDir, output, token } = await bootServer(t);
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { "content-type": "application/json" }) },
      body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const { VERIFICATION_FIXTURES } = await import("../scripts/verification/fixtures.js");
  const { forkCurrentQuoteVersion, formatQuoteVersionLabel } = await import("./quote-artifacts.js");
  const { resolveActiveJobGeneration } = await import("./job-generation.js");
  const fixture = VERIFICATION_FIXTURES[3];
  const moasureImportCount = async (dir) => JSON.parse(
    await readFile(join(dir, "quote-breakdown-source.json"), "utf8"),
  ).evidence.moasureImportCount;

  const created = await call("POST", "/api/jobs/manual", { quoteCatalogId: "field-verification", siteAddress: fixture.siteAddress });
  assert.equal(created.status, 200, `manual job failed: ${JSON.stringify(created.body)}\n${output.join("")}`);
  const jobId = created.body.id;
  const jobDir = await findJobDir(dataDir, jobId);
  const inputs = await call("PUT", `/api/jobs/${jobId}/quote-inputs`, fixture.quoteInputs);
  assert.equal(inputs.status, 200, `quote inputs failed: ${JSON.stringify(inputs.body)}`);
  const form = new FormData();
  form.append("files", new Blob([MOASURE_CSV], { type: "text/csv" }), "Front yard.csv");
  const uploaded = await call("POST", `/api/jobs/${jobId}/moasure-upload`, form);
  assert.equal(uploaded.status, 200, `upload failed: ${JSON.stringify(uploaded.body)}`);
  assert.equal(await moasureImportCount(await resolveActiveJobGeneration(jobDir)), 1);

  // Archive v1 the way forkCurrentQuoteVersion does: commercial files only.
  const forked = await forkCurrentQuoteVersion(jobDir);
  assert.deepEqual(forked, { previousVersion: 1, currentVersion: 2 });
  const archivedV1 = join(await resolveActiveJobGeneration(jobDir), "quote-versions", formatQuoteVersionLabel(1));
  assert.ok(existsSync(join(archivedV1, "quote.json")), "v1 was not archived");
  assert.equal(existsSync(join(archivedV1, "transcript.json")), false);
  assert.equal(existsSync(join(archivedV1, "moasure-summary.json")), false);

  const promoted = await call("POST", `/api/jobs/${jobId}/versions/1/promote`);
  assert.equal(promoted.status, 200, `promote failed: ${JSON.stringify(promoted.body)}`);
  assert.equal(promoted.body.sourceVersion, 1);
  assert.equal(promoted.body.previousVersion, 2);
  assert.equal(promoted.body.currentVersion, 3);

  const active = await resolveActiveJobGeneration(jobDir);
  assert.equal(await moasureImportCount(active), 1, "the promoted rebuild dropped the job's measurements");
  // The replaced v2 is archived with the root context it was built from.
  const archivedV2 = join(active, "quote-versions", formatQuoteVersionLabel(2));
  assert.deepEqual(
    JSON.parse(await readFile(join(archivedV2, "transcript.json"), "utf8")),
    JSON.parse(await readFile(join(jobDir, "transcript.json"), "utf8")),
  );
  const archivedSummary = JSON.parse(await readFile(join(archivedV2, "moasure-summary.json"), "utf8"));
  assert.equal(archivedSummary.imports.length, 1);
});

const WALL_CSV = [
  '"Layer","Path","Point","X:m","Y:m","Z:m","Layer-Name","Path-Type","Point-Name","Point-Type","Area:m²",',
  '"1","1","1","0.000","0.000","0.000","Base Layer","Dot2Dot","","Default",""',
  '"1","1","2","2.010","0.000","0.100","Base Layer","Dot2Dot","","Default",""',
  '"1","1","3","4.020","0.000","0.200","Base Layer","Dot2Dot","","Default",""',
  '"1","2","1","0.100","0.300","-0.650","Base Layer","Points","","Default",""',
  '"1","2","2","2.050","0.350","-0.950","Base Layer","Points","","Default",""',
  '"1","2","3","4.000","0.250","-1.200","Base Layer","Points","","Default",""',
].join("\n");

const WALL_DESIGN = {
  construction_rules: {
    bay_pitch_mm: 2010,
    min_remainder_for_extra_bay_mm: 500,
    max_sleepers_per_wall: 5,
    sleeper_height_mm: 200,
    tier2_trigger_m: 1.2,
    tier3_trigger_m: 2.4,
    protrusion_mm: 100,
    horizontal_step_mm: 600,
    post_below_ground_rule: "above_ground + 200mm",
    angle_threshold_degrees: 5,
    weld_time_minutes: 2,
    bags_per_hole: 8,
    pad_concrete_bags_per_2_bays: 0.5,
    cure_days: 2,
    sleeper_install_minutes_per_sleeper: 2,
  },
  design_overrides: { mower_gap_bays: [], cap_single_tier_bays: [], stairs: [] },
  process_times: {
    cutback_minutes: { "1T": 15, "2T": 25, "3T": 35 },
    drill_hours_per_hole: 1,
    concrete_minutes_per_post: 30,
    pad_height_minutes_per_post: 5,
    drainage_minutes_per_bay: 15,
    backfill_minutes: { "1T": 5, "2T": 10, "3T": 15 },
  },
  site: { distance_km_one_way: 18, crew_size: 3, estimated_site_days: 5 },
};

// A wall zone's sourceCsvPath names Moasure evidence under moasure/raw/, which
// stays at the job root. A quote build in a staged generation and the wall
// render must still price and draw the wall from it.
test("a wall zone measured from root Moasure evidence prices the quote and renders", async (t) => {
  const { base, dataDir, output, token } = await bootServer(t);
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { "content-type": "application/json" }) },
      body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const { VERIFICATION_FIXTURES } = await import("../scripts/verification/fixtures.js");
  const { resolveActiveJobGeneration, runAtomicJobGeneration } = await import("./job-generation.js");
  const fixture = VERIFICATION_FIXTURES[2];

  const created = await call("POST", "/api/jobs/manual", { quoteCatalogId: "field-verification", siteAddress: fixture.siteAddress });
  assert.equal(created.status, 200, `manual job failed: ${JSON.stringify(created.body)}\n${output.join("")}`);
  const jobId = created.body.id;
  const jobDir = await findJobDir(dataDir, jobId);
  const form = new FormData();
  form.append("files", new Blob([WALL_CSV], { type: "text/csv" }), "Rear wall.csv");
  const uploaded = await call("POST", `/api/jobs/${jobId}/moasure-upload`, form);
  assert.equal(uploaded.status, 200, `upload failed: ${JSON.stringify(uploaded.body)}`);
  const sourceCsvPath = `moasure/raw/${uploaded.body.moasure.latestBatchId}/Rear wall.csv`;
  assert.ok(existsSync(join(jobDir, sourceCsvPath)));

  // Wall zones are operator-authored commercial config, committed the way a
  // maintenance tool would: through one atomic generation.
  await runAtomicJobGeneration(jobDir, async (stagedJobDir) => {
    await writeFile(join(stagedJobDir, "wall-zones.json"), JSON.stringify({
      kind: "wall-zones",
      version: 1,
      baseDesign: WALL_DESIGN,
      zones: [{
        id: "rear-wall",
        title: "Rear retaining wall",
        lineItemCodes: ["retaining-wall__section-wall"],
        sourceCsvPath,
      }],
    }, null, 2));
  });

  const inputs = await call("PUT", `/api/jobs/${jobId}/quote-inputs`, fixture.quoteInputs);
  assert.equal(inputs.status, 200, `quote inputs failed: ${JSON.stringify(inputs.body)}`);
  const quote = JSON.parse(await readFile(join(await resolveActiveJobGeneration(jobDir), "quote.json"), "utf8"));
  const wallBreakdown = quote.internalPricing.lineItemBreakdowns
    .find((breakdown) => breakdown.sourceLineItemCode === "retaining-wall__section-wall");
  assert.equal(wallBreakdown?.recipe, "retaining_wall_exact", "the wall line was not priced from the measured wall zone");

  const render = await call("GET", `/api/jobs/${jobId}/wall-zones/rear-wall/render`);
  assert.equal(render.status, 200, `render failed: ${JSON.stringify(render.body)}`);
  assert.equal(render.body.data.measurementOverlay?.path1?.length, 3);
  assert.equal(render.body.data.measurementOverlay?.path2?.length, 3);
});
