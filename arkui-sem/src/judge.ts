// Decision models: questions, spec cards, slices, and backends that answer in one TypeSafe-shaped format.
import { choice, type ChoiceResponse, type EntryType, type JsonValue, noul, type NoulResponse, type Question, type Questions, score, type ScoreResponse, TypeSafeClient } from "@typesafe-ai/sdk";
import { type Candidate, type FileFacts, nestedDepth } from "./analysis.js";
import type { Credentials } from "./config.js";

// --- System One interface, Jev, Clef ---

export type Answer = NoulResponse | ChoiceResponse | ScoreResponse;

export interface Result {
  backend: string;
  answers: Record<string, Answer>;
  latencyMs: number;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface SystemOneBackend {
  readonly name: string;
  systemOne(state: EntryType, questions: Questions): Promise<Result>;
}

export class JevBackend implements SystemOneBackend {
  private readonly client: TypeSafeClient;

  /** Without apiKey the SDK reads TYPESAFE_API_KEY; model defaults to jev-latest. Laya is a local server with the same API. */
  constructor(apiKey?: string, readonly name = "jev", local?: { baseURL: string; model: string }) {
    this.client = new TypeSafeClient(local ? { apiKey: apiKey ?? "local", baseURL: local.baseURL, defaultModel: local.model } : apiKey ? { apiKey } : undefined);
  }

  async systemOne(state: EntryType, questions: Questions): Promise<Result> {
    const t0 = performance.now();
    // Laya rejects states over its context limit (HTTP 422); retry with smaller slices.
    for (const s of [state, ...shrink(state)]) {
      try {
        const { answers, usage } = await this.client.systemOne({ state: s, questions });
        return { backend: this.name, answers, latencyMs: performance.now() - t0, usage };
      } catch (e) {
        if (!/context limit/i.test((e as Error).message)) throw e;
      }
    }
    throw new Error(`${this.name}: state exceeds the context limit even after trimming`);
  }
}

/** Progressively smaller copies of a slice: no task context, then no spec card, then fewer excerpts. */
function shrink(state: EntryType): EntryType[] {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return [];
  const { task_context: _t, ...noTask } = state as { [key: string]: JsonValue };
  const { spec_card: _s, ...noCard } = noTask;
  const ex = Array.isArray(noCard.excerpts) ? noCard.excerpts : [];
  return [noTask, noCard, { ...noCard, excerpts: ex.slice(0, 3) }, { ...noCard, excerpts: ex.slice(0, 1) }];
}

type ClefModel = "@cf/cloudflare/clef" | "@cf/cloudflare/clef-flash";

interface WorkersAIEnvelope {
  success: boolean;
  errors: unknown[];
  result: { answers: Record<string, Answer> };
}

export class ClefBackend implements SystemOneBackend {
  private readonly accountId?: string;
  private readonly apiToken?: string;

  constructor(readonly name: ClefModel = "@cf/cloudflare/clef-flash", creds: { accountId?: string; apiToken?: string } = {}) {
    this.accountId = creds.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
    this.apiToken = creds.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
  }

