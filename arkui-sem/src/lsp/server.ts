// Finds ace-server (Huawei's ArkTS language server), the HarmonyOS SDK and node, and spawns the server.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

/** standard: LSP 3.17 (`out/standardIndex/index.js`, DevEco ≥ 26.0.0.610); legacy: private `aceProject/*` protocol. */
export type Protocol = 'standard' | 'legacy';

export interface ServerEntry {
  entry: string;
  protocol: Protocol;
}

export interface LspPaths {
  server: ServerEntry;
  /** HarmonyOS SDK root: the directory holding `default/openharmony` and `default/hms`. */
  sdk: string;
  node: string;
}

export interface LspPathOptions {
  /** ace-server root: a DevEco Studio install, its `plugins/openharmony`, an `ace-server` dir, or a dir holding `out/`. */
  aceServer?: string;
  sdk?: string;
  node?: string;
}

const STUDIO_CANDIDATES: Record<string, string[]> = {
  win32: ['C:\\Program Files\\Huawei\\DevEco Studio', 'C:\\Program Files (x86)\\Huawei\\DevEco Studio'],
  darwin: ['/Applications/DevEco-Studio.app/Contents', '/Applications/DevEco Studio.app/Contents'],
};

export function findStudio(env = process.env): string | undefined {
  const candidates = [env.DEVECO_STUDIO, ...(STUDIO_CANDIDATES[process.platform] ?? [])].filter(
    (p): p is string => !!p,
  );
  return candidates.find((p) => existsSync(join(p, 'plugins', 'openharmony', 'ace-server')));
}

/** The server entry under any accepted root; the standard one when the build ships it. */
export function locateServer(root: string): ServerEntry | undefined {
  for (const out of [
    join(root, 'plugins', 'openharmony', 'ace-server', 'out'),
    join(root, 'ace-server', 'out'),
    join(root, 'out'),
  ]) {
    const standard = join(out, 'standardIndex', 'index.js');
    if (existsSync(standard)) {
      return { entry: standard, protocol: 'standard' };
    }
    if (existsSync(join(out, 'index.js'))) {
      return { entry: join(out, 'index.js'), protocol: 'legacy' };
    }
  }
  return undefined;
}

/** The server comes from `aceServer`, else `ARKUI_SEM_ACE_SERVER`, else DevEco Studio's own install. */
export function resolvePaths(options: LspPathOptions = {}, env = process.env): LspPaths {
  const studio = findStudio(env);
  const root = options.aceServer || env.ARKUI_SEM_ACE_SERVER || studio;
  if (!root) {
    throw new Error('ace-server not found: install DevEco Studio or set ARKUI_SEM_ACE_SERVER');
  }
  const server = locateServer(root);
  if (!server) {
    throw new Error(`no ace-server entry under ${root}`);
  }
  const sdk = options.sdk || env.ARKUI_SEM_SDK || (studio && join(studio, 'sdk'));
  if (!sdk || !existsSync(join(sdk, 'default', 'openharmony'))) {
    throw new Error('HarmonyOS SDK not found: set ARKUI_SEM_SDK to the directory holding default/openharmony');
  }
  return { server, sdk, node: options.node || env.ARKUI_SEM_LSP_NODE || defaultNode(studio) };
}

/** Inside opencode `process.execPath` is its Bun-built binary, not node: use DevEco's node, else node from PATH. */
export function defaultNode(studio: string | undefined, isBun = !!process.versions.bun): string {
  if (!isBun) {
    return process.execPath;
  }
  const bundled = studio && join(studio, 'tools', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  return bundled && existsSync(bundled) ? bundled : 'node';
}

/** Shared by all runs: the server's logs and its per-project index cache. */
export function workDir(): string {
  // Per user: on a shared POSIX host another user's directory isn't writable.
  const dir = join(tmpdir(), `arkui-sem-lsp-${userInfo().username}`);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

/** The server reads its log path from argv and calls `gc()`, which needs `--expose-gc`. */
export function spawnServer(paths: LspPaths, maxOldSpaceMb: number): ChildProcessWithoutNullStreams {
  const logs = join(workDir(), 'logs');
  const args = [
    '--expose-gc',
    `--max-old-space-size=${maxOldSpaceMb}`,
    paths.server.entry,
    '--stdio',
    `--logger-path=${logs}`,
    '--logger-level=INFO',
  ];
  return spawn(paths.node, args, {
    cwd: dirname(paths.server.entry),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}
