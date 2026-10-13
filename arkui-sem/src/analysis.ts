// .ets source → program facts → rule candidates. Deterministic; no model calls.
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// --- Facts ---

export type StateMgmtVersion = "V1" | "V2";

export type WriteContext = "build-closure" | "async-callback" | "lifecycle" | "method";

export interface WriteFact {
  line: number;
  context: WriteContext;
  method: string;
  /** Property path below the field for in-place mutation ("title", "items[]"); absent for reassignment. */
  nestedPath?: string;
  /** The writing method is reached neither from build()/@Builder nor from lifecycle hooks: other code calls it. */
  external?: boolean;
  disabledRules: string[];
}

export interface FieldFact {
  name: string;
  line: number;
  decorators: string[];
  type?: string;
  hasInitializer: boolean;
  readsInBuild: number[];
  writes: WriteFact[];
  disabledRules: string[];
}

export interface ResourceFact {
  kind: "listener" | "timer" | "subscription";
  /** "emitter.on:refresh", "timer:this.pollId", "Mgr.getInstance().registerFoo", … */
  key: string;
  acquireLine: number;
  acquireIn: string;
  released: boolean;
  /** The matching release call, for the fix text. */
  release: string;
}

export interface ComponentFact {
  name: string;
  file: string;
  line: number;
  version: StateMgmtVersion;
  fields: FieldFact[];
  resources: ResourceFact[];
}

export interface FileFacts {
  file: string;
  components: ComponentFact[];
  /** V1 @Observed classes. */
  observedClasses: string[];
  observedV2Classes: string[];
  objectLinkTypes: string[];
  declaredClasses: string[];
  /** Declared field types of the classes in the file: class → field → type text. */
  classFields: Record<string, Record<string, string>>;
  /** Classes that extend Array<…>: class → element type text and the class's own type parameters. */
  arrayClasses: Record<string, { element: string; params: string[] }>;
  lines: string[];
}

export interface FactExtractor {
  readonly name: string;
  extract(file: string, text: string): FileFacts;
}

// --- Files ---

const SKIP_DIRS = new Set(["node_modules", "oh_modules", "build", "dist"]);

export const absolute = (p: string, base: string) => (isAbsolute(p) ? p : resolve(base, p));

export function etsFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return path.endsWith(".ets") ? [path] : [];
  return readdirSync(path).flatMap((name) => (SKIP_DIRS.has(name) || name.startsWith(".") ? [] : etsFiles(join(path, name))));
}

export function editedFiles(args: unknown, directory: string): string[] {
  const a = (args ?? {}) as { filePath?: unknown; patchText?: unknown };
  if (typeof a.filePath === "string") return [absolute(a.filePath, directory)];
  if (typeof a.patchText === "string") {
    return [...a.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/gm)]
      .map((m) => absolute((m[1] ?? m[2]).trim(), directory));
  }
  return [];
}

// --- Naive extractor ---

// Text-based and single-file: no type or alias analysis. FactExtractor lets a real analyzer replace it.

