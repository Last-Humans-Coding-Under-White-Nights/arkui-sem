#!/usr/bin/env node
// Set up a fresh clone, or check one. Run from anywhere in the repo:
//   node scripts/setup.mjs [--datasets <name,...>]
//     builds the linter and installs the plugin into the demo project sandbox/demo; with the private bench checked out
//     (bench/, a git submodule), also restores its datasets (node bench/setup.mjs)
//   node scripts/setup.mjs --doctor      reports what is missing; changes nothing
// The API key file is checked for existence only, never read.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINTER = join(ROOT, "arkui-sem");
const PROJECT = join(ROOT, "sandbox/demo");
const BENCH_SETUP = join(ROOT, "bench/setup.mjs");
const args = process.argv.slice(2);
const doctor = args.includes("--doctor");
const di = args.indexOf("--datasets");
const benchArgs = di >= 0 ? ["--datasets", args[di + 1]] : [];

const CMD_SHIMS = new Set(["npm", "opencode"]); // need a shell on Windows
// A shell takes one command string; the shimmed commands only get fixed, quote-free arguments.
const spawn = (cmd, a, opts) => process.platform === "win32" && CMD_SHIMS.has(cmd)
  ? spawnSync([cmd, ...a].join(" "), { cwd: ROOT, shell: true, ...opts })
  : spawnSync(cmd, a, { cwd: ROOT, ...opts });
const out = (cmd, a) => { const r = spawn(cmd, a, { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
const step = (label, cmd, a, cwd = ROOT) => {
  console.log(`\n> ${label}`);
  if (spawn(cmd, a, { cwd, stdio: "inherit" }).status !== 0) { console.error(`failed: ${label}`); process.exit(1); }
};
const newest = (dir) => readdirSync(dir, { recursive: true }).reduce((m, f) => Math.max(m, statSync(join(dir, f)).mtimeMs), 0);

function report() {
  const keyFile = process.env.ARKUI_SEM_CONFIG ?? join(homedir(), ".config/arkui-sem/config.json");
  const rows = [
    ["node", true, process.version],
    ["opencode on PATH (agent sessions, verify-backend)", out("opencode", ["--version"]) !== null, ""],
    ["arkui-sem/node_modules", existsSync(join(LINTER, "node_modules")), "npm install in arkui-sem/"],
    ["arkui-sem/dist up to date", existsSync(join(LINTER, "dist/cli.js")) && newest(join(LINTER, "dist")) >= newest(join(LINTER, "src")), "npm run build in arkui-sem/"],
    ["plugin in sandbox/demo", existsSync(join(PROJECT, ".opencode/plugins/arkui-sem.ts")), "node arkui-sem/scripts/install.mjs sandbox/demo"],
    ["API key file exists (live runs only; not read)", existsSync(keyFile), "node arkui-sem/dist/cli.js config --init, then fill it in yourself"],
  ];
  let missing = 0;
  for (const [what, ok, hint] of rows) {
    if (!ok && !what.includes("(live runs only")) missing++;
    console.log(`${ok ? "ok     " : "MISSING"} ${what}${hint && (!ok || what === "node") ? `  (${hint})` : ""}`);
  }
  if (!existsSync(BENCH_SETUP)) {
    console.log("skip    private bench not checked out (team members: git submodule update --init bench)");
    return missing;
  }
  return missing + (spawn(process.execPath, [BENCH_SETUP, "--doctor", ...benchArgs], { stdio: "inherit" }).status === 0 ? 0 : 1);
}

if (doctor) process.exit(report() ? 1 : 0);

if (!existsSync(join(LINTER, "node_modules"))) step("npm ci (arkui-sem)", "npm", ["ci"], LINTER);
step("build arkui-sem", "npm", ["run", "build"], LINTER);
step("install plugin + skill into sandbox/demo", process.execPath, [join(LINTER, "scripts/install.mjs"), PROJECT]);
if (existsSync(BENCH_SETUP)) step("bench datasets", process.execPath, [BENCH_SETUP, ...benchArgs]);

console.log("\n--- doctor");
report();
