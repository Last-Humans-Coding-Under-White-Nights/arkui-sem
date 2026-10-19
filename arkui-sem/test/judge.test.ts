// buildSlice: the facts a judge sees for a candidate.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidates } from '../src/analysis.js';
import { buildSlice } from '../src/judge.js';
import { extract } from './helpers.js';

const ITEM = "@Observed\nclass Item {\n  title: string = ''\n}";

/** The judge slice of the first candidate in an inline source. */
function slice(src: string) {
  const facts = extract(src);
  const [c] = candidates(facts);
  return buildSlice(facts, c).candidate as { [key: string]: unknown };
}

const nested = (field: string, child = '') => `${ITEM}
${child}
@Component
struct P {
  ${field}
  build() {
    Text(this.items[0].title)
  }
  tap() {
    this.items[0].title = 'a'
  }
}`;

test('the slice resolves Array<X> and X | undefined field types to the class X', () => {
  for (const field of ['@State items: Array<Item> = []', '@State items: Item[] | undefined = []']) {
    const s = slice(nested(field));
    assert.equal(s.type_is_observed_class, true, field);
    assert.equal(s.type_declared_in_file, true, field);
  }
});

test('the slice lists @ObjectLink types by class name', () => {
  const child = '@Component\nstruct V {\n  @ObjectLink item: Item | undefined\n  build() {}\n}';
  assert.deepEqual(slice(nested('@State items: Item[] = []', child)).object_link_types_in_file, ['Item']);
});

test('a V2 nested-write slice names the class that owns the write', () => {
  const s =
    slice(`class Address {\n  city: string = ''\n}\n@ObservedV2\nclass User {\n  @Trace address: Address = new Address()\n}
@ComponentV2
struct P {
  @Local user: User = new User()
  build() {
    Text(this.user.address.city)
  }
  tap() {
    this.user.address.city = 'a'
  }
}`);
  assert.deepEqual(s.v2_gaps, [{ kind: 'class', owner: 'Address', property: 'city' }]);
});

const v2 = (
  fields: string,
  writes: string,
) => `@ObservedV2\nclass User {\n  @Trace name: string = ''\n  age: number = 0\n}
@ComponentV2
struct P {
  ${fields}
  build() {
    Text(this.user.name + this.user.age)
  }
  tap() {
${writes}
  }
}`;

test('a nested-write slice shows the unobserved writes, not the observed ones', () => {
  const writes = "    this.user.name = 'a'\n    this.user.name = 'b'\n    this.user.name = 'c'\n    this.user.age = 1";
  const s = slice(v2('@Local user: User = new User()', writes));
  assert.deepEqual(
    (s.writes as { nested_path: string }[]).map((w) => w.nested_path),
    ['.age'],
  );
});

test('the slice reports no type for a field initialized with an object literal', () => {
  const s = slice(v2("@Local user = { name: '', age: 0 }", '    this.user.age = 1'));
  assert.equal(s.type, null);
});

test("a V2 nested-write slice leaves out facts about the field's own class", () => {
  const s = slice(`@ObservedV2\nclass User {\n  @Trace name: string = ''\n  age: number = 0\n}
@ComponentV2
struct P {
  @Local user: User = new User()
  build() {
    Text(\`\${this.user.age}\`)
  }
  tap() {
    this.user.age = 1
  }
}`);
  assert.ok(s.v2_gaps);
  assert.equal('type_is_observed_v2_class' in s, false);
  assert.equal('type_declared_in_file' in s, false);
});
