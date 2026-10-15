// Headless client for ace-server: definition, references and call hierarchy over the standard (LSP 3.17) and legacy
// (`aceProject/*`) protocols, for cross-file facts the single-file extractor can't see.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpc } from './jsonrpc.js';
import { initializeParams, toFileUri } from './project.js';
import { type LspPathOptions, type LspPaths, type Protocol, resolvePaths, spawnServer, workDir } from './server.js';

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Location {
  file: string;
  range: Range;
}
/** A function or method: `range` spans its body, `selection` its name. */
export interface CallItem {
  name: string;
  container?: string;
  file: string;
  range: Range;
  selection: Range;
}
/** A function calling the queried one, with the call sites inside it. */
export interface Caller {
  item: CallItem;
  calls: Range[];
}

export interface ArktsLsp {
  readonly protocol: Protocol;
  readonly paths: LspPaths;
  /** Sends a file's current text (from disk unless given); needed before querying a file that changed. */
  open(file: string, text?: string): void;
  definition(file: string, at: Position): Promise<Location[]>;
  references(file: string, at: Position): Promise<Location[]>;
  /** Functions that call the function at `at` (one level); a call inside an arrow callback counts for its enclosing method. */
  callers(file: string, at: Position): Promise<Caller[]>;
  /** Functions the function at `at` calls (one level); without call sites, which ace-server reports wrong. */
  callees(file: string, at: Position): Promise<CallItem[]>;
  close(file: string): void;
  stop(): Promise<void>;
}

export interface StartOptions extends LspPathOptions {
  /** Initialization may index for long; it fails only after this long without any server message. */
  initTimeoutMs?: number;
  /** Per request; legacy servers: without any server message, at most five times this in all. */
  requestTimeoutMs?: number;
  maxOldSpaceMb?: number;
  /** Server stderr and notifications, for debugging. */
  log?: (line: string) => void;
}

const DEFAULTS = { initTimeoutMs: 120_000, requestTimeoutMs: 60_000, maxOldSpaceMb: 8192 };
const NO_TIMEOUT = 2 ** 31 - 1;
/** A legacy answer may take this many `requestTimeoutMs` in all while the server keeps sending other messages. */
const LEGACY_ANSWER_CAP = 5;

export async function startArktsLsp(projectRoot: string, options: StartOptions = {}): Promise<ArktsLsp> {
  const opts: Opts = {
    ...options,
    initTimeoutMs: options.initTimeoutMs ?? DEFAULTS.initTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    maxOldSpaceMb: options.maxOldSpaceMb ?? DEFAULTS.maxOldSpaceMb,
  };
  const paths = resolvePaths(options);
  // A build without `standardIndex` falls back to the legacy protocol; say which one runs.
  opts.log?.(`[start] ${paths.server.protocol} ${paths.server.entry} (node ${paths.node})`);
  const params = initializeParams(projectRoot, paths, workDir());
  const child = spawnServer(paths, opts.maxOldSpaceMb);
  child.stderr.setEncoding('utf8').on('data', (s: string) => opts.log?.(`[stderr] ${s.trimEnd()}`));
  const rpc = new JsonRpc(child);
  const log = opts.log;
  if (log) {
    rpc.on('notification', (method, p) => log(`[notification] ${method} ${JSON.stringify(p ?? null).slice(0, 300)}`));
  }
  const session =
    paths.server.protocol === 'standard' ? new StandardSession(rpc, paths, opts) : new LegacySession(rpc, paths, opts);
  try {
    await session.initialize(params);
  } catch (e) {
    await session.stop();
    throw e;
  }
  return session;
}

type Opts = typeof DEFAULTS & StartOptions;
interface TextDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}
/** LSP CallHierarchyItem, as both protocols send it. */
interface RawItem {
  name: string;
  containerName?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
}

/** LSP CallHierarchyIncomingCall. */
interface IncomingCall {
  from: RawItem;
  fromRanges: Range[];
}

/** LSP CallHierarchyOutgoingCall; its `fromRanges` are wrong in ace-server, so they're not read. */
interface OutgoingCall {
  to: RawItem;
}

interface InitializeResult {
  capabilities?: object;
}

/** The legacy server's answer: both directions; each entry's `info` nests the next level, which isn't read. */
interface LegacyHierarchy {
  incoming?: Array<LegacyEntry<IncomingCall>>;
  outgoing?: Array<LegacyEntry<OutgoingCall>>;
}

interface LegacyEntry<T> {
  item: T;
}

/** Fields of legacy notifications this client reads: answers carry `requestId`, module loading `isSuccess`. */
interface LegacyNotice {
  requestId?: unknown;
  result?: unknown;
  isSuccess?: boolean;
}

abstract class Session implements ArktsLsp {
  private readonly versions = new Map<string, number>();
  abstract readonly protocol: Protocol;

  constructor(
    protected readonly rpc: JsonRpc,
    readonly paths: LspPaths,
    protected readonly opts: Opts,
  ) {}

