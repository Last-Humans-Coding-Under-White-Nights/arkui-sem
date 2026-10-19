// The opencode plugin with a mock client and the heuristic backend. Tests run in order: later ones depend on what
// earlier ones reported.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArkuiSemPlugin } from '../src/opencode.js';
import { put, ROOT, tempDir } from './helpers.js';

const data = tempDir();
process.env.ARKUI_SEM_DATA_DIR = data;
process.env.ARKUI_SEM_BACKEND = 'heuristic';
process.env.ARKUI_SEM_CONFIG = join(data, 'no-user-config.json'); // ignore any real user config

const prompts: any[] = [];
const client = {
  app: { log: async () => {} },
  session: {
    promptAsync: async (opts: unknown) => {
      prompts.push(opts);
    },
  },
};
const hooks: any = await ArkuiSemPlugin({
  client,
  directory: ROOT,
  worktree: ROOT,
  project: {},
  serverUrl: new URL('http://localhost'),
  $: undefined,
  experimental_workspace: { register() {} },
} as any);

/** Runs the tool.execute.after hook and returns the tool output it leaves. */
const after = async (tool: string, args: object, sessionID = 's1') => {
  const output = { title: '', output: 'ok', metadata: {} };
  await hooks['tool.execute.after']({ tool, sessionID, callID: 'c', args }, output);
  return output.output;
};
const idle = (sessionID: string) => hooks.event({ event: { type: 'session.idle', properties: { sessionID } } });
const ctx = {
  sessionID: 's1',
  messageID: 'm',
  agent: 'build',
  directory: ROOT,
  worktree: ROOT,
  abort: new AbortController().signal,
  metadata() {},
  ask: async () => {},
};

test('edit on .ets appends new findings and questions to the tool output', async () => {
  const out = await after('edit', { filePath: 'test/fixtures/Feed.ets', oldString: 'a', newString: 'b' });
  assert.match(out, /^ok\n\narkui-sem: 1 finding\(s\), 1 question\(s\)/);
  assert.match(out, /Feed\.items/);
  assert.match(out, /\[R1\?\].*Feed\.lastFetchMs/);
});

test('re-editing the same file reports nothing already reported', async () => {
  assert.equal(await after('edit', { filePath: 'test/fixtures/Feed.ets' }), 'ok');
});

test('non-.ets edits and non-editing tools are ignored', async () => {
  assert.equal(await after('write', { filePath: 'README.md', content: 'x' }), 'ok');
  assert.equal(await after('read', { filePath: 'test/fixtures/Counter.ets' }), 'ok');
});

test('apply_patch: files are taken from the patch headers', async () => {
  const patchText = '*** Begin Patch\n*** Update File: test/fixtures/Ticker.ets\n@@\n-a\n+b\n*** End Patch';
  const out = await after('apply_patch', { patchText });
  assert.match(out, /Ticker emitter\.on:refresh/);
  assert.match(out, /Ticker timer:this\.pollId/);
});

test('session.idle sends one follow-up listing confident findings', async () => {
  await idle('s1');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].path.id, 's1');
  const text = prompts[0].body.parts[0].text;
  assert.match(text, /3 finding\(s\)/);
  assert.doesNotMatch(text, /lastFetchMs/, 'questions never go through the gate');
});

test('the gate does not repeat for the same set of findings', async () => {
  await idle('s1');
  assert.equal(prompts.length, 1);
});

test('idle sessions with no .ets edits are left alone', async () => {
  await idle('other');
  assert.equal(prompts.length, 1);
});

test('arkui_check tool scans a directory', async () => {
  const out = await hooks.tool.arkui_check.execute({ paths: ['test/fixtures'] }, ctx);
  assert.match(out, /5 finding\(s\), 1 question\(s\)/);
});

test('arkui_facts tool returns ownership facts', async () => {
  const facts = JSON.parse(await hooks.tool.arkui_facts.execute({ file: 'test/fixtures/Counter.ets' }, ctx));
  const counter = facts.components.find((c: any) => c.name === 'Counter');
  const count = counter.fields.find((f: any) => f.name === 'count');
  assert.deepEqual(count.decorators, []);
  assert.equal(count.writes[0].context, 'build-closure');
  assert.equal(facts.components.find((c: any) => c.name === 'GoodCounterV2').stateManagement, 'V2');
});

test('arkui_facts lists only classes declared in the file, by their source names', async () => {
  const dir = tempDir();
  put(join(dir, 'model.ets'), '@Observed\nexport class Info {\n  n: number = 0\n}');
  const page = put(join(dir, 'P.ets'), "import { Info } from './model'\n@Observed\nclass Local {\n  n: number = 0\n}");
  const facts = JSON.parse(await hooks.tool.arkui_facts.execute({ file: page }, ctx));
  assert.deepEqual(facts.observedClasses, ['Local']);
});
