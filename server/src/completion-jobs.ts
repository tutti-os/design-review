import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "./config.js";
import { BadRequestError } from "./errors.js";
import { completePayload, type CompletePayload } from "./completion-service.js";

export type CompletionJob = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "done" | "error";
  result?: Awaited<ReturnType<typeof completePayload>>;
  error?: string;
};

const JOB_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const jobs = new Map<string, CompletionJob>();

export function startCompletionJob(config: RuntimeConfig, payload: unknown): CompletionJob {
  const now = new Date().toISOString();
  const job: CompletionJob = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: "running",
  };
  jobs.set(job.id, job);

  void completePayload(config, payload && typeof payload === "object" ? (payload as CompletePayload) : {})
    .then((result) => {
      updateJob(job.id, { status: "done", result });
    })
    .catch((error) => {
      updateJob(job.id, { status: "error", error: errorMessage(error) || "评审 Agent 调用失败。" });
    });

  return job;
}

export function getCompletionJob(rawId: unknown): CompletionJob | null {
  const id = normalizeJobId(rawId);
  return jobs.get(id) ?? null;
}

function updateJob(id: string, patch: Partial<CompletionJob>): void {
  const current = jobs.get(id);
  if (!current) return;
  jobs.set(id, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

function normalizeJobId(rawId: unknown): string {
  if (typeof rawId !== "string" || !JOB_ID_PATTERN.test(rawId)) {
    throw new BadRequestError("Invalid completion job id.");
  }
  return rawId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}
