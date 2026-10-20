// Shared test helpers: paths, rule candidates, temp dirs and a JSON mock server (cleaned up after the file's tests).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { candidates, NaiveExtractor } from '../src/analysis.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Node arguments that run the CLI from source, from any cwd. */
export const CLI = ['--import', import.meta.resolve('tsx'), join(ROOT, 'src', 'cli.ts')];

/** Facts of an ArkTS source, read as the file at path (relative imports resolve from there). */
export const extract = (src: string, path = 'T.ets') => new NaiveExtractor().extract(path, src);

/** Rule candidates in an inline ArkTS source (no judge). */
export const found = (src: string, path?: string) => candidates(extract(src, path));

/** A fresh temp dir, removed when the file's tests end. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arkui-sem-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Writes `text` (or JSON) to `path`, creating parent dirs; returns the path. */
export function put(path: string, value: string | object): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

export interface Received {
  url: string;
  auth?: string;
  body: any;
}

/**
 * A local HTTP server that records each JSON request and answers `[status, json]` from `reply`; closed after the
 * file's tests. Clear `requests` (`requests.length = 0`) between tests.
 */
export async function jsonServer(reply: (r: Received) => [number, unknown]) {
  const requests: Received[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
    }
    const received = { url: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw) };
    requests.push(received);
    const [status, json] = reply(received);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}
