#!/usr/bin/env bash
# Start Field on Replit. Replit routes external port 80 to PORT (19200 in .replit).
set -euo pipefail
cd "$(dirname "$0")/.."
export FIELD_PORT="${PORT:-${FIELD_PORT:-19200}}"
# Marks the Replit runtime: Field refuses a local PGlite database here (a
# published app loses runtime files), so the database must be DATABASE_URL.
export FIELD_RUNTIME="${FIELD_RUNTIME:-replit}"
# The build's git commit (scripts/replit-build.sh): Sentry's release, and the
# build revision in catalogue ETags.
if [ -z "${FIELD_REVISION:-}" ] && [ -s .field-revision ]; then
  export FIELD_REVISION="$(cat .field-revision)"
fi
# In the workspace only: bring the workspace's database to the migrations
# production runs, so Replit's "Development database changes detected" prompt
# does not appear (scripts/replit-workspace-db.js, docs/REPLIT.md "The
# workspace database"). It needs the FIELD_PRODUCTION_URL Secret. The
# published app (REPLIT_DEPLOYMENT, started by scripts/replit-deploy.sh)
# skips this and migrates itself. A failure only warns; Field still starts.
if [ -z "${REPLIT_DEPLOYMENT:-}" ] && [ -z "${FIELD_DEPLOYED_FROM:-}" ] && [ -n "${FIELD_PRODUCTION_URL:-}" ]; then
  node scripts/replit-workspace-db.js sync --warn-only \
    || echo "[workspace-db] WARNING: the workspace database could not follow production. Starting anyway" >&2
fi
# Sentry starts before Express so its routes are traced (no-op without SENTRY_DSN).
exec node --import ./server/observability/instrument.js server/index.js
