import { createDefaultLocalAgentRuntime } from "@tutti-os/agent-acp-kit";
import { loadTuttiAgentProviderCatalog } from "@tutti-os/agent-acp-kit/tutti";

export type AgentProviderSummary = {
  provider: string;
  label: string;
  detected: boolean;
  supported: boolean;
  status: "ready" | "unsupported" | "not-installed";
  models: string[];
  reason?: string;
};

export type AgentProviderCatalog = {
  defaultProvider: string | null;
  providers: AgentProviderSummary[];
};

export const localAgentRuntime = createDefaultLocalAgentRuntime();

const DETECTION_TTL_MS = 30_000;
let detectionCache: { at: number; value: AgentProviderCatalog } | null = null;
let detectionInFlight: Promise<AgentProviderCatalog> | null = null;

export function listRegisteredProviderIds(): string[] {
  return localAgentRuntime.listProviders().map((provider) => provider.id);
}

export async function detectAgentProviderCatalog(
  options: { maxAgeMs?: number } = {},
): Promise<AgentProviderCatalog> {
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

export async function detectAgentProviders(
  options: { maxAgeMs?: number } = {},
): Promise<AgentProviderSummary[]> {
  return (await detectAgentProviderCatalog(options)).providers;
}

export function warmAgentProviders(): void {
  void detectAgentProviderCatalog({ maxAgeMs: 0 }).catch(() => undefined);
}

export function pickDefaultProvider(
  providers: AgentProviderSummary[],
  preferred?: string | null,
): string | null {
  const ready = providers.filter((provider) => provider.status === "ready");
  const requested = preferred?.trim();
  return ready.find((provider) => provider.provider === requested)?.provider
    ?? ready[0]?.provider
    ?? null;
}

export async function assertProviderReady(provider: string): Promise<AgentProviderSummary> {
  const catalog = await detectAgentProviderCatalog();
  const match = catalog.providers.find((item) => item.provider === provider);
  if (!match) {
    throw new Error(`Provider is not exposed by the Tutti agent catalog: ${provider}`);
  }
  if (match.status !== "ready") {
    throw new Error(match.reason ?? `${provider} local agent is not ready.`);
  }
  return match;
}

async function runDetection(): Promise<AgentProviderCatalog> {
  try {
    const [catalog, detections] = await Promise.all([
      loadTuttiAgentProviderCatalog({ runtime: localAgentRuntime }),
      localAgentRuntime.detect(),
    ]);
    const detectionByProvider = new Map(
      detections.map((detection) => [detection.provider, detection]),
    );
    const providers = catalog.providers.map((provider) => {
      const detection = detectionByProvider.get(provider.providerId);
      const result = detection?.result;
      const detected = Boolean(result);
      const supported = provider.runtimeSupported && result?.supported !== false;
      const ready =
        detected &&
        supported &&
        provider.availability.status === "available";
      return {
        provider: provider.providerId,
        label: provider.displayName,
        detected,
        supported,
        status: ready ? "ready" : provider.runtimeSupported && !detected ? "not-installed" : "unsupported",
        models: result?.models?.map((model) => model.id) ?? [],
        reason:
          provider.availability.detail ||
          result?.unsupportedReason ||
          authReason(result?.authState),
      } satisfies AgentProviderSummary;
    });
    return {
      defaultProvider: pickDefaultProvider(providers, catalog.defaultProviderId),
      providers,
    };
  } catch {
    return { defaultProvider: null, providers: [] };
  }
}

function authReason(authState: string | undefined): string | undefined {
  if (authState === "missing") return "CLI detected but authentication is missing.";
  if (authState === "expired") return "CLI authentication has expired.";
  if (authState === "unknown") return "CLI authentication status is unknown.";
  return undefined;
}
