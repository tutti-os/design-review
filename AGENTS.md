# Design Review — Tutti Workspace App

Design Review is a self-contained Tutti workspace app. It reviews a website or
screenshot across six design dimensions, returns a scored report with a
prioritized fix list, draws agent issue boxes on the image, and lets the user
annotate regions for targeted advice.

The current runtime is a Node local HTTP server using
`@tutti-os/agent-acp-kit` for local agent execution. The Web UI is still the
package-local static UI under `static/`; it talks to the server through the
existing `POST /api/complete` bridge.

## Package Layout

- `tutti.app.json` — app manifest (`tutti.app.manifest.v1`).
- `tutti.cli.json` — CLI manifest (`tutti.app.cli.v1`, scope `design-review`).
- `COMMANDS.md` — human/agent documentation for CLI commands.
- `bootstrap.sh` — executable launch entrypoint. Starts the bundled Node server.
- `server/src/` — Node runtime, HTTP handlers, ACP Kit provider detection, local
  agent execution, CLI handlers, image/runtime storage helpers, and review prompts.
- `static/` — browser assets:
  - `index.html` — existing `x-dc` UI.
  - `support.js` — the `x-dc` mini-framework.
  - `i18n.js` — in-app i18n harness.
  - `tutti-agent.js` — shims `window.claude.complete()` onto `POST /api/complete`.
  - `vendor/` — local React / ReactDOM.
- `locales/<locale>/manifest.json` — manifest metadata translations.
- `locales/<locale>/app.json` — in-app UI copy dictionaries.
- `scripts/build-server.mjs` — bundles the Node server.
- `scripts/package-tutti-app.mjs` — builds and validates `build/tutti-app/package`.

Legacy Python files (`server.py`, `server_test.py`, `scripts/package_tutti_app.py`)
may remain in the development tree temporarily for comparison, but the publishable
package is built from the Node runtime.

## Runtime

Tutti starts `bootstrap.sh` with no arguments from `TUTTI_APP_RUNTIME_DIR`.

Environment variables:

- `TUTTI_APP_HOST` / `TUTTI_APP_PORT` — bind address. The server binds only to the
  provided host, defaulting to `127.0.0.1`.
- `TUTTI_APP_PACKAGE_DIR` — package files, read-only at runtime.
- `TUTTI_APP_DATA_DIR` — durable app data.
- `TUTTI_APP_RUNTIME_DIR` — scratch/runtime files; uploaded images and run dirs go here.
- `TUTTI_APP_LOG_DIR` — backend logs.
- `TUTTI_APP_NODE` — managed Node executable used by `bootstrap.sh`.
- `TUTTI_WORKSPACE_ROOT` — optional workspace path used as the agent cwd when present.

No startup-time install is allowed. `bootstrap.sh` only launches the prepared
server bundle.

Local run:

```sh
RUN="$(mktemp -d)"
WORKSPACE_ROOT="$(cd .. && pwd)"
pnpm build
TUTTI_APP_PACKAGE_DIR="$PWD" TUTTI_APP_HOST=127.0.0.1 TUTTI_APP_PORT=8799 \
TUTTI_APP_DATA_DIR="$RUN/data" TUTTI_APP_LOG_DIR="$RUN/logs" \
TUTTI_APP_RUNTIME_DIR="$RUN/runtime" TUTTI_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
TUTTI_APP_NODE="$(command -v node)" ./bootstrap.sh
```

Development run:

```sh
RUN="$(mktemp -d)"
WORKSPACE_ROOT="$(cd .. && pwd)"
TUTTI_APP_PACKAGE_DIR="$PWD" TUTTI_APP_HOST=127.0.0.1 TUTTI_APP_PORT=8799 \
TUTTI_APP_DATA_DIR="$RUN/data" TUTTI_APP_LOG_DIR="$RUN/logs" \
TUTTI_APP_RUNTIME_DIR="$RUN/runtime" TUTTI_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
pnpm dev
```

