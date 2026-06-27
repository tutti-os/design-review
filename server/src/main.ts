import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import Fastify from "fastify";

import { createRuntimeConfig } from "./config.js";
import { BadRequestError, AgentTimeoutError } from "./errors.js";
import { completePayload } from "./completion-service.js";
import { cliExport, cliHistory, cliReview, cliStatus } from "./cli-service.js";
import { detectAgentProviders, pickDefaultProvider, warmAgentProviders } from "./agent-service.js";
import { createReview, exportReview, listReviews, normalizeExportFormat, readReview, updateReview } from "./review-store.js";
import { getCompletionJob, startCompletionJob } from "./completion-jobs.js";

const I18N_PLACEHOLDER = "<!--__TUTTI_I18N__-->";

const config = await createRuntimeConfig();
const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
warmAgentProviders();

app.get("/healthz", async () => ({ ok: true }));

app.get("/favicon.ico", async (_request, reply) => reply.header("Cache-Control", "no-store").code(204).send());

app.get("/api/agents", async (_request, reply) => {
  try {
    const providers = (await detectAgentProviders({ maxAgeMs: 0 })).filter(
      (provider) => provider.status === "ready" && ["codex", "claude"].includes(provider.provider),
    );
    return {
      defaultProvider: pickDefaultProvider(providers) ?? providers[0]?.provider ?? null,
      providers,
    };
  } catch (error) {
    return sendApiError(reply, error, "读取本地 Agent 列表失败。");
  }
});

app.post("/api/complete", async (request, reply) => {
  try {
    return await completePayload(config, request.body && typeof request.body === "object" ? request.body : {});
  } catch (error) {
    return sendApiError(reply, error, "评审服务异常。");
  }
});

app.post("/api/completions", async (request, reply) => {
  try {
    return { job: startCompletionJob(config, request.body) };
  } catch (error) {
    return sendApiError(reply, error, "启动评审 Agent 失败。");
  }
});

app.get("/api/completions/:id", async (request, reply) => {
  try {
    const job = await getCompletionJob(config, (request.params as { id?: string }).id);
    if (!job) return reply.code(404).send({ error: "评审任务不存在。" });
    return { job };
  } catch (error) {
    return sendApiError(reply, error, "读取评审任务失败。");
  }
});

app.post("/api/reviews", async (request, reply) => {
  try {
    return { review: await createReview(config, request.body) };
  } catch (error) {
    return sendApiError(reply, error, "保存评审结果失败。");
  }
});

app.get("/api/reviews", async (_request, reply) => {
  try {
    return reply.header("Cache-Control", "no-store").send({ reviews: await listReviews(config) });
  } catch (error) {
    return sendApiError(reply, error, "读取评审历史失败。");
  }
});

app.get("/api/reviews/:id/export", async (request, reply) => {
  try {
    const format = normalizeExportFormat((request.query as { format?: string } | undefined)?.format);
    const result = await exportReview(config, (request.params as { id?: string }).id, format);
    if (!result) return reply.code(404).send({ error: "评审结果不存在。" });
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", `attachment; filename="${result.filename}"`)
      .type(result.contentType)
      .send(result.body);
  } catch (error) {
    return sendApiError(reply, error, "导出评审结果失败。");
  }
});

app.get("/api/reviews/:id", async (request, reply) => {
  try {
    const review = await readReview(config, (request.params as { id?: string }).id);
    if (!review) return reply.code(404).send({ error: "评审结果不存在。" });
    return { review };
  } catch (error) {
    return sendApiError(reply, error, "读取评审结果失败。");
  }
});

app.patch("/api/reviews/:id", async (request, reply) => {
  try {
    const review = await updateReview(config, (request.params as { id?: string }).id, request.body);
    if (!review) return reply.code(404).send({ error: "评审结果不存在。" });
    return { review };
  } catch (error) {
    return sendApiError(reply, error, "更新评审结果失败。");
  }
});

app.post("/tutti/cli/status", async (request, reply) => {
  try {
    return await cliStatus(config, request.body);
  } catch (error) {
    return sendCliError(reply, error, "design-review status failed.");
  }
});

