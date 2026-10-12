#!/usr/bin/env bash
# Build Field on Replit: server deps, the data layer, then the client bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --no-audit --no-fund
npm run build
# The commit this build is, for Sentry's release (scripts/replit-start.sh).
# Path-limited, so Replit's empty "Published your App" commits are skipped.
git log -1 --format=%H -- . > .field-revision 2>/dev/null || rm -f .field-revision
