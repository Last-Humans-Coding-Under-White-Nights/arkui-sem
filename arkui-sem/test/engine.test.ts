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

/** The V2 nested-write finding in a component with one @Local field and one write. */
async function v2Finding(types: string, field: string, write: string, render: string) {
  const path = put(
    join(tempDir(), 'R.ets'),
    `${types}\n@ComponentV2\nstruct R {\n  ${field}\n  build() {\n    Text(${render})\n  }\n  tap() {\n    ${write}\n  }\n}`,
  );
  const {
    findings: [finding],
  } = await checkFiles([path], { backend: bug });
  return finding;
}

test('a V2 nested-write fix names the class that owns the written property', async () => {
  const { fix } = await v2Finding(
    "class Address {\n  city: string = ''\n}\n@ObservedV2\nclass User {\n  @Trace address: Address = new Address()\n}",
    '@Local user: User = new User()',
    "this.user.address.city = 'a'",
    'this.user.address.city',
  );
  assert.match(fix, /^mark class Address @ObservedV2/);
});

test('a V2 nested-write fix names every owning class', async () => {
  const { fix } = await v2Finding(
    "class A {\n  x: string = ''\n}\nclass B {\n  y: string = ''\n}\nclass S {\n  a: A = new A()\n  b: B = new B()\n}",
    '@Local s: S = new S()',
    "this.s.a.x = 'q'; this.s.b.y = 'r'",
    'this.s.a.x + this.s.b.y',
  );
  assert.match(fix, /\bA\b.*\bB\b/);
});

test('a V2 nested-write fix on an interface asks for an @ObservedV2 class', async () => {
  const { fix } = await v2Finding(
    'interface User {\n  name: string\n}',
    "@Local user: User = { name: '' }",
    "this.user.name = 'y'",
    'this.user.name',
  );
  assert.match(fix, /make User an @ObservedV2 class/);
});

test('a V2 nested-write finding on an untraced property says @Trace is needed and asks for it', async () => {
  const { fix, evidence } = await v2Finding(
    "@ObservedV2\nclass User {\n  name: string = ''\n}",
    '@Local user: User = new User()',
    "this.user.name = 'y'",
    'this.user.name',
  );
  assert.match(evidence, /@Trace on an @ObservedV2 class/);
  assert.match(fix, /mark User\.name @Trace/);
});

test('a V2 nested-write fix on an object literal asks for an @ObservedV2 class', async () => {
  const { fix } = await v2Finding('', "@Local user = { name: '' }", "this.user.name = 'y'", 'this.user.name');
  assert.match(fix, /^reassign this\.user with a new object, or make it an @ObservedV2 class instance/);
});

test('a V2 fix for an untraced inherited property names the class that declares it', async () => {
  const { fix } = await v2Finding(
    "@ObservedV2\nclass Base {\n  name: string = ''\n}\n@ObservedV2\nclass Child extends Base {\n  @Trace age: number = 0\n}",
    '@Local c: Child = new Child()',
    "this.c.name = 'x'",
    'this.c.name',
  );
  assert.match(fix, /^mark Base\.name @Trace/);
});

test('a V2 fix asks for @ObservedV2 on a subclass that declares the property without it', async () => {
  const { fix } = await v2Finding(
    '@ObservedV2\nclass Base {\n}\nclass Child extends Base {\n  x: number = 0\n}',
    '@Local c: Child = new Child()',
    'this.c.x = 1',
    'this.c.x',
  );
  assert.match(fix, /^mark class Child @ObservedV2/);
});

test('a V1-decorated field in a @ComponentV2 struct gets the V1 nested-write fix', async () => {
  const { fix } = await v2Finding(
    "class B {\n  c: string = ''\n}\nclass A {\n  b: B = new B()\n}",
    '@State a: A = new A()',
    "this.a.b.c = 'x'",
    'this.a.b.c',
  );
  assert.match(fix, /^change it at the first layer/);
});

test('a V2 fix names one object-literal owner for writes through different indexes', async () => {
  const { fix } = await v2Finding(
    '',
    '@Local list: { done: boolean }[] = []',
    'this.list[0].done = true; this.list[1].done = false',
    'this.list[0].done',
  );
  assert.equal(fix.match(/@ObservedV2 class/g)?.length, 1);
  assert.match(fix, /reassign this\.list\[\] /);
});

test('a V2 fix for a nested array asks for a new inner array', async () => {
  const { fix } = await v2Finding('', '@Local grid: number[][] = []', 'this.grid[0][1] = 2', 'this.grid[0][1]');
  assert.match(fix, /assign a new inner array/);
});

test('an array in a Record gets the plain-object fix for the Record', async () => {
  const { fix } = await v2Finding(
    '',
    '@Local groups: Record<string, number[]> = {}',
    "this.groups['k'].push(1)",
    "this.groups['k']",
  );
  assert.match(fix, /^reassign this\.groups with a new object/);
});

test('nested-container evidence names nested containers, not @Trace', async () => {
  const { evidence } = await v2Finding('', '@Local grid: number[][] = []', 'this.grid[0][1] = 2', 'this.grid[0][1]');
  assert.match(evidence, /containers nested in containers/);
  assert.doesNotMatch(evidence, /@Trace/);
});

test('a type alias with nested generic parameters gets the object-type fix', async () => {
  const { fix } = await v2Finding(
    'type Box<T extends Map<string, number>> = {\n  a: number\n}',
    '@Local b: Box<Map<string, number>> = { a: 1 }',
    'this.b.a = 2',
    'this.b.a',
  );
  assert.match(fix, /^make Box an @ObservedV2 class/);
});
