# Design Review — Tutti CLI commands

This app exposes its design-critique capability to the Tutti ecosystem through
`tutti.cli.json` (scope `design-review`). Other Tutti apps and agents discover
and call these commands through the bundled Tutti CLI (`$TUTTI_CLI`). Every
command is served by the app runtime over HTTP `POST /tutti/cli/*` and returns a
`CliCommandOutput` JSON envelope (`{ "kind": "json", "value": ... }`).

Use `$TUTTI_CLI` for all calls — it builds the request invoke envelope
(`tutti.app.cli.invoke.v1`, with arguments under `input`) and routes to the app
runtime for you. (Integrators calling the HTTP handler directly should post that
same envelope; the handlers read `body.input`.)

Discover at runtime:

```sh
"$TUTTI_CLI" --help
"$TUTTI_CLI" design-review --help
"$TUTTI_CLI" design-review review --help
```

## `design-review review`

Run a six-dimension AI design review on a website URL **or** a local image file
and return a structured report. Provide either `--url` or `--image-path`.

Dimensions (fixed order): visual hierarchy/layout, color & contrast,
consistency, usability, brand fit, conversion/CTA.

Inputs:

- `--url <string>` — website URL to review.
- `--image-path <string>` — absolute path to a local screenshot/design image.
- `--strictness <string>` — `relaxed` | `standard` | `strict` (default
  `standard`). Chinese `宽松` | `标准` | `严苛` are also accepted.
- `--locale <string>` — output language, e.g. `zh-CN` or `en` (default
  `zh-CN`).

Output `value` (the design report):

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

Example (machine-readable; agent-to-app call):

```sh
"$TUTTI_CLI" --json design-review review --url "https://example.com" --locale en
"$TUTTI_CLI" --json design-review review --image-path "/abs/path/to/screen.png" --strictness strict
```

Notes:

- The review runs through the workspace's configured agent provider, so it can
  take up to ~5 minutes. The handler timeout is 290s.
- For URL reviews the agent reasons from its knowledge of the site/category;
  for the richest visual critique, pass a screenshot via `--image-path`.

## `design-review status`

Return app id, version, the configured default agent provider and its
availability. Use it to check readiness before calling `review`.

Inputs: none.

Output `value`:

```json
{
  "appId": "design-review",
  "version": "0.1.0",
  "provider": "claude-code",
  "providerAvailable": true,
  "ok": true
}
```

Example:

```sh
"$TUTTI_CLI" --json design-review status
```
