#!/bin/sh
set -eu

# Hard-require only the runtime-env contract variables Tutti guarantees. appId is
# read from tutti.app.json in server.py; workspace identity is optional and not
# part of the launch contract, so requiring it here would break startup.
: "${TUTTI_APP_PACKAGE_DIR:?}"
: "${TUTTI_APP_HOST:?}"
: "${TUTTI_APP_PORT:?}"
: "${TUTTI_APP_RUNTIME_DIR:?}"
: "${TUTTI_APP_DATA_DIR:?}"
: "${TUTTI_APP_LOG_DIR:?}"
: "${TUTTI_APP_PYTHON:?}"

mkdir -p "$TUTTI_APP_DATA_DIR" "$TUTTI_APP_LOG_DIR" "$TUTTI_APP_RUNTIME_DIR"
exec "$TUTTI_APP_PYTHON" "$TUTTI_APP_PACKAGE_DIR/server.py"
