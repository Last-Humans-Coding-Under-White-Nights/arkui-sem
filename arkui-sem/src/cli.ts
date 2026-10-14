// The engine outside opencode: shell, pre-commit, CI.
import { absolute, etsFiles } from "./analysis.js";
import {
  cachePath,
  describeSettings,
  initUserConfig,
  loadSettings,
  projectConfigPath,
  userConfigPath,
} from "./config.js";
import { checkFiles, formatForAgent } from "./engine.js";
import { createBackend } from "./judge.js";

const USAGE = `usage:
  arkui-sem check <file.ets|dir>... [--format agent|json] [--backend <name>]
  arkui-sem config [--init]
`;

async function check(rest: string[]) {
  const settings = loadSettings();
  for (const w of settings.warnings) process.stderr.write(`arkui-sem config: ${w}\n`);
  let format = "agent";
  const paths: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg !== "--format" && arg !== "--backend") {
      paths.push(arg);
      continue;
    }
    const value = rest[++i];
    if (value === undefined) {
      process.stderr.write(`arkui-sem: ${arg} needs a value\n${USAGE}`);
      process.exit(2);
    }
    if (arg === "--format") format = value;
    else settings.backend = value;
  }

  const files = (paths.length ? paths : ["."]).flatMap((p) => etsFiles(absolute(p, process.cwd())));
  const { findings, errors } = await checkFiles(files, {
    backend: await createBackend(settings.backend, settings.credentials),
    thresholds: settings.thresholds,
    cachePath: cachePath(settings),
    judgeTimeoutMs: settings.judgeTimeoutMs,
  });

  if (format === "json")
    process.stdout.write(`${JSON.stringify({ files: files.length, findings, errors }, null, 2)}\n`);
  else process.stdout.write(`${formatForAgent(findings) || `arkui-sem: no findings in ${files.length} file(s).`}\n`);
  if (errors.length) process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(findings.some((f) => f.band === "finding") ? 1 : 0);
}

function config(rest: string[]) {
  if (rest.includes("--init")) {
    const { path, created } = initUserConfig();
    process.stdout.write(
      created
        ? `created ${path}\nEdit it: set cloudflare.accountId and cloudflare.apiToken (and backend). Keep API keys here, not in ${projectConfigPath("<project>")}.\n`
        : `${path} already exists; not overwritten.\n`,
    );
    return;
  }
  const s = loadSettings();
  process.stdout.write(
    `${JSON.stringify({ userConfig: userConfigPath(), projectConfig: projectConfigPath(process.cwd()), resolved: describeSettings(s) }, null, 2)}\n`,
  );
}

const [command, ...rest] = process.argv.slice(2);
if (command === "check") await check(rest);
else if (command === "config") config(rest);
else {
  process.stderr.write(USAGE);
  process.exit(2);
}
