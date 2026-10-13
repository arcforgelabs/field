#!/usr/bin/env bash
# The Replit deployment's build and run commands (.replit [deployment]).
#
#   scripts/replit-deploy.sh build   # fetch the deploy ref from GitHub into .field-deploy/ and build it there
#   scripts/replit-deploy.sh start   # start Field from .field-deploy/
#
# Replit publishes a snapshot of the workspace files. This makes the deployment
# run a commit from GitHub instead: by default the tip of main, or the ref that
# FIELD_DEPLOY_REF names (a branch, a tag or a full commit hash). The fetch is
# anonymous; the repository is public.
#
# It only ever writes .field-deploy/ (gitignored). It never resets, checks out
# or deletes the workspace's own files, so it is safe wherever it runs.
#
#   FIELD_DEPLOY_REF=<ref>          deploy this ref instead of main (pin or roll back)
#   FIELD_DEPLOY_REPO=<url>         fetch from here (default: the public repository; a fork sets its own)
#   FIELD_DEPLOY_FROM_WORKSPACE=1   emergency only: build the workspace files as they are, no fetch
#
# If the fetch fails, the build fails. It never falls back to the workspace copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.field-deploy"
DEFAULT_REPO="https://github.com/arcforgelabs/field.git"

log() { echo "[deploy] $*"; }
die() { echo "[deploy] FAILED: $*" >&2; exit 1; }

# A ref is a branch, tag or commit name. Refuse anything git could read as an
# option or a refspec.
valid_ref() { [[ "$1" =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ ]] && [[ "$1" != *..* ]]; }

# Runtime state never ships: Field rebuilds its data directory from
# PostgreSQL at boot (#87).
remove_runtime_state() {
  rm -rf "$OUT/data" "$OUT/.git"
}

# The workspace files as they are: tracked and new files, uncommitted edits
# included, minus everything .gitignore excludes (data/, node_modules/, config).
copy_workspace() {
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "FIELD_DEPLOY_FROM_WORKSPACE=1 needs the workspace to be a git repository"
  mkdir -p "$OUT"
  local path
  git -C "$ROOT" ls-files -z --cached --others --exclude-standard --deduplicate \
    | while IFS= read -r -d '' path; do
        case "$path" in .field-deploy|.field-deploy/*) continue ;; esac
        # Tracked files deleted in the workspace are not copied.
        [ -e "$ROOT/$path" ] || [ -L "$ROOT/$path" ] || continue
        printf '%s\0' "$path"
      done \
    | tar -C "$ROOT" --null -T - -cf - \
    | tar -C "$OUT" -xf -
}

cmd_build() {
  local source ref revision repo
  rm -rf "$OUT"

  if [ "${FIELD_DEPLOY_FROM_WORKSPACE:-}" = "1" ]; then
    source=workspace
    ref=workspace
    log "FIELD_DEPLOY_FROM_WORKSPACE=1: building the workspace files as they are, NOT GitHub"
    copy_workspace
    revision="$(git -C "$ROOT" log -1 --format=%H -- . 2>/dev/null || true)"
    if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
      log "the workspace has uncommitted changes; they are in this build, so ${revision:-its commit} is only its base"
    fi
  else
    source=github
    ref="${FIELD_DEPLOY_REF:-main}"
    repo="${FIELD_DEPLOY_REPO:-$DEFAULT_REPO}"
    valid_ref "$ref" || die "FIELD_DEPLOY_REF '$ref' is not a branch, tag or full commit hash"
    log "fetching $ref from $repo"
    mkdir -p "$OUT"
    git -C "$OUT" init -q
    if ! GIT_TERMINAL_PROMPT=0 git -C "$OUT" -c credential.helper= \
        fetch -q --depth 1 --no-tags "$repo" "$ref"; then
      rm -rf "$OUT"
      die "could not fetch '$ref' from $repo. Nothing was built and the workspace copy is not deployed instead. Check the ref and the network, or set FIELD_DEPLOY_FROM_WORKSPACE=1 for an emergency build of the workspace files"
    fi
    git -C "$OUT" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
    revision="$(git -C "$OUT" rev-parse HEAD)"
    log "fetched $ref at $revision"
    # .replit and this script come from the workspace, not from the fetched
    # commit. Say so when they differ, so the workspace can be pulled.
    local f
    for f in .replit scripts/replit-deploy.sh; do
      if ! cmp -s "$ROOT/$f" "$OUT/$f"; then
        log "note: $f in the workspace differs from $ref; the workspace copy ran this build. Pull the workspace (scripts/github-sync.sh pull) to use the new one"
      fi
    done
  fi

  [ -f "$OUT/scripts/replit-build.sh" ] || die "$ref has no scripts/replit-build.sh to build with"
  log "building $source $ref${revision:+ at $revision}"
  (cd "$OUT" && bash scripts/replit-build.sh) || die "the build of $ref failed"

  remove_runtime_state
  if [ -n "$revision" ]; then
    printf '%s\n' "$revision" > "$OUT/.field-revision"
  else
    rm -f "$OUT/.field-revision"
  fi
  printf '%s\n' "$ref" > "$OUT/.field-deploy-ref"
  printf '%s\n' "$source" > "$OUT/.field-deploy-source"
  log "built $source $ref at ${revision:-an unknown commit} into .field-deploy/"
}

cmd_start() {
  if [ ! -f "$OUT/.field-deploy-source" ] || [ ! -f "$OUT/scripts/replit-start.sh" ]; then
    die "no deployment build in .field-deploy/; the deployment build command is 'bash scripts/replit-deploy.sh build'"
  fi
  local built_ref source revision
  built_ref="$(cat "$OUT/.field-deploy-ref")"
  source="$(cat "$OUT/.field-deploy-source")"
  revision="$(cat "$OUT/.field-revision" 2>/dev/null || true)"
  if [ "$source" = github ] && [ "${FIELD_DEPLOY_REF:-main}" != "$built_ref" ]; then
    log "WARNING: FIELD_DEPLOY_REF is '${FIELD_DEPLOY_REF:-main}' now, but this build fetched '$built_ref'. Publish again to deploy it"
  fi
  if [ "$source" = github ] && [ "${FIELD_DEPLOY_FROM_WORKSPACE:-}" = "1" ]; then
    log "WARNING: FIELD_DEPLOY_FROM_WORKSPACE=1 is set now, but this build fetched '$built_ref' from GitHub. Publish again to deploy the workspace"
  fi
  log "starting $source $built_ref at ${revision:-an unknown commit}"
  export FIELD_DEPLOYED_REF="$built_ref"
  export FIELD_DEPLOYED_FROM="$source"
  # The commit this build is, whatever the environment says.
  if [ -n "$revision" ]; then export FIELD_REVISION="$revision"; else unset FIELD_REVISION; fi
  exec bash "$OUT/scripts/replit-start.sh"
}

case "${1:-}" in
  build) cmd_build ;;
  start) cmd_start ;;
  *) echo "usage: $0 build|start" >&2; exit 2 ;;
esac
