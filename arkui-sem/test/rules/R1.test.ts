// R1 nested write (unobserved deep mutation) on inline ArkTS sources.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { nestedDepth } from '../../src/analysis.js';
import { found } from '../helpers.js';

const nestedHits = (src: string) =>
  found(src)
    .filter((c) => c.kind === 'nested-write-unobserved')
    .map((c) => c.field.name);

/** A V1 component with one field, one rendered expression and one write in a click handler. */
const v1 = (classes: string, field: string, write: string, render: string) => `${classes}
@Component
struct P {
  ${field}
  build() {
    Column() {
      Text(${render})
      Button('x').onClick(() => {
        ${write}
      })
    }
  }
}`;

const USER =
  "class Address {\n  city: string = ''\n}\nclass User {\n  name: string = ''\n  address: Address = new Address()\n  tags: string[] = []\n}";
const USER_OBSERVED =
  "@Observed\nclass Address {\n  city: string = ''\n}\n@Observed\nclass User {\n  name: string = ''\n  address: Address = new Address()\n}";
const USER_FIELD = '@State user: User = new User()';
const CITY = "this.user.address.city = 'a'";

test('nestedDepth counts levels below the field', () => {
  assert.equal(nestedDepth(undefined), 0);
  assert.equal(nestedDepth('.title'), 1);
  assert.equal(nestedDepth('[]'), 1);
  assert.equal(nestedDepth('.address.city'), 2);
  assert.equal(nestedDepth('[i].title'), 2);
  assert.equal(nestedDepth('.tags[]'), 2);
});

// ArkUI docs: V1 observes first-layer changes only; "@Observed alone has no effect in nested classes".
describe('V1', () => {
  test('a first-layer property write on @State is observed (no finding, @Observed or not)', () => {
    assert.deepEqual(nestedHits(v1(USER, USER_FIELD, "this.user.name = 'a'", 'this.user.name')), []);
  });

  test('a two-level write is flagged when the classes are not @Observed', () => {
    assert.deepEqual(nestedHits(v1(USER, USER_FIELD, CITY, 'this.user.address.city')), ['user']);
  });

  test('a two-level write is still flagged when the classes ARE @Observed (the run-4 fix)', () => {
    assert.deepEqual(nestedHits(v1(USER_OBSERVED, USER_FIELD, CITY, 'this.user.address.city')), ['user']);
  });

  test('reassigning at the first layer is not flagged', () => {
    assert.deepEqual(
      nestedHits(v1(USER, USER_FIELD, 'this.user.address = new Address()', 'this.user.address.city')),
      [],
    );
  });

  test("array push is observed; writing an item's property is not", () => {
    const items = "class Item {\n  title: string = ''\n}";
    const field = '@State items: Item[] = []';
    assert.deepEqual(nestedHits(v1(items, field, 'this.items.push(new Item())', 'this.items.length')), []);
    assert.deepEqual(nestedHits(v1(items, field, "this.items[0].title = 'a'", 'this.items[0].title')), ['items']);
  });

  test('mutating an array inside an object is two levels deep', () => {
    assert.deepEqual(nestedHits(v1(USER, USER_FIELD, "this.user.tags.push('a')", 'this.user.tags.length')), ['user']);
  });
});

test('V2: a property write needs @ObservedV2 on the class', () => {
  const src = (decorator: string) => `${decorator}class Settings {\n  dark: boolean = false\n}
@ComponentV2
struct S {
  @Local settings: Settings = new Settings()
  build() {
    Button(\`\${this.settings.dark}\`).onClick(() => {
      this.settings.dark = true
    })
  }
}`;
  assert.deepEqual(nestedHits(src('')), ['settings']);
  assert.deepEqual(nestedHits(src('@ObservedV2\n')), []);
});

