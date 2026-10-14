// JSON-RPC 2.0 over a child process's stdio with LSP Content-Length framing.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

const HEADER_END = '\r\n\r\n';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Any incoming message: a request has `method` and `id`, a notification only `method`, a response only `id`. */
interface Message {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: ResponseError;
}

interface ResponseError {
  message: string;
}

export interface JsonRpcEvents {
  notification: [method: string, params: unknown];
  message: [];
  exit: [code: number | null];
}

export class JsonRpc extends EventEmitter<JsonRpcEvents> {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    this.setMaxListeners(0); // every in-flight request watches for progress and exit
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // A write racing the server's exit fails with EPIPE; `exit` reports the end, so the write error is dropped.
    child.stdin.on('error', () => undefined);
    child.on('error', (e) => {
      if (!this.closed) {
        this.finish(new Error(`language server failed to start: ${e.message}`), null);
      }
    });
    child.on('exit', (code) => {
      if (!this.closed) {
        this.finish(new Error(`language server exited (${code})`), code);
      }
    });
  }

  private finish(error: Error, code: number | null): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit('exit', code);
  }

  get alive(): boolean {
    return !this.closed;
  }

  kill(): void {
    this.child.kill();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) {
        return reject(new Error('language server is not running'));
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) {
      this.write({ jsonrpc: '2.0', method, params });
    }
  }

  private write(message: object): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}${HEADER_END}`, 'ascii'), body]));
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd < 0) {
        return;
      }
      const length = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'))?.[1];
      const start = headerEnd + HEADER_END.length;
      if (length === undefined) {
        this.buffer = this.buffer.subarray(start);
        continue;
      }
      const end = start + Number(length);
      if (this.buffer.length < end) {
        return;
      }
      const body = this.buffer.subarray(start, end).toString('utf8');
      this.buffer = this.buffer.subarray(end);
      try {
        this.dispatch(JSON.parse(body));
      } catch {
        /* a malformed message must not stop the stream */
      }
    }
  }

  private dispatch(msg: Message): void {
    this.emit('message');
    if (msg.method !== undefined && msg.id !== undefined) {
      // Server requests (client/registerCapability, workspace/configuration, ...): this client offers nothing back.
      this.write({ jsonrpc: '2.0', id: msg.id, result: emptyAnswer(msg) });
      return;
    }
    if (msg.method !== undefined) {
      this.emit('notification', msg.method, msg.params);
      return;
    }
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (p && typeof msg.id === 'number') {
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(msg.error.message));
      } else {
        p.resolve(msg.result);
      }
    }
  }
}

interface ConfigurationParams {
  items?: unknown[];
}

/** `workspace/configuration` expects one entry per requested item; other requests take null. */
function emptyAnswer(msg: Message): unknown {
  if (msg.method !== 'workspace/configuration') {
    return null;
  }
  const items = (msg.params as ConfigurationParams | undefined)?.items;
  return Array.isArray(items) ? items.map(() => null) : [];
}
