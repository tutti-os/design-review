import { createDefaultLocalAgentRuntime } from "@tutti-os/agent-acp-kit";
import { loadTuttiAgentCatalog } from "@tutti-os/agent-acp-kit/tutti";

import { BadRequestError } from "./errors.js";

export type AgentTargetSummary = {
  agentTargetId: string;
  providerId: string;
  label: string;
  detected: boolean;
  supported: boolean;
  status: "ready" | "unsupported" | "not-installed";
  models: string[];
  reason?: string;
};

export type AgentTargetCatalog = {
  defaultAgentTargetId: string | null;
  agents: AgentTargetSummary[];
};

export const localAgentRuntime = createDefaultLocalAgentRuntime();

const DETECTION_TTL_MS = 30_000;
let detectionCache: { at: number; value: AgentTargetCatalog } | null = null;
let detectionInFlight: Promise<AgentTargetCatalog> | null = null;

export function listRegisteredProviderIds(): string[] {
  return localAgentRuntime.listProviders().map((provider) => provider.id);
}

export async function detectAgentTargetCatalog(
  options: { maxAgeMs?: number; signal?: AbortSignal } = {},
): Promise<AgentTargetCatalog> {
  const maxAgeMs = options.maxAgeMs ?? DETECTION_TTL_MS;
  if (detectionCache && Date.now() - detectionCache.at <= maxAgeMs) {
    return detectionCache.value;
  }
  if (options.signal) {
    return runDetection(options.signal);
  }
  if (!detectionInFlight) {
    detectionInFlight = runDetection()
      .then((value) => {
        detectionCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        detectionInFlight = null;
      });
  }
  return detectionInFlight;
}

export function warmAgentTargets(): void {
  void detectAgentTargetCatalog({ maxAgeMs: 0 }).catch(() => undefined);
}

export function pickDefaultAgentTarget(
  agents: AgentTargetSummary[],
  preferred?: string | null,
): string | null {
  const ready = agents.filter((agent) => agent.status === "ready");
  const requested = preferred?.trim();
  return (
    ready.find((agent) => agent.agentTargetId === requested)?.agentTargetId ??
    ready[0]?.agentTargetId ??
    null
  );
}

export async function resolveReadyAgentTarget(input: {
  agentTargetId?: string;
  provider?: string;
  signal?: AbortSignal;
}): Promise<AgentTargetSummary> {
  const catalog = await detectAgentTargetCatalog({ signal: input.signal });
  return resolveReadyAgentTargetFromCatalog(catalog, input);
}

export function resolveReadyAgentTargetFromCatalog(
  catalog: AgentTargetCatalog,
  input: { agentTargetId?: string; provider?: string },
): AgentTargetSummary {
  const requestedTarget = input.agentTargetId?.trim();
  let match = requestedTarget
    ? catalog.agents.find((agent) => agent.agentTargetId === requestedTarget)
    : undefined;
  if (!match && !requestedTarget && input.provider?.trim()) {
    const providerMatches = catalog.agents.filter(
      (agent) => agent.providerId === input.provider?.trim(),
    );
    if (providerMatches.length > 1) {
      throw new BadRequestError(
        `Multiple agents use provider ${input.provider}; select an exact agent target id.`,
      );
    }
    match = providerMatches[0];
  }
  if (!match && !requestedTarget && !input.provider?.trim()) {
    match = catalog.agents.find((agent) => agent.agentTargetId === catalog.defaultAgentTargetId);
  }
  if (!match) {
    throw new BadRequestError(
      requestedTarget
        ? `Agent target is not exposed by the Tutti agent catalog: ${requestedTarget}`
        : "No ready local agent. Check the current Tutti agent list, then retry.",
    );
  }
  if (match.status !== "ready") {
    throw new BadRequestError(match.reason ?? `${match.label} is not ready.`);
  }
  return match;
}

async function runDetection(signal?: AbortSignal): Promise<AgentTargetCatalog> {
  try {
    const [catalog, detections] = await Promise.all([
      loadTuttiAgentCatalog({ runtime: localAgentRuntime, signal }),
      localAgentRuntime.detect(),
    ]);
    const detectionByProvider = new Map(
      detections.map((detection) => [detection.provider, detection]),
    );
    const agents = catalog.agents.map((agent) => {
      const detection = detectionByProvider.get(agent.providerId);
      const detected = runtimeWasDetected(
        agent.availability.reasonCode,
        detection?.reason,
        Boolean(detection),
      );
      const supported = agent.runtimeSupported && detection?.supported !== false;
      const ready = detected && supported && agent.availability.status === "available";
      return {
        agentTargetId: agent.agentTargetId,
        providerId: agent.providerId,
        label: agent.displayName,
        detected,
        supported,
        status: ready
          ? "ready"
          : agent.runtimeSupported && !detected
            ? "not-installed"
            : "unsupported",
        models: detection?.models?.map((model) => model.id) ?? [],
        reason: agent.availability.detail || detection?.reason || authReason(detection?.authState),
      } satisfies AgentTargetSummary;
    });
    return {
      defaultAgentTargetId: pickDefaultAgentTarget(agents, catalog.defaultAgentTargetId),
      agents,
    };
  } catch {
    return { defaultAgentTargetId: null, agents: [] };
  }
}

export function runtimeWasDetected(
  availabilityReasonCode: string | undefined,
  detectionReason: string | undefined,
  hasDetection: boolean,
): boolean {
  if (!hasDetection) return false;
  const code = availabilityReasonCode?.trim().toLowerCase() ?? "";
  if (
    code === "runtime_not_detected" ||
    code === "cli_not_found" ||
    code.includes("not_installed") ||
    code.includes("executable_not_found")
  ) {
    return false;
  }
  const reason = detectionReason?.trim().toLowerCase() ?? "";
  return !(
    reason.includes("executable not found") ||
    reason.includes("executable was not found") ||
    reason.includes("runtime was not detected") ||
    reason.includes("runtime is not installed")
  );
}

function authReason(authState: string | undefined): string | undefined {
  if (authState === "missing") return "CLI detected but authentication is missing.";
  if (authState === "expired") return "CLI authentication has expired.";
  if (authState === "unknown") return "CLI authentication status is unknown.";
  return undefined;
}
