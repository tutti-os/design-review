import { mkdir } from "node:fs/promises";

import type { AgentEvent } from "@tutti-os/agent-acp-kit";

import { assertProviderReady, localAgentRuntime, pickDefaultProvider, detectAgentProviders } from "./agent-service.js";
import type { RuntimeConfig } from "./config.js";
import { AgentTimeoutError } from "./errors.js";

export type CompletionRunInput = {
  config: RuntimeConfig;
  runId: string;
  provider?: string;
  model?: string;
  prompt: string;
  runDir: string;
  timeoutMs: number;
};

export type CompletionRunOutput = {
  text: string;
  provider: string;
  sessionId?: string;
  resumeToken?: string;
};

export async function runLocalAgentCompletion(input: CompletionRunInput): Promise<CompletionRunOutput> {
  await mkdir(input.runDir, { recursive: true });
  const provider = input.provider?.trim() || pickDefaultProvider(await detectAgentProviders());
  if (!provider) {
    throw new Error("No ready local agent provider. Install and sign in to Claude or Codex, then retry.");
  }
  await assertProviderReady(provider);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  let text = "";
  let sessionId: string | undefined;
  let resumeToken: string | undefined;

  try {
    for await (const event of localAgentRuntime.run({
      runId: input.runId,
      conversationId: input.runId,
      sessionId: input.runId,
      provider,
      runtimeKind: "local-agent",
      runtimeProvider: provider,
      cwd: input.config.workspaceRoot ?? input.runDir,
      prompt: input.prompt,
      model: stripProviderPrefix(input.model?.trim() || "default", provider),
      timeoutMs: input.timeoutMs,
      extraAllowedDirs: [input.runDir, input.config.runtimeDir],
      signal: controller.signal,
    })) {
      const mapped = mapAgentEvent(event);
      if (mapped.type === "text") text += mapped.text;
      if (mapped.type === "error") throw new Error(mapped.message);
      if (mapped.type === "done") {
        sessionId = mapped.sessionId ?? sessionId;
        resumeToken = mapped.resumeToken ?? resumeToken;
        if (mapped.status === "failed") {
          throw new Error(`local-agent ${provider} failed${typeof mapped.exitCode === "number" ? ` with exit code ${mapped.exitCode}` : ""}`);
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AgentTimeoutError("等待评审 Agent 返回结果超时。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await localAgentRuntime.cancel(input.runId).catch(() => undefined);
  }

  return { text: text.trim(), provider, sessionId, resumeToken };
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
