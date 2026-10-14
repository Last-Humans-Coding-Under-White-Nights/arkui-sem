// The engine outside opencode: shell, pre-commit, CI.
import { absolute, etsFiles } from './analysis.js';
import {
  cachePath,
  describeSettings,
  initUserConfig,
  loadSettings,
  projectConfigPath,
  userConfigPath,
} from './config.js';
import { checkFiles, formatForAgent } from './engine.js';
import { createBackend } from './judge.js';
import { type ArktsLsp, startArktsLsp } from './lsp/client.js';
import { projectRootFor } from './lsp/project.js';

const USAGE = `usage:
  arkui-sem check <file.ets|dir>... [--format agent|json] [--backend <name>]
  arkui-sem config [--init]
  arkui-sem lsp <definition|references|callers|callees> <file.ets> <line:col> [--project <dir>] [--ace-server <dir>]
                [--sdk <dir>] [--node <path>] [--verbose]
`;
const FORMATS = new Set(['agent', 'json']);

function usageError(message: string): never {
  process.stderr.write(`arkui-sem: ${message}\n${USAGE}`);
  process.exit(2);
}

async function check(rest: string[]) {
  const settings = loadSettings();
  for (const w of settings.warnings) {
    process.stderr.write(`arkui-sem config: ${w}\n`);
  }
  let format = 'agent';
  const paths: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg !== '--format' && arg !== '--backend') {
      paths.push(arg);
      continue;
    }
    const value = rest[++i];
    if (value === undefined) {
      usageError(`${arg} needs a value`);
    }
    if (arg === '--format') {
      if (!FORMATS.has(value)) {
        usageError(`unknown format "${value}"`);
      }
      format = value;
    } else {
      settings.backend = value;
    }
  }

  const files = (paths.length ? paths : ['.']).flatMap((p) => etsFiles(absolute(p, process.cwd())));
  const { findings, errors } = await checkFiles(files, {
    backend: await createBackend(settings.backend, settings.credentials),
    thresholds: settings.thresholds,
    cachePath: cachePath(settings),
    judgeTimeoutMs: settings.judgeTimeoutMs,
  });

  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ files: files.length, findings, errors }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatForAgent(findings) || `arkui-sem: no findings in ${files.length} file(s).`}\n`);
  }
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`);
  }
  process.exit(findings.some((f) => f.band === 'finding') ? 1 : 0);
}

function config(rest: string[]) {
  if (rest.includes('--init')) {
    const { path, created } = initUserConfig();
    process.stdout.write(
      created
        ? `created ${path}\nEdit it: set cloudflare.accountId and cloudflare.apiToken (and backend). Keep API keys here, not in ${projectConfigPath('<project>')}.\n`
        : `${path} already exists; not overwritten.\n`,
    );
    return;
  }
  const s = loadSettings();
  process.stdout.write(
    `${JSON.stringify({ userConfig: userConfigPath(), projectConfig: projectConfigPath(process.cwd()), resolved: describeSettings(s) }, null, 2)}\n`,
  );
}

const LSP_ACTIONS = ['definition', 'references', 'callers', 'callees'] as const;
type LspAction = (typeof LSP_ACTIONS)[number];
const LSP_VALUE_FLAGS = ['--project', '--ace-server', '--sdk', '--node'];

function isLspAction(a: string | undefined): a is LspAction {
  return LSP_ACTIONS.some((action) => action === a);
}

// Asks ace-server (ArkTS language server); line:col are 1-based, output is JSON.
async function lsp(rest: string[]) {
  const args: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--verbose') {
      flags.set(arg, '');
      continue;
    }
    if (!LSP_VALUE_FLAGS.includes(arg)) {
      args.push(arg);
      continue;
    }
    const value = rest[++i];
    if (value === undefined) {
      process.stderr.write(`arkui-sem: ${arg} needs a value\n${USAGE}`);
      process.exit(2);
    }
    flags.set(arg, value);
  }
  const [action, file, at] = args;
  const position = /^(\d+):(\d+)$/.exec(at ?? '');
  if (!isLspAction(action) || !file || !position || Number(position[1]) < 1 || Number(position[2]) < 1) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const started = Date.now();
  let server: ArktsLsp | undefined;
  try {
    server = await startArktsLsp(flags.get('--project') ?? projectRootFor(file), {
      aceServer: flags.get('--ace-server'),
      sdk: flags.get('--sdk'),
      node: flags.get('--node'),
      log: flags.has('--verbose') ? (line) => process.stderr.write(`${line}\n`) : undefined,
    });
    const initMs = Date.now() - started;
    server.open(file);
    const result = await server[action](file, { line: Number(position[1]) - 1, character: Number(position[2]) - 1 });
    const output = {
      protocol: server.protocol,
      server: server.paths.server.entry,
      initMs,
      totalMs: Date.now() - started,
      result,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`arkui-sem lsp: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await server?.stop();
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'check') {
  await check(rest);
} else if (command === 'config') {
  config(rest);
} else if (command === 'lsp') {
  await lsp(rest);
} else {
  process.stderr.write(USAGE);
  process.exit(2);
}
