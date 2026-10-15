// checkFiles and formatForAgent with a stub judge that calls everything a bug.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkFiles, formatForAgent } from '../src/engine.js';
import { put, tempDir } from './helpers.js';

const bug = {
  name: 'stub',
  systemOne: async () => ({
    backend: 'stub',
    latencyMs: 0,
    answers: { verdict: { type: 'choice', choice: 'desync_bug', confidence: 1, probabilities: { desync_bug: 1 } } },
  }),
} as any;

const file = put(
  join(tempDir(), 'P.ets'),
  `class Address {\n  city: string = ''\n}\nclass User {\n  address: Address = new Address()\n}
@Component
struct P {
  @State user: User = new User()
  build() {
    Column() {
      Text(this.user.address.city)
      Button('a').onClick(() => { this.user.address.city = 'a' })
      Button('b').onClick(() => { this.user.address.city = 'b'; this.user.address.city = 'c' })
    }
  }
}`,
);

test('a nested-write finding cites each write line once', async () => {
  const {
    findings: [finding],
  } = await checkFiles([file], { backend: bug });
  assert.match(finding.evidence, /line 13; also written in place at line 14\)/);
});

test('a nested-write question says where the disable comment goes', async () => {
  const { findings } = await checkFiles([file], { backend: bug, thresholds: { finding: 2, question: 0 } });
  assert.match(formatForAgent(findings), /above each write it lists, or above the field's decorators/);
});
