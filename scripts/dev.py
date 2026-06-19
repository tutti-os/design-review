#!/usr/bin/env python3
"""Local development launcher — run the design-review UI in a plain browser.

Stage 1 (independent development): start the app with safe local defaults for
every TUTTI_APP_* variable, so you do NOT need Tutti to see and build the UI.
Scratch/data/logs go under .dev/ (gitignored). Binds 127.0.0.1 and prints the URL.

    python3 scripts/dev.py                # UI only, on http://127.0.0.1:8799
    python3 scripts/dev.py --port 5180
    python3 scripts/dev.py --mock-agent   # canned review so the flow works in-browser

The AI *review* shells out to the Tutti agent runtime via $TUTTI_CLI, which a
plain browser does not provide. Without --mock-agent the UI loads and is fully
interactive, but clicking "Review" errors until you either open the app inside
the Tutti dev base (which injects a real $TUTTI_CLI) or pass --mock-agent.

The port honors --port, then $PORT (set by the preview tool's autoPort), then 8799.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEV_DIR = REPO_ROOT / ".dev"
MOCK_CLI = REPO_ROOT / "scripts" / "dev_mock_tutti.py"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=None, help="port to bind (default $PORT or 8799)")
    parser.add_argument("--host", default="127.0.0.1", help="host to bind (default 127.0.0.1)")
    parser.add_argument(
        "--mock-agent",
        action="store_true",
        help="use the bundled mock $TUTTI_CLI so the review works without Tutti",
    )
    args = parser.parse_args()

    port = args.port or int(os.environ.get("PORT") or 8799)

    for sub in ("data", "logs", "runtime", "workspace"):
        (DEV_DIR / sub).mkdir(parents=True, exist_ok=True)

    # Fill every TUTTI_APP_* var the server needs, but never clobber a value Tutti
    # (or the caller) already provided.
    defaults = {
        "TUTTI_APP_PACKAGE_DIR": str(REPO_ROOT),
        "TUTTI_APP_ID": "design-review",
        "TUTTI_WORKSPACE_ID": "dev",
        "TUTTI_WORKSPACE_NAME": "dev",
        "TUTTI_APP_HOST": args.host,
        "TUTTI_APP_PORT": str(port),
        "TUTTI_APP_BASE_URL": f"http://{args.host}:{port}",
        "TUTTI_APP_DATA_DIR": str(DEV_DIR / "data"),
        "TUTTI_APP_LOG_DIR": str(DEV_DIR / "logs"),
        "TUTTI_APP_RUNTIME_DIR": str(DEV_DIR / "runtime"),
        "TUTTI_APP_PYTHON": sys.executable,
        "TUTTI_WORKSPACE_ROOT": str(DEV_DIR / "workspace"),
    }
    for key, value in defaults.items():
        os.environ.setdefault(key, value)
    # --port / --host are authoritative for local dev.
    os.environ["TUTTI_APP_HOST"] = args.host
    os.environ["TUTTI_APP_PORT"] = str(port)
    os.environ["TUTTI_APP_BASE_URL"] = f"http://{args.host}:{port}"

    if args.mock_agent:
        os.environ["TUTTI_CLI"] = str(MOCK_CLI)
        agent_note = f"mock agent  ({MOCK_CLI.name})"
    elif os.environ.get("TUTTI_CLI"):
        agent_note = f"$TUTTI_CLI = {os.environ['TUTTI_CLI']}"
    else:
        agent_note = "no agent — UI loads, but 'Review' needs Tutti or --mock-agent"

    url = f"http://{args.host}:{port}/"
    print("design-review dev server")
    print(f"  open:  {url}")
    print(f"  agent: {agent_note}")
    print("  stop:  Ctrl-C", flush=True)

    # Replace this process with the real server so signals/output pass straight through.
    os.execv(sys.executable, [sys.executable, str(REPO_ROOT / "server.py")])
    return 0  # unreachable


if __name__ == "__main__":
    sys.exit(main())
