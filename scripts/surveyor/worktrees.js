import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Detached baseline/candidate worktrees.
 *
 * Never
 * check out the baseline or candidate ref in the synced repo root. Sync can leave
 * the root dirty, `git checkout` then aborts or mixes proof state across lanes.
 * Each lane gets its own detached worktree under the run's output directory.
 */

export function git(args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`));
      }
      resolvePromise(stdout.trim());
    });
  });
}

export async function resolveSha(ref, { repoRoot }) {
  return git(["rev-parse", ref], { cwd: repoRoot });
}

/**
 * Create one detached worktree per lane. Returns { path, ref, sha }.
 */
export async function addWorktree({ repoRoot, ref, lane, outputDir }) {
  const path = join(outputDir, lane, "checkout");
  mkdirSync(join(outputDir, lane), { recursive: true });
  rmSync(path, { recursive: true, force: true });
  const sha = await resolveSha(ref, { repoRoot });
  await git(["worktree", "add", "--detach", "--force", path, sha], { cwd: repoRoot });
  return { path, ref, sha, lane };
}

export async function removeWorktree({ repoRoot, path }) {
  try {
    await git(["worktree", "remove", "--force", path], { cwd: repoRoot });
    return true;
  } catch {
    rmSync(path, { recursive: true, force: true });
    return false;
  }
}

/** `git worktree prune` after a crashed run leaves stale administrative entries. */
export async function pruneWorktrees({ repoRoot }) {
  await git(["worktree", "prune"], { cwd: repoRoot });
}
