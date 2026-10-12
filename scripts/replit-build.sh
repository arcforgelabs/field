#!/usr/bin/env bash
# Build Field on Replit: server deps, the data layer, then the client bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --no-audit --no-fund
npm run build
