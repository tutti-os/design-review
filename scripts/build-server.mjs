import path from "node:path";
import { builtinModules } from "node:module";
import { mkdir, rm } from "node:fs/promises";

import { build } from "esbuild";

const rootDir = path.resolve(import.meta.dirname, "..");
const serverDir = path.join(rootDir, "server");
const outDir = path.join(serverDir, "dist");
const outFile = path.join(outDir, "server.js");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

await build({
  entryPoints: [path.join(serverDir, "src", "main.ts")],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: [...nodeBuiltins],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});

