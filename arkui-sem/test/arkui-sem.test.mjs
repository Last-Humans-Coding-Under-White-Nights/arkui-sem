// All tests (npm test builds first). Each section is a block with its own helpers.
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

// --- Rules ---

{
// ArkUI docs: V1 observes first-layer changes only; "@Observed alone has no effect in nested classes".

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => import(pathToFileURL(join(root, "dist", p)).href);
const { NaiveExtractor, candidates, nestedDepth } = await load("analysis.js");

const nestedHits = (src) =>
  candidates(new NaiveExtractor().extract("T.ets", src)).filter((c) => c.kind === "nested-write-unobserved").map((c) => c.field.name);

const v1 = (classes, field, write, render) => `${classes}
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

const USER = "class Address {\n  city: string = ''\n}\nclass User {\n  name: string = ''\n  address: Address = new Address()\n  tags: string[] = []\n}";
const USER_OBSERVED = "@Observed\nclass Address {\n  city: string = ''\n}\n@Observed\nclass User {\n  name: string = ''\n  address: Address = new Address()\n}";

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

test("nestedDepth counts levels below the field", () => {
  assert.equal(nestedDepth(undefined), 0);
  assert.equal(nestedDepth(".title"), 1);
  assert.equal(nestedDepth("[]"), 1);
  assert.equal(nestedDepth(".address.city"), 2);
  assert.equal(nestedDepth("[i].title"), 2);
  assert.equal(nestedDepth(".tags[]"), 2);
});

test("V1: a first-layer property write on @State is observed (no finding, @Observed or not)", () => {
  assert.deepEqual(nestedHits(v1(USER, "@State user: User = new User()", "this.user.name = 'a'", "this.user.name")), []);
});

test("V1: a two-level write is flagged when the classes are not @Observed", () => {
  assert.deepEqual(nestedHits(v1(USER, "@State user: User = new User()", "this.user.address.city = 'a'", "this.user.address.city")), ["user"]);
});

test("V1: a two-level write is still flagged when the classes ARE @Observed (the run-4 fix)", () => {
  assert.deepEqual(nestedHits(v1(USER_OBSERVED, "@State user: User = new User()", "this.user.address.city = 'Beijing'", "this.user.address.city")), ["user"]);
});

test("V1: reassigning at the first layer is not flagged", () => {
  assert.deepEqual(nestedHits(v1(USER, "@State user: User = new User()", "this.user.address = new Address()", "this.user.address.city")), []);
});

test("V1: array push is observed; writing an item's property is not", () => {
  const items = "class Item {\n  title: string = ''\n}";
  assert.deepEqual(nestedHits(v1(items, "@State items: Item[] = []", "this.items.push(new Item())", "this.items.length")), []);
  assert.deepEqual(nestedHits(v1(items, "@State items: Item[] = []", "this.items[0].title = 'a'", "this.items[0].title")), ["items"]);
});

test("V1: mutating an array inside an object is two levels deep", () => {
  assert.deepEqual(nestedHits(v1(USER, "@State user: User = new User()", "this.user.tags.push('a')", "this.user.tags.length")), ["user"]);
});

test("V2: a property write needs @ObservedV2 on the class", () => {
  const src = (decorator) => `${decorator}class Settings {\n  dark: boolean = false\n}
@ComponentV2
struct S {
  @Local settings: Settings = new Settings()
  build() {
    Button(\`\${this.settings.dark}\`).onClick(() => {
      this.settings.dark = true
    })
  }
}`;
  assert.deepEqual(nestedHits(src("")), ["settings"]);
  assert.deepEqual(nestedHits(src("@ObservedV2\n")), []);
});

test("R3: constant-event listeners, register/subscribe pairs and helper-called releases", () => {
  const src = (teardown) => `@Component
struct R {
  aboutToAppear() {
    this.bus.on(Events.CHANGE, this.onChange)
    Mgr.getInstance().registerFoo(this.cb)
    this.setup()
  }
  setup() {
    commonEvent.subscribe(this.sub, this.cb)
  }
  aboutToDisappear() {
${teardown}
  }
  build() {}
}`;
  const leaks = (t) => candidates(new NaiveExtractor().extract("T.ets", src(t))).filter((c) => c.rule === "R3").map((c) => c.resource.key).sort();
  assert.deepEqual(leaks(""), ["Mgr.getInstance().registerFoo", "commonEvent.subscribe", "this.bus.on:Events.CHANGE"]);
  assert.deepEqual(leaks("    this.bus.off(Events.CHANGE, this.onChange)\n    this.teardown()\n  }\n  teardown() {\n    Mgr.getInstance().unregisterFoo(this.cb)\n    commonEvent.unsubscribe(this.sub)"), []);
});

// ArkUI docs (@Observed/@ObjectLink): a property change on an @Observed object updates every @ObjectLink bound to it.
const linked = (classes, child, field, body, write) => `${classes}
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
const OTHER = "@Observed\nclass Other {\n  x: number = 0\n}";
const ITEM = "@Observed\nclass Item {\n  done: boolean = false\n}";
const TAGS = "@Observed\nclass ObservedArray<T> extends Array<T> {}\n@Observed\nclass User {\n  tags: ObservedArray<string> = new ObservedArray<string>()\n  plain: string[] = []\n}";
const USER_FIELD = "@State user: User = new User()", TO_ADDRESS = "V({ address: this.user.address })", CITY = "this.user.address.city = 'a'";

test("V1: a deep write is seen by a same-file @ObjectLink child of the owning @Observed class", () => {
  const cases = [
    ["linked", [], USER_OBSERVED, "@ObjectLink address: Address", USER_FIELD, TO_ADDRESS, CITY],
    ["class not @Observed", ["user"], USER, "@ObjectLink address: Address", USER_FIELD, TO_ADDRESS, CITY],
    ["child links another class", ["user"], `${USER_OBSERVED}\n${OTHER}`, "@ObjectLink other: Other", USER_FIELD, "V({ other: new Other() })\n      Text(this.user.name)", CITY],
    ["parent renders the path", ["user"], USER_OBSERVED, "@ObjectLink address: Address", USER_FIELD, `${TO_ADDRESS}\n      Text(this.user.address.city)`, CITY],
    ["undeclared property", ["user"], USER_OBSERVED, "@ObjectLink address: Address", USER_FIELD, TO_ADDRESS, "this.user.constructor.name = 'a'"],
    ["array item", [], ITEM, "@ObjectLink item: Item", "@State items: Array<Item> = []", "ForEach(this.items, (item: Item) => { V({ item: item }) })", "this.items[0].done = true"],
    ["@Observed array passed to the child", [], TAGS, "@ObjectLink tags: ObservedArray<string>", USER_FIELD, "V({ tags: this.user.tags })", "this.user.tags.push('a')"],
    ["plain array in a linked object", ["user"], TAGS, "@ObjectLink user: User", USER_FIELD, "V({ user: this.user })", "this.user.plain.push('a')"],
  ];
  for (const [name, hits, ...parts] of cases) assert.deepEqual(nestedHits(linked(...parts)), hits, name);
});

const DISABLE = "// arkui-sem-disable-next-line R1 -- intended";

test("disable comments: above the decorators, the field name or one write (R1); above the acquire line (R3)", () => {
  const deep = (field, write = CITY) => v1(USER, field, write, "this.user.address.city");
  assert.deepEqual(nestedHits(deep(`${DISABLE}\n  @State\n  user: User = new User()`)), []);
  assert.deepEqual(nestedHits(deep(`${DISABLE}\n  ${USER_FIELD}`)), []);
  assert.deepEqual(nestedHits(deep(USER_FIELD, `${DISABLE}\n        ${CITY}`)), []);
  const two = deep(USER_FIELD, `${DISABLE}\n        ${CITY}\n        this.user.address.city = 'b'`);
  const [c] = candidates(new NaiveExtractor().extract("T.ets", two)).filter((x) => x.kind === "nested-write-unobserved");
  assert.equal(c.line, two.split("\n").findIndex((l) => l.includes("'b'")) + 1);
  const r3 = (comment) => candidates(new NaiveExtractor().extract("T.ets", `@Component\nstruct R {\n  aboutToAppear() {\n    ${comment}\n    this.bus.on('refresh', this.h)\n  }\n  build() {}\n}`)).filter((x) => x.rule === "R3").length;
  assert.deepEqual([r3(""), r3("// arkui-sem-disable-next-line R3 -- app-lifetime bus")], [1, 0]);
});

console.log(`\n${passed} passed`);
}

// --- Engine (stub judge) ---

{

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { checkFiles, formatForAgent } = await import(pathToFileURL(join(root, "dist", "engine.js")).href);
const bug = { name: "stub", systemOne: async () => ({ backend: "stub", latencyMs: 0, answers: { verdict: { type: "choice", choice: "desync_bug", confidence: 1, probabilities: { desync_bug: 1 } } } }) };
const file = join(mkdtempSync(join(tmpdir(), "arkui-sem-engine-")), "P.ets");
writeFileSync(file, `class Address {\n  city: string = ''\n}\nclass User {\n  address: Address = new Address()\n}
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
}`);

const { findings: [finding] } = await checkFiles([file], { backend: bug });
assert.match(finding.evidence, /line 13; also written in place at line 14\)/);
const { findings: questions } = await checkFiles([file], { backend: bug, thresholds: { finding: 2, question: 0 } });
assert.match(formatForAgent(questions), /above each write it lists, or above the field's decorators/);
console.log("ok engine: a nested-write finding cites each write line once and says where the disable comment goes");
}

// --- Config ---

{

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { loadSettings, describeSettings } = await import(pathToFileURL(join(root, "dist", "config.js")).href);

const VARS = ["ARKUI_SEM_BACKEND", "ARKUI_SEM_GATE", "ARKUI_SEM_FINDING_THRESHOLD", "ARKUI_SEM_QUESTION_THRESHOLD", "ARKUI_SEM_JUDGE_TIMEOUT_MS", "ARKUI_SEM_DATA_DIR", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "TYPESAFE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL"];
const tmp = mkdtempSync(join(tmpdir(), "arkui-sem-config-"));
const userFile = join(tmp, "user", "config.json");
const project = join(tmp, "project");
const projectFile = join(project, ".opencode", "arkui-sem.json");
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };

let passed = 0;
const test = (name, fn) => {
  for (const v of VARS) delete process.env[v];
  process.env.ARKUI_SEM_CONFIG = userFile;
  write(userFile, "{}");
  write(projectFile, "{}");
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

test("defaults when no config files or variables are set", () => {
  const s = loadSettings({}, project);
  assert.equal(s.backend, "clef");
  assert.equal(s.gate, true);
  assert.deepEqual(s.thresholds, { finding: 0.8, question: 0.5 });
  assert.equal(s.credentials.deepseekApiKey, undefined);
  assert.deepEqual(s.warnings, []);
});

test("the user config supplies the backend and the DeepSeek key", () => {
  write(userFile, { backend: "deepseek-flash", deepseek: { apiKey: "sk-user-1234567890" }, gate: false });
  const s = loadSettings({}, project);
  assert.equal(s.backend, "deepseek-flash");
  assert.equal(s.credentials.deepseekApiKey, "sk-user-1234567890");
  assert.equal(s.gate, false);
  assert.deepEqual(s.sources, [userFile, projectFile]);
});

test("the project config overrides the user config", () => {
  write(userFile, { backend: "deepseek-flash", findingThreshold: 0.7 });
  write(projectFile, { backend: "clef-flash", findingThreshold: 0.9 });
  const s = loadSettings({}, project);
  assert.equal(s.backend, "clef-flash");
  assert.equal(s.thresholds.finding, 0.9);
});

test("environment variables override both files", () => {
  write(userFile, { backend: "deepseek-flash", deepseek: { apiKey: "sk-file-1234567890" } });
  process.env.ARKUI_SEM_BACKEND = "heuristic";
  process.env.DEEPSEEK_API_KEY = "sk-env-0987654321";
  const s = loadSettings({}, project);
  assert.equal(s.backend, "heuristic");
  assert.equal(s.credentials.deepseekApiKey, "sk-env-0987654321");
});

test("plugin options override everything", () => {
  process.env.ARKUI_SEM_BACKEND = "heuristic";
  const s = loadSettings({ backend: "jev", typesafe: { apiKey: "ts-opt" } }, project);
  assert.equal(s.backend, "jev");
  assert.equal(s.credentials.typesafeApiKey, "ts-opt");
});

test("a secret in the project config works but warns", () => {
  write(projectFile, { deepseek: { apiKey: "sk-proj-1234567890" } });
  const s = loadSettings({}, project);
  assert.equal(s.credentials.deepseekApiKey, "sk-proj-1234567890");
  assert.ok(s.warnings.some((w) => w.includes("deepseek.apiKey") && w.includes("may be committed")));
});

test("bad JSON, unknown keys and wrong types are ignored with warnings", () => {
  write(userFile, "{ not json");
  write(projectFile, { backend: 3, colour: "blue", deepseek: { apiKey: "sk-x-1234567890", region: "eu" } });
  const s = loadSettings({}, project);
  assert.equal(s.backend, "clef");
  assert.ok(s.warnings.some((w) => w.includes("not valid JSON")));
  assert.ok(s.warnings.some((w) => w.includes('"backend" should be a string')));
  assert.ok(s.warnings.some((w) => w.includes('unknown key "colour"')));
  assert.ok(s.warnings.some((w) => w.includes('unknown key "deepseek.region"')));
  assert.equal(s.credentials.deepseekApiKey, "sk-x-1234567890");
});

test("describeSettings masks secrets", () => {
  write(userFile, { deepseek: { apiKey: "sk-abcdefghijklmnop" } });
  const shown = JSON.stringify(describeSettings(loadSettings({}, project)));
  assert.ok(!shown.includes("sk-abcdefghijklmnop"));
  assert.ok(shown.includes("sk-…mnop"));
});

test("CLI: config --init writes a starter file once; config shows the masked token", () => {
  const fresh = join(tmp, "fresh", "config.json");
  const run = (...args) => execFileSync(process.execPath, [join(root, "dist", "cli.js"), ...args], {
    cwd: project, encoding: "utf8", env: { ...process.env, ARKUI_SEM_CONFIG: fresh },
  });
  assert.match(run("config", "--init"), /created/);
  assert.match(run("config", "--init"), /already exists/);
  const out = JSON.parse(run("config"));
  assert.equal(out.resolved.backend, "clef");
  assert.equal(out.resolved.credentials.cloudflareApiToken, "REP…E_ME");
  assert.ok(out.resolved.sources.includes(fresh));
});

console.log(`\n${passed} passed`);
}

// --- DeepSeek backend (mock server) ---

{

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => import(pathToFileURL(join(root, "dist", p)).href);
const { DeepSeekBackend, Q_R1 } = await load("judge.js");
const { choice, noul, score } = await import("@typesafe-ai/sdk");
const requests = [];
let behaviour = { strictFails: 0 };

function structuredArgs(body) {
  // Fill every property of the schema the backend sent: first label 0.7, the rest share 0.3.
  const props = body.tools?.[0]?.function.parameters.properties
    ?? JSON.parse(body.messages[0].content.match(/example: (\{.*\})$/s)[1]);
  return Object.fromEntries(Object.entries(props).map(([id, v]) => {
    const labels = v.required ?? Object.keys(v);
    return [id, Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 0.7 : 0.3 / (labels.length - 1)]))];
  }));
}

const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ url: req.url, body });
  const reply = (code, json) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };
  const usage = { prompt_tokens: 100, completion_tokens: 40 };

  if (req.url === "/beta/chat/completions") {
    if (behaviour.strictFails > 0) { behaviour.strictFails--; return reply(500, { error: "beta unavailable" }); }
    return reply(200, { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ function: { name: "submit_answers", arguments: JSON.stringify(structuredArgs(body)) } }] } }], usage });
  }
  return reply(200, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(structuredArgs(body)) } }], usage });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.DEEPSEEK_API_KEY = "test-key";
const close = (a, b) => Math.abs(a - b) < 1e-9;
function assertSystemOneShapes(questions, answers) {
  assert.deepEqual(Object.keys(answers).sort(), Object.keys(questions).sort());
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    assert.equal(a.type, q.type, `${id}: type`);
    if (q.type === "noul") {
      assert.deepEqual(Object.keys(a).sort(), ["noul", "type"]);
      assert.ok(a.noul >= 0 && a.noul <= 1);
      continue;
    }
    const labels = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    assert.deepEqual(Object.keys(a.probabilities), labels, `${id}: a probability for every allowed answer`);
    assert.ok(close(Object.values(a.probabilities).reduce((s, v) => s + v, 0), 1), `${id}: probabilities sum to 1`);
    if (q.type === "choice") {
      assert.deepEqual(Object.keys(a).sort(), ["choice", "confidence", "probabilities", "type"]);
      assert.ok(labels.includes(a.choice));
      assert.ok(close(a.confidence, Math.max(...Object.values(a.probabilities))));
    } else {
      assert.deepEqual(Object.keys(a).sort(), ["confidence", "legend", "probabilities", "score", "type"]);
      assert.deepEqual(Object.keys(a.legend), labels);
      assert.ok(close(a.score, labels.reduce((s, l) => s + Number(l) * a.probabilities[l], 0)), `${id}: probability-weighted score`);
    }
  }
}

const state = { rule: "R1", candidate: { field: "items" } };
let passed = 0;
const test = async (name, fn) => { requests.length = 0; behaviour = { strictFails: 0 }; await fn(); passed++; console.log(`ok - ${name}`); };

await test("structured: one strict-schema call on the beta endpoint, System One answer shapes", async () => {
  const r = await new DeepSeekBackend().systemOne(state, Q_R1);
  assert.equal(requests.length, 1);
  const { url, body } = requests[0];
  assert.equal(url, "/beta/chat/completions");
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.tool_choice, "required");
  const fn = body.tools[0].function;
  assert.equal(fn.strict, true);
  assert.equal(fn.parameters.additionalProperties, false);
  assert.deepEqual(fn.parameters.required, Object.keys(Q_R1));
  assert.deepEqual(fn.parameters.properties.severity.required, ["0", "1", "2", "3"]);
  assertSystemOneShapes(Q_R1, r.answers);
  assert.equal(r.answers.verdict.choice, "desync_bug");
  assert.ok(close(r.answers.is_ui_state.noul, 0.7));
  assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 40 });
});

await test("structured: falls back to json_object mode when the strict endpoint fails", async () => {
  behaviour.strictFails = 2;
  const r = await new DeepSeekBackend().systemOne(state, Q_R1);
  assert.deepEqual(requests.map((q) => q.url), ["/beta/chat/completions", "/beta/chat/completions", "/chat/completions"]);
  assert.deepEqual(requests[2].body.response_format, { type: "json_object" });
  assert.match(requests[2].body.messages[0].content, /json/);
  assertSystemOneShapes(Q_R1, r.answers);
});

await test("request constraints match System One (2–255 choices, 2–10 score levels)", async () => {
  const b = new DeepSeekBackend();
  await assert.rejects(() => b.systemOne(state, {}), /non-empty/);
  await assert.rejects(() => b.systemOne(state, { c: choice("x", { only: null }) }), /2–255/);
  await assert.rejects(() => b.systemOne(state, { s: score("x", Array.from({ length: 11 }, (_, i) => `l${i}`)) }), /2–10/);
  assert.equal(requests.length, 0, "invalid requests never reach the API");
});

await test("every request uses deepseek-flash", async () => {
  await new DeepSeekBackend().systemOne(state, Q_R1);
  behaviour.strictFails = 2;
  await new DeepSeekBackend().systemOne(state, Q_R1);
  assert.ok(requests.length > 1);
  assert.ok(requests.every((q) => q.body.model === "deepseek-flash"));
});

server.close();
console.log(`\n${passed} passed`);
}

// --- opencode plugin (mock client) ---

{

process.env.ARKUI_SEM_DATA_DIR = mkdtempSync(join(tmpdir(), "arkui-sem-test-"));
process.env.ARKUI_SEM_BACKEND = "heuristic";
process.env.ARKUI_SEM_CONFIG = join(process.env.ARKUI_SEM_DATA_DIR, "no-user-config.json"); // ignore any real user config

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { ArkuiSemPlugin } = await import(pathToFileURL(join(root, "dist", "opencode.js")).href);

const prompts = [];
const logs = [];
const client = {
  app: { log: async ({ body }) => { logs.push(body); } },
  session: { promptAsync: async (opts) => { prompts.push(opts); } },
};
const hooks = await ArkuiSemPlugin({ client, directory: root, worktree: root, project: {}, serverUrl: new URL("http://localhost"), $: undefined, experimental_workspace: { register() {} } });

const after = async (tool, args, sessionID = "s1") => {
  const output = { title: "", output: "ok", metadata: {} };
  await hooks["tool.execute.after"]({ tool, sessionID, callID: "c", args }, output);
  return output.output;
};
const ctx = { sessionID: "s1", messageID: "m", agent: "build", directory: root, worktree: root, abort: new AbortController().signal, metadata() {}, ask: async () => {} };

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

await test("edit on .ets appends new findings and questions to the tool output", async () => {
  const out = await after("edit", { filePath: "test/fixtures/Feed.ets", oldString: "a", newString: "b" });
  assert.match(out, /^ok\n\narkui-sem: 1 finding\(s\), 1 question\(s\)/);
  assert.match(out, /Feed\.items/);
  assert.match(out, /\[R1\?\].*Feed\.lastFetchMs/);
});

await test("re-editing the same file reports nothing already reported", async () => {
  assert.equal(await after("edit", { filePath: "test/fixtures/Feed.ets" }), "ok");
});

await test("non-.ets edits and non-editing tools are ignored", async () => {
  assert.equal(await after("write", { filePath: "README.md", content: "x" }), "ok");
  assert.equal(await after("read", { filePath: "test/fixtures/Counter.ets" }), "ok");
});

await test("apply_patch: files are taken from the patch headers", async () => {
  const patchText = "*** Begin Patch\n*** Update File: test/fixtures/Ticker.ets\n@@\n-a\n+b\n*** End Patch";
  const out = await after("apply_patch", { patchText });
  assert.match(out, /Ticker emitter\.on:refresh/);
  assert.match(out, /Ticker timer:this\.pollId/);
});

await test("session.idle sends one follow-up listing confident findings", async () => {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].path.id, "s1");
  const text = prompts[0].body.parts[0].text;
  assert.match(text, /3 finding\(s\)/);
  assert.doesNotMatch(text, /lastFetchMs/, "questions never go through the gate");
});

await test("the gate does not repeat for the same set of findings", async () => {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(prompts.length, 1);
});

await test("idle sessions with no .ets edits are left alone", async () => {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "other" } } });
  assert.equal(prompts.length, 1);
});

await test("arkui_check tool scans a directory", async () => {
  const out = await hooks.tool.arkui_check.execute({ paths: ["test/fixtures"] }, ctx);
  assert.match(out, /5 finding\(s\), 1 question\(s\)/);
});

await test("arkui_facts tool returns ownership facts", async () => {
  const facts = JSON.parse(await hooks.tool.arkui_facts.execute({ file: "test/fixtures/Counter.ets" }, ctx));
  const counter = facts.components.find((c) => c.name === "Counter");
  const count = counter.fields.find((f) => f.name === "count");
  assert.deepEqual(count.decorators, []);
  assert.equal(count.writes[0].context, "build-closure");
  assert.equal(facts.components.find((c) => c.name === "GoodCounterV2").stateManagement, "V2");
});

console.log(`\n${passed} passed; plugin logs: ${logs.map((l) => `${l.level}: ${l.message}`).join(" | ")}`);
}

// --- OpenRouter Clef (Decisions API) ---
{
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { createBackend } = await import(pathToFileURL(join(root, "dist", "judge.js")).href);
  const seen = [];
  let mode = "ok";
  const srv = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    const send = (code, json) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };
    if (mode === "error") return send(401, { error: { message: "bad key sk-or-secret" } });
    send(200, { answers: { q: { type: "noul", noul: 0.9 } } });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}/api/alpha`;
  const questions = { q: { type: "noul", instructions: "x" } };

  const b = await createBackend("or-clef-flash", { openrouterApiKey: "sk-or-secret", openrouterBaseUrl: baseUrl });
  const r = await b.systemOne("state", questions);
  assert.equal(r.backend, "cloudflare/clef-flash");
  assert.equal(r.answers.q.noul, 0.9);
  assert.equal(seen[0].url, "/api/alpha/decisions");
  assert.equal(seen[0].auth, "Bearer sk-or-secret");
  assert.equal(seen[0].body.model, "cloudflare/clef-flash");
  assert.deepEqual(seen[0].body.questions, questions);

  mode = "error";
  const c = await createBackend("or-clef", { openrouterApiKey: "sk-or-secret", openrouterBaseUrl: baseUrl });
  await assert.rejects(() => c.systemOne("state", questions), (e) => /HTTP 401/.test(e.message) && !e.message.includes("sk-or-secret"));
  await assert.rejects(() => new (b.constructor)("cloudflare/clef", { apiKey: "" }).systemOne("s", questions), /not configured|HTTP|fetch/);
  srv.close();
  console.log("ok openrouter clef backend");
}
