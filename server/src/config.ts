import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadManifest } from "./app-meta.js";

export type RuntimeConfig = {
  appId: string;
  appVersion: string;
  dataDir: string;
  defaultLocale: string;
  host: string;
  locales: string[];
  localesDir: string;
  logDir: string;
  packageDir: string;
  port: number;
  runtimeDir: string;
  staticDir: string;
  workspaceRoot: string | null;
};

export async function createRuntimeConfig(): Promise<RuntimeConfig> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const inferredPackageDir = path.resolve(currentDir, "../..");
  const packageDir = process.env.TUTTI_APP_PACKAGE_DIR ?? inferredPackageDir;
  const generatedDir = path.join(packageDir, "generated");
  const dataDir = process.env.TUTTI_APP_DATA_DIR ?? path.join(generatedDir, "data");
  const logDir = process.env.TUTTI_APP_LOG_DIR ?? path.join(generatedDir, "logs");
  const runtimeDir = process.env.TUTTI_APP_RUNTIME_DIR ?? path.join(generatedDir, "runtime");
  const manifest = loadManifest(packageDir);
  const localization = manifest.localizationInfo ?? {};
  const defaultLocale = localization.defaultLocale ?? "zh-CN";
  const locales = [
    defaultLocale,
    ...(localization.additionalLocales ?? [])
      .map((entry) => entry.locale)
      .filter((locale): locale is string => Boolean(locale)),
  ];

  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(logDir, { recursive: true }), mkdir(runtimeDir, { recursive: true })]);

  return {
    appId: manifest.appId ?? process.env.TUTTI_APP_ID ?? "design-review",
    appVersion: manifest.version ?? "0.1.0",
    dataDir,
    defaultLocale,
    host: process.env.TUTTI_APP_HOST?.trim() || "127.0.0.1",
    locales,
    localesDir: path.join(packageDir, "locales"),
    logDir,
    packageDir,
    port: Number(process.env.TUTTI_APP_PORT ?? "8799"),
    runtimeDir,
    staticDir: path.join(packageDir, "static"),
    workspaceRoot: process.env.TUTTI_WORKSPACE_ROOT?.trim() || null,
  };
}

