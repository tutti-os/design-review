#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_DIR="${TUTTI_APP_PACKAGE_DIR:-$SCRIPT_DIR}"
NODE_BIN="${TUTTI_APP_NODE:-node}"

export TUTTI_APP_PACKAGE_DIR="$PACKAGE_DIR"
export TUTTI_APP_HOST="${TUTTI_APP_HOST:-127.0.0.1}"
export TUTTI_APP_PORT="${TUTTI_APP_PORT:-8799}"
export TUTTI_APP_DATA_DIR="${TUTTI_APP_DATA_DIR:-$PACKAGE_DIR/generated/data}"
export TUTTI_APP_LOG_DIR="${TUTTI_APP_LOG_DIR:-$PACKAGE_DIR/generated/logs}"
export TUTTI_APP_RUNTIME_DIR="${TUTTI_APP_RUNTIME_DIR:-$PACKAGE_DIR/generated/runtime}"

mkdir -p "$TUTTI_APP_DATA_DIR" "$TUTTI_APP_LOG_DIR" "$TUTTI_APP_RUNTIME_DIR"
exec "$NODE_BIN" "$PACKAGE_DIR/server/server.js"
