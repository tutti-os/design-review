# Design Review — Tutti workspace app

A self-contained Tutti workspace app. It reviews a website or screenshot across
six design dimensions, returns a scored report with a prioritized fix list, draws
the agent's issue boxes on the image, and lets the user annotate regions and ask
the agent for targeted advice. The review runs through the workspace's configured
Tutti agent provider.

The repo root is the **development tree**: it carries the app sources plus tests,
CI config, build scripts, and local scratch. The **publishable package** is the
subset under `build/tutti-app/package`, produced and validated by
`scripts/package_tutti_app.py` (see [Packaging & publishing](#packaging--publishing)).
The manifest sources (`tutti.app.json`, `tutti.cli.json`) live at the repo root.

## Package layout

- `tutti.app.json` — app manifest (`tutti.app.manifest.v1`). Declares the icon,
  runtime, `cli.manifest`, window sizing, and `localizationInfo`.
- `tutti.cli.json` — CLI manifest (`tutti.app.cli.v1`, scope `design-review`).
  Exposes the `review` and `status` capabilities to the Tutti ecosystem.
- `COMMANDS.md` — human/agent documentation for the CLI commands.
- `bootstrap.sh` — executable launch entrypoint (no args). Launches `server.py`.
- `server.py` — local HTTP runtime (Python stdlib only).
- `icon.svg` — package-local manifest icon.
- `AGENTS.md` / `COMMANDS.md` — package-local docs (shipped in the package).
- `static/` — browser assets:
  - `index.html` — the UI (an inline `x-dc` component rendered by `support.js`).
  - `support.js` — the `x-dc` mini-framework (loads React from `vendor/`).
  - `i18n.js` — in-app i18n harness (see below).
  - `tutti-agent.js` — shims `window.claude.complete()` onto `POST /api/complete`.
  - `vendor/` — local React / ReactDOM (no CDN at runtime).
- `locales/<locale>/manifest.json` — manifest metadata translations.
- `locales/<locale>/app.json` — in-app UI copy dictionaries (source of truth).

Dev-tree only (excluded from the published package by `scripts/package_tutti_app.py`):

- `server_test.py` — unit tests for the runtime.
- `scripts/` — `package_tutti_app.py` (package builder) and
  `validate_tutti_app_package.py` (vendored factory validator).
- `.github/workflows/` — CI and release workflows.
- `.claude/` (launch config, local settings) and `build/` (the build output) are
  local scratch and are not part of the published package.

## Runtime

Tutti starts `bootstrap.sh` with no arguments from `TUTTI_APP_RUNTIME_DIR`.
The server uses only these environment variables:

- `TUTTI_APP_HOST` / `TUTTI_APP_PORT` — bind address. `server.py` binds
  `TUTTI_APP_HOST:TUTTI_APP_PORT` (host defaults to `127.0.0.1`); it never binds
  all interfaces.
- `TUTTI_APP_PACKAGE_DIR` — package files, **read-only** at runtime.
- `TUTTI_APP_DATA_DIR` — durable app data.
- `TUTTI_APP_RUNTIME_DIR` — scratch (uploaded images for the agent are written here).
- `TUTTI_APP_LOG_DIR` — backend logs.
- `TUTTI_APP_PYTHON` — managed Python interpreter (used by `bootstrap.sh`).
- `TUTTI_CLI` — entrypoint for calling local Tutti capabilities (the agent runtime).
- `TUTTI_WORKSPACE_ROOT` — optional; passed to the agent as `--cwd` when present.

No durable data is written today; the package directory is never written to.
Storage stays inside the `TUTTI_APP_*` directories above — never the package dir.

Local run (outside Tutti):

```sh
RUN="$(mktemp -d)"
TUTTI_APP_PACKAGE_DIR="$PWD" TUTTI_APP_HOST=127.0.0.1 TUTTI_APP_PORT=8799 \
TUTTI_APP_BASE_URL=http://127.0.0.1:8799 \
TUTTI_APP_DATA_DIR="$RUN/data" TUTTI_APP_LOG_DIR="$RUN/logs" \
TUTTI_APP_RUNTIME_DIR="$RUN/runtime" TUTTI_APP_ID=design-review \
TUTTI_WORKSPACE_ID=dev TUTTI_WORKSPACE_NAME=dev \
TUTTI_CLI="$(command -v tutti || echo /usr/local/bin/tutti)" \
"$(command -v python3)" server.py
```

## Endpoints

- `GET /healthz` — `{"ok": true}`.
- `GET /` (and `/index.html`) — serves `index.html` with the i18n bundle injected.
- `GET /static asset` and `GET /locales/<locale>/app.json` — package assets.
- `POST /api/complete` — UI bridge. Body `{ "messages": [...] }` (Claude-style
  text/image content). Runs the agent and returns
  `{ "text": "<agent text>", "agentSessionId": "...", "agentProvider": "..." }`.
- `POST /tutti/cli/review` — CLI `review` handler. Returns a `CliCommandOutput`
  envelope `{ "kind": "json", "value": <design report> }`.
- `POST /tutti/cli/status` — CLI `status` handler. Returns provider/app readiness.

CLI request body — invoke envelope: Tutti posts an **invoke envelope**, not the
raw command input, to these handlers:

```json
{ "schemaVersion": "tutti.app.cli.invoke.v1", "commandId": "design-review.review",
  "scope": "design-review", "path": ["review"], "workspaceId": "...",
  "input": { "url": "https://example.com", "locale": "en" }, "outputMode": "json" }
```

`cli_command_input()` in `server.py` unwraps `body.input` for the handlers; it also
accepts a raw input object directly as a local-test / backward-compat path (never
rely on that for Tutti runtime calls). Handlers return the `CliCommandOutput` shape
(`{"kind":"json","value":...}`) **directly** — never wrapped in `{"ok":...}`. On
error they return a non-2xx status with `{ "error": "<message>" }`.

## Tutti ecosystem (CLI capabilities)

`tutti.app.json` declares `cli.manifest: tutti.cli.json`, so other Tutti apps and
agents can call this app through `$TUTTI_CLI`:

```sh
"$TUTTI_CLI" --json design-review status
"$TUTTI_CLI" --json design-review review --url https://example.com --locale en
"$TUTTI_CLI" --json design-review review --image-path /abs/screen.png --strictness strict
```

See `COMMANDS.md` for inputs/outputs. CLI handlers reuse the same agent path as
the UI (`start_agent_session` → `wait_for_agent_text`) with server-side,
locale-aware prompt building (`build_review_prompt`).

### Agent provider

`server.py` resolves the workspace's configured default provider via
`tutti agent providers` and prefers it (default `claude-code`). It never falls
back to `codex`. The agent is started without `--show`, so results flow back into
the app instead of opening a chat window.

## Internationalization

- Default locale `zh-CN`; additional locale `en`. Add more by extending both the
  manifest `localizationInfo` and the locale dictionaries.
- Manifest metadata translations: `locales/<locale>/manifest.json` (only
  `name` / `description` / `tags`). The default locale's metadata is the
  top-level `tutti.app.json` fields.
- In-app UI copy: `locales/<locale>/app.json` is the **single source of truth**.
  `server.py` reads every `locales/*/app.json` and injects them into `index.html`
  as `window.__TUTTI_I18N__` at serve time. `static/i18n.js` exposes
  `window.TuttiI18n` (`t(locale, key)`, `list(locale, key)`, locale detection,
  `checkParity()`).
- The UI reads the current locale from the optional Tutti host context
  (`window.tuttiExternal.app.getContext` / `subscribe`) and falls back to
  `document.documentElement.lang` / `navigator.language`. **Never** from URL query
  params. Agent prompts and the six dimension names are locale-aware too, so an
  English UI produces an English report.

To add or rename a copy key:

1. Add/rename the key in **every** `locales/<locale>/app.json` (keep the flattened
   key set identical across locales; ordered lists like `dims` / `analyzing.steps`
   must keep the same length).
2. Reference it in `index.html` as `{{ someKey }}` and provide it in
   `renderVals()` via `T('your.key')` (per-loop strings go on the loop item).
3. Run the validator (below); it static-checks locale key parity. At runtime
   `window.TuttiI18n.checkParity()` returns `{ ok, problems }`.

## Theming (light / dark)

`index.html` defines semantic CSS variables on `:root` with a
`@media (prefers-color-scheme: dark)` override. Surfaces, text, borders, soft
lines and the hard "brutalist" shadow are tokenized and flip with the OS theme;
the accent palette (primary + the six dimension colors) is intentionally fixed
across themes. Use the tokens (`--bg`, `--surface`, `--surface-2/3`, `--input-bg`,
`--ink`, `--text-2`, `--muted`, `--muted-2`, `--line`, `--shadow`, `--on-accent`)
for any new neutral surface or text; never read `theme` from URL params.

## Modification rules

- Keep the package self-contained; no startup-time installs (none are needed —
  React is vendored). If a build step is ever required, add an executable
  `prepare.sh` and keep `bootstrap.sh` launch-only.
- Keep runtime writes out of `TUTTI_APP_PACKAGE_DIR`.
- Preserve the `x-dc` interaction logic in `index.html`; route new user-facing
  text through i18n keys and new colors through theme tokens.
- Update this file and `COMMANDS.md` when endpoints, commands, storage, or i18n
  keys change.

## Packaging & publishing

The publishable package is assembled and validated by `scripts/package_tutti_app.py`:

```sh
python3 scripts/package_tutti_app.py          # -> build/tutti-app/package
```

It copies only the publishable files (manifests, docs, `bootstrap.sh`, `icon.svg`,
`server.py`, `static/`, `locales/`), refuses symlinks, preserves the `bootstrap.sh`
executable bit, confirms manifest-referenced files are present, and runs the
vendored `scripts/validate_tutti_app_package.py` on the output. This is the app's
`package:tutti` step — both CI and the release workflows invoke it.

GitHub Actions (`.github/workflows/`):

- `ci.yml` — PR/branch checks: byte-compile, unit tests, package + validate. Never
  publishes.
- `publish-tutti-app-staging.yml` — manual staging release via the reusable Tutti
  release workflow (`tutti-os/tutti/.github/workflows/publish-tutti-app-release.yml`).
- `publish-tutti-app.yml` — manual production release (semver bump + release tag +
  optional catalog refresh).

The publish workflows need GitHub OIDC (`id-token: write`) to assume the Tutti
release AWS role and the `TUTTI_APP_RELEASES_*` org/repo variables. They pass
`package_command: python3 scripts/package_tutti_app.py` and
`package_dir: build/tutti-app/package`. Run staging first, then production. The app
id (`design-review`) must stay consistent across `tutti.app.json`, `app_id`, and
`release_tag_prefix` (`design-review-v`).

## Validation

```sh
python3 -m py_compile server.py server_test.py scripts/package_tutti_app.py
python3 server_test.py
python3 scripts/package_tutti_app.py          # builds + validates the package
# validate an explicit package dir directly:
python3 scripts/validate_tutti_app_package.py build/tutti-app/package
```

The validator statically checks the manifest/CLI contract, icon + localization
files, `bootstrap.sh` (executable, launch-only, managed runtime vars), locale-key
parity across `locales/*/app.json`, and that no UI source reads locale/theme from
URL query params.
