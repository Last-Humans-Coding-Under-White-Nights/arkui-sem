// The `initialize` params ace-server requires: project root, server dir, and one record per ArkTS module.
// Modules are the directories holding src/main/ets, no hvigor sync needed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LspPaths } from './server.js';

const MODULE_SOURCES = join('src', 'main', 'ets');
const SCAN_DEPTH = 4;
const SKIP_DIRS = new Set(['node_modules', 'oh_modules', 'build']);
const DEVICE_PHONE = 5;

/** `file:///D%3A/...` on Windows: the form ace-server keys documents by for `clientType: "intellij"`. */
export function toFileUri(file: string): string {
  const uri = pathToFileURL(resolve(file)).href;
  const drive = /^file:\/\/\/([A-Za-z]):/.exec(uri);
  return drive ? `file:///${drive[1].toUpperCase()}%3A${uri.slice(drive[0].length)}` : uri;
}

export function findModuleDirs(projectRoot: string): string[] {
  const found: string[] = [];
  function walk(dir: string, depth: number) {
    if (existsSync(join(dir, MODULE_SOURCES))) {
      found.push(dir);
      return;
    }
    if (depth === SCAN_DEPTH) {
      return;
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        walk(join(dir, e.name), depth + 1);
      }
    }
  }
  walk(resolve(projectRoot), 0);
  return found;
}

/** Nearest ancestor with build-profile.json5, else the parent of the module holding the file. */
export function projectRootFor(file: string): string {
  let moduleDir: string | undefined;
  for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'build-profile.json5'))) {
      return dir;
    }
    if (!moduleDir && existsSync(join(dir, MODULE_SOURCES))) {
      moduleDir = dir;
    }
    if (dirname(dir) === dir) {
      return moduleDir ? dirname(moduleDir) : dirname(resolve(file));
    }
  }
}

function unix(p: string): string {
  return p.replace(/\\/g, '/');
}

interface SdkVersion {
  version: string;
  level: string;
}

/** `default/sdk-pkg.json` in a HarmonyOS SDK. */
interface SdkPkg {
  data?: SdkPkgData;
}

interface SdkPkgData {
  version?: unknown;
  apiVersion?: unknown;
}

/** API level and full version from the SDK's `default/sdk-pkg.json`. */
function sdkVersion(sdk: string): SdkVersion {
  const file = join(sdk, 'default', 'sdk-pkg.json');
  const pkg: SdkPkg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return { version: String(pkg.data?.version ?? ''), level: String(pkg.data?.apiVersion ?? '') };
}

export function initializeParams(projectRoot: string, paths: LspPaths, workDir: string) {
  const root = resolve(projectRoot);
  const { version, level } = sdkVersion(paths.sdk);
  const ets = join(paths.sdk, 'default', 'openharmony', 'ets');
  const modules = findModuleDirs(root).map((dir) => ({
    moduleName: basename(dir),
    modulePath: unix(dir),
    jsComponentType: 'declarative', // ArkTS UI module (server enum ComponentType)
    apiType: 'stageMode',
    deviceType: [DEVICE_PHONE],
    sdkJsPath: unix(join(ets, 'api')),
    aceLoaderPath: unix(join(ets, 'build-tools', 'ets-loader')),
    hosSdkPath: unix(join(paths.sdk, 'default', 'hms')),
    compileSdkVersion: version,
    compileSdkLevel: level,
    compatibleSdkVersion: version,
    compatibleSdkLevel: level,
  }));
  if (modules.length === 0) {
    throw new Error(`no ArkTS module (a dir with ${MODULE_SOURCES}) under ${root}`);
  }
  const rootUri = toFileUri(root);
  const indexDir = join(
    workDir,
    'index',
    createHash('sha1')
      .update(process.platform === 'win32' ? root.toLowerCase() : root)
      .digest('hex')
      .slice(0, 12),
  );
  mkdirSync(indexDir, { recursive: true });
  return {
    // Required in LSP InitializeParams.
    processId: process.pid,
    rootUri,
    capabilities: {},
    // The server refuses to start without rootUri, lspServerWorkspacePath and modules.
    initializationOptions: {
      rootUri,
      // Its bundled config (CSS, HML) resolves relative to this directory.
      lspServerWorkspacePath: unix(dirname(paths.server.entry)),
      modules,
      clientType: 'intellij',
      indexingDataLocation: unix(indexDir),
      // The legacy server replaces its completion defaults with this object and fails on undefined.
      completionSortSetting: { enableCodePreloadForCheckBox: false },
    },
  };
}
