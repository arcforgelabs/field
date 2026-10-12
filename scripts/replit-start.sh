#!/usr/bin/env bash
# Start Field on Replit. Replit routes external port 80 to PORT (19200 in .replit).
set -euo pipefail
cd "$(dirname "$0")/.."
export FIELD_PORT="${PORT:-${FIELD_PORT:-19200}}"
# Marks the Replit runtime: Field refuses a local PGlite database here (a
# published app loses runtime files), so the database must be DATABASE_URL.
export FIELD_RUNTIME="${FIELD_RUNTIME:-replit}"
exec node server/index.js