  async systemOne(state: EntryType, questions: Questions): Promise<Result> {
    if (!this.accountId || !this.apiToken) throw new Error("Cloudflare accountId/apiToken are not configured");
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.name}`;
    const t0 = performance.now();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, questions }),
    });
    const body = (await res.json()) as WorkersAIEnvelope;
    if (!res.ok || !body.success) throw new Error(`${this.name}: ${JSON.stringify(body.errors)}`);
    return { backend: this.name, answers: body.result.answers, latencyMs: performance.now() - t0 };
  }
}

/** Clef through OpenRouter's Decisions API: same {state, questions} body, plus `model`; answers at the top level. */
export class OpenRouterClefBackend implements SystemOneBackend {
  private readonly apiKey?: string;
  private readonly baseURL: string;

  constructor(readonly name: "cloudflare/clef" | "cloudflare/clef-flash" = "cloudflare/clef-flash", creds: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = creds.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.baseURL = (creds.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/alpha").replace(/\/+$/, "");
  }

  async systemOne(state: EntryType, questions: Questions): Promise<Result> {
    if (!this.apiKey) throw new Error("OpenRouter apiKey is not configured");
    const t0 = performance.now();
    const res = await fetch(`${this.baseURL}/decisions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "X-Title": "arkui-sem" },
      body: JSON.stringify({ model: this.name, state, questions }),
    });
    const raw = await res.text();
    let body: { answers?: Record<string, Answer>; result?: { answers?: Record<string, Answer> }; error?: unknown } = {};
    try { body = JSON.parse(raw); } catch { /* reported below */ }
    const answers = body.answers ?? body.result?.answers;
    if (!res.ok || !answers) throw new Error(`${this.name}: HTTP ${res.status} ${(body.error ? JSON.stringify(body.error) : raw).slice(0, 300).replaceAll(this.apiKey, "***")}`);
    return { backend: this.name, answers, latencyMs: performance.now() - t0 };
  }
}

// --- Answer helpers ---

// For backends that don't return System One answers natively.

export const MAX_CHOICE_OPTIONS = 255;
export const MAX_SCORE_LEVELS = 10;

export const text = (e: EntryType | undefined): string =>
  e == null ? "" : typeof e === "string" ? e : JSON.stringify(e);

/** Allowed answers per question: noul → "true"/"false"; choice → its labels; score → levels "0".."n-1". */
export function labelsOf(q: Question): string[] {
  if (q.type === "noul") return ["true", "false"];
  if (q.type === "choice") return Object.keys(q.criteria);
  return q.criteria.map((_, i) => String(i));
}

/** Same limits as the System One API: 2–255 choices, 2–10 score levels. */
export function validateQuestions(questions: Questions): void {
  const entries = Object.entries(questions);
  if (entries.length === 0) throw new Error("questions must be non-empty");
  for (const [id, q] of entries) {
    if (q.type === "choice") {
      const n = Object.keys(q.criteria).length;
      if (n < 2 || n > MAX_CHOICE_OPTIONS) throw new Error(`${id}: a choice needs 2–${MAX_CHOICE_OPTIONS} options, got ${n}`);
    } else if (q.type === "score") {
      const n = q.criteria.length;
      if (n < 2 || n > MAX_SCORE_LEVELS) throw new Error(`${id}: a score needs 2–${MAX_SCORE_LEVELS} levels, got ${n}`);
    }
  }
}

export function describeQuestion(id: string, q: Question): string {
  const keys = labelsOf(q);
  const head = `${id} [${q.type}]: ${text(q.instructions)}`;
  if (q.type === "noul") {
    const c = q.criteria ?? {};
    return `${head}\n  ${keys[0]}: yes${c.true == null ? "" : ` (${text(c.true)})`}\n  ${keys[1]}: no${c.false == null ? "" : ` (${text(c.false)})`}`;
  }
  const options: [string, EntryType][] =
    q.type === "choice" ? Object.entries(q.criteria) : q.criteria.map((d, i) => [String(i), d]);
  return [head, ...options.map(([label, d], i) => `  ${keys[i]}: ${q.type === "choice" ? label : `level ${label}`}${d == null ? "" : ` (${text(d)})`}`)].join("\n");
}

export function normalize(dist: Record<string, number>, labels: string[]): Record<string, number> {
  const vals = labels.map((l) => { const v = dist[l]; return Number.isFinite(v) ? Math.max(0, v) : 0; });
  const total = vals.reduce((s, v) => s + v, 0);
  return Object.fromEntries(labels.map((l, i) => [l, total > 0 ? vals[i] / total : 1 / labels.length]));
}

