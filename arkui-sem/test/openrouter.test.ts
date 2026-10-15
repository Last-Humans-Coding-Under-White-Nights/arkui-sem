// OpenRouter Clef backends against a mock Decisions API.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBackend } from '../src/judge.js';
import { jsonServer } from './helpers.js';

let status = 200;
const server = await jsonServer(() =>
  status === 200
    ? [200, { answers: { q: { type: 'noul', noul: 0.9 } } }]
    : [status, { error: { message: 'bad key sk-or-secret' } }],
);
const creds = { openrouterApiKey: 'sk-or-secret', openrouterBaseUrl: `${server.url}/api/alpha` };
const questions: any = { q: { type: 'noul', instructions: 'x' } };

test('posts the questions to /decisions with the key and the Clef model', async () => {
  const r = await (await createBackend('or-clef-flash', creds)).systemOne('state', questions);
  assert.equal(r.backend, 'cloudflare/clef-flash');
  assert.equal(r.answers.q.noul, 0.9);
  const [seen] = server.requests;
  assert.equal(seen.url, '/api/alpha/decisions');
  assert.equal(seen.auth, 'Bearer sk-or-secret');
  assert.equal(seen.body.model, 'cloudflare/clef-flash');
  assert.deepEqual(seen.body.questions, questions);
});

test('an HTTP error is reported without the key', async () => {
  status = 401;
  const b = await createBackend('or-clef', creds);
  await assert.rejects(
    () => b.systemOne('state', questions),
    (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes('sk-or-secret'),
  );
});

test('a backend without a key fails', async () => {
  const b: any = await createBackend('or-clef-flash', creds);
  await assert.rejects(
    () => new b.constructor('cloudflare/clef', { apiKey: '' }).systemOne('s', questions),
    /not configured|HTTP|fetch/,
  );
});
