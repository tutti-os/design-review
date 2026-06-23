# Design Review Agent ACP Kit Migration Plan

## Background

Design Review is currently a self-contained Tutti app package. It serves the existing static Web UI from `static/index.html`, exposes `design-review review/status` through `tutti.cli.json`, and reaches an agent by shelling out to `$TUTTI_CLI --json agent ...` from `server.py`.

That package shape passes Tutti validation, but the agent execution path does not match the newer Tutti agent app guidance: local agent execution should use `@tutti-os/agent-acp-kit` instead of hand-rolled provider detection and `$TUTTI_CLI agent ...` polling.

The migration should therefore start with a smaller, safer target:

- Keep the Web UI unchanged in phase 1.
- Keep `static/index.html`, `static/i18n.js`, `static/tutti-agent.js`, and current browser behavior.
- Replace only the server-side agent execution layer with `@tutti-os/agent-acp-kit`.
- Keep `/api/complete` compatible so the current `window.claude.complete(...)` shim continues to work.
- Keep `design-review status` and `design-review review` CLI commands compatible.

Competitive Analysis remains the main reference for provider detection and `localAgentRuntime.run(...)`, but not for a full Web rewrite in the first pass.

## Recommendation

Use a two-stage migration:

1. **Phase A: Server-only ACP Kit migration.**  
   Replace Python/Tutti CLI agent orchestration with a Node server using `@tutti-os/agent-acp-kit`, while serving the existing static Web files unchanged.

2. **Phase B: Optional minimal Web provider selector.**  
   Add a small provider/model dropdown only if visible user choice is required. This can be done without rewriting the whole Web app to React.

This keeps the highest-risk behavior, agent execution, inside the server migration and avoids coupling it to a full UI rewrite.

## Phase A Goals

- Replace `$TUTTI_CLI agent start/get/messages/providers/composer-options` usage with `@tutti-os/agent-acp-kit`.
- Preserve current Web contract:
  - `POST /api/complete`
  - request body `{ "messages": [...] }`
  - response body `{ "text": "...", "agentSessionId": "...", "agentProvider": "..." }`
- Preserve current static UI files and user workflows:
  - URL review
  - screenshot review
  - scorecard JSON
  - marker JSON
  - cropped-region annotation follow-up
  - existing `zh-CN` / `en` i18n behavior
- Preserve current CLI contract:
  - `design-review status`
  - `design-review review`
  - invoke envelope support
  - `CliCommandOutput` response shape
- Preserve runtime storage rules:
  - package directory read-only
  - decoded images and run scratch under `$TUTTI_APP_RUNTIME_DIR`
  - durable data under `$TUTTI_APP_DATA_DIR` if needed later
  - logs under `$TUTTI_APP_LOG_DIR`

## Phase A Non-Goals

- Do not rewrite `static/index.html`.
- Do not introduce React/Vite just to satisfy the ACP Kit migration.
- Do not add a visible provider/model dropdown in the first pass.
- Do not add a Tutti references library unless review reports become persisted artifacts later.
- Do not add a run-scoped MCP tool gateway unless Design Review needs app-specific tools beyond local image/url inputs.
- Do not change `appId`, CLI scope, command paths, or manifest metadata.

## Target Phase A Shape

Phase A can keep the repository close to the current package layout while changing the runtime from Python to Node:

```text
design-review/
  server/
    src/
      app-meta.ts
      config.ts
      main.ts
      agent-service.ts
      local-agent-provider.ts
      completion-service.ts
      cli-service.ts
      image-store.ts
      review-prompt.ts
      schemas.ts
    package.json
    tsconfig.json
  static/
    index.html
    i18n.js
    support.js
    tutti-agent.js
    vendor/
  locales/
  scripts/
    package-tutti-app.mjs
    validate-package-smoke.mjs
  bootstrap.sh
  COMMANDS.md
  AGENTS.md
  icon.svg
  package.json
  pnpm-lock.yaml
  tutti.app.json
  tutti.cli.json
```

This does not require `apps/web` or `packages/shared` yet. If the server grows larger later, it can be split into `apps/server` and `packages/shared`, but that is not necessary for phase A.

## Server Contract

The Node server must continue to implement the current endpoints:

- `GET /healthz`: return a 2xx health response.
- `GET /`: serve `static/index.html` with the i18n bundle injected, matching current behavior.
- `GET /static/*`: serve package-local static assets.
- `GET /locales/<locale>/app.json`: serve locale dictionaries.
- `POST /api/complete`: accept the existing Claude-style message payload from `static/tutti-agent.js`.
- `POST /tutti/cli/status`: report ACP Kit provider readiness.
- `POST /tutti/cli/review`: run a review through the same server-side agent path.