/** confidence = P(top label); score = probability-weighted level. */
export function toAnswer(q: Question, dist: Record<string, number>): Answer {
  const labels = labelsOf(q);
  const p = normalize(dist, labels);
  if (q.type === "noul") return { type: "noul", noul: p.true };
  const [best, confidence] = Object.entries(p).reduce((a, b) => (b[1] > a[1] ? b : a));
  if (q.type === "choice") return { type: "choice", choice: best, confidence, probabilities: p };
  const legend = Object.fromEntries(q.criteria.map((d, i) => [String(i), d]));
  const score = Object.entries(p).reduce((s, [level, v]) => s + Number(level) * v, 0);
  return { type: "score", score, confidence, legend, probabilities: p } as ScoreResponse;
}

// --- Questions ---

/** R1: under-reactive state. */
export const Q_R1 = {
  is_ui_state: noul("The value is shown to the user and is expected to change while this screen is visible."),
  intended_static: noul(
    "The value is configuration, a cache, a debug label, or bookkeeping that is not meant to change what users see.",
  ),
  user_expects: noul("A user performing the triggering action would expect the displayed output to change."),
  verdict: choice("Classify the relationship between this value's mutations and the rendered UI.", {
    desync_bug: "The UI is meant to reflect the mutation but will not re-render.",
    intentionally_non_reactive: "The value is deliberately not reactive.",
    not_user_visible: "The value does not affect anything the user sees.",
    insufficient_context: "The state does not contain enough information to decide.",
  }),
  severity: score("How severe is the user-visible effect if this is a bug?", [
    "Cosmetic",
    "Minor: stale but harmless",
    "Broken feature",
    "Data loss or crash",
  ]),
} satisfies Questions;

/** R3: acquired resource with no release in teardown. */
export const Q_R3 = {
  app_lifetime: noul("The resource is intended to live for the whole application, not just this component."),
  released_elsewhere: noul("The resource is plausibly released somewhere outside this component (an owner object or service)."),
  verdict: choice("Classify this acquired resource with no release in the component's teardown hooks.", {
    leak_bug: "It should be released when the component disappears; leaving it causes leaks or duplicate callbacks.",
    intentionally_persistent: "It is deliberately kept alive beyond this component.",
    released_elsewhere: "Another owner releases it.",
    insufficient_context: "The state does not contain enough information to decide.",
  }),
} satisfies Questions;

/** R2: ownership intent; the rules map it to V1/V2 decorators. */
export const Q_R2 = {
  ownership: choice("Which ownership does the child component's use of this value intend?", {
    child_local_copy: "The child edits its own draft; the parent does not need to see edits.",
    shared_with_parent: "The parent must see the child's edits.",
    parent_display_only: "The child should only display the value and should not mutate it.",
  }),
} satisfies Questions;

// --- Slices ---

// Facts first, short excerpts second; the spec card is injected because the model isn't trusted to know ArkUI.

export const SPEC_CARDS: Record<string, string> = {
  "R1:V1":
    "ArkUI state management V1: only decorated state re-renders the UI. @State = local reactive state; @Prop = one-way copy from the parent (local edits are overwritten when the parent updates); @Link = two-way binding with parent state. Undecorated struct members never trigger re-render. @State observes reassignment and first-level property changes only; in-place changes two or more levels deep (this.a.b.c = ...) never re-render this component, even when the classes are @Observed; that needs the nested object rendered through @ObjectLink in a child component, or a first-layer reassignment.",
  "R1:V2":
    "ArkUI state management V2 (@ComponentV2): @Local = local reactive state; @Param = read-only input from the parent (changes flow back through an @Event callback); undecorated members never trigger re-render. Deep observation of class properties requires @ObservedV2 on the class and @Trace on each observed property.",
  "R3:V1":
    "ArkUI component lifecycle: aboutToAppear runs before the first build, aboutToDisappear before the component is destroyed. Listeners, subscriptions and timers registered in aboutToAppear are normally released in aboutToDisappear (off(...), unregisterX(...), unsubscribe(...), clearInterval(...)); otherwise callbacks keep firing and leak after the component is gone.",
};
SPEC_CARDS["R3:V2"] = SPEC_CARDS["R3:V1"];
// R2 cards explain the intents without naming decorators, so the card can't leak the answer.
SPEC_CARDS["R2:V1"] =
  "ArkUI components receive values from their parent when the parent constructs them in its build(). A passed-in field can be used three ways: shared_with_parent = the child's writes must reach the parent's variable (two-way: the parent and its other children see the change); child_local_copy = the child starts from the parent's value and edits its own draft, and the parent never sees those edits (a later parent update overwrites the draft); parent_display_only = the child only reads and renders the value, the parent alone changes it. Judge from what the child does with the value: whether and where it writes it (event handlers, async callbacks, lifecycle), whether the edit is meant to be visible outside the child, and the field's name and type.";
