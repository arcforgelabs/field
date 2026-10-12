import test from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as fs from "./fs.js";
import * as fsp from "./fs-promises.js";
import { setDataRoot, setWriteRecorder } from "./write-recorder.js";

function scratch(t) {
  const base = nodeFs.mkdtempSync(join(tmpdir(), "field-storage-"));
  const root = join(base, "data");
  const outside = join(base, "data-sibling"); // shares the root's prefix but is outside it
  nodeFs.mkdirSync(root);
  nodeFs.mkdirSync(outside);
  const records = [];
  t.after(() => {
    setWriteRecorder(null);
    setDataRoot(null);
    nodeFs.rmSync(base, { recursive: true, force: true });
  });
  return { root, outside, records, record: () => {
    setDataRoot(root);
    setWriteRecorder((path, kind) => records.push([path, kind]));
  } };
}

// Runs one write of every kind under `dir`, in the given API style, and returns
// the [path, kind] records that should result when `dir` is the data root.
async function everyWriteKind(dir, api) {
  const p = (name) => join(dir, name);
  const expected = [];
  const run = async (kind, paths, call) => {
    await call();
    for (const path of paths) expected.push([path, kind]);
  };
  const cb = (name) => promisify(fs[name]);
  const call = {
    sync: (name, ...args) => fs[`${name}Sync`](...args),
    callback: (name, ...args) => cb(name)(...args),
    promises: (name, ...args) => fsp[name](...args),
  }[api];

  await run("mkdir", [p("d")], () => call("mkdir", p("d")));
  await run("writeFile", [p("a.txt")], () => call("writeFile", p("a.txt"), "a"));
  await run("appendFile", [p("a.txt")], () => call("appendFile", p("a.txt"), "b"));
  await run("copyFile", [p("b.txt")], () => call("copyFile", p("a.txt"), p("b.txt")));
  await run("cp", [p("d2")], () => call("cp", p("d"), p("d2"), { recursive: true }));
  await run("rename", [p("b.txt"), p("c.txt")], () => call("rename", p("b.txt"), p("c.txt")));
  await run("truncate", [p("c.txt")], () => call("truncate", p("c.txt"), 0));
  await run("utimes", [p("c.txt")], () => call("utimes", p("c.txt"), new Date(), new Date()));
  await run("chmod", [p("c.txt")], () => call("chmod", p("c.txt"), 0o600));
  await run("symlink", [p("s.txt")], () => call("symlink", p("c.txt"), p("s.txt")));
  await run("lutimes", [p("s.txt")], () => call("lutimes", p("s.txt"), new Date(), new Date()));
  await run("link", [p("h.txt")], () => call("link", p("c.txt"), p("h.txt")));
  await run("open", [p("lock")], async () => {
    const opened = await call("open", p("lock"), "wx", 0o600);
    if (typeof opened === "number") nodeFs.closeSync(opened);
    else await opened.close();
  });
  await run("unlink", [p("h.txt")], () => call("unlink", p("h.txt")));
  await run("rmdir", [p("d")], () => call("rmdir", p("d")));
  await run("rm", [p("d2")], () => call("rm", p("d2"), { recursive: true }));
  const temp = await call("mkdtemp", join(dir, "t-"));
  expected.push([temp, "mkdtemp"]);
  return expected;
}

for (const api of ["sync", "callback", "promises"]) {
  test(`${api} API records every write kind under the data root`, async (t) => {
    const { root, records, record } = scratch(t);
    record();
    const expected = await everyWriteKind(root, api);
    assert.deepEqual(records, expected);
  });

  test(`${api} API records nothing outside the data root`, async (t) => {
    const { outside, records, record } = scratch(t);
    record();
    await everyWriteKind(outside, api);
    assert.deepEqual(records, []);
  });
}

test("createWriteStream records the file once it is opened", async (t) => {
  const { root, records, record } = scratch(t);
  record();
  const path = join(root, "stream.txt");
  const stream = fs.createWriteStream(path);
  stream.end("hello");
  await new Promise((resolve, reject) => stream.on("close", resolve).on("error", reject));
  assert.equal(nodeFs.readFileSync(path, "utf8"), "hello");
  assert.deepEqual(records, [[path, "createWriteStream"]]);
});

test("reads and read-only opens are not recorded", async (t) => {
  const { root, records, record } = scratch(t);
  const path = join(root, "r.txt");
  nodeFs.writeFileSync(path, "r");
  record();
  fs.readFileSync(path);
  fs.existsSync(path);
  fs.statSync(path);
  fs.readdirSync(root);
  await fsp.readFile(path);
  await fsp.readdir(root);
  await fsp.stat(path);
  await fsp.access(path);
  nodeFs.closeSync(fs.openSync(path));
  nodeFs.closeSync(fs.openSync(path, "r"));
  nodeFs.closeSync(fs.openSync(path, nodeFs.constants.O_RDONLY));
  await (await fsp.open(path, "r")).close();
  await new Promise((resolve, reject) => fs.createReadStream(path).on("close", resolve).on("error", reject).resume());
  assert.deepEqual(records, []);
});

test("numeric open flags that write are recorded", async (t) => {
  const { root, records, record } = scratch(t);
  record();
  const path = join(root, "n.txt");
  nodeFs.closeSync(fs.openSync(path, nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT));
  assert.deepEqual(records, [[path, "open"]]);
});

