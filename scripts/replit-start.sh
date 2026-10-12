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
# Sentry starts before Express so its routes are traced (no-op without SENTRY_DSN).
exec node --import ./server/observability/instrument.js server/index.js