  abstract initialize(params: ReturnType<typeof initializeParams>): Promise<void>;
  protected abstract send(doc: TextDocument, first: boolean): void;
  abstract definition(file: string, at: Position): Promise<Location[]>;
  abstract references(file: string, at: Position): Promise<Location[]>;
  abstract callers(file: string, at: Position): Promise<Caller[]>;
  abstract callees(file: string, at: Position): Promise<CallItem[]>;

  open(file: string, text?: string): void {
    const content = text ?? readFileSync(resolve(file), 'utf8');
    const uri = toFileUri(file);
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.send(
      { uri, languageId: `deveco.apptool.${extname(file).slice(1) || 'ts'}`, version, text: content },
      version === 1,
    );
  }

  close(file: string): void {
    const uri = toFileUri(file);
    if (this.versions.delete(uri)) {
      this.rpc.notify('textDocument/didClose', { textDocument: { uri } });
    }
  }

  protected isOpen(file: string): boolean {
    return this.versions.has(toFileUri(file));
  }

  async stop(): Promise<void> {
    if (!this.rpc.alive) {
      return;
    }
    const exited = new Promise<void>((r) => this.rpc.once('exit', () => r()));
    try {
      await this.rpc.request('shutdown', undefined, 3000);
    } catch {
      /* ends with kill below */
    }
    this.rpc.notify('exit', undefined);
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([exited, new Promise((r) => (grace = setTimeout(r, 3000)))]);
    clearTimeout(grace);
    if (this.rpc.alive) {
      this.rpc.kill();
    }
  }

  /** Resolves with `done`; rejects once the server has sent nothing for `idleMs`, after `maxMs` in all, or on exit. */
  protected untilQuiet<T>(done: Promise<T>, idleMs: number, what: string, maxMs = NO_TIMEOUT): Promise<T> {
    const rpc = this.rpc;
    if (!rpc.alive) {
      return Promise.reject(new Error(`${what}: language server is not running`));
    }
    return new Promise((resolve, reject) => {
      let timer = setTimeout(fail, idleMs);
      const deadline = setTimeout(fail, maxMs);
      function fail() {
        cleanup();
        reject(new Error(`${what}: no answer in time`));
      }
      function bump() {
        clearTimeout(timer);
        timer = setTimeout(fail, idleMs);
      }
      function exited(code: number | null) {
        cleanup();
        reject(new Error(`${what}: language server exited (${code})`));
      }
      function cleanup() {
        clearTimeout(timer);
        clearTimeout(deadline);
        rpc.off('message', bump);
        rpc.off('exit', exited);
      }
      rpc.on('message', bump);
      rpc.on('exit', exited);
      done.then(
        (v) => {
          cleanup();
          resolve(v);
        },
        (e) => {
          cleanup();
          reject(e);
        },
      );
    });
  }
}

class StandardSession extends Session {
  readonly protocol = 'standard' as const;

  async initialize(params: ReturnType<typeof initializeParams>): Promise<void> {
    const response = this.rpc.request('initialize', params, NO_TIMEOUT);
    const { capabilities } = (await this.untilQuiet(
      response,
      this.opts.initTimeoutMs,
      'initialize',
    )) as InitializeResult;
    // Invalid initializationOptions get empty capabilities instead of an error.
    if (!capabilities || Object.keys(capabilities).length === 0) {
      throw new Error(`ace-server rejected the initialize params (see its log in ${workDir()})`);
    }
    this.rpc.notify('initialized', {});
  }

  protected send(doc: TextDocument, first: boolean): void {
    if (first) {
      this.rpc.notify('textDocument/didOpen', { textDocument: doc });
    } else {
      this.rpc.notify('textDocument/didChange', {
        textDocument: { uri: doc.uri, version: doc.version },
        contentChanges: [{ text: doc.text }],
      });
    }
  }

  async definition(file: string, at: Position): Promise<Location[]> {
    return locations(await this.request('textDocument/definition', position(file, at)));
  }

  async references(file: string, at: Position): Promise<Location[]> {
    return locations(
      await this.request('textDocument/references', { ...position(file, at), context: { includeDeclaration: true } }),
    );
  }

  async callers(file: string, at: Position): Promise<Caller[]> {
    const item = await this.prepare(file, at);
    const calls = item
      ? ((await this.request('callHierarchy/incomingCalls', { item })) as IncomingCall[] | null)
      : null;
    return (calls ?? []).map((c) => ({ item: callItem(c.from), calls: c.fromRanges }));
  }

  async callees(file: string, at: Position): Promise<CallItem[]> {
    const item = await this.prepare(file, at);
    const calls = item
      ? ((await this.request('callHierarchy/outgoingCalls', { item })) as OutgoingCall[] | null)
      : null;
    return (calls ?? []).map((c) => callItem(c.to));
  }

  private async prepare(file: string, at: Position): Promise<RawItem | undefined> {
    return ((await this.request('textDocument/prepareCallHierarchy', position(file, at))) as RawItem[] | null)?.[0];
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return this.rpc.request(method, params, this.opts.requestTimeoutMs);
  }
}

