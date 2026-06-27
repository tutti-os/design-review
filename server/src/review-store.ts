import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RuntimeConfig } from "./config.js";
import { BadRequestError } from "./errors.js";

export type StoredReview = {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: Record<string, unknown>;
};

export type ReviewSummary = {
  id: string;
  createdAt: string;
  updatedAt: string;
  mode: string;
  source: string;
  status: string;
  overall: number | null;
  summary: string;
};

export type ReviewExport = {
  filename: string;
  contentType: string;
  body: string;
};

export type ExportFormat = "md" | "json";

const REVIEW_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

export async function createReview(config: RuntimeConfig, body: unknown): Promise<StoredReview> {
  const now = new Date().toISOString();
  const review: StoredReview = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    state: reviewStateFromBody(body),
  };
  await writeReview(config, review);
  return review;
}

export async function readReview(config: RuntimeConfig, rawId: unknown): Promise<StoredReview | null> {
  const id = normalizeReviewId(rawId);
  try {
    return normalizeStoredReview(JSON.parse(await readFile(reviewFilePath(config, id), "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Validate and normalize an untrusted, persisted review object into the
 * `StoredReview` shape. Returns null when the record is unusable (missing/invalid
 * id or non-object payload). Used before summarizing, listing, or exporting so a
 * corrupt file can never produce a bad filename or crash a read.
 */
function normalizeStoredReview(raw: unknown): StoredReview | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !REVIEW_ID_PATTERN.test(record.id)) return null;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : createdAt;
  const state =
    record.state && typeof record.state === "object" && !Array.isArray(record.state)
      ? (record.state as Record<string, unknown>)
      : {};
  return { id: record.id, createdAt, updatedAt: updatedAt || createdAt, state };
}

export async function updateReview(config: RuntimeConfig, rawId: unknown, body: unknown): Promise<StoredReview | null> {
  const current = await readReview(config, rawId);
  if (!current) return null;
  const review: StoredReview = {
    ...current,
    updatedAt: new Date().toISOString(),
    state: {
      ...current.state,
      ...reviewStateFromBody(body),
    },
  };
  await writeReview(config, review);
  return review;
}

function reviewStateFromBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("state" in body)) {
    throw new BadRequestError("Missing review state.");
  }
  const state = body.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new BadRequestError("Review state must be an object.");
  }
  return state as Record<string, unknown>;
}

function normalizeReviewId(rawId: unknown): string {
  if (typeof rawId !== "string" || !REVIEW_ID_PATTERN.test(rawId)) {
    throw new BadRequestError("Invalid review id.");
  }
  return rawId;
}