SPEC_CARDS["R2:V2"] =
  "ArkUI V2 components (@ComponentV2) receive values from their parent when the parent constructs them in its build(). A passed-in field can be used three ways: shared_with_parent = the child's changes must reach the parent's variable (either written through a shared ancestor-provided value or sent back through a callback the parent passed in); child_local_copy = the child starts from the parent's value and edits its own draft, which the parent never sees; parent_display_only = the child only reads and renders the value. Judge from what the child does with the value, which callbacks it invokes, and the field's name and type.";

const MAX_EXCERPTS = 6;

function excerpt(facts: FileFacts, line: number): string {
  const text = facts.lines[line - 1]?.trim() ?? "";
  return `${line}: ${text.length > 160 ? `${text.slice(0, 157)}...` : text}`;
}

/** Function-typed fields of the component that it invokes as this.name(...): the callbacks the child calls back on. */
function invokedCallbacks(facts: FileFacts, c: Candidate): string[] {
  const text = facts.lines.join("\n");
  return c.component.fields
    .filter((f) => f.name !== c.field?.name && /=>/.test(f.type ?? "") && new RegExp(`this\\.${f.name}\\s*(\\?\\.)?\\(`).test(text))
    .map((f) => `${f.name}: ${f.type}`)
    .slice(0, 5);
}

/** extras: harness-supplied facts merged into the slice (for example an R2 parent call site). */
export function buildSlice(facts: FileFacts, c: Candidate, taskContext?: string, extras?: { [key: string]: JsonValue }): { [key: string]: JsonValue } {
  const comp = c.component;
  const lines = new Set<number>([comp.line]);
  let candidate: { [key: string]: JsonValue };

  if (c.field) {
    const f = c.field;
    lines.add(f.line);
    f.readsInBuild.slice(0, 2).forEach((l) => lines.add(l));
    f.writes.slice(0, 3).forEach((w) => lines.add(w.line));
    const typeName = f.type?.replace(/\[\]$/, "").trim();
    if (c.rule === "R2") {
      // No decorators: R2 asks for the intent the decorator should express.
      candidate = {
        kind: c.kind,
        field: f.name,
        type: f.type ?? null,
        has_initializer: f.hasInitializer,
        reads_in_build: f.readsInBuild.length,
        writes: f.writes.slice(0, 5).map((w) => ({ line: w.line, context: w.context, method: w.method, nested_path: w.nestedPath ?? null })),
        write_count: f.writes.length,
        type_is_observed_class: typeName ? facts.observedClasses.includes(typeName) || facts.observedV2Classes.includes(typeName) : null,
        callbacks_invoked: invokedCallbacks(facts, c),
      };
    } else candidate = {
      kind: c.kind,
      field: f.name,
      decorators: f.decorators,
      type: f.type ?? null,
      has_initializer: f.hasInitializer,
      reads_in_build: f.readsInBuild.length,
      writes: f.writes.slice(0, 5).map((w) => ({
        line: w.line, context: w.context, method: w.method, nested_path: w.nestedPath ?? null, nested_depth: nestedDepth(w.nestedPath),
      })),
      type_is_observed_class: typeName ? facts.observedClasses.includes(typeName) : null,
      type_is_observed_v2_class: typeName ? facts.observedV2Classes.includes(typeName) : null,
      object_link_types_in_file: facts.objectLinkTypes,
      type_declared_in_file: typeName ? facts.declaredClasses.includes(typeName) : null,
    };
  } else {
    const r = c.resource!;
    lines.add(r.acquireLine);
    candidate = { kind: c.kind, resource: r.key, resource_kind: r.kind, acquired_in: r.acquireIn, released_in_teardown: r.released };
  }

  return {
    rule: c.rule,
    framework: { name: "ArkUI", state_mgmt: comp.version },
    spec_card: SPEC_CARDS[`${c.rule}:${comp.version}`] ?? null,
    component: comp.name,
    candidate,
    excerpts: [...lines].sort((a, b) => a - b).slice(0, MAX_EXCERPTS).map((l) => excerpt(facts, l)),
    ...(taskContext ? { task_context: taskContext.slice(0, 600) } : {}),
    ...(extras ?? {}),
  };
}