app.post("/tutti/cli/review", async (request, reply) => {
  try {
    return await cliReview(config, request.body);
  } catch (error) {
    return sendCliError(reply, error, "design-review review failed.");
  }
});

app.post("/tutti/cli/history", async (request, reply) => {
  try {
    return await cliHistory(config, request.body);
  } catch (error) {
    return sendCliError(reply, error, "design-review history failed.");
  }
});

app.post("/tutti/cli/export", async (request, reply) => {
  try {
    return await cliExport(config, request.body);
  } catch (error) {
    return sendCliError(reply, error, "design-review export failed.");
  }
});

app.get("/*", async (request, reply) => {
  const requestPath = request.url.split("?", 1)[0];
  if (requestPath.startsWith("/locales/")) {
    const target = safePackagePath(config.packageDir, requestPath, config.localesDir);
    if (!target) return reply.code(404).send({ error: "Not found" });
    return sendFile(reply, target);
  }
  const target = safeStaticPath(requestPath);
  if (!target) return reply.code(404).send({ error: "Not found" });
  if (target === path.join(config.staticDir, "index.html")) {
    return reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(await renderIndexHtml());
  }
  return sendFile(reply, target);
});

await app.listen({ host: config.host, port: config.port });

async function renderIndexHtml(): Promise<string> {
  const html = await readFile(path.join(config.staticDir, "index.html"), "utf8");
  const bundle = {
    messages: await loadAppI18n(),
    defaultLocale: config.defaultLocale,
    locales: config.locales,
  };
  const script = `<script>window.__TUTTI_I18N__=${JSON.stringify(bundle)};</script>`;
  return html.replace(I18N_PLACEHOLDER, script);
}

async function loadAppI18n(): Promise<Record<string, unknown>> {
  const messages: Record<string, unknown> = {};
  try {
    const entries = await readdir(config.localesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        messages[entry.name] = JSON.parse(await readFile(path.join(config.localesDir, entry.name, "app.json"), "utf8"));
      } catch {
        continue;
      }
    }
  } catch {
    return messages;
  }
  return messages;
}

function safeStaticPath(requestPath: string): string | null {
  const relativePath = decodeURIComponent(requestPath).replace(/^\/+/, "") || "index.html";
  const target = path.resolve(config.staticDir, relativePath);
  const root = path.resolve(config.staticDir);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

function safePackagePath(packageDir: string, requestPath: string, allowedRoot: string): string | null {
  const relativePath = decodeURIComponent(requestPath).replace(/^\/+/, "");
  const target = path.resolve(packageDir, relativePath);
  const root = path.resolve(allowedRoot);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

async function sendFile(reply: { header: (name: string, value: string) => unknown; type: (contentType: string) => unknown; code: (status: number) => { send: (body: unknown) => unknown }; send: (body: unknown) => unknown }, target: string) {
  try {
    const data = await readFile(target);
    reply.header("Cache-Control", "no-store");
    reply.type(contentTypeFor(target));
    return reply.send(data);
  } catch {
    return reply.code(404).send({ error: "Not found" });
  }
}

function contentTypeFor(filePath: string): string {
  const suffix = path.extname(filePath);
  if (suffix === ".html") return "text/html; charset=utf-8";
  if (suffix === ".css") return "text/css; charset=utf-8";
  if (suffix === ".js") return "application/javascript; charset=utf-8";
  if (suffix === ".svg") return "image/svg+xml";
  if (suffix === ".json") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function sendApiError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown, fallback: string) {
  const status = error instanceof BadRequestError || error instanceof AgentTimeoutError ? error.statusCode : 500;
  return reply.code(status).send({ error: errorMessage(error) || fallback });
}

function sendCliError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown, fallback: string) {
  const status = error instanceof BadRequestError || error instanceof AgentTimeoutError ? error.statusCode : 500;
  const code = error instanceof BadRequestError ? "invalid_input" : error instanceof AgentTimeoutError ? "timeout" : "internal_error";
  return reply.code(status).send({ error: { code, message: errorMessage(error) || fallback } });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}
