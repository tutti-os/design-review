import path from "node:path";
import { spawn } from "node:child_process";
import { chmod, cp, lstat, mkdir, readdir, rm } from "node:fs/promises";

const rootDir = path.resolve(import.meta.dirname, "..");
const buildRoot = path.join(rootDir, "build", "tutti-app");
const packageRoot = path.join(buildRoot, "package");
const packageServerDir = path.join(packageRoot, "server");
const packageFiles = [
  "tutti.app.json",
  "tutti.cli.json",
  "COMMANDS.md",
  "AGENTS.md",
  "icon.svg",
  "bootstrap.sh",
];
const packageDirs = ["static", "locales", "docs"];

await run("pnpm", ["build"], rootDir);
await rm(buildRoot, { recursive: true, force: true });
await mkdir(packageServerDir, { recursive: true });

await copyRequiredFile(path.join(rootDir, "server", "dist", "server.js"), path.join(packageServerDir, "server.js"));
await copyRequiredFile(path.join(rootDir, "server", "dist", "server.js.map"), path.join(packageServerDir, "server.js.map"));
for (const name of packageFiles) {
  await copyRequiredFile(path.join(rootDir, name), path.join(packageRoot, name));
}
for (const name of packageDirs) {
  await copyRequiredDir(path.join(rootDir, name), path.join(packageRoot, name));
}

await chmod(path.join(packageRoot, "bootstrap.sh"), 0o755);

await run(
  "python3",
  [
    path.join(rootDir, "scripts", "validate_tutti_app_package.py"),
    packageRoot,
  ],
  rootDir,
);

console.log(`Packaged Tutti app -> ${packageRoot}`);

async function copyRequiredFile(source, target) {
  const info = await requiredLstat(source);
  if (!info.isFile()) throw new Error(`Required package file is not a file: ${path.relative(rootDir, source)}`);
  await cp(source, target);
}

async function copyRequiredDir(source, target) {
  const info = await requiredLstat(source);
  if (!info.isDirectory()) throw new Error(`Required package entry is not a directory: ${path.relative(rootDir, source)}`);
  await rejectSymlinks(source);
  await cp(source, target, { recursive: true });
}

async function requiredLstat(source) {
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    throw new Error(`Missing required package entry: ${path.relative(rootDir, source)}`, { cause: error });
  }
  if (info.isSymbolicLink()) throw new Error(`Refusing to package symlink: ${path.relative(rootDir, source)}`);
  return info;
}

async function rejectSymlinks(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new Error(`Refusing to package symlink: ${path.relative(rootDir, fullPath)}`);
    if (info.isDirectory()) await rejectSymlinks(fullPath);
  }
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
    child.on("error", reject);
  });
}
