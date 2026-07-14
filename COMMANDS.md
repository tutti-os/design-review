# Design Review — Tutti CLI Commands

This app exposes its design-critique capability through `tutti.cli.json`
(scope `design-review`). Commands are served by the app runtime over
`POST /tutti/cli/*` and return a `CliCommandOutput` envelope:
`{ "kind": "json", "value": ... }`.

The runtime uses `@tutti-os/agent-acp-kit` for dynamic Agent Target discovery and agent
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
- `--agent-id <string>` — optional exact Agent Target ID. Discover current values
  with `tutti agent list --json`.
- `--provider <string>` — deprecated compatibility input, accepted only when one
  current Agent Target uniquely uses that provider.
- `--model <string>` — optional model override for the selected Agent.

Output `value`:

```json
{
  "overall": 82,
  "summary": "Clear hierarchy, weak conversion",
  "dimensions": [
    {
      "name": "Visual hierarchy / layout",
      "score": 82,
      "verdict": "Clear",
      "detail": "Hero focus reads well"
    }
  ],
  "suggestions": [
    {
      "priority": "high",
      "title": "Strengthen the primary CTA",
      "desc": "Raise contrast and reduce competing actions"
    }
  ]
}
```

Examples:

```sh
"$TUTTI_CLI" --json design-review review --url "https://example.com" --locale en
"$TUTTI_CLI" --json design-review review --image-path "/abs/path/to/screen.png" --strictness strict
"$TUTTI_CLI" --json design-review review --url "https://example.com" --agent-id "<agent-target-id>"
```

Notes:

- The handler timeout is 290s; the app caps agent work below that.
- URL reviews ask the local agent to fetch the live page with its available tools.
  If the page is unreachable, the agent should report `overall: 0` instead of
  guessing.

## `design-review history`

List previously saved design reviews (most recent first) so callers can browse
review history. Reviews are saved by the web UI under `TUTTI_APP_DATA_DIR/reviews`;
each entry is summarized here. Use an `id` with `design-review export` to retrieve
the full report.

Inputs:

- `--limit <number>` — optional maximum number of reviews to return (most recent first).

Output `value`:

```json
{
  "count": 1,
  "total": 1,
  "reviews": [
    {
      "id": "0464db2a-0058-4608-a9ca-52086b47759a",
      "createdAt": "2026-06-27T14:34:41.829Z",
      "updatedAt": "2026-06-27T14:34:41.829Z",
      "mode": "url",
      "source": "https://example.com",
      "status": "done",
      "overall": 82,
      "summary": "Clear hierarchy, weak conversion"
    }
  ]
}
```

Example:

```sh
"$TUTTI_CLI" --json design-review history --limit 20
```

## `design-review export`

Export a saved design review as Markdown or JSON. Provide the review `id` (from
`design-review history`) and an optional `format`.

Inputs:

- `--id <string>` — id of the saved review to export (required).
- `--format <string>` — `md` | `json` (default `md`).

Output `value`:

```json
{
  "id": "0464db2a-0058-4608-a9ca-52086b47759a",
  "format": "md",
  "filename": "design-review-0464db2a.md",
  "content": "# Design Review Report\n..."
}
```

Example:

```sh
"$TUTTI_CLI" --json design-review export --id 0464db2a-0058-4608-a9ca-52086b47759a --format md
```

The web UI exposes the same two capabilities: a **History** panel in the header
lists saved reviews, and **Export Markdown / Export JSON** buttons on a finished
report download the report via `GET /api/reviews/:id/export?format=md|json`.

## `design-review status`

Return app id, version, default Agent Target, and ACP Kit Agent readiness.

Inputs: none.

Output `value`:

```json
{
  "appId": "design-review",
  "version": "0.1.0",
  "agentTargetId": "local:example",
  "agentAvailable": true,
  "ok": true,
  "agents": [
    {
      "agentTargetId": "local:example",
      "providerId": "example",
      "label": "Example Agent",
      "status": "ready",
      "models": ["default"]
    }
  ]
}
```

`ok` is true only when at least one current Agent Target is ready.

Example:

```sh
"$TUTTI_CLI" --json design-review status
```