// ArkUI docs (@Observed/@ObjectLink): a property change on an @Observed object updates every @ObjectLink bound to it.
describe('V1: a deep write is seen by a same-file @ObjectLink child of the owning @Observed class', () => {
  const linked = (classes: string, child: string, field: string, body: string, write: string) => `${classes}
@Component
struct V {
  ${child}
  build() {}
}
@Component
struct P {
  ${field}
  build() {
    Column() {
      ${body}
      Button('x').onClick(() => {
        ${write}
      })
    }
  }
}`;
  const OTHER = '@Observed\nclass Other {\n  x: number = 0\n}';
  const ITEM = '@Observed\nclass Item {\n  done: boolean = false\n}';
  const TAGS =
    '@Observed\nclass ObservedArray<T> extends Array<T> {}\n@Observed\nclass User {\n  tags: ObservedArray<string> = new ObservedArray<string>()\n  plain: string[] = []\n}';
  const TO_ADDRESS = 'V({ address: this.user.address })';
  const FOR_EACH_ITEM = 'ForEach(this.items, (item: Item) => { V({ item: item }) })';
  const ITEM_DONE = 'this.items[0].done = true';

  // [name, expected hits, classes, child field, parent field, parent body, write]
  const cases: [string, string[], string, string, string, string, string][] = [
    ['linked', [], USER_OBSERVED, '@ObjectLink address: Address', USER_FIELD, TO_ADDRESS, CITY],
    ['class not @Observed', ['user'], USER, '@ObjectLink address: Address', USER_FIELD, TO_ADDRESS, CITY],
    [
      'child links another class',
      ['user'],
      `${USER_OBSERVED}\n${OTHER}`,
      '@ObjectLink other: Other',
      USER_FIELD,
      'V({ other: new Other() })\n      Text(this.user.name)',
      CITY,
    ],
    [
      'parent renders the path',
      ['user'],
      USER_OBSERVED,
      '@ObjectLink address: Address',
      USER_FIELD,
      `${TO_ADDRESS}\n      Text(this.user.address.city)`,
      CITY,
    ],
    [
      'undeclared property',
      ['user'],
      USER_OBSERVED,
      '@ObjectLink address: Address',
      USER_FIELD,
      TO_ADDRESS,
      "this.user.constructor.name = 'a'",
    ],
    ['array item', [], ITEM, '@ObjectLink item: Item', '@State items: Array<Item> = []', FOR_EACH_ITEM, ITEM_DONE],
    [
      'item of an @Observed Array subclass',
      [],
      `${ITEM}\n@Observed\nclass ItemList extends Array<Item> {\n}`,
      '@ObjectLink item: Item',
      '@State items: ItemList = new ItemList()',
      FOR_EACH_ITEM,
      ITEM_DONE,
    ],
    [
      'item of a generic @Observed Array subclass',
      [],
      `${ITEM}\n${TAGS}`,
      '@ObjectLink item: Item',
      '@State items: ObservedArray<Item> = new ObservedArray<Item>()',
      FOR_EACH_ITEM,
      ITEM_DONE,
    ],
    [
      'parent renders an item through ?.[',
      ['items'],
      ITEM,
      '@ObjectLink item: Item',
      '@State items: Array<Item> = []',
      `${FOR_EACH_ITEM}\n      Text(this.items?.[0].done ? 'y' : 'n')`,
      ITEM_DONE,
    ],
    [
      'parent renders array contents through ?.[',
      ['user'],
      TAGS,
      '@ObjectLink tags: ObservedArray<string>',
      USER_FIELD,
      'V({ tags: this.user.tags })\n      Text(this.user.tags?.[0])',
      "this.user.tags.push('a')",
    ],
    [
      '@Observed array passed to the child',
      [],
      TAGS,
      '@ObjectLink tags: ObservedArray<string>',
      USER_FIELD,
      'V({ tags: this.user.tags })',
      "this.user.tags.push('a')",
    ],
    [
      'plain array in a linked object',
      ['user'],
      TAGS,
      '@ObjectLink user: User',
      USER_FIELD,
      'V({ user: this.user })',
      "this.user.plain.push('a')",
    ],
  ];
  for (const [name, hits, ...parts] of cases) {
    test(name, () => assert.deepEqual(nestedHits(linked(...parts)), hits));
  }
});

describe('disable comments', () => {
  const DISABLE = '// arkui-sem-disable-next-line R1 -- intended';
  const deep = (field: string, write = CITY) => v1(USER, field, write, 'this.user.address.city');

  test('above the decorators, the field name or the write', () => {
    assert.deepEqual(nestedHits(deep(`${DISABLE}\n  @State\n  user: User = new User()`)), []);
    assert.deepEqual(nestedHits(deep(`${DISABLE}\n  ${USER_FIELD}`)), []);
    assert.deepEqual(nestedHits(deep(USER_FIELD, `${DISABLE}\n        ${CITY}`)), []);
  });

  test('a comment above one write leaves the finding on the next write', () => {
    const src = deep(USER_FIELD, `${DISABLE}\n        ${CITY}\n        this.user.address.city = 'b'`);
    const [c] = found(src).filter((x) => x.kind === 'nested-write-unobserved');
    assert.equal(c.line, src.split('\n').findIndex((l) => l.includes("'b'")) + 1);
  });
});