// --- Heuristic backend ---

// Deterministic name/shape heuristics; the zero-config default.

const INTENTIONALLY_STATIC = /debug|log|trace|cache|tmp|temp|prev|last|timer|handle|controller|listener|(Id|Ms|Ts|At)$/;

function choiceAnswer(probabilities: Record<string, number>): Answer {
  const [choice, confidence] = Object.entries(probabilities).reduce((a, b) => (b[1] > a[1] ? b : a));
  return { type: "choice", choice, confidence, probabilities };
}

export class HeuristicBackend implements SystemOneBackend {
  readonly name = "heuristic";

  async systemOne(state: EntryType, questions: Questions): Promise<Result> {
    const s = (typeof state === "object" && state !== null && !Array.isArray(state) ? state : {}) as Record<string, any>;
    const cand = (s.candidate ?? {}) as Record<string, any>;
    const answers: Record<string, Answer> = {};

    if (s.rule === "R1") {
      const field = typeof cand.field === "string" ? cand.field : "";
      const type = typeof cand.type === "string" ? cand.type : "";
      const writes = Array.isArray(cand.writes) ? cand.writes : [];

      // 1. Controller / ViewModel / Manager / Service hard filter
      const isControllerOrModel =
        /Controller|Scroller|Context|Worker|Mutex|Client|Reporter|ViewModel|Manager|Service/i.test(type) ||
        /Controller|Scroller|Context|Worker|Mutex|Client|Reporter|ViewModel|Manager|Service/i.test(field);

      let p = 0.55;
      if (isControllerOrModel) {
        p = 0.05;
      } else {
        const contexts = writes.map((w: any) => w.context);
        const methods = writes.map((w: any) => w.method).filter(Boolean);

        const onlyLifecycle = contexts.length > 0 && contexts.every((c: string) => c === "lifecycle");
        const allInitHelpers =
          methods.length > 0 &&
          methods.every((m: string) => /^init|^calculate|^compute|^setup|^processUiExtNode|Init$/i.test(m));
        const hasInteractive = contexts.some((c: string) => c === "method" || c === "async-callback" || c === "build-closure");
        const hasDirectBuildWrite = contexts.some((c: string) => c === "build");
        const isStaticName =
          /(?:debug|log|trace|cache|tmp|temp|prev|last|timer|handle|controller|listener|config|style)|(?:Id|Ms|Ts|At|Flag|Config|Style)$/i.test(
            field,
          ) && !/^item|^items/i.test(field);

        // Calibrated logistic regression formula (v3 model)
        let z = -0.30;
        if (onlyLifecycle || allInitHelpers) {
          z -= 2.0;
        } else if (hasInteractive) {
          z += 2.10;
        }

        if (hasDirectBuildWrite) z -= 0.6;
        if (isStaticName) z -= 1.4;

        p = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
        p = Math.max(0.05, Math.min(0.95, p));
      }

      answers.is_ui_state = { type: "noul", noul: p };
      answers.intended_static = { type: "noul", noul: 1 - p };
      answers.verdict = choiceAnswer({
        desync_bug: p,
        intentionally_non_reactive: (1 - p) * 0.7,
        not_user_visible: (1 - p) * 0.2,
        insufficient_context: (1 - p) * 0.1,
      });
    } else if (s.rule === "R3") {
      const appScoped = typeof cand.resource === "string" && /AppStorage|globalThis|ability|Application/i.test(cand.resource);
      const p = appScoped ? 0.4 : 0.8;
      answers.app_lifetime = { type: "noul", noul: appScoped ? 0.6 : 0.15 };
      answers.released_elsewhere = { type: "noul", noul: 0.15 };
      answers.verdict = choiceAnswer({ leak_bug: p, intentionally_persistent: appScoped ? 0.45 : 0.1, released_elsewhere: 0.05, insufficient_context: Math.max(0, 0.95 - p - (appScoped ? 0.45 : 0.1)) });
    }

    // Any question this heuristic doesn't model gets an uninformative answer.
    for (const [id, q] of Object.entries(questions)) {
      if (answers[id]) continue;
      if (q.type === "noul") answers[id] = { type: "noul", noul: 0.5 };
      else if (q.type === "choice") {
        const labels = Object.keys(q.criteria);
        answers[id] = choiceAnswer(Object.fromEntries(labels.map((l) => [l, 1 / labels.length])));
      } else {
        const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), 1 / q.criteria.length]));
        answers[id] = { type: "score", score: (q.criteria.length - 1) / 2, confidence: 1 / q.criteria.length, legend: Object.fromEntries(q.criteria.map((d, i) => [String(i), d])), probabilities } as Answer;
      }
    }
    return { backend: this.name, answers, latencyMs: 0 };
  }
}

