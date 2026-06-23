import { readFileSync } from "node:fs";
import path from "node:path";

export type AppManifest = {
  appId?: string;
  version?: string;
  localizationInfo?: {
    defaultLocale?: string;
    additionalLocales?: Array<{ locale?: string; file?: string }>;
  };
};

export function loadManifest(packageDir: string): AppManifest {
  try {
    return JSON.parse(readFileSync(path.join(packageDir, "tutti.app.json"), "utf8")) as AppManifest;
  } catch {
    return {};
  }
}

