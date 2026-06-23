#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="${TUTTI_APP_PACKAGE_DIR:-$SCRIPT_DIR}"
: "${TUTTI_APP_NODE:?TUTTI_APP_NODE is required by the Tutti runtime}"

export TUTTI_APP_PACKAGE_DIR="$PACKAGE_DIR"
export TUTTI_APP_HOST="${TUTTI_APP_HOST:-127.0.0.1}"
export TUTTI_APP_PORT="${TUTTI_APP_PORT:-8799}"
export TUTTI_APP_DATA_DIR="${TUTTI_APP_DATA_DIR:-$PACKAGE_DIR/generated/data}"
export TUTTI_APP_LOG_DIR="${TUTTI_APP_LOG_DIR:-$PACKAGE_DIR/generated/logs}"
export TUTTI_APP_RUNTIME_DIR="${TUTTI_APP_RUNTIME_DIR:-$PACKAGE_DIR/generated/runtime}"

mkdir -p "$TUTTI_APP_DATA_DIR" "$TUTTI_APP_LOG_DIR" "$TUTTI_APP_RUNTIME_DIR"

child_pid=""
cleanup() {
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
}

trap 'cleanup; exit 143' INT TERM

"$TUTTI_APP_NODE" "$PACKAGE_DIR/server/server.js" &
child_pid="$!"

set +e
wait "$child_pid"
status="$?"
set -e
trap - INT TERM
exit "$status"
