#!/usr/bin/env bash
# Build step of a Replit deployment (.replit [deployment] build): install the
# Field release field.lock pins, and refuse it unless it verifies.
#
# 1. npm installs @arcforgelabs/field at exactly field.lock's version into
#    runtime/. The package's shrinkwrap pins every dependency.
# 2. `npm audit signatures` checks the registry signatures and the provenance
#    attestation cryptographically.
# 3. verify-release.mjs checks the installed integrity against field.lock,
#    and that the provenance names field.lock's commit, the Field repository
#    and its release workflow.
#
# Any failure fails the build, so Replit keeps running the previous
# deployment. Nothing here needs a secret.
set -euo pipefail
cd "$(dirname "$0")"

version="$(node verify-release.mjs version)"
echo "[field] installing @arcforgelabs/field@${version}"
rm -rf runtime
mkdir runtime
# Replit's package firewall needs the lockfile's own URLs (.npmrc explains).
cp .npmrc runtime/.npmrc
cat > runtime/package.json <<JSON
{ "private": true, "dependencies": { "@arcforgelabs/field": "${version}" } }
JSON
(cd runtime && npm install --omit=dev --no-audit --no-fund --save-exact)
(cd runtime && npm audit signatures)
node verify-release.mjs verify runtime
