// `pnpm dev` for the API on every OS: recompile on change (tsc --watch) and restart the server on
// change (node --watch), side by side. A shell `a & b` does this on macOS/Linux, but on Windows
// cmd.exe runs `a` first and waits forever, so the API never started.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const entry = join(root, "dist", "main.js");
const children = [];

function run(args) {
  // process.execPath is this Node binary: no shell, so no Windows/Unix quoting differences.
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
  children.push(child);
  child.on("exit", (code) => stop(code ?? 1));
  return child;
}

function stop(code) {
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

run([tsc, "-p", "tsconfig.build.json", "--watch", "--preserveWatchOutput"]);

// On a fresh clone, wait for the first compile before starting the server.
const started = Date.now();
const timer = setInterval(() => {
  if (existsSync(entry)) {
    clearInterval(timer);
    run(["--watch", entry]);
  } else if (Date.now() - started > 120_000) {
    console.error("API did not compile within 2 minutes; see the TypeScript errors above.");
    stop(1);
  }
}, 500);
