#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function expandHome(path) {
  if (!path) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(stderr.trim() || stdout.trim() || `${command} ${args.join(" ")} failed`);
      error.code = code;
      reject(error);
    });
  });
}

async function isWritableDirectory(path) {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    try {
      await access(dirname(path), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

async function resolveInstallPrefix() {
  const explicitPrefix = expandHome(process.env.FIELD_CLI_PREFIX || "");
  if (explicitPrefix) {
    await mkdir(explicitPrefix, { recursive: true });
    return explicitPrefix;
  }

  const { stdout } = await runCommand(npmCommand, ["config", "get", "prefix"]);
  const configuredPrefix = expandHome(stdout.trim());
  if (configuredPrefix && await isWritableDirectory(configuredPrefix)) {
    return configuredPrefix;
  }

  const localPrefix = join(homedir(), ".local");
  await mkdir(localPrefix, { recursive: true });
  return localPrefix;
}

async function main() {
  const installPrefix = await resolveInstallPrefix();
  const binDir = join(installPrefix, "bin");
  await mkdir(binDir, { recursive: true });

  await runCommand(npmCommand, ["link"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      npm_config_prefix: installPrefix,
    },
    stdio: "inherit",
  });

  console.log(`Field CLI installed via npm link`);
  console.log(`  prefix: ${installPrefix}`);
  console.log(`  bin dir: ${binDir}`);

  const pathEntries = String(process.env.PATH || "").split(delimiter).filter(Boolean);
  if (!pathEntries.includes(binDir)) {
    console.log(`  note: ensure ${binDir} is on PATH for non-login shells`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(typeof error?.code === "number" ? error.code : 1);
});
