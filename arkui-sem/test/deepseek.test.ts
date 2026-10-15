// DeepSeekBackend against a mock DeepSeek API: request shape, json_object fallback, System One answer shapes.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { choice, type Question, score } from '@typesafe-ai/sdk';
import { DeepSeekBackend, Q_R1 } from '../src/judge.js';
import { jsonServer } from './helpers.js';

/** Fills every property of the schema the backend sent: first label 0.7, the rest share 0.3. */
function structuredArgs(body: any) {
  const props =
    body.tools?.[0]?.function.parameters.properties ??
    JSON.parse(body.messages[0].content.match(/example: (\{.*\})$/s)[1]);
  return Object.fromEntries(
    Object.entries(props).map(([id, v]: [string, any]) => {
      const labels: string[] = v.required ?? Object.keys(v);
      return [id, Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 0.7 : 0.3 / (labels.length - 1)]))];
    }),
  );
}

let strictFails = 0;
const usage = { prompt_tokens: 100, completion_tokens: 40 };
const { url, requests } = await jsonServer(({ url, body }) => {
  if (url !== '/beta/chat/completions') {
    return [
      200,
      { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(structuredArgs(body)) } }], usage },
    ];
  }
  if (strictFails > 0) {
    strictFails--;
    return [500, { error: 'beta unavailable' }];
  }
  const call = { function: { name: 'submit_answers', arguments: JSON.stringify(structuredArgs(body)) } };
  return [200, { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [call] } }], usage }];
});
process.env.DEEPSEEK_BASE_URL = url;
process.env.DEEPSEEK_API_KEY = 'test-key';

beforeEach(() => {
  requests.length = 0;
  strictFails = 0;
});

const state = { rule: 'R1', candidate: { field: 'items' } };
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

function assertSystemOneShapes(questions: Record<string, Question>, answers: Record<string, any>) {
  assert.deepEqual(Object.keys(answers).sort(), Object.keys(questions).sort());
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    assert.equal(a.type, q.type, `${id}: type`);
    if (q.type === 'noul') {
      assert.deepEqual(Object.keys(a).sort(), ['noul', 'type']);
      assert.ok(a.noul >= 0 && a.noul <= 1);
      continue;
    }
    const labels = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    const probabilities = Object.values(a.probabilities) as number[];
    assert.deepEqual(Object.keys(a.probabilities), labels, `${id}: a probability for every allowed answer`);
    assert.ok(
      close(
        probabilities.reduce((s, v) => s + v, 0),
        1,
      ),
      `${id}: probabilities sum to 1`,
    );
    if (q.type === 'choice') {
      assert.deepEqual(Object.keys(a).sort(), ['choice', 'confidence', 'probabilities', 'type']);
      assert.ok(labels.includes(a.choice));
      assert.ok(close(a.confidence, Math.max(...probabilities)));
    } else {
      assert.deepEqual(Object.keys(a).sort(), ['confidence', 'legend', 'probabilities', 'score', 'type']);
      assert.deepEqual(Object.keys(a.legend), labels);
      const weighted = labels.reduce((s, l) => s + Number(l) * a.probabilities[l], 0);
      assert.ok(close(a.score, weighted), `${id}: probability-weighted score`);
    }
  }
}

test('structured: one strict-schema call on the beta endpoint, System One answer shapes', async () => {
  const r = await new DeepSeekBackend().systemOne(state, Q_R1);
  assert.equal(requests.length, 1);
  const { url, body } = requests[0];
  assert.equal(url, '/beta/chat/completions');
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.tool_choice, 'required');
  const fn = body.tools[0].function;
  assert.equal(fn.strict, true);
  assert.equal(fn.parameters.additionalProperties, false);
  assert.deepEqual(fn.parameters.required, Object.keys(Q_R1));
  assert.deepEqual(fn.parameters.properties.severity.required, ['0', '1', '2', '3']);
  assertSystemOneShapes(Q_R1, r.answers);
  assert.equal(r.answers.verdict.choice, 'desync_bug');
  assert.ok(close(r.answers.is_ui_state.noul, 0.7));
  assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 40 });
});

test('structured: falls back to json_object mode when the strict endpoint fails', async () => {
  strictFails = 2;
  const r = await new DeepSeekBackend().systemOne(state, Q_R1);
  assert.deepEqual(
    requests.map((q) => q.url),
    ['/beta/chat/completions', '/beta/chat/completions', '/chat/completions'],
  );
  assert.deepEqual(requests[2].body.response_format, { type: 'json_object' });
  assert.match(requests[2].body.messages[0].content, /json/);
  assertSystemOneShapes(Q_R1, r.answers);
});

test('request constraints match System One (2–255 choices, 2–10 score levels)', async () => {
  const b = new DeepSeekBackend();
  const levels = Array.from({ length: 11 }, (_, i) => `l${i}`);
  await assert.rejects(() => b.systemOne(state, {}), /non-empty/);
  await assert.rejects(() => b.systemOne(state, { c: choice('x', { only: null }) }), /2–255/);
  await assert.rejects(() => b.systemOne(state, { s: score('x', levels) }), /2–10/);
  assert.equal(requests.length, 0, 'invalid requests never reach the API');
});

test('every request uses deepseek-flash', async () => {
  await new DeepSeekBackend().systemOne(state, Q_R1);
  strictFails = 2;
  await new DeepSeekBackend().systemOne(state, Q_R1);
  assert.ok(requests.length > 1);
  assert.ok(requests.every((q) => q.body.model === 'deepseek-flash'));
});
