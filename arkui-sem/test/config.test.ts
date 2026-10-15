// Settings from the user config, the project config, environment variables and plugin options; the CLI on top.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { describeSettings, loadSettings } from '../src/config.js';
import { CLI, put, tempDir } from './helpers.js';

const VARS = [
  'ARKUI_SEM_BACKEND',
  'ARKUI_SEM_GATE',
  'ARKUI_SEM_FINDING_THRESHOLD',
  'ARKUI_SEM_QUESTION_THRESHOLD',
  'ARKUI_SEM_JUDGE_TIMEOUT_MS',
  'ARKUI_SEM_DATA_DIR',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'TYPESAFE_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
];
const tmp = tempDir();
const userFile = join(tmp, 'user', 'config.json');
const project = join(tmp, 'project');
const projectFile = join(project, '.opencode', 'arkui-sem.json');

describe('loadSettings', () => {
  beforeEach(() => {
    for (const v of VARS) {
      delete process.env[v];
    }
    process.env.ARKUI_SEM_CONFIG = userFile;
    put(userFile, {});
    put(projectFile, {});
  });

  test('defaults when no config files or variables are set', () => {
    const s = loadSettings({}, project);
    assert.equal(s.backend, 'clef');
    assert.equal(s.gate, true);
    assert.deepEqual(s.thresholds, { finding: 0.8, question: 0.5 });
    assert.equal(s.credentials.deepseekApiKey, undefined);
    assert.deepEqual(s.warnings, []);
  });

  test('the user config supplies the backend and the DeepSeek key', () => {
    put(userFile, { backend: 'deepseek-flash', deepseek: { apiKey: 'sk-user-1234567890' }, gate: false });
    const s = loadSettings({}, project);
    assert.equal(s.backend, 'deepseek-flash');
    assert.equal(s.credentials.deepseekApiKey, 'sk-user-1234567890');
    assert.equal(s.gate, false);
    assert.deepEqual(s.sources, [userFile, projectFile]);
  });

  test('the project config overrides the user config', () => {
    put(userFile, { backend: 'deepseek-flash', findingThreshold: 0.7 });
    put(projectFile, { backend: 'clef-flash', findingThreshold: 0.9 });
    const s = loadSettings({}, project);
    assert.equal(s.backend, 'clef-flash');
    assert.equal(s.thresholds.finding, 0.9);
  });

  test('environment variables override both files', () => {
    put(userFile, { backend: 'deepseek-flash', deepseek: { apiKey: 'sk-file-1234567890' } });
    process.env.ARKUI_SEM_BACKEND = 'heuristic';
    process.env.DEEPSEEK_API_KEY = 'sk-env-0987654321';
    const s = loadSettings({}, project);
    assert.equal(s.backend, 'heuristic');
    assert.equal(s.credentials.deepseekApiKey, 'sk-env-0987654321');
  });

  test('plugin options override everything', () => {
    process.env.ARKUI_SEM_BACKEND = 'heuristic';
    const s = loadSettings({ backend: 'jev', typesafe: { apiKey: 'ts-opt' } }, project);
    assert.equal(s.backend, 'jev');
    assert.equal(s.credentials.typesafeApiKey, 'ts-opt');
  });

  test('a secret in the project config works but warns', () => {
    put(projectFile, { deepseek: { apiKey: 'sk-proj-1234567890' } });
    const s = loadSettings({}, project);
    assert.equal(s.credentials.deepseekApiKey, 'sk-proj-1234567890');
    assert.ok(s.warnings.some((w) => w.includes('deepseek.apiKey') && w.includes('may be committed')));
  });

  test('bad JSON, unknown keys and wrong types are ignored with warnings', () => {
    put(userFile, '{ not json');
    put(projectFile, { backend: 3, colour: 'blue', deepseek: { apiKey: 'sk-x-1234567890', region: 'eu' } });
    const s = loadSettings({}, project);
    assert.equal(s.backend, 'clef');
    for (const warning of [
      'not valid JSON',
      '"backend" should be a string',
      'unknown key "colour"',
      'unknown key "deepseek.region"',
    ]) {
      assert.ok(
        s.warnings.some((w) => w.includes(warning)),
        warning,
      );
    }
    assert.equal(s.credentials.deepseekApiKey, 'sk-x-1234567890');
  });

  test('describeSettings masks secrets', () => {
    put(userFile, { deepseek: { apiKey: 'sk-abcdefghijklmnop' } });
    const shown = JSON.stringify(describeSettings(loadSettings({}, project)));
    assert.ok(!shown.includes('sk-abcdefghijklmnop'));
    assert.ok(shown.includes('sk-…mnop'));
  });
});

describe('CLI', () => {
  test('config --init writes a starter file once; config shows the masked token', () => {
    const fresh = join(tmp, 'fresh', 'config.json');
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [...CLI, ...args], {
        cwd: project,
        encoding: 'utf8',
        env: { ...process.env, ARKUI_SEM_CONFIG: fresh },
      });
    assert.match(run('config', '--init'), /created/);
    assert.match(run('config', '--init'), /already exists/);
    const out = JSON.parse(run('config'));
    assert.equal(out.resolved.backend, 'clef');
    assert.equal(out.resolved.credentials.cloudflareApiToken, 'REP…E_ME');
    assert.ok(out.resolved.sources.includes(fresh));
  });

  test('check rejects a flag without a value and an unknown format', () => {
    for (const args of [['--format'], ['--backend'], ['--format', 'xml']]) {
      assert.throws(
        () => execFileSync(process.execPath, [...CLI, 'check', ...args], { stdio: 'pipe' }),
        { status: 2 },
        args.join(' '),
      );
    }
  });
});
