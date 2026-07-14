import { mkdir, rm } from "node:fs/promises";

import type { AgentEvent } from "@tutti-os/agent-acp-kit";
import {
  loadTuttiAgentComposerOptions,
  loadTuttiAgentSkillContext,
} from "@tutti-os/agent-acp-kit/tutti";

import { localAgentRuntime, resolveReadyAgentTarget } from "./agent-service.js";
import type { RuntimeConfig } from "./config.js";
import { AgentTimeoutError } from "./errors.js";

export type CompletionRunInput = {
  config: RuntimeConfig;
  runId: string;
  agentTargetId?: string;
  /** @deprecated Compatibility input for clients that have not migrated to Agent Target IDs. */
  provider?: string;
  model?: string;
  prompt: string;
  runDir: string;
  timeoutMs: number;
};

export type CompletionRunOutput = {
  text: string;
  agentTargetId: string;
  provider: string;
  sessionId?: string;
  resumeToken?: string;
};

export async function runLocalAgentCompletion(
  input: CompletionRunInput,
): Promise<CompletionRunOutput> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  let text = "";
  let agentTargetId = "";
  let provider = "";
  let sessionId: string | undefined;
  let resumeToken: string | undefined;

  try {
    await mkdir(input.runDir, { recursive: true });
    const target = await abortOnSignal(
      resolveReadyAgentTarget({
        agentTargetId: input.agentTargetId,
        provider: input.provider,
        signal: controller.signal,
      }),
      controller.signal,
    );
    agentTargetId = target.agentTargetId;
    provider = target.providerId;
    const cwd = input.config.workspaceRoot ?? input.runDir;
    const [composer, skillContext] = await abortOnSignal(
      Promise.all([
        loadTuttiAgentComposerOptions({
          runtime: localAgentRuntime,
          agentTargetId: target.agentTargetId,
          model: input.model?.trim(),
          cwd,
          env: process.env,
          signal: controller.signal,
        }),
        loadTuttiAgentSkillContext({
          agentTargetId: target.agentTargetId,
          agentSessionId: input.runId,
          cwd,
          env: process.env,
          signal: controller.signal,
        }),
      ]),
      controller.signal,
    );
    const model = stripProviderPrefix(
      input.model?.trim() ||
        composer.modelConfig.currentValue ||
        composer.modelConfig.defaultValue ||
        "default",
      provider,
    );
    const permissionMode = composer.permissionConfig.modes.find(
      (mode) => mode.id === composer.permissionConfig.defaultValue,
    );

    for await (const event of localAgentRuntime.run({
      runId: input.runId,
      conversationId: input.runId,
      sessionId: input.runId,
      provider,
      runtimeKind: "local-agent",
      runtimeProvider: provider,
      cwd,
      prompt: input.prompt,
      systemPrompt: skillContext.recommendedSystemPrompt?.content,
      model,
      reasoning:
        composer.reasoningConfig.currentValue || composer.reasoningConfig.defaultValue || undefined,
      permission: permissionMode
        ? { modeId: permissionMode.id, semantic: permissionMode.semantic }
        : undefined,
      timeoutMs: input.timeoutMs,
      extraAllowedDirs: [
        input.runDir,
        input.config.runtimeDir,
        input.config.dataDir,
        ...(input.config.workspaceRoot ? [input.config.workspaceRoot] : []),
      ],
      signal: controller.signal,
      skillManifest: skillContext.skillManifest,
    })) {
      const mapped = mapAgentEvent(event);
      if (mapped.type === "text") text += mapped.text;
      if (mapped.type === "error") throw new Error(mapped.message);
      if (mapped.type === "done") {
        sessionId = mapped.sessionId ?? sessionId;
        resumeToken = mapped.resumeToken ?? resumeToken;
        if (mapped.status && mapped.status !== "completed") {
          throw new Error(
            `local-agent ${provider} ${mapped.status}${typeof mapped.exitCode === "number" ? ` with exit code ${mapped.exitCode}` : ""}`,
          );
        }
      }
    }
    if (controller.signal.aborted) {
      throw new AgentTimeoutError("等待评审 Agent 返回结果超时。");
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AgentTimeoutError("等待评审 Agent 返回结果超时。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await localAgentRuntime.cancel(input.runId).catch(() => undefined);
    await rm(input.runDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    text: text.trim(),
    agentTargetId,
    provider,
    sessionId,
    resumeToken,
  };
}

function abortOnSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new AgentTimeoutError("等待评审 Agent 返回结果超时。"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new AgentTimeoutError("等待评审 Agent 返回结果超时。"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

type MappedAgentEvent =
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; status?: string; exitCode?: number; sessionId?: string; resumeToken?: string }
  | { type: "ignore" };

function mapAgentEvent(event: AgentEvent): MappedAgentEvent {
  if (event.type === "text_delta") return { type: "text", text: event.text };
  if (event.type === "error") return { type: "error", message: event.message };
  if (event.type === "done") {
    return {
      type: "done",
      status: event.status,
      exitCode: event.exitCode ?? undefined,
      sessionId: event.sessionId,
      resumeToken: event.resumeToken,
    };
  }
  return { type: "ignore" };
}

function stripProviderPrefix(model: string, provider: string) {
  const prefix = `${provider}:`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}
