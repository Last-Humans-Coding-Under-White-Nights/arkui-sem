// R1 nested write (unobserved deep mutation) on inline ArkTS sources.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { nestedDepth } from '../../src/analysis.js';
import { found, put, tempDir } from '../helpers.js';

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
  const src = (decorator: string) => `${decorator}class Settings {\n  @Trace dark: boolean = false\n}
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

// ArkUI docs (@ObservedV2/@Trace, @Local): V2 observes array index writes and API calls, and @Trace properties of @ObservedV2 classes.
describe('V2', () => {
  const v2 = (classes: string, fields: string, write: string, render: string) => `${classes}
@ComponentV2
struct P {
  ${fields}
  build() {
    Text(${render})
  }
  tap() {
    ${write}
  }
}`;
  const PLAIN = "class User {\n  name: string = ''\n  tags: string[] = []\n}";
  const OBSERVED = "@ObservedV2\nclass User {\n  @Trace name: string = ''\n}";
  const ITEM = "class Item {\n  title: string = ''\n}";
  const TRACED_TAGS = '@ObservedV2\nclass User {\n  @Trace tags: string[] = []\n}';

  // [name, expected hits, classes, fields, write, render]
  const cases: [string, string[], string, string, string, string][] = [
    ['array index write', [], '', '@Local items: string[] = []', "this.items[0] = 'x'", 'this.items[0]'],
    ['array call', [], '', '@Local items: string[] = []', "this.items.push('x')", 'this.items[0]'],
    ['inferred @ObservedV2 type', [], OBSERVED, '@Local user = new User()', "this.user.name = 'y'", 'this.user.name'],
    ['inferred plain type', ['user'], PLAIN, '@Local user = new User()', "this.user.name = 'y'", 'this.user.name'],
    [
      'array index and @ObservedV2 writes together',
      [],
      OBSERVED,
      '@Local items: string[] = []\n  @Local user = new User()',
      "this.items[0] = 'x'; this.user.name = 'y'",
      'this.items[0] + this.user.name',
    ],
    [
      'index write on an array in a plain class',
      ['user'],
      PLAIN,
      '@Local user: User = new User()',
      "this.user.tags[0] = 'a'",
      'this.user.tags[0]',
    ],
    [
      'index write on a @Trace array',
      [],
      TRACED_TAGS,
      '@Local user: User = new User()',
      "this.user.tags[0] = 'a'",
      'this.user.tags[0]',
    ],
    [
      'interface',
      ['user'],
      'interface User {\n  name: string\n}',
      "@Local user: User = { name: '' }",
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'object type alias',
      ['user'],
      'type User = {\n  name: string\n}',
      "@Local user: User = { name: '' }",
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'property of an interface field',
      ['user'],
      'interface Address {\n  city: string\n}\ninterface User {\n  address: Address\n}',
      "@Local user: User = { address: { city: '' } }",
      "this.user.address.city = 'y'",
      'this.user.address.city',
    ],
    [
      'inherited @Trace property',
      [],
      "@ObservedV2\nclass Base {\n  @Trace name: string = ''\n}\nclass Sub extends Base {\n}",
      '@Local user: Sub = new Sub()',
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'property of an inherited field',
      ['user'],
      "class Address {\n  city: string = ''\n}\nclass Base {\n  address: Address = new Address()\n}\nclass Sub extends Base {\n}",
      '@Local user: Sub = new Sub()',
      "this.user.address.city = 'y'",
      'this.user.address.city',
    ],
    [
      '@ObservedV2 property without @Trace',
      ['user'],
      "@ObservedV2\nclass User {\n  name: string = ''\n}",
      '@Local user: User = new User()',
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'inferred type with nested type arguments',
      ['b'],
      "class Box<T> {\n  v: string = ''\n}",
      '@Local b = new Box<Array<string>>()',
      "this.b.v = 'q'",
      'this.b.v',
    ],
    [
      '@Trace on the line above its property',
      [],
      "@ObservedV2\nclass User {\n  @Trace\n  name: string = ''\n}",
      '@Local user: User = new User()',
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'one-line @ObservedV2 class',
      [],
      "@ObservedV2 class User { @Trace name: string = ''; }",
      '@Local user: User = new User()',
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'alias of an @ObservedV2 class',
      [],
      `${OBSERVED}\ntype U = User`,
      '@Local user: U = new User()',
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'setter on an @ObservedV2 class',
      [],
      "@ObservedV2\nclass User {\n  @Trace first: string = ''\n  set full(v: string) {\n    this.first = v\n  }\n}",
      '@Local user: User = new User()',
      "this.user.full = 'y'",
      'this.user.first',
    ],
    ['object literal', ['user'], '', "@Local user = { name: '' }", "this.user.name = 'y'", 'this.user.name'],
    [
      'inline object type',
      ['user'],
      '',
      "@Local user: { name: string } = { name: '' }",
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'a comment and a blank line between @Trace and its property',
      [],
      "@ObservedV2\nclass User {\n  @Trace\n  // display name\n\n  name: string = ''\n}",
      '@Local user: User = new User()',
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      '@ObservedV2 type holding an object literal',
      ['user'],
      OBSERVED,
      "@Local user: User = { name: '' }",
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'extends on the next line',
      [],
      "@ObservedV2\nclass Base {\n  @Trace name: string = ''\n}\nclass Sub\n  extends Base {\n}",
      '@Local user: Sub = new Sub()',
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'one-line interface with comma-separated members',
      ['p'],
      'interface Z {\n  v: number\n}\ninterface Pt { x: number, y: Z }',
      '@Local p: Pt = { x: 0, y: { v: 0 } }',
      'this.p.y.v = 1',
      'this.p.y.v',
    ],
    [
      'interface with two parents',
      ['c'],
      'interface Z {\n  v: number\n}\ninterface A {\n}\ninterface B {\n  z: Z\n}\ninterface C extends A, B {\n}',
      '@Local c: C = { z: { v: 0 } }',
      'this.c.z.v = 1',
      'this.c.z.v',
    ],
    [
      'interface-typed field holding an @ObservedV2 instance',
      [],
      "interface IItem {\n  n: string\n}\n@ObservedV2\nclass Item implements IItem {\n  @Trace n: string = ''\n}",
      '@Local a: IItem = new Item()',
      "this.a.n = 'x'",
      'this.a.n',
    ],
    ['index write on a Record', ['a'], '', '@Local a: Record<string, number> = {}', "this.a['k'] = 1", "this.a['k']"],
    ['index write on an object literal', ['a'], '', '@Local a = {}', "this.a['k'] = 1", "this.a['k']"],
    [
      'class member holding an object literal',
      ['a'],
      '@ObservedV2\nclass Cfg {\n  @Trace d: boolean = true\n}\n@ObservedV2\nclass S {\n  @Trace cfg: Cfg = { d: true }\n}',
      '@Local a: S = new S()',
      'this.a.cfg.d = false',
      'this.a.cfg.d',
    ],
    [
      'deep write into an object literal',
      ['a'],
      '',
      '@Local a = { t: { d: true } }',
      'this.a.t.d = false',
      'this.a.t.d',
    ],
    ['inner array of a nested array', ['a'], '', '@Local a: number[][] = []', 'this.a[0][1] = 2', 'this.a[0][1]'],
    [
      'untraced property next to a base class from another file',
      ['a'],
      "@ObservedV2\nclass S extends ExtBase {\n  name: string = ''\n}",
      '@Local a: S = new S()',
      "this.a.name = 'x'",
      'this.a.name',
    ],
    [
      'one-line class with a comparison in a method',
      [],
      "@ObservedV2 class S { foo(a: number, b: number) { return a < b }; @Trace name: string = '' }",
      '@Local a: S = new S()',
      "this.a.name = 'x'",
      'this.a.name',
    ],
    [
      'element of a generic Array subclass with nested type arguments',
      ['a'],
      "class Item {\n  title: string = ''\n}\nclass L<K, T> extends Array<T> {\n}",
      '@Local a: L<Map<string, number>, Item> = new L<Map<string, number>, Item>()',
      "this.a[0].title = 'x'",
      'this.a[0].title',
    ],
    [
      'constructor parameters on their own lines',
      [],
      "@ObservedV2\nclass User {\n  @Trace name: string = ''\n  constructor(\n    name: string,\n  ) {\n    this.name = name\n  }\n}",
      "@Local user: User = new User('a')",
      "this.user.name = 'b'",
      'this.user.name',
    ],
    [
      '@ObservedV2 instance inside an object literal',
      [],
      "@ObservedV2\nclass Addr {\n  @Trace city: string = ''\n}",
      '@Local s = { a: new Addr() }',
      "this.s.a.city = 'x'",
      'this.s.a.city',
    ],
    [
      'write in a struct method with parameters on their own lines',
      ['prefs'],
      "class Prefs {\n  theme: string = ''\n}",
      '@Local prefs: Prefs = new Prefs()',
      '}\n  onPick(\n    value: string,\n    index: number,\n  ) {\n    this.prefs.theme = value',
      'this.prefs.theme',
    ],
    [
      'mutating-named method on a plain class (not judged)',
      [],
      "class Prefs {\n  theme: string = ''\n  set(k: string, v: string) {\n    this.theme = v\n  }\n}\n@ObservedV2\nclass User {\n  @Trace prefs: Prefs = new Prefs()\n}",
      '@Local user: User = new User()',
      "this.user.prefs.set('theme', 'dark')",
      'this.user.prefs.theme',
    ],
    [
      'element of an Array subclass with a function type in a type argument',
      ['a'],
      "class Item {\n  title: string = ''\n}\nclass Box<A, B> {\n}\nclass L<K, T> extends Array<T> {\n}",
      '@Local a: L<Box<() => void, string>, Item> = new L<Box<() => void, string>, Item>()',
      "this.a[0].title = 'x'",
      'this.a[0].title',
    ],
    [
      'call on the inner array of a nested array',
      ['a'],
      '',
      '@Local a: number[][] = []',
      'this.a[0].push(2)',
      'this.a[0][1]',
    ],
    [
      'array in an object type alias',
      ['s'],
      'type Cfg = {\n  list: number[]\n  n: number\n}',
      '@Local s: Cfg = { list: [1], n: 0 }',
      'this.s.list.push(1)',
      'this.s.list[0]',
    ],
    [
      'call on an untyped array in a plain class',
      ['s'],
      'class State {\n  list = []\n}',
      '@Local s: State = new State()',
      'this.s.list.push(1)',
      'this.s.list[0]',
    ],
    [
      'mutating-named method that writes no field',
      [],
      'class Store {\n  items: string[] = []\n  set(k: string) {\n  }\n}',
      '@Local store: Store = new Store()',
      "this.store.set('a')",
      'this.store.items[0]',
    ],
    [
      'member after a field initializer with a callback',
      [],
      "@ObservedV2\nclass Store {\n  unsub: number = register(() => {\n    log()\n  })\n  @Trace title: string = ''\n}",
      '@Local s: Store = new Store()',
      "this.s.title = 'a'",
      'this.s.title',
    ],
    [
      'array initializer elements are not members',
      [],
      "@ObservedV2\nclass Store {\n  @Trace title: string = ''\n  ids: string[] = [\n    a,\n    title\n  ]\n}",
      '@Local s: Store = new Store()',
      "this.s.title = 'a'",
      'this.s.title',
    ],
    [
      'multi-line interface member with a trailing comma',
      ['cfg'],
      'class Inner {\n  x: number = 0\n}\ninterface Cfg {\n  inner: Inner,\n}',
      '@Local cfg: Cfg = makeCfg()',
      'this.cfg.inner.x = 2',
      'this.cfg.inner.x',
    ],
    [
      'class type parameter with a nested generic constraint',
      [],
      '@ObservedV2\nclass Base {\n  @Trace x: number = 0\n}\nclass Child<T extends Array<number>> extends Base {\n}',
      '@Local c: Child<number[]> = new Child<number[]>()',
      'this.c.x = 2',
      'this.c.x',
    ],
    [
      'field reassigned with a class instance',
      [],
      OBSERVED,
      "@Local user: User = { name: '' }",
      "this.user = new User()\n    this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'call on an element of an untyped field',
      [],
      '',
      '@Local items = getItems()',
      "this.items[0].set('k', 1)",
      'this.items[0]',
    ],
    [
      '@Param with an object-literal default',
      [],
      OBSERVED,
      "@Param p: User = { name: '' }",
      "this.p.name = 'y'",
      'this.p.name',
    ],
    [
      'class member literal replaced in the constructor',
      [],
      'interface Info {\n  a: number\n}\n@ObservedV2\nclass InfoImpl implements Info {\n  @Trace a: number = 0\n}\n@ObservedV2\nclass P {\n  @Trace info: Info = { a: 0 }\n  constructor() {\n    this.info = new InfoImpl()\n  }\n}',
      '@Local p: P = new P()',
      'this.p.info.a = 1',
      'this.p.info.a',
    ],
    [
      'in-place write in a method keeps a class field literal',
      ['store'],
      'class Store {\n  data = { count: 0 }\n  inc() {\n    this.data.count++\n  }\n}',
      '@Local store: Store = new Store()',
      'this.store.data.count = 5',
      'this.store.data.count',
    ],
    [
      '@Provider with an object-literal default',
      [],
      OBSERVED,
      "@Provider() user: User = { name: '' }",
      "this.user.name = 'y'",
      'this.user.name',
    ],
    [
      'bracket-key write on an @ObservedV2 instance',
      [],
      "@ObservedV2\nclass Model {\n  @Trace title: string = ''\n}",
      '@Local m: Model = new Model()',
      "this.m['title'] = 'x'",
      'this.m.title',
    ],
    [
      'field reassigned with a literal of another shape',
      [],
      '@ObservedV2\nclass T {\n  @Trace b: number = 0\n}',
      '@Local s = { a: { b: 1 } }',
      'this.s = { a: new T() }\n    this.s.a.b = 2',
      'this.s.a.b',
    ],
    [
      'class member literal replaced by the component',
      [],
      '@ObservedV2\nclass Cfg {\n  @Trace a: number = 0\n}\n@ObservedV2\nclass Info {\n  @Trace cfg: Cfg = { a: 1 }\n}',
      '@Local info: Info = new Info()',
      'this.info.cfg = new Cfg()\n    this.info.cfg.a = 2',
      'this.info.cfg.a',
    ],
    [
      'class member literal replaced in a setter',
      [],
      '@ObservedV2\nclass Cfg {\n  @Trace a: number = 0\n}\n@ObservedV2\nclass Info {\n  @Trace _cfg: Cfg = { a: 1 }\n  set cfg(v: Cfg) {\n    this._cfg = v\n  }\n}',
      '@Local info: Info = new Info()',
      'this.info._cfg.a = 2',
      'this.info._cfg.a',
    ],
    [
      'override member with @Trace',
      [],
      'class Base {\n  a: number = 0\n}\n@ObservedV2\nclass Info extends Base {\n  @Trace override a: number = 1\n}',
      '@Local info: Info = new Info()',
      'this.info.a = 2',
      'this.info.a',
    ],
    [
      'untraced property nothing renders',
      [],
      "@ObservedV2\nclass Profile {\n  @Trace name: string = ''\n  cacheVersion: number = 0\n}",
      '@Local profile: Profile = new Profile()',
      'this.profile.cacheVersion++',
      'this.profile.name',
    ],
    [
      'plain-class property nothing renders',
      [],
      "class User {\n  name: string = ''\n  hits: number = 0\n}",
      '@Local user: User = new User()',
      'this.user.hits++',
      'this.user.name',
    ],
    ['class from another file', [], '', '@Local user: User = new User()', "this.user.name = 'y'", 'this.user.name'],
    ['unknown type', [], '', '@Local user = makeUser()', "this.user.name = 'y'", 'this.user.name'],
    [
      'array call in a plain class',
      ['user'],
      PLAIN,
      '@Local user: User = new User()',
      "this.user.tags.push('a')",
      'this.user.tags[0]',
    ],
    [
      'property of a plain array item',
      ['items'],
      ITEM,
      '@Local items: Item[] = []',
      "this.items[0].title = 'a'",
      'this.items[0].title',
    ],
  ];
  for (const [name, hits, classes, fields, write, render] of cases) {
    test(name, () => assert.deepEqual(nestedHits(v2(classes, fields, write, render)), hits));
  }
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

// Owners declared in other files are skipped until cross-file facts come from ace-server.
test('V2: a class declared in another file is skipped', () => {
  const dir = tempDir();
  put(join(dir, 'model', 'User.ets'), "export class User {\n  name: string = ''\n}");
  const src = `import { User } from '../model/User'