The existing Web can remain unchanged because its only backend dependency is:

```text
window.claude.complete(...)
  -> static/tutti-agent.js
  -> POST /api/complete
  -> server
```

The server can change everything behind `/api/complete` without touching the UI.

## Agent Runtime Design

Use `@tutti-os/agent-acp-kit` directly, following Competitive Analysis's server-side pattern:

```ts
import {
  createDefaultLocalAgentProviderPlugins,
  createLocalAgentRuntime
} from "@tutti-os/agent-acp-kit";

const localAgentRuntime = createLocalAgentRuntime({
  providers: createDefaultLocalAgentProviderPlugins()
});
```

Provider detection:

- Cache detection results for a short TTL, as Competitive Analysis does.
- Return provider summaries with `provider`, `label`, `status`, `models`, and `reason`.
- Pick a default provider server-side:
  - prefer ready `claude`
  - otherwise first ready provider
  - otherwise report no ready provider
- In phase A, no Web selector is present, so `/api/complete` uses this server-chosen default.

Runtime execution:

1. Create a run directory under `$TUTTI_APP_RUNTIME_DIR/runs/<runId>`.
2. Decode any base64 images from the `/api/complete` payload into files under the run directory.
3. Convert the existing Web-supplied messages into a final prompt, preserving the current behavior where the Web owns prompt text.
4. Append local image file paths to the prompt, as `server.py` does today.
5. Call `localAgentRuntime.run(...)`.
6. Accumulate text deltas and final assistant text.
7. Preserve the current completion-type validation:
   - review JSON
   - marker JSON array
   - annotation plain text
8. Return the same `/api/complete` response shape used today.

Suggested runtime context:

```ts
export interface CompletionRunContext {
  runId: string;
  provider: string;
  model?: string;
  cwd: string;
  prompt: string;
  completionType: "review_json" | "marker_json" | "annotation_text";
  timeoutMs: number;
  signal?: AbortSignal;
}
```

No `skillManifest` is required in phase A because Design Review's instructions already come from the existing Web prompts and server helpers. Competitive Analysis needs a skill manifest because its product-swipefile workflow is a bundled skill; Design Review can stay prompt-driven first.

## CLI Design

Keep `tutti.cli.json` mostly unchanged in phase A.

`design-review status` should:

- use ACP Kit provider detection
- return `ok: true` only when a ready provider exists
- include:
  - `appId`
  - `version`
  - selected/default provider
  - provider availability
  - optional provider list for diagnostics

`design-review review` should:

- continue accepting `url`, `image-path`, `strictness`, and `locale`
- build the same server-side review prompt used today by `server.py`
- call the new local ACP Kit runtime directly
- return `{ "kind": "json", "value": <review> }`

Optional `provider` and `model` inputs can be added to the CLI command in phase A because that does not require Web changes. Existing callers can omit them.

## Packaging

Switch package startup from Python to Node.

`bootstrap.sh` should use managed Node:

```sh
#!/usr/bin/env bash
set -euo pipefail

NODE_BIN="${TUTTI_APP_NODE:-node}"
PACKAGE_DIR="${TUTTI_APP_PACKAGE_DIR:-$(cd "$(dirname "$0")" && pwd)}"

exec "$NODE_BIN" "$PACKAGE_DIR/server/server.js"
```

`scripts/package-tutti-app.mjs` should:

1. build the server bundle
2. copy `server/server.js`
3. copy `static/`
4. copy `locales/`
5. copy `tutti.app.json`, `tutti.cli.json`, `COMMANDS.md`, `AGENTS.md`, `icon.svg`, and `bootstrap.sh`
6. mark `bootstrap.sh` executable
7. run the Tutti factory validator against `build/tutti-app/package`
8. optionally zip `build/tutti-app/package`

The final phase A package should not ship `server.py` as the runtime server. It can remain in the repository temporarily until the Node path is stable.

## Phase A Implementation Steps

### Step 1: Node Server Scaffold

- Add root `package.json` with pnpm scripts.
- Add `server/package.json` with dependencies:
  - `@tutti-os/agent-acp-kit`
  - `fastify`
  - `@fastify/static`
  - `tsx` / `typescript` for development
- Add `server/src/main.ts`, `config.ts`, and `app-meta.ts`.
- Bind to `$TUTTI_APP_HOST:$TUTTI_APP_PORT`, defaulting host to `127.0.0.1`.

Verification:

- `pnpm install`
- `pnpm typecheck`
- local `pnpm dev` starts a server
- `GET /healthz` returns 2xx

