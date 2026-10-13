#!/usr/bin/env bash
# Build a local verification image using a commit-derived tag and inspect its
# immutable image ID and OCI labels. This never pushes or contacts a registry.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
short_sha="$(git -C "$SCRIPT_DIR" rev-parse --short=12 HEAD)"
full_sha="$(git -C "$SCRIPT_DIR" rev-parse HEAD)"
tag="field-verification:verify-${short_sha}"

docker build \
  --label "org.opencontainers.image.source=https://github.com/arcforgelabs/field" \
  --label "org.opencontainers.image.revision=${full_sha}" \
  --tag "$tag" \
  "$SCRIPT_DIR"

docker image inspect "$tag" \
  --format 'PASS field-verification-image: id={{.Id}} labels={{json .Config.Labels}}'
