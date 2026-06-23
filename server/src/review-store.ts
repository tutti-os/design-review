import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RuntimeConfig } from "./config.js";
import { BadRequestError } from "./errors.js";

export type StoredReview = {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: Record<string, unknown>;
};

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
    return JSON.parse(await readFile(reviewFilePath(config, id), "utf8")) as StoredReview;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
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
