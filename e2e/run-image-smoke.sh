#!/usr/bin/env bash
# Playwright smoke of a built Field image, on synthetic data.
#
#   e2e/run-image-smoke.sh <image> [revision]
#
# Starts a throwaway PostgreSQL container, seeds the verification catalogue
# (scripts/verification/fixtures.js) into it with the image's own code, starts
# the image the way README.md ("Deploying", Docker) documents, and runs
# e2e/smoke.spec.js against it. With a revision, /health must report it.
# Everything it starts is removed when it exits. Needs Docker, and Playwright's
# Chromium (`npx --prefix e2e playwright install chromium`).
set -euo pipefail

image="${1:?usage: e2e/run-image-smoke.sh <image> [revision]}"
revision="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
port="${FIELD_SMOKE_PORT:-19299}"
pg_port="${FIELD_SMOKE_PG_PORT:-55432}"
suffix="$$"
pg="field-smoke-pg-$suffix"
app="field-smoke-app-$suffix"
db="postgres://postgres@127.0.0.1:${pg_port}/field_smoke"

cleanup() {
  status=$?
  if [[ $status -ne 0 ]] && docker inspect "$app" >/dev/null 2>&1; then
    echo "--- Field log (last 80 lines)"
    docker logs "$app" 2>&1 | tail -n 80
  fi
  docker rm -f "$app" "$pg" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker run -d --name "$pg" -p "127.0.0.1:${pg_port}:5432" \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=field_smoke postgres:16-alpine >/dev/null
# Over TCP: the image's first start runs initdb on a socket-only server and then
# restarts, so a socket check can pass before the real server is up.
for _ in $(seq 1 60); do
  docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres -d field_smoke >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres -d field_smoke >/dev/null

# The image holds the catalogue code and fixtures; only the seed script is
# lent to it, read-only.
docker run --rm --network host \
  -v "$root/scripts/quote-invoice-proof/seed.mjs:/app/scripts/quote-invoice-proof/seed.mjs:ro" \
  -e DATABASE_URL="$db" -e FIELD_DB_URL="$db" \
  "$image" node scripts/quote-invoice-proof/seed.mjs /app /tmp

config='{"dataDir":"/app/data","authToken":"smoke-installation-token","quoteCatalogId":"field-verification","bootstrapUsers":[{"email":"smoke.operator@example.invalid","password":"smoke-password-fixture","role":"admin","name":"Smoke Operator"}],"mail":{"fromEmail":"smoke.operator@example.invalid","gmailUser":"smoke.operator@example.invalid","deliveryPolicy":{"mode":"live"}},"googleServiceAccountKey":"/tmp/smoke-key.json"}'
docker run -d --name "$app" --network host \
  -v "$root/scripts/quote-invoice-proof/hooks.mjs:/tmp/hooks.mjs:ro" \
  -v "$root/scripts/quote-invoice-proof/fake-googleapis.mjs:/tmp/fake-googleapis.mjs:ro" \
  -e FIELD_PROOF_MAIL_DIR=/tmp/smoke-mail \
  -e FIELD_CONFIG_JSON="$config" -e DATABASE_URL="$db" -e FIELD_STORAGE=postgres -e FIELD_PORT="$port" \
  "$image" node --import /tmp/hooks.mjs --input-type=module -e '
    import { writeFileSync } from "node:fs";
    writeFileSync("/tmp/smoke-key.json", JSON.stringify({ client_email: "proof@example.invalid", private_key: "not-a-key" }));
    await import("/app/server/index.js");
  ' >/dev/null

for _ in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1 && break
  if [[ "$(docker inspect -f '{{.State.Running}}' "$app")" != "true" ]]; then
    echo "Field exited before it answered /health" >&2
    exit 1
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${port}/health" >/dev/null

cd "$here"
FIELD_SMOKE_URL="http://127.0.0.1:${port}" FIELD_SMOKE_REVISION="$revision" npx playwright test
