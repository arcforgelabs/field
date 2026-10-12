import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The first Surveyor scenario: narrow enough to keep the harness honest, with a deterministic
 * oracle rather than a screenshot.
 *
 * Oracle: the Field HTTP server boots on an isolated port with an isolated data
 * root and answers a request. No product behaviour is asserted, so this is a
 * harness smoke — it proves the lane works, not that a bug is fixed.
 */

const BOOT_TIMEOUT_MS = 90_000;

/**
 * Stderr shapes that mean "the environment is wrong", not "the product is
 * broken". Rule: a setup failure must report as a harness failure so a
 * maintainer never reads it as a verdict on the code.
 */
const SETUP_FAILURE_PATTERNS = [
  /FIELD_TOKEN or config\.authToken required/i,
  /EADDRINUSE/i,
  /Cannot find module/i,
  /ERR_MODULE_NOT_FOUND/i,
];

function classifyBootFailure(stderr) {
  const matched = SETUP_FAILURE_PATTERNS.find((pattern) => pattern.test(stderr));
  return matched ? { status: "error", setupIssue: matched.source } : { status: "fail", setupIssue: null };
}

function pickPort(offset = 0) {
  // 19200 is the Field default; step well clear of it and of the operator's dev server.
  return 24_000 + (process.pid % 500) + offset;
}

async function poll(url, { timeoutMs, signalStopped }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (signalStopped()) return { ok: false, reason: "server exited before answering" };
    try {
      const response = await fetch(url, { redirect: "manual" });
      return { ok: true, status: response.status };
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { ok: false, reason: `no response within ${timeoutMs}ms: ${lastError?.message ?? "unknown"}` };
}

export const serverBootSmoke = {
  id: "server-boot-smoke",
  title: "Field server boots and answers on an isolated port",
  transport: "http",
  smoke: true,
  requiredCredentials: [],
  baselineExpectation: "server answers",
  candidateExpectation: "server answers",
  visualCaptureTargets: [],
  timeoutMs: BOOT_TIMEOUT_MS + 30_000,

  /**
   * @returns {Promise<{status: "pass"|"fail"|"error", oracle: object, notes: string[]}>}
   */
  async run({ checkoutPath, lane, log }) {
    const notes = [];
    const dataDir = mkdtempSync(join(tmpdir(), `surveyor-${lane}-data-`));
    const port = pickPort(lane === "candidate" ? 1 : 0);
    // The lane provisions its own throwaway auth token against its own empty
    // data root. It must never borrow the operator's config or real token.
    const authToken = `surveyor-${randomBytes(16).toString("hex")}`;
    let child = null;
    let exited = false;
    let stderrTail = "";

    try {
      log(`SURVEYOR_PHASE:install:${lane}`);
      const install = await runOnce("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: checkoutPath,
        timeoutMs: 600_000,
      });
      if (install.code !== 0) {
        // Dependency install is harness, not product: report `error`, not `fail`.
        return {
          status: "error",
          oracle: { stage: "install", exitCode: install.code },
          notes: [`npm install failed in ${lane} lane`],
        };
      }

      log(`SURVEYOR_PHASE:boot:${lane}`);
      child = spawn("node", ["server/index.js"], {
        cwd: checkoutPath,
        env: {
          ...process.env,
          FIELD_PORT: String(port),
          FIELD_DATA: dataDir,
          FIELD_TOKEN: authToken,
          NODE_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.on("exit", () => (exited = true));
      child.stdout.on("data", (chunk) => log(`[${lane}] ${String(chunk).trimEnd()}`));
      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        stderrTail = `${stderrTail}${text}`.slice(-4000);
        log(`[${lane}!] ${text.trimEnd()}`);
      });

      const result = await poll(`http://127.0.0.1:${port}/`, {
        timeoutMs: BOOT_TIMEOUT_MS,
        signalStopped: () => exited,
      });

      if (!result.ok) {
        const { status, setupIssue } = classifyBootFailure(stderrTail);
        if (setupIssue) notes.push(`setup blocker matched /${setupIssue}/ in ${lane} lane`);
        return {
          status,
          oracle: { stage: "boot", port, reason: result.reason, setupIssue },
          notes,
        };
      }
      if (result.status >= 500) {
        return { status: "fail", oracle: { stage: "respond", port, httpStatus: result.status }, notes };
      }
      return { status: "pass", oracle: { stage: "respond", port, httpStatus: result.status }, notes };
    } finally {
      if (child && !exited) child.kill("SIGTERM");
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch (error) {
        notes.push(`cleanup: could not remove isolated data dir (${error.code ?? "unknown"})`);
      }
    }
  },
};

function runOnce(command, args, { cwd, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stderr });
    });
  });
}