// --- DeepSeek backend ---

// Always deepseek-flash, thinking disabled: one strict tool call with self-reported probabilities.

const MODEL = "deepseek-flash";

const MAX_ATTEMPTS = 3;

const SYSTEM_STRUCTURED = `You are a decision function. You receive a STATE and typed QUESTIONS.
For each question, give a probability between 0 and 1 for every allowed answer, judged only from the STATE.
Use intermediate probabilities when the evidence is mixed or missing; the probabilities of one question should sum to 1.
Answer by calling submit_answers. If you cannot call tools, reply with only the json object.`;

interface ChatResponse {
  choices: Array<{
    finish_reason: string;
    message: { content: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

type Distribution = Record<string, number>;

function schemaFor(questions: Questions) {
  const properties = Object.fromEntries(
    Object.entries(questions).map(([id, q]) => {
      const labels = labelsOf(q);
      return [id, {
        type: "object",
        additionalProperties: false,
        required: labels,
        properties: Object.fromEntries(labels.map((l) => [l, { type: "number", minimum: 0, maximum: 1 }])),
      }];
    }),
  );
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

function exampleFor(questions: Questions): string {
  return JSON.stringify(Object.fromEntries(Object.entries(questions).map(([id, q]) => {
    const labels = labelsOf(q);
    return [id, Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 0.7 : Number((0.3 / (labels.length - 1)).toFixed(3))]))];
  })));
}

function complete(raw: unknown, questions: Questions): raw is Record<string, Distribution> {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, Record<string, unknown>>;
  return Object.entries(questions).every(([id, q]) =>
    typeof r[id] === "object" && r[id] !== null && labelsOf(q).every((l) => Number.isFinite(r[id][l])));
}

export class DeepSeekBackend implements SystemOneBackend {
  readonly name = MODEL;
  private readonly baseURL: string;
  private readonly apiKey?: string;

  readonly model = MODEL;

