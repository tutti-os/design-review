import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_JOBS = 200;
const jobs = new Map<string, CompletionJob>();
const jobConfigs = new Map<string, RuntimeConfig>();

export function startCompletionJob(config: RuntimeConfig, payload: unknown): CompletionJob {
  pruneJobs();
  const now = new Date().toISOString();
  const job: CompletionJob = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: "running",
  };
  jobs.set(job.id, job);
  jobConfigs.set(job.id, config);
  void writeJob(config, job).catch(() => undefined);

  void completePayload(config, payload && typeof payload === "object" ? (payload as CompletePayload) : {})
    .then((result) => {
      updateJob(job.id, { status: "done", result });
    })
    .catch((error) => {
      updateJob(job.id, { status: "error", error: errorMessage(error) || "评审 Agent 调用失败。" });
    });

  return job;
}

export async function getCompletionJob(config: RuntimeConfig, rawId: unknown): Promise<CompletionJob | null> {
  pruneJobs();
  const id = normalizeJobId(rawId);
  const memoryJob = jobs.get(id);
  if (memoryJob) return memoryJob;
  const persisted = await readJob(config, id);
  if (!persisted) return null;
  if (persisted.status === "running") {
    return {
      ...persisted,
      status: "error",
      error: "评审任务因服务重启中断，请重新开始。",
      updatedAt: new Date().toISOString(),
    };
  }
  return persisted;
}

function updateJob(id: string, patch: Partial<CompletionJob>): void {
  const current = jobs.get(id);
  if (!current) return;
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, next);
  const config = jobConfigs.get(id);
  if (config) void writeJob(config, next).catch(() => undefined);
}

function normalizeJobId(rawId: unknown): string {
  if (typeof rawId !== "string" || !JOB_ID_PATTERN.test(rawId)) {
    throw new BadRequestError("Invalid completion job id.");
  }
  return rawId;
}

function pruneJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "running" && now - Date.parse(job.updatedAt) > JOB_TTL_MS) {
      jobs.delete(id);
      jobConfigs.delete(id);
    }
  }

  while (jobs.size > MAX_JOBS) {
    const oldestDone = Array.from(jobs.values())
      .filter((job) => job.status !== "running")
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))[0];
    if (!oldestDone) break;
    jobs.delete(oldestDone.id);
    jobConfigs.delete(oldestDone.id);
  }
}

async function readJob(config: RuntimeConfig, id: string): Promise<CompletionJob | null> {
  try {
    return JSON.parse(await readFile(jobFilePath(config, id), "utf8")) as CompletionJob;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJob(config: RuntimeConfig, job: CompletionJob): Promise<void> {
  const dir = path.join(config.runtimeDir, "completion-jobs");
  await mkdir(dir, { recursive: true });
  await writeFile(jobFilePath(config, job.id), JSON.stringify(job), "utf8");
}

function jobFilePath(config: RuntimeConfig, id: string): string {
  return path.join(config.runtimeDir, "completion-jobs", `${id}.json`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}