### Step 2: Static Asset Parity

- Port static serving from `server.py`.
- Preserve index i18n injection.
- Preserve locale dictionary loading from `locales/*/app.json`.

Verification:

- `GET /` returns the existing UI
- `GET /static/tutti-agent.js` works
- `GET /locales/zh-CN/app.json` and `/locales/en/app.json` work

### Step 3: `/api/complete` Compatibility

- Reimplement current `complete_payload` behavior in TypeScript.
- Accept the same `messages` shape.
- Decode image content into `$TUTTI_APP_RUNTIME_DIR`.
- Preserve current prompt extraction and image path append behavior.
- Preserve output validation and normalization.

Verification:

- unit tests for message parsing
- unit tests for image decoding and size/type validation
- `/api/complete` mock test returns the same response shape

### Step 4: ACP Kit Provider Detection

- Implement `agent-service.ts` based on Competitive Analysis:
  - `createLocalAgentRuntime`
  - `detectAgentProviders`
  - TTL cache
  - `pickDefaultProvider`
- Do not call `$TUTTI_CLI agent providers`.

Verification:

- provider detection smoke test
- `POST /tutti/cli/status` returns provider readiness from ACP Kit

### Step 5: ACP Kit Completion Runtime

- Implement `local-agent-provider.ts`.
- Call `localAgentRuntime.run(...)` with:
  - `runId`
  - `provider`
  - `runtimeKind: "local-agent"`
  - `runtimeProvider`
  - `cwd`
  - `prompt`
  - optional `model`
  - timeout
  - abort signal
- Accumulate final assistant text from ACP events.
- Surface errors cleanly.

Verification:

- event normalization unit tests
- real provider detection before run
- one narrow real-agent smoke test if credentials are available

### Step 6: CLI Route Parity

- Reimplement `/tutti/cli/status`.
- Reimplement `/tutti/cli/review`.
- Keep invoke-envelope support.
- Keep direct raw input as local-test/backward-compatible path.
- Optionally add `provider` and `model` to `tutti.cli.json`.

Verification:

- route tests for CLI invoke envelopes
- `curl -X POST /tutti/cli/status`
- `curl -X POST /tutti/cli/review` with a small URL prompt or mocked provider

### Step 7: Package Builder

- Add `scripts/package-tutti-app.mjs`.
- Update `bootstrap.sh` to managed Node.
- Copy static files unchanged.
- Run the Tutti factory validator.

Verification:

- `pnpm package:tutti`
- factory validator passes
- packaged server starts from `build/tutti-app/package`
- packaged `/healthz` returns 2xx

### Step 8: Cleanup After Parity

- Keep Python files until the Node package is proven.
- After parity:
  - remove Python runtime from package output
  - update `AGENTS.md`
  - update `COMMANDS.md`
  - update CI/package workflow commands

Verification:

- `pnpm check`
- `pnpm package:tutti`
- app smoke through existing Web
- CLI status/review smoke

## Phase B: Optional Minimal Web Provider Selector

If visible provider/model choice is still required after phase A, do a small Web change rather than a full Web rewrite.

Keep `static/index.html` and add:

- a provider dropdown control near the review action
- a small `GET /api/providers` or reuse `GET /api/bootstrap`
- localStorage persistence for `{ provider, model }`
- extra request fields in `static/tutti-agent.js`, for example:

```json
{
  "messages": [],
  "provider": "claude",
  "model": "sonnet"
}
```

Server behavior:

- if `provider` is present, validate it is registered and ready
- if `model` is present, pass it to `localAgentRuntime.run(...)`
- otherwise use the server default

This gives the Competitive Analysis-style chooser without converting the UI to React.

## Open Decisions

- Should phase A add optional `provider` and `model` to `tutti.cli.json` immediately?
- Should `/api/complete` accept optional `provider` and `model` even before the Web exposes a dropdown?
- Should the server keep the current Web-owned prompts, or should CLI and Web prompt building be unified in server modules later?
- Should marker generation remain a separate call, or can full review always return markers once ACP Kit removes the old frontend token-limit workaround?
- Should completed reviews be persisted under `$TUTTI_APP_DATA_DIR` for future references support?

## Proposed First Slice

Build the smallest end-to-end proof:

1. Node server serves the existing static UI.
2. `/api/complete` accepts the current Web payload.
3. ACP Kit detects ready providers and picks a default.
4. `/api/complete` runs one prompt through `localAgentRuntime.run(...)`.
5. `/tutti/cli/status` reports ACP Kit provider readiness.
6. Package validator passes.

Once that works, port `/tutti/cli/review`, then decide whether Phase B's visible dropdown is needed.