async function writeReview(config: RuntimeConfig, review: StoredReview): Promise<void> {
  const dir = path.join(config.dataDir, "reviews");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${review.id}.json`), JSON.stringify(review), "utf8");
}

function reviewFilePath(config: RuntimeConfig, id: string): string {
  return path.join(config.dataDir, "reviews", `${id}.json`);
}

export async function listReviews(config: RuntimeConfig): Promise<ReviewSummary[]> {
  const dir = path.join(config.dataDir, "reviews");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const summaries: ReviewSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const review = normalizeStoredReview(JSON.parse(await readFile(path.join(dir, entry), "utf8")));
      if (review) summaries.push(summarizeReview(review));
    } catch {
      // Skip unreadable/corrupt review files rather than failing the whole listing.
      continue;
    }
  }
  summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return summaries;
}

export function summarizeReview(review: StoredReview): ReviewSummary {
  const state = (review.state ?? {}) as Record<string, unknown>;
  const result = (state.result ?? null) as Record<string, unknown> | null;
  const mode = typeof state.mode === "string" ? state.mode : "url";
  const status = typeof state.status === "string" ? state.status : result ? "done" : "input";
  const overallRaw = result ? Number(result.overall) : NaN;
  return {
    id: review.id,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    mode,
    source: reviewSource(state, mode),
    status,
    overall: Number.isFinite(overallRaw) ? Math.round(overallRaw) : null,
    summary: result && typeof result.summary === "string" ? result.summary : "",
  };
}

function reviewSource(state: Record<string, unknown>, mode: string): string {
  if (mode === "json") return "External agent";
  if (mode === "image") return typeof state.fileName === "string" && state.fileName ? state.fileName : "Screenshot";
  return typeof state.url === "string" && state.url ? state.url : "Link review";
}

export async function exportReview(
  config: RuntimeConfig,
  rawId: unknown,
  format: ExportFormat,
): Promise<ReviewExport | null> {
  const review = await readReview(config, rawId);
  if (!review) return null;
  const shortId = review.id.slice(0, 8);
  if (format === "json") {
    return {
      filename: `design-review-${shortId}.json`,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(review, null, 2),
    };
  }
  return {
    filename: `design-review-${shortId}.md`,
    contentType: "text/markdown; charset=utf-8",
    body: reviewToMarkdown(review),
  };
}

export function normalizeExportFormat(value: unknown): ExportFormat {
  const text = String(value ?? "md").trim().toLowerCase();
  if (text === "json") return "json";
  if (text === "md" || text === "markdown" || text === "") return "md";
  throw new BadRequestError("Unsupported export format. Use md or json.");
}

export function reviewToMarkdown(review: StoredReview): string {
  const state = (review.state ?? {}) as Record<string, unknown>;
  const result = (state.result ?? null) as Record<string, unknown> | null;
  const summary = summarizeReview(review);
  const en = String(state.locale ?? "").toLowerCase().startsWith("en");
  const t = en ? MD_LABELS.en : MD_LABELS["zh-CN"];
  const lines: string[] = [];
  lines.push(`# ${t.title}`, "");
  lines.push(`- **${t.source}:** ${summary.source}`);
  lines.push(`- **${t.overall}:** ${summary.overall == null ? "—" : `${summary.overall} / 100`}`);
  lines.push(`- **${t.status}:** ${summary.status}`);
  lines.push(`- **${t.created}:** ${review.createdAt}`);
  lines.push(`- **${t.updated}:** ${review.updatedAt}`, "");

  if (summary.summary) {
    lines.push(`## ${t.verdict}`, "", summary.summary, "");
  }

  const dimensions = Array.isArray(result?.dimensions) ? (result!.dimensions as Record<string, unknown>[]) : [];
  if (dimensions.length) {
    lines.push(`## ${t.dimensions}`, "");
    lines.push(`| ${t.dimension} | ${t.score} | ${t.dimVerdict} | ${t.detail} |`);
    lines.push("| --- | --- | --- | --- |");
    for (const dim of dimensions.slice(0, 6)) {
      const name = mdCell(dim.name);
      const score = Number.isFinite(Number(dim.score)) ? String(Math.round(Number(dim.score))) : "—";
      lines.push(`| ${name} | ${score} | ${mdCell(dim.verdict)} | ${mdCell(dim.detail)} |`);
    }
    lines.push("");
  }

  const suggestions = Array.isArray(result?.suggestions) ? (result!.suggestions as Record<string, unknown>[]) : [];
  if (suggestions.length) {
    lines.push(`## ${t.suggestions}`, "");
    suggestions.forEach((item, index) => {
      const priority = item.priority ? `\`${mdInline(item.priority)}\` ` : "";
      const title = mdInline(item.title);
      const desc = item.desc ? ` — ${mdInline(item.desc)}` : "";
      lines.push(`${index + 1}. ${priority}**${title}**${desc}`);
    });
    lines.push("");
  }

  const annotations = Array.isArray(state.annotations) ? (state.annotations as Record<string, unknown>[]) : [];
  const withComment = annotations.filter((a) => a && typeof a.comment === "string" && a.comment.trim());
  if (withComment.length) {
    lines.push(`## ${t.annotations}`, "");
    withComment.forEach((a, index) => {
      lines.push(`- **#${index + 1}** ${mdInline(a.comment)}`);
      if (typeof a.reply === "string" && a.reply.trim()) lines.push(`  - ${t.reply}: ${mdInline(a.reply)}`);
    });
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

const MD_LABELS = {
  "zh-CN": {
    title: "设计评审报告",
    source: "评审对象",
    overall: "总分",
    status: "状态",
    created: "创建时间",
    updated: "更新时间",
    verdict: "总评",
    dimensions: "维度评分",
    dimension: "维度",
    score: "分数",
    dimVerdict: "判断",
    detail: "说明",
    suggestions: "改进清单",
    annotations: "我的标注",
    reply: "回复",
  },
  en: {
    title: "Design Review Report",
    source: "Source",
    overall: "Overall",
    status: "Status",
    created: "Created",
    updated: "Updated",
    verdict: "Verdict",
    dimensions: "Dimension Scores",
    dimension: "Dimension",
    score: "Score",
    dimVerdict: "Verdict",
    detail: "Detail",
    suggestions: "Suggestions",
    annotations: "My Annotations",
    reply: "Reply",
  },
} as const;

function mdInline(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

function mdCell(value: unknown): string {
  return mdInline(value).replace(/\|/g, "\\|") || "—";
}
