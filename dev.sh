#!/usr/bin/env bash
# Start the local Field development environment from this repo. Like
# `npm run dev`, it keeps a local PGlite database under data/pglite unless
# FIELD_PGLITE, FIELD_PGLITE_DIR or DATABASE_URL say otherwise.
#
# Usage:
#   ./dev.sh               # start Field locally
#   ./dev.sh stop          # stop the Field process started by this script
#   ./dev.sh status        # show current Field status
#   ./dev.sh build-client  # rebuild the React bundle served by Field
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIELD_CONFIG="$REPO_DIR/config.local.json"
FIELD_LOG="/tmp/field-dev.log"
RUN_DIR="$REPO_DIR/.run"
FIELD_PID_FILE="$RUN_DIR/field-dev.pid"
FIELD_URL="http://localhost:19200"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

require_prereqs() {
  have_command curl || die "curl is required"
  have_command node || die "node is required"
  have_command python3 || die "python3 is required"
}

ensure_run_dir() {
  mkdir -p "$RUN_DIR"
}

read_pid() {
  if [[ -f "$FIELD_PID_FILE" ]]; then
    tr -d ' \n' < "$FIELD_PID_FILE"
  fi
}

pid_running() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

clear_stale_pid() {
  local pid
  pid="$(read_pid)"
  if [[ -n "$pid" ]] && ! pid_running "$pid"; then
    rm -f "$FIELD_PID_FILE"
  fi
}

field_port_in_use() {
  if have_command ss; then
    ss -ltnH | awk '{print $4}' | grep -Eq '(^|:)19200$'
    return
  fi
  if have_command lsof; then
    lsof -nP -iTCP:19200 -sTCP:LISTEN >/dev/null 2>&1
    return
  fi
  return 1
}

ensure_local_config() {
  [[ -f "$FIELD_CONFIG" ]] || die "Missing $FIELD_CONFIG. Copy config.local.example.json to config.local.json and fill the required values."
}

read_auth_token() {
  python3 - <<PY
import json
from pathlib import Path
path = Path(r"$FIELD_CONFIG")
data = json.loads(path.read_text())
token = data.get("authToken", "").strip()
if not token:
    raise SystemExit("config.local.json is missing authToken")
print(token)
PY
}

build_client() {
  echo "==> Building client bundle..."
  npm --prefix "$REPO_DIR/client" install --no-audit --no-fund >/dev/null
  npm --prefix "$REPO_DIR/client" run build
}

ensure_data_layer() {
  if [[ -d "$REPO_DIR/server/db/dist" ]]; then
    return
  fi
  echo "==> Building data layer..."
  npm --prefix "$REPO_DIR" run db:build
}

ensure_client_bundle() {
  if [[ -f "$REPO_DIR/client/dist/index.html" ]]; then
    return
  fi
  build_client
}

wait_for_field() {
  local attempt=1
  while (( attempt <= 20 )); do
    local status
    status="$(curl -s -o /dev/null -w '%{http_code}' "$FIELD_URL/" || true)"
    if [[ "$status" == "200" ]]; then
      echo "  Field ready at ${FIELD_URL}"
      echo "  Log: ${FIELD_LOG}"
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
}

status() {
  require_prereqs
  clear_stale_pid

  echo "=== Field App ==="
  local pid
  pid="$(read_pid)"
  if pid_running "$pid"; then
    echo "running (PID ${pid}) at ${FIELD_URL}"
  elif field_port_in_use; then
    echo "port 19200 is in use by another process"
  else
    echo "not running"
  fi
}

stop() {
  require_prereqs
  clear_stale_pid

  echo "==> Stopping Field app..."
  local pid
  pid="$(read_pid)"
  if pid_running "$pid"; then
    kill "$pid"
    rm -f "$FIELD_PID_FILE"
    echo "  stopped (PID ${pid})"
  else
    echo "  not running"
  fi
}

start() {
  require_prereqs
  ensure_run_dir
  clear_stale_pid
  ensure_local_config
  ensure_data_layer
  ensure_client_bundle

  local existing_pid
  existing_pid="$(read_pid)"
  if pid_running "$existing_pid"; then
    echo "Field already running (PID ${existing_pid}) at ${FIELD_URL}"
    return 0
  fi

  if field_port_in_use; then
    die "Port 19200 is already in use. Refusing to kill an unknown process."
  fi

  echo "==> Starting Field app..."
  (
    cd "$REPO_DIR"
    nohup setsid env FIELD_CONFIG="$FIELD_CONFIG" FIELD_PGLITE="${FIELD_PGLITE:-1}" node server/index.js >> "$FIELD_LOG" 2>&1 < /dev/null &
    echo $! > "$FIELD_PID_FILE"
  )

  if ! wait_for_field; then
    local pid
    pid="$(read_pid)"
    if pid_running "$pid"; then
      kill "$pid" || true
    fi
    rm -f "$FIELD_PID_FILE"
    echo "  FAILED. Last log lines:"
    tail -20 "$FIELD_LOG" 2>/dev/null || true
    exit 1
  fi

  echo ""
  echo "==> Local Field ready"
  echo "  Field app: ${FIELD_URL}"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  build-client) build_client ;;
  *)
    echo "Usage: $0 [start|stop|status|build-client]"
    exit 1
    ;;
esac
