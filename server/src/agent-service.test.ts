import assert from "node:assert/strict";
import test from "node:test";

import {
  pickDefaultAgentTarget,
  resolveReadyAgentTargetFromCatalog,
  runtimeWasDetected,
  type AgentTargetCatalog,
  type AgentTargetSummary,
} from "./agent-service.js";
import { BadRequestError } from "./errors.js";

function agent(
  agentTargetId: string,
  providerId: string,
  status: AgentTargetSummary["status"] = "ready",
) {
  return {
    agentTargetId,
    providerId,
    label: agentTargetId,
    detected: true,
    supported: status === "ready",
    status,
    models: [],
  } satisfies AgentTargetSummary;
}

test("default selection uses exact target identity when providers are shared", () => {
  const agents = [agent("team:writer", "codex"), agent("team:reviewer", "codex")];
  assert.equal(pickDefaultAgentTarget(agents, "team:reviewer"), "team:reviewer");
});

test("legacy provider selection fails closed when multiple agents share it", () => {
  const catalog: AgentTargetCatalog = {
    defaultAgentTargetId: "team:writer",
    agents: [agent("team:writer", "codex"), agent("team:reviewer", "codex")],
  };
  assert.throws(
    () => resolveReadyAgentTargetFromCatalog(catalog, { provider: "codex" }),
    (error) => {
      assert.ok(error instanceof BadRequestError);
      assert.match(error.message, /Multiple agents use provider codex/);
      return true;
    },
  );
});

test("exact target selection resolves provider only as runtime metadata", () => {
  const catalog: AgentTargetCatalog = {
    defaultAgentTargetId: "team:writer",
    agents: [agent("team:writer", "codex"), agent("team:reviewer", "codex")],
  };
  assert.deepEqual(
    resolveReadyAgentTargetFromCatalog(catalog, { agentTargetId: "team:reviewer" }),
    catalog.agents[1],
  );
});

test("unknown exact target is an invalid-input error", () => {
  const catalog: AgentTargetCatalog = {
    defaultAgentTargetId: "team:writer",
    agents: [agent("team:writer", "codex")],
  };
  assert.throws(
    () => resolveReadyAgentTargetFromCatalog(catalog, { agentTargetId: "team:missing" }),
    BadRequestError,
  );
});

test("an exact target that is not ready is an invalid-input error", () => {
  const catalog: AgentTargetCatalog = {
    defaultAgentTargetId: null,
    agents: [agent("team:reviewer", "codex", "not-installed")],
  };
  assert.throws(
    () => resolveReadyAgentTargetFromCatalog(catalog, { agentTargetId: "team:reviewer" }),
    BadRequestError,
  );
});

test("missing executables remain not-installed while auth failures remain detected", () => {
  assert.equal(
    runtimeWasDetected("cli_not_found", "Executable not found on PATH: opencode", true),
    false,
  );
  assert.equal(runtimeWasDetected("auth_required", "Provider authentication is required.", true), true);
});
