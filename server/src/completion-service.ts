import path from "node:path";
import { randomUUID } from "node:crypto";

import type { RuntimeConfig } from "./config.js";
import { BadRequestError } from "./errors.js";
import {
  extractJsonArrayText,
  extractJsonText,
  isJsonArrayText,
  isJsonReviewText,
} from "./json-utils.js";
import { runLocalAgentCompletion } from "./local-agent-provider.js";
import { saveBase64Image } from "./image-store.js";

export type CompletePayload = {
  messages?: unknown;
  agentTargetId?: unknown;
  /** @deprecated Compatibility input. */
  provider?: unknown;
  model?: unknown;
};

type CompletionType = "review_json" | "marker_json" | "plain_text";

export async function completePayload(config: RuntimeConfig, payload: CompletePayload) {
  const agentTargetId = cleanString(payload.agentTargetId);
  const provider = cleanString(payload.provider);
  if (agentTargetId && provider) {
    throw new BadRequestError("Provide agentTargetId or deprecated provider, not both.");
  }
  const prompt = await buildAgentPrompt(config, payload);
  const completionType = completionTypeForPrompt(prompt);
  const runId = `design-review-${randomUUID()}`;
  const runDir = path.join(config.runtimeDir, "runs", runId);
  const session = await runLocalAgentCompletion({
    config,
    runId,
    runDir,
    agentTargetId,
    provider,
    model: cleanString(payload.model),
    prompt,
    timeoutMs: 300_000,
  });

  if (!acceptsCompletionText(session.text, completionType)) {
    throw new Error(invalidCompletionMessage(completionType));
  }

  return {
    text: normalizeCompletionText(session.text, completionType),
    agentSessionId: session.sessionId ?? runId,
    agentTargetId: session.agentTargetId,
    agentProvider: session.provider,
    resumeToken: session.resumeToken,
  };
}

export async function buildAgentPrompt(
  config: RuntimeConfig,
  payload: CompletePayload,
): Promise<string> {
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequestError("缺少 messages。");
  }

  const parts: string[] = [];
  const imagePaths: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const typed = item as { type?: unknown; text?: unknown; source?: unknown };
        if (typed.type === "text") {
          parts.push(String(typed.text ?? ""));
        } else if (typed.type === "image") {
          imagePaths.push(await saveImageContent(config, typed.source));
        }
      }
    }
  }

  let prompt = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!prompt) throw new BadRequestError("缺少 prompt 内容。");
  if (imagePaths.length > 0) {
    prompt += `\n\n# 本地图片文件\n${imagePaths.map((imagePath) => `- ${imagePath}`).join("\n")}`;
    prompt += "\n请优先读取这些本地图片文件进行视觉评审。";
  }
  return prompt;
}

async function saveImageContent(config: RuntimeConfig, sourceValue: unknown): Promise<string> {
  const source =
    sourceValue && typeof sourceValue === "object"
      ? (sourceValue as { data?: unknown; media_type?: unknown })
      : {};
  return saveBase64Image({
    runtimeDir: config.runtimeDir,
    data: String(source.data ?? ""),
    mediaType: String(source.media_type ?? "image/png"),
  });
}

function completionTypeForPrompt(prompt: string): CompletionType {
  if (
    prompt.includes("只输出一个合法的 JSON 数组") ||
    prompt.includes("请只挑出 4-6 处最主要的问题区域") ||
    prompt.includes("the 4-6 most important problem areas")
  ) {
    return "marker_json";
  }
  if (
    prompt.includes("这是一张界面设计截图中被框选出来的局部区域") ||
    prompt.includes("附图是一张界面设计截图里被框选出来的局部区域") ||
    prompt.includes("a cropped local region of a UI design screenshot")
  ) {
    return "plain_text";
  }
  return "review_json";
}

function acceptsCompletionText(text: string, completionType: CompletionType): boolean {
  if (completionType === "marker_json") return isJsonArrayText(text);
  if (completionType === "plain_text") return Boolean(text.trim());
  return isJsonReviewText(text);
}

function normalizeCompletionText(text: string, completionType: CompletionType): string {
  if (completionType === "marker_json") return extractJsonArrayText(text);
  if (completionType === "plain_text") return text.trim();
  return extractJsonText(text);
}

function invalidCompletionMessage(completionType: CompletionType): string {
  if (completionType === "marker_json") return "Agent 没有返回完整的标注 JSON 数组。";
  if (completionType === "plain_text") return "Agent 没有返回有效的局部建议。";
  return "Agent 没有返回完整的设计评审 JSON。";
}

function cleanString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}