/**
 * Requests are notifications carrying a `requestId`; the answer is a notification of the same method echoing it.
 * Find-usages and callers see usages in open documents only: like the standard session, only queried and edited files
 * are opened, so usages in other files may be missing (opening more stalls the server on large projects).
 */
class LegacySession extends Session {
  readonly protocol = 'legacy' as const;
  private readonly waiting = new Map<string, (result: unknown) => void>();
  private modulesLoaded?: (ok: boolean) => void;

  constructor(rpc: JsonRpc, paths: LspPaths, opts: Opts) {
    super(rpc, paths, opts);
    rpc.on('notification', (method, params) => {
      const p = params as LegacyNotice | undefined;
      if (method === 'aceProject/onModuleInitFinish') {
        this.modulesLoaded?.(p?.isSuccess !== false);
      } else if (typeof p?.requestId === 'string') {
        this.waiting.get(p.requestId)?.(p.result);
      }
    });
  }

  async initialize(params: ReturnType<typeof initializeParams>): Promise<void> {
    const loaded = new Promise<boolean>((r) => {
      this.modulesLoaded = r;
    });
    this.rpc.request('initialize', params, NO_TIMEOUT).catch(() => undefined);
    if (!(await this.untilQuiet(loaded, this.opts.initTimeoutMs, 'initialize'))) {
      throw new Error(`ace-server could not load the project modules (see its log in ${workDir()})`);
    }
    this.rpc.notify('initialized', { editors: [] });
  }

  protected send(doc: TextDocument, first: boolean): void {
    const params = first
      ? { textDocument: doc }
      : { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text: doc.text }] };
    this.rpc.notify(first ? 'aceProject/onAsyncDidOpen' : 'aceProject/onAsyncDidChange', this.payload(params, doc.uri));
  }

  async definition(file: string, at: Position): Promise<Location[]> {
    return locations(await this.ask('aceProject/onAsyncDefinition', file, at));
  }

  async references(file: string, at: Position): Promise<Location[]> {
    this.ensureOpen(file);
    return locations(await this.ask('aceProject/onAsyncFindUsages', file, at));
  }

  async callers(file: string, at: Position): Promise<Caller[]> {
    const { incoming } = await this.hierarchy(file, at);
    return (incoming ?? []).map((c) => ({ item: callItem(c.item.from), calls: c.item.fromRanges }));
  }

  async callees(file: string, at: Position): Promise<CallItem[]> {
    const { outgoing } = await this.hierarchy(file, at);
    return (outgoing ?? []).map((c) => callItem(c.item.to));
  }

  private async hierarchy(file: string, at: Position): Promise<LegacyHierarchy> {
    this.ensureOpen(file);
    return ((await this.ask('aceProject/onAsyncCallHierarchy', file, at)) ?? {}) as LegacyHierarchy;
  }

  /** The server answers call hierarchy only for open documents; an open file stays open with its last text. */
  private ensureOpen(file: string): void {
    if (!this.isOpen(file)) {
      this.open(file);
    }
  }

  /** Server traffic (diagnostics of opened files) keeps a slow answer alive, up to a cap. */
  private ask(method: string, file: string, at: Position): Promise<unknown> {
    const payload = this.payload(position(file, at), toFileUri(file));
    const answer = new Promise<unknown>((r) => this.waiting.set(payload.requestId, r));
    this.rpc.notify(method, payload);
    const idle = this.opts.requestTimeoutMs;
    return this.untilQuiet(answer, idle, method, idle * LEGACY_ANSWER_CAP).finally(() =>
      this.waiting.delete(payload.requestId),
    );
  }

  /** `editorFiles` are file system paths: the server runs `URI.file()` on them. */
  private payload(params: unknown, uri: string) {
    return { requestId: randomUUID(), traceId: randomUUID(), params, editorFiles: [fileURLToPath(uri)] };
  }
}

function position(file: string, at: Position) {
  return { textDocument: { uri: toFileUri(file) }, position: at };
}

function toFile(uri: string): string {
  const file = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
  return file.replace(/^[a-z]:/, (d) => d.toUpperCase());
}

function callItem(raw: RawItem): CallItem {
  return {
    name: raw.name,
    container: raw.containerName,
    file: toFile(raw.uri),
    range: raw.range,
    selection: raw.selectionRange,
  };
}

/** LSP Location or LocationLink. */
interface RawLocation {
  uri?: unknown;
  targetUri?: unknown;
  range?: Range;
  targetSelectionRange?: Range;
  targetRange?: Range;
}

/** Location | Location[] | LocationLink[] (or null) → plain locations with file paths. */
export function locations(result: unknown): Location[] {
  const list: unknown[] = Array.isArray(result) ? result : result ? [result] : [];
  return list.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const l: RawLocation = entry;
    const uri = l.uri ?? l.targetUri;
    const range = l.range ?? l.targetSelectionRange ?? l.targetRange;
    return typeof uri === 'string' && range ? [{ file: toFile(uri), range }] : [];
  });
}
