#!/usr/bin/env bash
# Installs a packed @arcforgelabs/field tarball the way an operator would, in
# an empty directory, then starts it and checks it answers.
#
#   scripts/release/package-smoke.sh <tarball>
#
# It seeds the synthetic verification catalogue into a PGlite database with
# the installed package's own code, starts `field-server` from the install,
# and requires /health to be ok and / to serve the client. Everything lives in
# a temporary directory that is removed on exit.
set -euo pipefail

tarball="$(cd "$(dirname "${1:?usage: package-smoke.sh <tarball>}")" && pwd)/$(basename "$1")"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
port="${FIELD_PACKAGE_SMOKE_PORT:-19298}"
server_pid=""
cleanup() {
  status=$?
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  if [[ $status -ne 0 && -f "$work/server.log" ]]; then
    echo "--- field-server log (last 60 lines)"
    tail -n 60 "$work/server.log"
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

cd "$work"
npm init -y >/dev/null
npm install --omit=dev --no-audit --no-fund "$tarball"
installed="$work/node_modules/@arcforgelabs/field"
test -f "$installed/client/dist/index.html"
test -f "$installed/server/db/dist/index.js"

export FIELD_PGLITE_DIR="$work/pglite"
FIELD_DATA="$work/data" node "$repo/scripts/quote-invoice-proof/seed.mjs" "$installed" "$work/data"

export FIELD_CONFIG_JSON='{"authToken":"package-smoke-token","bootstrapUsers":[{"email":"smoke.operator@example.invalid","password":"smoke-password-fixture","role":"admin","name":"Smoke Operator"}]}'
FIELD_DATA="$work/data" FIELD_PORT="$port" "$work/node_modules/.bin/field-server" > "$work/server.log" 2>&1 &
server_pid=$!

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1 && break
  kill -0 "$server_pid" 2>/dev/null || { echo "field-server exited before it answered /health" >&2; exit 1; }
  sleep 1
done
expected_release="v$(node -p 'require(process.argv[1]).version' "$installed/package.json")"
curl -fsS "http://127.0.0.1:${port}/health" | EXPECTED="$expected_release" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);if(!h.ok)process.exit(1);const r=h.build&&h.build.release;if(r!==process.env.EXPECTED){console.error("health build.release is "+r+", expected "+process.env.EXPECTED);process.exit(1)}console.log("health ok, release "+r)})'
curl -fsS "http://127.0.0.1:${port}/" | grep -q '<div id="root"' && echo "client served"
"$work/node_modules/.bin/field" --help >/dev/null && echo "field CLI runs"