const LIFECYCLE = new Set([
  "aboutToAppear", "aboutToDisappear", "onPageShow", "onPageHide", "onBackPress",
  "aboutToReuse", "aboutToRecycle", "onDidBuild",
]);
const ACQUIRE_HOOKS = new Set(["aboutToAppear", "onPageShow", "aboutToReuse", "onDidBuild"]);
const RELEASE_HOOKS = new Set(["aboutToDisappear", "onPageHide", "aboutToRecycle"]);
const MUTATING_CALLS = new Set(["push", "pop", "splice", "shift", "unshift", "sort", "reverse", "fill", "set", "delete", "clear"]);
const ASYNC_MARKERS = /\.then\(|\bawait\b|setTimeout\(|setInterval\(|\.on\(|subscribe\(/;

/** Blank out comments and string contents (keeping `${…}` expressions), preserving offsets and newlines. */
function blank(text: string): string {
  let out = "";
  let state: "code" | "sq" | "dq" | "tpl" | "lc" | "bc" = "code";
  const exprDepth: number[] = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const d = text[i + 1];
    switch (state) {
      case "code":
        if (c === "/" && d === "/") { state = "lc"; out += "  "; i += 2; continue; }
        if (c === "/" && d === "*") { state = "bc"; out += "  "; i += 2; continue; }
        if (c === "'" || c === '"' || c === "`") { state = c === "'" ? "sq" : c === '"' ? "dq" : "tpl"; out += c; i++; continue; }
        if (exprDepth.length > 0) {
          const top = exprDepth.length - 1;
          if (c === "{") exprDepth[top]++;
          else if (c === "}") {
            if (exprDepth[top] === 0) { exprDepth.pop(); state = "tpl"; out += c; i++; continue; }
            exprDepth[top]--;
          }
        }
        out += c; i++; continue;
      case "lc":
        if (c === "\n") { state = "code"; out += c; } else out += " ";
        i++; continue;
      case "bc":
        if (c === "*" && d === "/") { state = "code"; out += "  "; i += 2; continue; }
        out += c === "\n" ? "\n" : " "; i++; continue;
      case "sq":
      case "dq": {
        const quote = state === "sq" ? "'" : '"';
        if (c === "\\") { out += d === "\n" ? " \n" : "  "; i += 2; continue; }
        if (c === quote || c === "\n") { state = "code"; out += c; i++; continue; }
        out += " "; i++; continue;
      }
      case "tpl":
        if (c === "\\") { out += d === "\n" ? " \n" : "  "; i += 2; continue; }
        if (c === "`") { state = "code"; out += c; i++; continue; }
        if (c === "$" && d === "{") { out += "${"; i += 2; state = "code"; exprDepth.push(0); continue; }
        out += c === "\n" ? "\n" : " "; i++; continue;
    }
  }
  return out;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

/**
 * Methods no code in the component reaches from build()/@Builder (calls or `this.m` references, e.g. `.onClick(this.m)`)
 * or from lifecycle hooks (calls): entry points for listeners, callbacks and other classes.
 */
function externalMethods(methods: Method[], code: string[]): Set<string> {
  const names = new Set(methods.map((m) => m.name));
  const edges = new Map(methods.map((m) => {
    const calls = new Set<string>(), refs = new Set<string>();
    for (let i = m.firstLine; i <= m.lastLine; i++) {
      for (const h of code[i].matchAll(/this\.(\w+)(\s*\()?/g)) {
        if (names.has(h[1]) && h[1] !== m.name) (h[2] ? calls : refs).add(h[1]);
      }
    }
    return [m.name, { calls, refs }] as const;
  }));
  const reach = (roots: string[], viaRefs: boolean) => {
    const seen = new Set(roots), todo = [...roots];
    while (todo.length) {
      const e = edges.get(todo.pop()!)!;
      for (const n of [...e.calls, ...(viaRefs ? e.refs : [])]) {
        if (!seen.has(n) && !LIFECYCLE.has(n)) { seen.add(n); todo.push(n); }
      }
    }
    return seen;
  };
  const roots = (f: (m: Method) => boolean) => methods.filter(f).map((m) => m.name);
  const fromBuild = reach(roots((m) => m.name === "build" || m.decorators.includes("@Builder")), true);
  const fromLifecycle = reach(roots((m) => LIFECYCLE.has(m.name)), false);
  return new Set([...names].filter((n) => !LIFECYCLE.has(n) && !fromBuild.has(n) && !fromLifecycle.has(n)));
}

interface Method {
  name: string;
  decorators: string[];
  firstLine: number;
  lastLine: number;
}

const DECORATOR = /@\w+(?:\([^)]*\))?/g;
const DECORATOR_ONLY = /^\s*(?:@\w+(?:\([^)]*\))?\s*)+$/;
const METHOD = /^\s*(?:(?:private|public|protected|static|async)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(/;
const FIELD = /^\s*(?:(?:private|public|protected|static|readonly)\s+)*(\w+)\s*[?!]?\s*(?::\s*([^=;]+?))?\s*(=.*)?;?\s*$/;

function decoratorsOf(s: string): string[] {
  return (s.match(DECORATOR) ?? []).map((d) => d.replace(/\(.*$/, ""));
}

function disabledRulesAt(raw: string[], index: number): string[] {
  const prev = raw[index - 1] ?? "";
  const m = prev.match(/arkui-sem-disable-next-line\s+([\w\s,]+)/);
  return m ? m[1].split(/[\s,]+/).filter((r) => /^R\d+$/.test(r)) : [];
}

export class NaiveExtractor implements FactExtractor {
  readonly name = "naive";

  extract(file: string, text: string): FileFacts {
    const raw = text.split(/\r?\n/);
    const code = blank(text).split(/\r?\n/);

    const depthBefore: number[] = [];
    let depth = 0;
    for (const line of code) {
      depthBefore.push(depth);
      depth += count(line, "{") - count(line, "}");
    }
    const depthAfter = (i: number) => depthBefore[i] + count(code[i], "{") - count(code[i], "}");

    const flat = blank(text);
    const observedClasses = [...flat.matchAll(/@Observed\s+(?:export\s+)?class\s+(\w+)/g)].map((m) => m[1]);
    const observedV2Classes = [...flat.matchAll(/@ObservedV2\s+(?:export\s+)?class\s+(\w+)/g)].map((m) => m[1]);
    const declaredClasses = [...flat.matchAll(/\bclass\s+(\w+)/g)].map((m) => m[1]);

    const components: ComponentFact[] = [];
    for (let i = 0; i < code.length; i++) {
      const sm = code[i].match(/\bstruct\s+(\w+)/);
      if (!sm) continue;
      const header = code.slice(Math.max(0, i - 4), i + 1).join(" ");
      const decos = decoratorsOf(header);
      if (!decos.includes("@Component") && !decos.includes("@ComponentV2")) continue;

      const structDepth = depthBefore[i];
      let end = i;
      while (end + 1 < code.length && !(end > i && depthAfter(end) <= structDepth)) end++;

      components.push(this.component(file, sm[1], decos.includes("@ComponentV2") ? "V2" : "V1", i, end, structDepth, raw, code, depthBefore, depthAfter));
      i = end;
    }
    const objectLinkTypes = components.flatMap((c) =>
      c.fields.filter((f) => f.decorators.includes("@ObjectLink") && f.type).map((f) => f.type!.replace(/\[\]$/, "").trim()));
    const { classFields, arrayClasses } = this.classes(code, depthBefore, depthAfter);
    return { file, components, observedClasses, observedV2Classes, objectLinkTypes, declaredClasses, classFields, arrayClasses, lines: raw };
  }

  private classes(code: string[], depthBefore: number[], depthAfter: (i: number) => number): Pick<FileFacts, "classFields" | "arrayClasses"> {
    const classFields: FileFacts["classFields"] = {};
    const arrayClasses: FileFacts["arrayClasses"] = {};
    for (let i = 0; i < code.length; i++) {
      const cm = code[i].match(/\bclass\s+(\w+)\s*(?:<([^>]*)>)?/);
      if (!cm) continue;
      const am = code[i].match(/\bextends\s+Array\s*<(.+?)>\s*(?:implements\b[^{]*)?(?:\{|$)/);
      if (am) arrayClasses[cm[1]] = { element: am[1].trim(), params: (cm[2] ?? "").split(",").map((p) => p.trim().split(/\s/)[0]).filter(Boolean) };
      const classDepth = depthBefore[i];
      const fields: Record<string, string> = {};
      classFields[cm[1]] = fields;
      if (code[i].includes("{") && depthAfter(i) <= classDepth) continue; // body opens and closes on the header line
      let end = i;
      while (end + 1 < code.length && !(end > i && depthAfter(end) <= classDepth)) {
        end++;
        if (depthBefore[end] !== classDepth + 1) continue;
        const fm = code[end].replace(/^\s*(?:@\w+(?:\([^)]*\))?\s*)*/, "").match(FIELD);
        if (fm?.[2]) fields[fm[1]] = fm[2].trim();
      }
      i = end;
    }
    return { classFields, arrayClasses };
  }

  private component(
    file: string, name: string, version: "V1" | "V2", start: number, end: number, structDepth: number,
    raw: string[], code: string[], depthBefore: number[], depthAfter: (i: number) => number,
  ): ComponentFact {
    const fields: FieldFact[] = [];
    const methods: Method[] = [];
    let pending: string[] = [];
    let pendingStart = -1;

    for (let i = start + 1; i < end; i++) {
      if (depthBefore[i] !== structDepth + 1) continue;
      const line = code[i];
      if (line.trim() === "") continue;
      if (DECORATOR_ONLY.test(line)) {
        if (pending.length === 0) pendingStart = i;
        pending.push(...decoratorsOf(line));
        continue;
      }

      const inline = decoratorsOf(line.match(/^\s*(?:@\w+(?:\([^)]*\))?\s*)*/)?.[0] ?? "");
      const rest = line.replace(/^\s*(?:@\w+(?:\([^)]*\))?\s*)*/, "");
      const decorators = [...pending, ...inline];
      // The disable comment may sit above the decorator lines or directly above the field name.
      const disabledRules = [...new Set([...disabledRulesAt(raw, i), ...(pending.length ? disabledRulesAt(raw, pendingStart) : [])])];
      pending = [];

      const mm = rest.match(METHOD);
      if (mm && !/^\s*\w+\s*[?!]?\s*:/.test(rest)) {
        let mEnd = i;
        while (mEnd + 1 < end && !(depthAfter(mEnd) <= structDepth + 1 && (mEnd > i || code[i].includes("}")))) mEnd++;
        methods.push({ name: mm[1], decorators, firstLine: i, lastLine: mEnd });
        i = mEnd;
        continue;
      }
      const fm = rest.match(FIELD);
      if (fm) {
        fields.push({
          name: fm[1], line: i + 1, decorators, type: fm[2]?.trim(), hasInitializer: fm[3] !== undefined,
          readsInBuild: [], writes: [], disabledRules,
        });
      }
    }

    const byName = new Map(fields.map((f) => [f.name, f]));
    for (const m of methods) this.scanMethod(m, raw, code, byName);
    const external = externalMethods(methods, code);
    for (const f of fields) for (const w of f.writes) w.external = external.has(w.method);

    return { name, file, line: start + 1, version, fields, resources: this.resources(methods, raw) };
  }

  private scanMethod(m: Method, raw: string[], code: string[], fields: Map<string, FieldFact>) {
    const isBuild = m.name === "build" || m.decorators.includes("@Builder");
    for (let i = m.firstLine; i <= m.lastLine; i++) {
      const line = code[i];
      for (const hit of line.matchAll(/this\.(\w+)/g)) {
        const field = fields.get(hit[1]);
        if (!field) continue;
        const after = line.slice((hit.index ?? 0) + hit[0].length);
        const chain = after.match(/^((?:\??\.\w+|\[[^\]]*\])*)/)?.[1] ?? "";
        const tail = after.slice(chain.length);
        const before = line.slice(0, hit.index ?? 0);

        const lastCall = chain.match(/\.(\w+)$/)?.[1];
        const mutatingCall = lastCall !== undefined && MUTATING_CALLS.has(lastCall) && /^\s*\(/.test(tail);
        const assigned = /^\s*(?:=(?![=>])|\+=|-=|\*=|\/=|%=|\+\+|--)/.test(tail) || /(?:\+\+|--)\s*$/.test(before);

        if (!assigned && !mutatingCall) {
          if (isBuild && !field.readsInBuild.includes(i + 1)) field.readsInBuild.push(i + 1);
          continue;
        }
        const nested = mutatingCall ? chain.replace(/\.\w+$/, "") + "[]" : chain;
        const window = code.slice(Math.max(m.firstLine, i - 3), i + 1).join("\n");
        const isAsync = ASYNC_MARKERS.test(window);
        const context: WriteContext = isAsync ? "async-callback"
          : isBuild ? "build-closure"
          : LIFECYCLE.has(m.name) ? "lifecycle"
          : "method";
        field.writes.push({ line: i + 1, context, method: m.name, nestedPath: nested || undefined, disabledRules: disabledRulesAt(raw, i) });
      }
    }
  }

  private resources(methods: Method[], raw: string[]): ResourceFact[] {
    const body = (m: Method) => raw.slice(m.firstLine, m.lastLine + 1).join("\n");
    // A lifecycle hook plus the same-component helpers it calls directly (one level), e.g. aboutToDisappear → this.unregisterAll().
    const scope = (hooks: Set<string>) => methods.filter((m) => hooks.has(m.name)).flatMap((h) => [
      { m: h, via: h.name },
      ...[...new Set([...body(h).matchAll(/\bthis\.(\w+)\s*\(/g)].map((x) => x[1]))]
        .map((n) => methods.find((m) => m.name === n && !LIFECYCLE.has(n)))
        .filter((m): m is Method => m !== undefined)
        .map((m) => ({ m, via: `${h.name}→${m.name}` })),
    ]);
    const released = scope(RELEASE_HOOKS).map((s) => body(s.m)).join("\n");
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const out: ResourceFact[] = [];
    const seen = new Set<string>();
    const add = (r: ResourceFact) => { if (!seen.has(r.key)) { seen.add(r.key); out.push(r); } };
    for (const { m, via } of scope(ACQUIRE_HOOKS)) {
      for (let i = m.firstLine; i <= m.lastLine; i++) {
        const line = raw[i];
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        // Event listeners: target.on('event' | CONST.EVENT, handler) ↔ target.off(same event).
        for (const on of line.matchAll(/([\w$.]+(?:\(\))?)\.on\(\s*((['"])[^'"]+\3|[\w$.]+)\s*[,)]/g)) {
          const [, target, event] = on;
          const name = event.replace(/^['"]|['"]$/g, "");
          const off = new RegExp(`\\.off\\(\\s*(['"]${esc(name)}['"]|${esc(name)})\\s*[,)]`);
          add({ kind: "listener", key: `${target}.on:${name}`, acquireLine: i + 1, acquireIn: via, released: off.test(released),
            release: `${target}.off(${event}, <same handler>)` });
        }
        // Registrations: registerX ↔ unregisterX, subscribe ↔ unsubscribe, addXListener/Observer ↔ removeX.
        for (const reg of line.matchAll(/([\w$.]+(?:\(\))?)\.(register\w*|subscribe\w*|add\w*(?:Listener|Observer|Callback))\(/g)) {
          const [, target, method] = reg;
          const undo = method.startsWith("add") ? `remove${method.slice(3)}` : `un${method}`;
          const releasedHere = new RegExp(`\\b${esc(undo)}\\s*\\(`, "i").test(released);
          add({ kind: "subscription", key: `${target}.${method}`, acquireLine: i + 1, acquireIn: via, released: releasedHere,
            release: `${target}.${undo}(...)` });
        }
        const timer = line.match(/(this\.\w+)\s*=\s*setInterval\(/);
        if (timer) {
          add({ kind: "timer", key: `timer:${timer[1]}`, acquireLine: i + 1, acquireIn: via, released: released.includes(`clearInterval(${timer[1]}`),
            release: `clearInterval(${timer[1]})` });
        } else if (/\bsetInterval\(/.test(line)) {
          add({ kind: "timer", key: `timer:anonymous@${i + 1}`, acquireLine: i + 1, acquireIn: via, released: false, release: "clearInterval(<the interval id>)" });
        }
      }
    }
    return out;
  }
}

// --- Rules ---

export type RuleId = "R1" | "R2" | "R3";

export type CandidateKind =
  | "undecorated-mutated-rendered" // R1: plain member written after init and read in build()
  | "nested-write-unobserved"      // R1: in-place write deeper than the state decorator observes
  | "ownership-intent"             // R2: passed-in field; candidates() does not emit it (callers build it)
  | "unreleased-resource";         // R3: acquired in a lifecycle hook, no matching release

export interface Candidate {
  rule: RuleId;
  kind: CandidateKind;
  file: string;
  component: ComponentFact;
  field?: FieldFact;
  resource?: ResourceFact;
  line: number;
  /** Nested-write: every unobserved write, in source order. */
  writes?: WriteFact[];
  /** Stable across runs: dedupe, cache, dismissals. */
  fingerprint: string;
}

const REACTIVE_V1 = new Set([
  "@State", "@Prop", "@Link", "@ObjectLink", "@Provide", "@Consume",
  "@StorageLink", "@StorageProp", "@LocalStorageLink", "@LocalStorageProp",
]);
const REACTIVE_V2 = new Set(["@Local", "@Param", "@Provider", "@Consumer"]);
// Fields that never hold renderable state.
const NON_STATE = new Set(["@BuilderParam", "@Event", "@Require"]);

const isReactive = (f: FieldFact) => f.decorators.some((d) => REACTIVE_V1.has(d) || REACTIVE_V2.has(d));
const isReactiveV1 = (f: FieldFact) => f.decorators.some((d) => REACTIVE_V1.has(d));
const baseType = (t?: string) => t?.replace(/\[\]$/, "").replace(/\s*\|\s*(undefined|null)$/, "").trim();

const segments = (path?: string) => path?.match(/\??\.\w+|\[[^\]]*\]/g) ?? [];

/** Levels below the field a write reaches: ".title" → 1, ".address.city" → 2, "[i].title" → 2, "[]" (array call) → 1. */
export const nestedDepth = (path?: string) => segments(path).length;

const nonNull = (t: string) => t.replace(/\s*\|\s*(?:undefined|null)\b/g, "").trim();
const className = (t: string) => nonNull(t).replace(/<.*>$/, "").trim();
const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

/** Element type of X[], Array<X>, or a file class extending Array<…> (its type parameters bound from t's arguments). */
function elementType(t: string, facts: FileFacts): string | undefined {
  const builtin = (t.match(/^(.+)\[\]$/) ?? t.match(/^Array<(.+)>$/))?.[1].trim();
  if (builtin !== undefined) return builtin;
  const cls = own(facts.arrayClasses, className(t));
  if (!cls) return undefined;
  const args = t.match(/<(.+)>$/)?.[1].split(",").map((a) => a.trim()) ?? [];
  const param = cls.params.indexOf(cls.element);
  return param < 0 ? cls.element : args[param];
}

/** Declared type of this.<field><segs>, from the field's type and the file's class fields; undefined when unknown. */
function typeAt(fieldType: string | undefined, segs: string[], facts: FileFacts): string | undefined {
  let t = fieldType && nonNull(fieldType);
  for (const s of segs) {
    if (t === undefined) return undefined;
    const prop = s.match(/^\??\.(\w+)$/)?.[1];
    const fields = own(facts.classFields, className(t));
    const next = prop === undefined ? elementType(t, facts) : fields && own(fields, prop);
    t = next && nonNull(next);
  }
  return t;
}

/** Whether build() or a @Builder reads this.<field><path> or deeper; any index matches any index, with or without ?. before
 *  it. For an array call ("…[]") only reads of the contents count, so passing the array itself to a child does not. */
function rendersPath(f: FieldFact, path: string, facts: FileFacts): boolean {
  const arrayCall = path.endsWith("[]");
  const tail = segments(arrayCall ? path.slice(0, -2) : path)
    .map((s) => (s.startsWith("[") ? "(?:\\?\\.)?\\[[^\\]]*\\]" : "\\??\\." + s.replace(/^\??\./, "")))
    .join("");
  const read = new RegExp(`\\bthis\\.${f.name}${tail}${arrayCall ? "(?:(?:\\?\\.)?\\[|\\??\\.\\w)" : "(?!\\w)"}`);
  return f.readsInBuild.some((l) => read.test(facts.lines[l - 1] ?? ""));
}

/** V1: a property change on an @Observed object reaches every @ObjectLink bound to that object (OpenHarmony @Observed/@ObjectLink
 *  docs), so a deep write is seen when a child in the file takes the owning class as @ObjectLink, unless the parent renders the
 *  path itself. */
function seenByObjectLink(f: FieldFact, w: WriteFact, facts: FileFacts): boolean {
  const owner = typeAt(f.type, segments(w.nestedPath).slice(0, -1), facts);
  if (owner === undefined) return false;
  const cls = className(owner);
  return facts.observedClasses.includes(cls) && facts.objectLinkTypes.some((t) => className(t) === cls)
    && !rendersPath(f, w.nestedPath!, facts);
}

/** Writes the decorator can't see, minus writes under a disable comment. V1: deeper than the first layer, even with @Observed
 *  classes, unless an @ObjectLink child sees them. V2: any property write unless the class is @ObservedV2. */
function unobservedWrites(f: FieldFact, facts: FileFacts) {
  const writes = f.writes.filter((w) => !w.disabledRules.includes("R1"));
  if (isReactiveV1(f)) return writes.filter((w) => nestedDepth(w.nestedPath) >= 2 && !seenByObjectLink(f, w, facts));
  const type = baseType(f.type);
  if (type !== undefined && facts.observedV2Classes.includes(type)) return [];
  return writes.filter((w) => w.nestedPath && w.nestedPath !== "[]");
}

export function candidates(facts: FileFacts): Candidate[] {
  const out: Candidate[] = [];
  for (const c of facts.components) {
    for (const f of c.fields) {
      if (f.decorators.some((d) => NON_STATE.has(d))) continue;

      if (!isReactive(f) && f.readsInBuild.length > 0 && f.writes.length > 0 && !f.disabledRules.includes("R1")) {
        out.push({
          rule: "R1", kind: "undecorated-mutated-rendered", file: facts.file, component: c, field: f,
          line: f.line, fingerprint: `${facts.file}#${c.name}.${f.name}#R1-undecorated`,
        });
      }

      const nested = isReactive(f) ? unobservedWrites(f, facts) : [];
      if (nested.length > 0 && f.readsInBuild.length > 0 && !f.disabledRules.includes("R1")) {
        out.push({
          rule: "R1", kind: "nested-write-unobserved", file: facts.file, component: c, field: f,
          line: nested[0].line, writes: nested, fingerprint: `${facts.file}#${c.name}.${f.name}#R1-nested`,
        });
      }
    }
    for (const r of c.resources) {
      if (r.released) continue;
      if (disabledRulesAt(facts.lines, r.acquireLine - 1).includes("R3")) continue;
      out.push({
        rule: "R3", kind: "unreleased-resource", file: facts.file, component: c, resource: r,
        line: r.acquireLine, fingerprint: `${facts.file}#${c.name}#R3-${r.key}`,
      });
    }
  }
  return out;
}
