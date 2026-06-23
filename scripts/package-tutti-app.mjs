import path from "node:path";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, rm } from "node:fs/promises";

const rootDir = path.resolve(import.meta.dirname, "..");
const buildRoot = path.join(rootDir, "build", "tutti-app");
const packageRoot = path.join(buildRoot, "package");
const packageServerDir = path.join(packageRoot, "server");

await run("pnpm", ["build"], rootDir);
await rm(buildRoot, { recursive: true, force: true });
await mkdir(packageServerDir, { recursive: true });

await cp(path.join(rootDir, "server", "dist", "server.js"), path.join(packageServerDir, "server.js"));
await cp(path.join(rootDir, "server", "dist", "server.js.map"), path.join(packageServerDir, "server.js.map"));
await cp(path.join(rootDir, "static"), path.join(packageRoot, "static"), { recursive: true });
await cp(path.join(rootDir, "locales"), path.join(packageRoot, "locales"), { recursive: true });
await cp(path.join(rootDir, "tutti.app.json"), path.join(packageRoot, "tutti.app.json"));
await cp(path.join(rootDir, "tutti.cli.json"), path.join(packageRoot, "tutti.cli.json"));
await cp(path.join(rootDir, "COMMANDS.md"), path.join(packageRoot, "COMMANDS.md"));
await cp(path.join(rootDir, "AGENTS.md"), path.join(packageRoot, "AGENTS.md"));
await cp(path.join(rootDir, "icon.svg"), path.join(packageRoot, "icon.svg"));
await cp(path.join(rootDir, "bootstrap.sh"), path.join(packageRoot, "bootstrap.sh"));

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
