// Test helper: a throwaway local S3 server with a LOCKED bucket, standing in
// for the R2 bucket of issued documents (#240), whose bucket lock refuses
// overwrite and delete. Off by default; opt in with
//
//   FIELD_R2_TEST_DOCKER=1     start a minio/minio container (pinned digest)
//
// startTestMinio() returns null when it is not set. Otherwise it starts MinIO
// on 127.0.0.1 with a random port and random throwaway credentials, creates a
// bucket with object locking on and a default COMPLIANCE retention of 1 day
// (`mc mb --with-lock`, `mc retention set --default`), and returns
// { endpoint, bucket, accessKeyId, secretAccessKey, containerId, stop }.
// stop() removes the container (no volume: nothing survives it). Credentials
// reach Docker through the environment, never the command line. It never
// talks to anything but the container it started.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export const MINIO_IMAGE = "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e"; // RELEASE.2025-09-07T16-13-09Z
export const MC_IMAGE = "minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727";

export function testMinioEnabled(env = process.env) {
  return env.FIELD_R2_TEST_DOCKER === "1";
}

async function waitReady(endpoint) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${endpoint}/minio/health/ready`)).ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error("MinIO did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function startTestMinio(env = process.env) {
  if (!testMinioEnabled(env)) return null;
  if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0) {
    throw new Error("FIELD_R2_TEST_DOCKER=1 requires a working Docker CLI");
  }
  const accessKeyId = `test${randomBytes(8).toString("hex")}`;
  const secretAccessKey = randomBytes(24).toString("hex");
  const bucket = `field-test-${randomBytes(4).toString("hex")}`;
  const childEnv = { ...process.env, MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey };
  const id = execFileSync("docker", [
    "run", "--rm", "--detach",
    "--label", "field-test=r2-minio",
    "--publish", "127.0.0.1::9000",
    "--env", "MINIO_ROOT_USER",
    "--env", "MINIO_ROOT_PASSWORD",
    MINIO_IMAGE, "server", "/data",
  ], { encoding: "utf8", env: childEnv }).trim();
  const remove = () => {
    const result = spawnSync("docker", ["rm", "--force", id], { stdio: "ignore" });
    if (result.status !== 0) throw new Error(`Failed to remove test MinIO container ${id}`);
  };
  try {
    const port = execFileSync("docker", ["port", id, "9000/tcp"], { encoding: "utf8" }).trim().match(/:(\d+)$/m)?.[1];
    if (!port) throw new Error("Docker did not publish a MinIO port");
    const endpoint = `http://127.0.0.1:${port}`;
    await waitReady(endpoint);
    // mc runs in the MinIO container's network namespace; MC_HOST_local
    // carries the credentials through the environment.
    const mcEnv = { ...process.env, MC_HOST_local: `http://${accessKeyId}:${secretAccessKey}@127.0.0.1:9000` };
    for (const args of [["mb", "--with-lock", `local/${bucket}`], ["retention", "set", "--default", "COMPLIANCE", "1d", `local/${bucket}`]]) {
      execFileSync("docker", ["run", "--rm", "--network", `container:${id}`, "--env", "MC_HOST_local", MC_IMAGE, ...args], { env: mcEnv, stdio: "ignore" });
    }
    return { endpoint, bucket, accessKeyId, secretAccessKey, region: "auto", containerId: id, stop: async () => remove() };
  } catch (error) {
    remove();
    throw error;
  }
}
