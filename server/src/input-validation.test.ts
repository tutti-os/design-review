import assert from "node:assert/strict";
import test from "node:test";

import { cliReview } from "./cli-service.js";
import { completePayload } from "./completion-service.js";
import type { RuntimeConfig } from "./config.js";
import { BadRequestError } from "./errors.js";

const config = {
  appId: "design-review",
  appVersion: "test",
  dataDir: "/tmp/design-review-test/data",
  defaultLocale: "en",
  host: "127.0.0.1",
  locales: ["en"],
  localesDir: "/tmp/design-review-test/locales",
  logDir: "/tmp/design-review-test/logs",
  packageDir: "/tmp/design-review-test/package",
  port: 8799,
  runtimeDir: "/tmp/design-review-test/runtime",
  staticDir: "/tmp/design-review-test/static",
} satisfies RuntimeConfig;

test("completion rejects non-string exact agent target ids", async () => {
  await assert.rejects(
    completePayload(config, {
      messages: [{ content: "review" }],
      agentTargetId: ["team:reviewer"],
    }),
    BadRequestError,
  );
});

test("CLI rejects conflicting exact agent target aliases", async () => {
  await assert.rejects(
    cliReview(config, {
      url: "https://example.com",
      "agent-id": "team:writer",
      agentTargetId: "team:reviewer",
    }),
    (error) => {
      assert.ok(error instanceof BadRequestError);
      assert.match(error.message, /must match/);
      return true;
    },
  );
});
