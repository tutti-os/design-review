# Design Review — Tutti CLI Commands

This app exposes its design-critique capability through `tutti.cli.json`
(scope `design-review`). Commands are served by the app runtime over
`POST /tutti/cli/*` and return a `CliCommandOutput` envelope:
`{ "kind": "json", "value": ... }`.

The runtime uses `@tutti-os/agent-acp-kit` for local provider detection and agent
execution. It does not call `$TUTTI_CLI agent ...` internally.

Discover at runtime:

```sh
"$TUTTI_CLI" --help
"$TUTTI_CLI" design-review --help
"$TUTTI_CLI" design-review review --help
```

## `design-review review`

Run a six-dimension AI design review on a website URL **or** a local image file.
Provide either `--url` or `--image-path`.

Dimensions: visual hierarchy/layout, color & contrast, consistency, usability,
brand fit, conversion/CTA.

Inputs:

- `--url <string>` — website URL to review.
- `--image-path <string>` — absolute path to a local screenshot/design image
  under the workspace/runtime/data directory.
- `--strictness <string>` — `relaxed` | `standard` | `strict`; Chinese
  `宽松` | `标准` | `严苛` are also accepted.
- `--locale <string>` — output language, e.g. `zh-CN` or `en`.
- `--provider <string>` — optional local agent provider override, e.g. `claude`
  or `codex`.
- `--model <string>` — optional model override for the selected provider.

Output `value`:

```json
{
  "overall": 82,
  "summary": "Clear hierarchy, weak conversion",
  "dimensions": [
    { "name": "Visual hierarchy / layout", "score": 82, "verdict": "Clear", "detail": "Hero focus reads well" }
  ],
  "suggestions": [
    { "priority": "high", "title": "Strengthen the primary CTA", "desc": "Raise contrast and reduce competing actions" }
  ]
}
```

Examples:

```sh
"$TUTTI_CLI" --json design-review review --url "https://example.com" --locale en
"$TUTTI_CLI" --json design-review review --image-path "/abs/path/to/screen.png" --strictness strict
"$TUTTI_CLI" --json design-review review --url "https://example.com" --provider codex
```

Notes:

- The handler timeout is 290s; the app caps agent work below that.
- URL reviews ask the local agent to fetch the live page with its available tools.
  If the page is unreachable, the agent should report `overall: 0` instead of
  guessing.

## `design-review status`

Return app id, version, selected/default provider, and ACP Kit provider readiness.

Inputs: none.

Output `value`:

```json
{
  "appId": "design-review",
  "version": "0.1.0",
  "provider": "claude",
  "providerAvailable": true,
  "ok": true,
  "providers": [
    { "provider": "claude", "label": "Claude Code", "status": "ready", "models": ["default"] }
  ]
}
```

`ok` is true only when at least one local provider is ready.

Example:

```sh
"$TUTTI_CLI" --json design-review status
```
