import {
  createDefaultLocalAgentProviderPlugins,
  createLocalAgentRuntime,
} from "@tutti-os/agent-acp-kit";

export type AgentProviderSummary = {
  provider: string;
  label: string;
  detected: boolean;
  supported: boolean;
  status: "ready" | "unsupported" | "not-installed";
  models: string[];
  reason?: string;
};

export const localAgentRuntime = createLocalAgentRuntime({
  providers: createDefaultLocalAgentProviderPlugins(),
});

const DETECTION_TTL_MS = 30_000;
let detectionCache: { at: number; value: AgentProviderSummary[] } | null = null;
let detectionInFlight: Promise<AgentProviderSummary[]> | null = null;

export function listRegisteredProviderIds(): string[] {
  return localAgentRuntime.listProviders().map((provider) => provider.id);
}

export async function detectAgentProviders(options: { maxAgeMs?: number } = {}): Promise<AgentProviderSummary[]> {
  const maxAgeMs = options.maxAgeMs ?? DETECTION_TTL_MS;
  if (detectionCache && Date.now() - detectionCache.at <= maxAgeMs) {
    return detectionCache.value;
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

export function warmAgentProviders(): void {
  void detectAgentProviders({ maxAgeMs: 0 }).catch(() => undefined);
}

export function pickDefaultProvider(providers: AgentProviderSummary[]): string | null {
  const ready = providers.filter((provider) => provider.status === "ready");
  const claude = ready.find((provider) => provider.provider === "claude");
  return claude?.provider ?? ready[0]?.provider ?? null;
}

export async function assertProviderReady(provider: string): Promise<AgentProviderSummary> {
  if (!listRegisteredProviderIds().includes(provider)) {
    throw new Error(`Provider is not registered in @tutti-os/agent-acp-kit: ${provider}`);
  }
  const providers = await detectAgentProviders();
  const match = providers.find((item) => item.provider === provider);
  if (!match || match.status !== "ready") {
    throw new Error(match?.reason ?? `${provider} local agent is not ready.`);
  }
  return match;
}

async function runDetection(): Promise<AgentProviderSummary[]> {
  try {
    const detections = await localAgentRuntime.detect();
    return detections.map((detection) => {
      const models = detection.result?.models?.map((model) => model.id) ?? [];
      const supported = detection.result?.supported !== false;
      const detected = Boolean(detection.result);
      const authState = detection.result?.authState;
      const authBlocked = authState === "missing" || authState === "expired";
      const ready = detected && supported && !authBlocked;

      return {
        provider: detection.provider,
        label: detection.displayName,
        detected,
        supported,
        status: ready ? "ready" : detected ? "unsupported" : "not-installed",
        models,
        reason:
          detection.result?.unsupportedReason ??
          (ready ? undefined : authReason(authState)),
      };
    });
  } catch {
    return [];
  }
}

function authReason(authState: string | undefined): string | undefined {
  if (authState === "missing") return "CLI detected but authentication is missing.";
  if (authState === "expired") return "CLI authentication has expired.";
  if (authState === "unknown") return "CLI authentication status is unknown.";
  return undefined;
}
