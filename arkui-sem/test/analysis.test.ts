// NaiveExtractor facts on inline ArkTS sources.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extract } from './helpers.js';

test('a regex literal with an unmatched paren does not hide later members', () => {
  const facts = extract(`@Component
struct P {
  trim(s: string) {
    return s.replace(/\\)+$/, '')
  }
  @State count: number = 0
  build() {
    Text(\`\${this.count}\`)
  }
}`);
  assert.deepEqual(
    facts.components[0].fields.map((f) => f.name),
    ['count'],
  );
});

test('a method body opening on its own line keeps its writes', () => {
  const facts = extract(`@ComponentV2
struct P {
  @Local n: number = 0
  build() {
    Text(\`\${this.n}\`)
  }
  change()
  {
    this.n = 1
  }
}`);
  assert.equal(facts.components[0].fields[0].writes.length, 1);
});

test('a member on the class closing line is recorded', () => {
  const facts = extract("@ObservedV2\nclass P {\n  name: string = ''\n  @Trace age: number = 0 }");
  assert.deepEqual(facts.classMembers.P.age?.decorators, ['@Trace']);
});

test('an abstract @ObservedV2 class is observed', () => {
  const facts = extract("@ObservedV2\nexport default abstract class Base {\n  @Trace name: string = ''\n}");
  assert.deepEqual(facts.observedV2Classes, ['Base']);
});

test('logical and other compound assignments count as writes', () => {
  const facts = extract(`@ComponentV2
struct P {
  @Local n?: number
  @Local m?: Map<string, number>
  init() {
    this.n ??= 0
    this.m ||= new Map()
  }
  build() {
    Text(\`\${this.n}\`)
  }
}`);
  assert.deepEqual(
    facts.components[0].fields.map((f) => f.writes.length),
    [1, 1],
  );
});

test('a / after a non-null assertion is a division, not a regex', () => {
  const facts = extract(`@ComponentV2
struct P {
  @Local size?: number = 4
  half() {
    return Math.round(this.size! / 2)
  }
  build() {
    Text(\`\${this.size}\`)
  }
}`);
  assert.equal(facts.components[0].fields[0].readsInBuild.length, 1);
});

test('a / starting a continuation line is a division', () => {
  const facts = extract(`@ComponentV2
struct P {
  @Local n: number = 4
  calc() {
    const h = this.n
      / 2; this.n = h
  }
  build() {
    Text(\`\${this.n}\`)
  }
}`);
  assert.equal(facts.components[0].fields[0].writes.length, 1);
});

const fieldsOf = (method: string) =>
  extract(`@ComponentV2
struct P {
  @Local n: number = 0
${method}
  @Local m: number = 0
  build() {
    Text(\`\${this.n}\${this.m}\`)
  }
}`).components[0].fields.map((f) => [f.name, f.writes.length]);

test('a regex after `return !` is blanked', () => {
  assert.deepEqual(fieldsOf('  open(s: string) {\n    return !/[{]/.test(s)\n  }'), [
    ['n', 0],
    ['m', 0],
  ]);
});

test('a / after postfix ++ divides', () => {
  assert.deepEqual(fieldsOf('  half() {\n    if (this.n++ / 2 > 1) {\n      this.n = 0\n    }\n  }'), [
    ['n', 2],
    ['m', 0],
  ]);
});

test('a / after a long blanked comment is a division', () => {
  const facts = extract(`@ComponentV2
struct P {
  @Local n: number = 4
  calc() {
    const h = this.n
      // ${'a long comment line that runs well past the sixty-four character window'}
      / 2; this.n = h
  }
  build() {
    Text(\`\${this.n}\`)
  }
}`);
  assert.equal(facts.components[0].fields[0].writes.length, 1);
});

test('a member with an inline object type spelled with semicolons is recorded', () => {
  const facts = extract("class C {\n  user: { name: string; age: number } = { name: '', age: 0 }\n}");
  assert.equal(facts.classMembers.C.user?.type, '{ name: string; age: number }');
});

test('a constructor type ends at its own type arguments', () => {
  const facts = extract(`@ComponentV2
struct P {
  @Local box = new Box<A>(new Inner<B>())
  build() {
    Text(\`\${this.box}\`)
  }
}`);
  assert.equal(facts.components[0].fields[0].type, 'Box<A>');
});

test('a member after a method in a one-line class is recorded', () => {
  const facts = extract('@ObservedV2\nclass S { foo() {} @Trace bar: number = 0 }');
  assert.deepEqual(facts.classMembers.S.bar?.decorators, ['@Trace']);
});