test("relative, Buffer and file URL paths are recorded as absolute paths", async (t) => {
  const { root, records, record } = scratch(t);
  record();
  const a = join(root, "rel.txt");
  const b = join(root, "buf.txt");
  const c = join(root, "url.txt");
  fs.writeFileSync(relative(process.cwd(), a), "x");
  fs.writeFileSync(Buffer.from(b), "x");
  await fsp.writeFile(pathToFileURL(c), "x");
  fs.writeFileSync(join(root, "rel.txt"), "x");
  assert.deepEqual(records, [[a, "writeFile"], [b, "writeFile"], [c, "writeFile"], [a, "writeFile"]]);
});

test("the data root itself counts as under the data root", async (t) => {
  const { root, records, record } = scratch(t);
  record();
  fs.rmSync(root, { recursive: true });
  fs.mkdirSync(root);
  assert.deepEqual(records, [[root, "rm"], [root, "mkdir"]]);
});

test("nothing is recorded without a recorder or without a data root", async (t) => {
  const { root, records } = scratch(t);
  setDataRoot(root);
  fs.writeFileSync(join(root, "a"), "a");
  setDataRoot(null);
  setWriteRecorder((path, kind) => records.push([path, kind]));
  fs.writeFileSync(join(root, "b"), "b");
  await fsp.writeFile(join(root, "c"), "c");
  assert.deepEqual(records, []);
});

test("read and stream exports are node:fs's own functions", () => {
  for (const name of ["readFileSync", "existsSync", "statSync", "readdirSync", "createReadStream", "readFile", "close", "constants"]) {
    assert.equal(fs[name], nodeFs[name], name);
  }
  for (const name of ["readFile", "readdir", "stat", "access", "constants"]) {
    assert.equal(fsp[name], nodeFsPromises[name], name);
  }
  assert.equal(fs.promises.writeFile, fsp.writeFile);
  assert.equal(fs.default.promises.writeFile, fsp.writeFile);
  assert.equal(fs.default.writeFileSync, fs.writeFileSync);
  assert.equal(fsp.default.rename, fsp.rename);
});

async function settle(fn) {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error };
  }
}

for (const [label, withRecorder] of [["without a recorder", false], ["with a recorder", true]]) {
  test(`writes return node:fs's values and errors ${label}`, async (t) => {
    const { root, records, record } = scratch(t);
    if (withRecorder) record();
    const p = (name) => join(root, name);

    assert.equal(fs.mkdirSync(p("x/y"), { recursive: true }), p("x"));
    assert.equal(fs.mkdirSync(p("x/y"), { recursive: true }), undefined);
    assert.equal(await fsp.mkdir(p("z"), { recursive: true }), p("z"));
    assert.equal(fs.writeFileSync(p("w"), "w"), undefined);
    assert.equal(await fsp.writeFile(p("w"), "w"), undefined);
    assert.equal(typeof fs.openSync(p("o"), "w"), "number");
    const handle = await fsp.open(p("o2"), "w");
    assert.equal(handle.constructor.name, "FileHandle");
    await handle.close();
    assert.match(fs.mkdtempSync(p("t-")), /t-/);

    const cases = [
      ["renameSync", () => fs.renameSync(p("missing"), p("dest")), () => nodeFs.renameSync(p("missing"), p("dest"))],
      ["writeFileSync", () => fs.writeFileSync(p("no/such/file"), "x"), () => nodeFs.writeFileSync(p("no/such/file"), "x")],
      ["open wx", () => fsp.open(p("w"), "wx"), () => nodeFsPromises.open(p("w"), "wx")],
      ["rm", () => fsp.rm(p("missing")), () => nodeFsPromises.rm(p("missing"))],
      ["unlink cb", () => promisify(fs.unlink)(p("missing")), () => promisify(nodeFs.unlink)(p("missing"))],
      ["mkdir cb", () => promisify(fs.mkdir)(p("z")), () => promisify(nodeFs.mkdir)(p("z"))],
    ];
    const before = records.length;
    for (const [name, viaShim, viaNode] of cases) {
      const shim = await settle(viaShim);
      const node = await settle(viaNode);
      assert.ok(shim.error && node.error, `${name} should fail`);
      assert.equal(shim.error.constructor, node.error.constructor, name);
      assert.equal(shim.error.message, node.error.message, name);
      assert.equal(shim.error.code, node.error.code, name);
      assert.equal(shim.error.syscall, node.error.syscall, name);
    }
    assert.equal(records.length, before, "failed writes are not recorded");
  });
}

test("a failing recorder surfaces through every API style", async (t) => {
  const { root } = scratch(t);
  setDataRoot(root);
  const failure = new Error("record failed");
  setWriteRecorder(() => { throw failure; });
  assert.throws(() => fs.writeFileSync(join(root, "a"), "a"), failure);
  await assert.rejects(fsp.writeFile(join(root, "b"), "b"), failure);
  await assert.rejects(promisify(fs.writeFile)(join(root, "c"), "c"), failure);
  const stream = fs.createWriteStream(join(root, "d"));
  await assert.rejects(new Promise((resolve, reject) => stream.on("error", reject).on("finish", resolve)), failure);
  // The write itself happened; only the record failed.
  assert.equal(nodeFs.readFileSync(join(root, "a"), "utf8"), "a");
});

test("setWriteRecorder rejects a non-function", () => {
  assert.throws(() => setWriteRecorder("nope"), TypeError);
});