  constructor(creds: { apiKey?: string; baseUrl?: string } = {}) {
    this.apiKey = creds.apiKey ?? process.env.DEEPSEEK_API_KEY;
    this.baseURL = (creds.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  }

  async systemOne(state: EntryType, questions: Questions): Promise<Result> {
    validateQuestions(questions);
    const usage = { input_tokens: 0, output_tokens: 0 };
    const t0 = performance.now();

    const dists = await this.structured(state, questions, usage);
    const answers: Record<string, Answer> = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, toAnswer(q, dists[id])]));
    return { backend: this.name, answers, latencyMs: performance.now() - t0, usage };
  }

  private async chat(body: Record<string, unknown>, beta: boolean, usage: Result["usage"] & object): Promise<ChatResponse> {
    const key = this.apiKey;
    if (!key) throw new Error("DeepSeek API key is not configured (deepseek.apiKey in ~/.config/arkui-sem/config.json, or DEEPSEEK_API_KEY)");
    const res = await fetch(`${this.baseURL}${beta ? "/beta" : ""}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, thinking: { type: "disabled" }, ...body }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as ChatResponse;
    usage.input_tokens += data.usage?.prompt_tokens ?? 0;
    usage.output_tokens += data.usage?.completion_tokens ?? 0;
    return data;
  }

  /** One call for all questions: strict tool schema first, json_object mode as the fallback. */
  private async structured(state: EntryType, questions: Questions, usage: Result["usage"] & object): Promise<Record<string, Distribution>> {
    const user = `STATE:\n${text(state)}\n\nQUESTIONS:\n${Object.entries(questions).map(([id, q]) => describeQuestion(id, q)).join("\n")}`;
    const schema = schemaFor(questions);
    let lastError = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const strict = attempt < MAX_ATTEMPTS; // last attempt: plain JSON mode in case the beta endpoint is unavailable
      try {
        const data = strict
          ? await this.chat({
              messages: [{ role: "system", content: SYSTEM_STRUCTURED }, { role: "user", content: user }],
              tools: [{ type: "function", function: { name: "submit_answers", description: "Submit a probability for every allowed answer of every question.", strict: true, parameters: schema } }],
              tool_choice: "required",
              max_tokens: 4096,
            }, true, usage)
          : await this.chat({
              messages: [
                { role: "system", content: `${SYSTEM_STRUCTURED}\nReply with a json object shaped exactly like this example: ${exampleFor(questions)}` },
                { role: "user", content: user },
              ],
              response_format: { type: "json_object" },
              max_tokens: 4096,
            }, false, usage);
        const msg = data.choices[0]?.message;
        const raw = msg?.tool_calls?.[0]?.function.arguments ?? msg?.content ?? "";
        const parsed = JSON.parse(raw) as unknown;
        if (complete(parsed, questions)) return parsed;
        lastError = "response is missing questions or labels";
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    throw new Error(`DeepSeek structured output failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
  }

}

// --- Backend registry ---

export const BACKENDS = [
  "heuristic", "jev", "laya", "clef", "clef-flash", "or-clef", "or-clef-flash",
  "deepseek-flash",
] as const;
export type BackendName = (typeof BACKENDS)[number];

export async function createBackend(name: string, creds: Credentials = {}): Promise<SystemOneBackend> {
  switch (name) {
    case "heuristic":
      return new HeuristicBackend();
    case "jev":
      return new JevBackend(creds.typesafeApiKey);
    case "laya":
      return new JevBackend(undefined, "laya", { baseURL: (creds.layaBaseUrl ?? "http://127.0.0.1:8080").replace(/\/+$/, ""), model: creds.layaModel ?? "laya" });
    case "clef":
    case "clef-flash":
      return new ClefBackend(name === "clef" ? "@cf/cloudflare/clef" : "@cf/cloudflare/clef-flash", { accountId: creds.cloudflareAccountId, apiToken: creds.cloudflareApiToken });
    case "or-clef":
    case "or-clef-flash":
      return new OpenRouterClefBackend(name === "or-clef" ? "cloudflare/clef" : "cloudflare/clef-flash", { apiKey: creds.openrouterApiKey, baseUrl: creds.openrouterBaseUrl });
    case "deepseek-flash":
      return new DeepSeekBackend({ apiKey: creds.deepseekApiKey, baseUrl: creds.deepseekBaseUrl });
    default:
      throw new Error(`Unknown backend "${name}". Expected one of: ${BACKENDS.join(", ")}`);
  }
}
