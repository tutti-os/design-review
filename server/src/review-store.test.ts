import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuntimeConfig } from "./config.js";
import { BadRequestError } from "./errors.js";
import {
  createReview,
  exportReview,
  listReviews,
  normalizeExportFormat,
  reviewToMarkdown,
  summarizeReview,
  type StoredReview,
} from "./review-store.js";

function configWith(dataDir: string): RuntimeConfig {
  return { dataDir } as unknown as RuntimeConfig;
}

const sampleReview: StoredReview = {
  id: "abcd1234-aaaa-bbbb-cccc-dddddddddddd",
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T01:00:00.000Z",
  state: {
    mode: "url",
    url: "https://example.com",
    status: "done",
    locale: "en",
    result: {
      overall: 82,
      summary: "Solid layout, weak CTA contrast.",
      dimensions: [
        { name: "Visual hierarchy / layout", score: 88, verdict: "Clear", detail: "Good spacing | rhythm" },
        { name: "Conversion / CTA", score: 61, verdict: "Weak", detail: "Low contrast button" },
      ],
      suggestions: [{ priority: "high", title: "Boost CTA contrast", desc: "Use a darker accent." }],
    },
    annotations: [{ comment: "Hero copy is vague", reply: "Tighten the headline." }],
  },
};

test("summarizeReview derives source, status, and rounded overall", () => {
  const summary = summarizeReview(sampleReview);
  assert.equal(summary.id, sampleReview.id);
  assert.equal(summary.mode, "url");
  assert.equal(summary.source, "https://example.com");
  assert.equal(summary.status, "done");
  assert.equal(summary.overall, 82);
  assert.equal(summary.summary, "Solid layout, weak CTA contrast.");
});

test("summarizeReview tolerates missing result", () => {
  const summary = summarizeReview({
    id: "no-result-xxxxxxxx",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    state: { mode: "image", fileName: "home.png" },
  });
  assert.equal(summary.overall, null);
  assert.equal(summary.source, "home.png");
  assert.equal(summary.status, "input");
});

test("reviewToMarkdown renders headings, escaped table, and suggestions", () => {
  const md = reviewToMarkdown(sampleReview);
  assert.match(md, /# Design Review Report/);
  assert.match(md, /\*\*Overall:\*\* 82 \/ 100/);
  assert.match(md, /\| Dimension \| Score \| Verdict \| Detail \|/);
  // Pipe characters inside cells must be escaped so the table stays valid.
  assert.match(md, /Good spacing \\\| rhythm/);
  assert.match(md, /1\. `high` \*\*Boost CTA contrast\*\* — Use a darker accent\./);
  assert.match(md, /## My Annotations/);
  assert.ok(md.endsWith("\n"));
});

test("reviewToMarkdown uses localized headings for zh-CN", () => {
  const zh = reviewToMarkdown({ ...sampleReview, state: { ...sampleReview.state, locale: "zh-CN" } });
  assert.match(zh, /# 设计评审报告/);
  assert.match(zh, /## 维度评分/);
});

test("normalizeExportFormat accepts md/markdown/json and rejects others", () => {
  assert.equal(normalizeExportFormat(undefined), "md");
  assert.equal(normalizeExportFormat("markdown"), "md");
  assert.equal(normalizeExportFormat("JSON"), "json");
  assert.throws(() => normalizeExportFormat("pdf"), BadRequestError);
});

test("create, list, and export round-trip through the data dir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dr-store-"));
  try {
    const config = configWith(dir);
    assert.deepEqual(await listReviews(config), []);

    const created = await createReview(config, { state: sampleReview.state });
    const list = await listReviews(config);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
    assert.equal(list[0].overall, 82);

    const mdExport = await exportReview(config, created.id, "md");
    assert.ok(mdExport);
    assert.equal(mdExport!.contentType, "text/markdown; charset=utf-8");
    assert.match(mdExport!.filename, /^design-review-[a-z0-9]{8}\.md$/);
    assert.match(mdExport!.body, /# Design Review Report/);

    const jsonExport = await exportReview(config, created.id, "json");
    assert.ok(jsonExport);
    const parsed = JSON.parse(jsonExport!.body) as StoredReview;
    assert.equal(parsed.id, created.id);

    assert.equal(await exportReview(config, "missingidxxxx", "md"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