## Endpoints

- `GET /healthz` — `{"ok": true}`.
- `GET /` — serves `static/index.html` with `window.__TUTTI_I18N__` injected.
- `GET /static asset` and `GET /locales/<locale>/app.json` — package assets.
- `POST /api/complete` — Web bridge. Body `{ "messages": [...] }` with optional
  `provider` / `model`. Returns `{ "text": "...", "agentSessionId": "...",
  "agentProvider": "..." }`.
- `POST /api/reviews` / `GET /api/reviews/:id` / `PATCH /api/reviews/:id` —
  create/read/update a persisted review (`TUTTI_APP_DATA_DIR/reviews/<id>.json`).
- `GET /api/reviews` — list saved review summaries (most recent first) for the
  in-app History panel. Returns `{ "reviews": [ <summary> ] }`.
- `GET /api/reviews/:id/export?format=md|json` — download a saved review as
  Markdown (default) or JSON, with a `Content-Disposition: attachment` filename.
- `POST /tutti/cli/review` — CLI `review` handler. Returns
  `{ "kind": "json", "value": <design report> }`.
- `POST /tutti/cli/history` — CLI `history` handler. Returns
  `{ "kind": "json", "value": { count, total, reviews } }`.
- `POST /tutti/cli/export` — CLI `export` handler. Body `{ id, format }`. Returns
  `{ "kind": "json", "value": { id, format, filename, content } }`.
- `POST /tutti/cli/status` — CLI `status` handler. Reports ACP Kit provider
  readiness; `ok` is true only when a ready local provider exists.

CLI handlers accept the Tutti invoke envelope and also direct raw input as a
local-test/backward-compatible path.

## Agent Provider

The runtime uses `@tutti-os/agent-acp-kit`:

- provider detection is cached briefly;
- the Tutti/SDK catalog default is used when it is ready;
- otherwise the first ready catalog provider is used;
- `/api/complete` and `design-review review` can accept optional `provider` and
  `model` overrides;
- no `$TUTTI_CLI agent ...` polling is used for local agent execution.

## Tutti Ecosystem

Other Tutti apps and agents can call:

```sh
"$TUTTI_CLI" --json design-review status
"$TUTTI_CLI" --json design-review review --url https://example.com --locale en
"$TUTTI_CLI" --json design-review review --image-path /abs/screen.png --strictness strict
"$TUTTI_CLI" --json design-review review --url https://example.com --provider codex
"$TUTTI_CLI" --json design-review history --limit 20
"$TUTTI_CLI" --json design-review export --id <review-id> --format md
```

## Internationalization

- Default locale `zh-CN`; additional locale `en`.
- Manifest metadata translations live in `locales/<locale>/manifest.json`.
- In-app copy lives in `locales/<locale>/app.json`.
- `server/src/main.ts` injects every app dictionary into `index.html`.
- The UI reads locale from optional Tutti host context and browser locale APIs,
  not URL query params.

When adding or renaming UI copy keys, update every `locales/<locale>/app.json`
file and keep flattened key sets aligned.

## Modification Rules

- Keep the static Web UI unchanged unless the task explicitly asks for UI changes.
- Preserve the `window.claude.complete()` bridge and `/api/complete` response shape.
- Keep runtime writes out of `TUTTI_APP_PACKAGE_DIR`.
- Use `@tutti-os/agent-acp-kit` for local agent execution.
- Update this file and `COMMANDS.md` when endpoints, CLI commands, storage, or
  provider behavior changes.

## Packaging

```sh
pnpm package:tutti
```

This runs `pnpm build`, copies the bundled Node server plus static assets,
manifests, docs, icon, and locale files into `build/tutti-app/package`, marks
`bootstrap.sh` executable, and runs the Tutti factory validator.

## Validation

```sh
pnpm check
pnpm package:tutti
python3 ./scripts/validate_tutti_app_package.py build/tutti-app/package
```