@ComponentV2
struct P {
  @Local user: User = new User()
  build() {
    Text(this.user.name)
  }
  tap() {
    this.user.name = 'x'
  }
}`;
  assert.deepEqual(
    found(src, put(join(dir, 'pages', 'P.ets'), src)).map((c) => c.field.name),
    [],
  );
});

describe('V2: an array on a plain class rendered through ForEach', () => {
  const store = (render: string) => `class Store {
  items: string[] = []
  title: string = ''
}
@ComponentV2
struct P {
  @Local store: Store = new Store()
  build() {
    ${render}
  }
  add() {
    this.store.items.push('x')
    this.store.items[0] = 'y'
  }
}`;
  test('is flagged, citing both writes', () => {
    const hits = found(store('ForEach(this.store.items, (item: string) => { Text(item) })'));
    assert.deepEqual(
      hits.map((c) => [c.field.name, c.writes?.length]),
      [['store', 2]],
    );
  });
  test('is silent when nothing renders it', () => {
    assert.deepEqual(nestedHits(store('Text(this.store.title)')), []);
  });
});

describe('V2: property names with $', () => {
  const user = (classes: string) => `${classes}
@ComponentV2
struct P {
  @Local user: User = new User()
  build() {
    Text(\`\${this.user.$id}\`)
  }
  tap() {
    this.user.$id = 1
  }
}`;
  test('a plain-class property is flagged', () => {
    assert.deepEqual(nestedHits(user('class User {\n  $id: number = 0\n}')), ['user']);
  });
  test('a @Trace property is observed', () => {
    assert.deepEqual(nestedHits(user('@ObservedV2\nclass User {\n  @Trace $id: number = 0\n}')), []);
  });
});
