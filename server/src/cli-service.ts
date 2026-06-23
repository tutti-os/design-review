import type { RuntimeConfig } from "./config.js";
import { BadRequestError } from "./errors.js";
import { detectAgentProviders, pickDefaultProvider } from "./agent-service.js";
import { extractJsonText, isJsonReviewText } from "./json-utils.js";
import { runLocalAgentCompletion } from "./local-agent-provider.js";
import { validateImagePath } from "./image-store.js";
import { buildReviewPrompt, normalizeLocale, normalizeStrictness } from "./review-prompt.js";
import path from "node:path";
import { randomUUID } from "node:crypto";

const CLI_REVIEW_TIMEOUT_MS = 280_000;

export async function cliStatus(config: RuntimeConfig, payload: unknown) {
  cliCommandInput(payload);
  const providers = await detectAgentProviders({ maxAgeMs: 0 });
  const provider = pickDefaultProvider(providers);
  const providerAvailable = Boolean(provider);
  const value: Record<string, unknown> = {
    appId: config.appId,
    version: config.appVersion,
    provider: provider ?? "none",
    providerAvailable,
    ok: providerAvailable,
    providers,
  };
  if (!providerAvailable) {
    value.error = "No ready local agent provider. Install and sign in to Claude or Codex, then retry.";
  }
  return { kind: "json", value };
}

export async function cliReview(config: RuntimeConfig, payload: unknown) {
  const input = cliCommandInput(payload);
  const url = cleanString(input.url);
  let imagePath = cleanString(input["image-path"]) || cleanString(input.imagePath);
  const provider = cleanString(input.provider);
  const model = cleanString(input.model);
  const strictness = normalizeStrictness(input.strictness);
  const locale = normalizeLocale(input.locale, config.defaultLocale);
  if (!url && !imagePath) {
    throw new BadRequestError("Provide either url or image-path.");
  }
  if (imagePath) {
    imagePath = await validateImagePath(imagePath, [
      ...(config.workspaceRoot ? [config.workspaceRoot] : []),
      config.runtimeDir,
      config.dataDir,
    ]);
  }
  const prompt = buildReviewPrompt({ url, imagePath, strictness, locale });
  const runId = `design-review-cli-${randomUUID()}`;
  const runDir = path.join(config.runtimeDir, "runs", runId);
  const completion = await runLocalAgentCompletion({
    config,
    runId,
    runDir,
    provider,
    model,
    prompt,
    timeoutMs: CLI_REVIEW_TIMEOUT_MS,
  });
  if (!isJsonReviewText(completion.text)) {
    throw new Error("Agent 没有返回完整的设计评审 JSON。");
  }
  return { kind: "json", value: JSON.parse(extractJsonText(completion.text)) };
}

function cliCommandInput(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const value = payload as Record<string, unknown>;
  const schemaVersion = String(value.schemaVersion ?? "");
  const isEnvelope =
    schemaVersion.startsWith("tutti.app.cli.invoke") ||
    ("input" in value && ["commandId", "path", "outputMode", "scope", "context"].some((key) => key in value));
  if (isEnvelope) {
    return value.input && typeof value.input === "object" ? (value.input as Record<string, unknown>) : {};
  }
  return value;
}

function cleanString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

