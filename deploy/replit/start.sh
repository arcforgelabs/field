#!/usr/bin/env bash
# Run step of a Replit deployment (.replit run and [deployment] run): start
# the Field release install-and-verify.sh installed.
#
# Configure it with Replit Secrets (docs/SELF_HOSTING.md, "Replit"):
# FIELD_CONFIG_JSON, DATABASE_URL and the others your installation uses.
set -euo pipefail
cd "$(dirname "$0")"

server="runtime/node_modules/.bin/field-server"
if [[ ! -x "$server" ]]; then
  echo "[field] no verified release installed; run install-and-verify.sh first" >&2
  exit 1
fi
export FIELD_PORT="${PORT:-${FIELD_PORT:-19200}}"
# Field refuses a local PGlite database on Replit: a published app loses its
# runtime files, so the database must be DATABASE_URL.
export FIELD_RUNTIME="${FIELD_RUNTIME:-replit}"
# Job files live in PostgreSQL; the data directory is rebuilt from it at boot.
export FIELD_STORAGE="${FIELD_STORAGE:-postgres}"
export FIELD_DATA="${FIELD_DATA:-$PWD/data}"
# The release's commit, for Sentry's release and GET /health.
FIELD_REVISION="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync("field.lock","utf8")).commit)')"
export FIELD_REVISION
exec "$server"
