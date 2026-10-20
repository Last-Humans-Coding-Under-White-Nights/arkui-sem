// .ets source → program facts → rule candidates. Deterministic; no model calls.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

// --- Facts ---

export type StateMgmtVersion = 'V1' | 'V2';

export type WriteContext = 'build-closure' | 'async-callback' | 'lifecycle' | 'method';

export interface WriteFact {
  line: number;
  context: WriteContext;
  method: string;
  /** Property path below the field for in-place mutation ("title", "items[]"); absent for reassignment. */
  nestedPath?: string;
  /** For an assignment (`=`, compound or update), what the assigned value is. */
  value?: 'object-literal' | 'new' | 'other';
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
  /** Text of an object-literal initializer (`{…}`, possibly cut at the line end): a plain object, whatever the type. */
  literal?: string;
  readsInBuild: number[];
  writes: WriteFact[];
  disabledRules: string[];
}

export interface ResourceFact {
  kind: 'listener' | 'timer' | 'subscription';
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
  /** Interfaces and object type aliases. */
  declaredTypes: string[];
  /** Members of the classes, interfaces and object type aliases: class → member name → its facts. */
  classMembers: Record<string, Record<string, ClassMember>>;
  /** What each class or interface in the file extends (other than Array): child → parent names. */
  classParents: Record<string, string[]>;
  /** Classes that extend Array<…>: class → element type text and the class's own type parameters. */
  arrayClasses: Record<string, { element: string; params: string[] }>;
  lines: string[];
}

export interface ClassMember {
  decorators: string[];
  setter: boolean;
  /** Fields: the declared type, else the class of a `new X(…)` initializer. */
  type?: string;
  /** Text of an object-literal initializer, as for FieldFact. */
  literal?: string;
}

export interface FactExtractor {
  readonly name: string;
  extract(file: string, text: string): FileFacts;
}

// --- Files ---

const SKIP_DIRS = new Set(['node_modules', 'oh_modules', 'build', 'dist']);

export function absolute(p: string, base: string) {
  return isAbsolute(p) ? p : resolve(base, p);
}

export function etsFiles(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  if (statSync(path).isFile()) {
    return path.endsWith('.ets') ? [path] : [];
  }
  return readdirSync(path).flatMap((name) =>
    SKIP_DIRS.has(name) || name.startsWith('.') ? [] : etsFiles(join(path, name)),
  );
}

export function editedFiles(args: unknown, directory: string): string[] {
  const a = (args ?? {}) as { filePath?: unknown; patchText?: unknown };
  if (typeof a.filePath === 'string') {
    return [absolute(a.filePath, directory)];
  }
  if (typeof a.patchText === 'string') {
    return [...a.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) =>
      absolute((m[1] ?? m[2]).trim(), directory),
    );
  }
  return [];
}

// --- Naive extractor ---

// Text-based and single-file: no type or alias analysis. FactExtractor lets a real analyzer replace it.

const LIFECYCLE = new Set([
  'aboutToAppear',
  'aboutToDisappear',
  'onPageShow',
  'onPageHide',
  'onBackPress',
  'aboutToReuse',
  'aboutToRecycle',
  'onDidBuild',
]);
const ACQUIRE_HOOKS = new Set(['aboutToAppear', 'onPageShow', 'aboutToReuse', 'onDidBuild']);
const RELEASE_HOOKS = new Set(['aboutToDisappear', 'onPageHide', 'aboutToRecycle']);
const MUTATING_CALLS = new Set([
  'push',
  'pop',
  'splice',
  'shift',
  'unshift',
  'sort',
  'reverse',
  'fill',
  'set',
  'delete',
  'clear',
]);
const ASYNC_MARKERS = /\.then\(|\bawait\b|setTimeout\(|setInterval\(|\.on\(|subscribe\(/;

/** Brace depth before each line, and after a given line. */
function braceDepths(code: string[]): { depthBefore: number[]; depthAfter: (i: number) => number } {
  const depthBefore: number[] = [];
  let depth = 0;
  for (const line of code) {
    depthBefore.push(depth);
    depth += count(line, '{') - count(line, '}');
  }
  return { depthBefore, depthAfter: (i) => depthBefore[i] + count(code[i], '{') - count(code[i], '}') };
}

/** Code before a / that starts a regex literal rather than a division: an operator or opening bracket, a logical not (a
 *  non-null assertion `x!` follows its operand directly), or a keyword. */
const REGEX_BEFORE = /(?:[(,=:[&|?{};+\-*%<>~^}]|(?:^|[^\w$)\]])!|\b(?:return|typeof|case|in|of))$/;

/** Whether a / after out starts a regex: judged by the code before it, across line breaks (after a name or a closing
 *  bracket it divides, even on a continuation line). */
function regexAllowed(out: string[]): boolean {
  let k = out.length - 1;
  while (k >= 0 && out[k].trim() === '') {
    k--; // whitespace, including blanked comments
  }
  let before = '';
  for (; k >= 0 && before.length < 64; k--) {
    before = out[k] + before;
  }
  before = before.trimEnd();
  // A postfix ++ or -- ends an operand, so the / divides.
  return before === '' || (REGEX_BEFORE.test(before) && !/[\w$)\]](?:\+\+|--)$/.test(before));
}

/** Blank out comments, string contents (keeping `${…}` expressions) and regex literal contents, preserving offsets and
 *  newlines. */
function blank(text: string): string {
  const out: string[] = [];
  let state: 'code' | 'sq' | 'dq' | 'tpl' | 'lc' | 'bc' | 're' = 'code';
  let reClass = false; // inside [...] of a regex literal, where / doesn't end it
  const exprDepth: number[] = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const d = text[i + 1];
    switch (state) {
      case 'code':
        if (c === '/' && d === '/') {
          state = 'lc';
          out.push('  ');
          i += 2;
          continue;
        }
        if (c === '/' && d === '*') {
          state = 'bc';
          out.push('  ');
          i += 2;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') {
          state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
          out.push(c);
          i++;
          continue;
        }
        if (c === '/' && regexAllowed(out)) {
          state = 're';
          reClass = false;
          out.push(c);
          i++;
          continue;
        }
        if (exprDepth.length > 0) {
          const top = exprDepth.length - 1;
          if (c === '{') {
            exprDepth[top]++;
          } else if (c === '}') {
            if (exprDepth[top] === 0) {
              exprDepth.pop();
              state = 'tpl';
              out.push(c);
              i++;
              continue;
            }
            exprDepth[top]--;
          }
        }
        out.push(c);
        i++;
        continue;
      case 're':
        if (c === '\\' && d !== '\n') {
          out.push('  ');
          i += 2;
          continue;
        }
        if ((c === '/' && !reClass) || c === '\n') {
          state = 'code';
          out.push(c);
        } else {
          reClass = c === '[' ? true : c === ']' ? false : reClass;
          out.push(' ');
        }
        i++;
        continue;
      case 'lc':
        if (c === '\n') {
          state = 'code';
          out.push(c);
        } else {
          out.push(' ');
        }
        i++;
        continue;
      case 'bc':
        if (c === '*' && d === '/') {
          state = 'code';
          out.push('  ');
          i += 2;
          continue;
        }
        out.push(c === '\n' ? '\n' : ' ');
        i++;
        continue;
      case 'sq':
      case 'dq': {
        const quote = state === 'sq' ? "'" : '"';
        if (c === '\\') {
          out.push(d === '\n' ? ' \n' : '  ');
          i += 2;
          continue;
        }
        if (c === quote || c === '\n') {
          state = 'code';
          out.push(c);
          i++;
          continue;
        }
        out.push(' ');
        i++;
        continue;
      }
      case 'tpl':
        if (c === '\\') {
          out.push(d === '\n' ? ' \n' : '  ');
          i += 2;
          continue;
        }
        if (c === '`') {
          state = 'code';
          out.push(c);
          i++;
          continue;
        }
        if (c === '$' && d === '{') {
          out.push('${');
          i += 2;
          state = 'code';
          exprDepth.push(0);
          continue;
        }
        out.push(c === '\n' ? '\n' : ' ');
        i++;
        continue;
    }
  }
  return out.join('');
}

function count(s: string, ch: string) {
  return s.split(ch).length - 1;
}

/**
 * Methods no code in the component reaches from build()/@Builder (calls or `this.m` references, e.g. `.onClick(this.m)`)
 * or from lifecycle hooks (calls): entry points for listeners, callbacks and other classes.
 */
function externalMethods(methods: Method[], code: string[]): Set<string> {
  const names = new Set(methods.map((m) => m.name));
  const edges = new Map(
    methods.map((m) => {
      const calls = new Set<string>();
      const refs = new Set<string>();
      for (let i = m.firstLine; i <= m.lastLine; i++) {
        for (const h of code[i].matchAll(/this\.([\w$]+)(\s*\()?/g)) {
          if (names.has(h[1]) && h[1] !== m.name) {
            (h[2] ? calls : refs).add(h[1]);
          }
        }
      }
      return [m.name, { calls, refs }] as const;
    }),
  );
  function reach(roots: string[], viaRefs: boolean) {
    const seen = new Set(roots);
    const todo = [...roots];
    for (let m = todo.pop(); m !== undefined; m = todo.pop()) {
      const e = edges.get(m);
      if (!e) {
        continue;
      }
      for (const n of [...e.calls, ...(viaRefs ? e.refs : [])]) {
        if (!seen.has(n) && !LIFECYCLE.has(n)) {
          seen.add(n);
          todo.push(n);
        }
      }
    }
    return seen;
  }
  function roots(f: (m: Method) => boolean) {
    return methods.filter(f).map((m) => m.name);
  }
  const fromBuild = reach(
    roots((m) => m.name === 'build' || m.decorators.includes('@Builder')),
    true,
  );
  const fromLifecycle = reach(
    roots((m) => LIFECYCLE.has(m.name)),
    false,
  );
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
const DECORATOR_PREFIX = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*/;
/** Member modifiers before a name. */
const MODIFIERS = String.raw`(?:(?:private|public|protected|static|readonly|override|declare|accessor|abstract|async)\s+)*`;
const METHOD = new RegExp(String.raw`^\s*${MODIFIERS}([\w$]+)\s*(?:<[^>]*>)?\s*\(`);
const FIELD = new RegExp(
  String.raw`^\s*${MODIFIERS}([\w$]+)\s*[?!]?\s*(?::\s*((?:=>|\{(?:[^{}]|\{[^{}]*\})*\}|[^=;{])+?))?\s*(=(?!>).*?)?[;,]?\s*$`,
);

const NEW_INSTANCE = /^\s*new\s+([\w$]+(?:\s*<[^()]*>)?)\s*\(/;

/** A FIELD match's declared type, else the class of a `= new X(…)` initializer. */
function fieldType(fm: RegExpMatchArray): string | undefined {
  return fm[2]?.trim() ?? fm[3]?.replace(/^=/, '').match(NEW_INSTANCE)?.[1];
}

function literalOf(fm: RegExpMatchArray): string | undefined {
  const init = fm[3]?.replace(/^=\s*/, '');
  return init?.startsWith('{') ? init : undefined;
}

/** The value text of prop in an object literal's text, when the literal spells it out. */
function literalValue(literal: string, prop: string): string | undefined {
  const body = literal.replace(/^\{/, '').replace(/\}[\s;]*$/, '');
  for (const part of splitTopLevel(body, ',;')) {
    const m = part.match(/^\s*([\w$]+)\s*:\s*([\s\S]*?)\s*$/);
    if (m?.[1] === prop) {
      return m[2];
    }
  }
  return undefined;
}

const CLOSES: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' };

/** Members of a class or struct body after the line open, through the line close (its text before the closing brace), at
 *  depth: each member's first and last
 *  line. A member runs until the next line at member depth that starts code outside an open ( or [ (wrapped parameters,
 *  calls, arrays and an own-line body brace stay with their member). Brackets count only on lines at or returning to member
 *  depth, so method bodies can't unbalance them. */
function memberRanges(
  code: string[],
  depthBefore: number[],
  open: number,
  close: number,
  depth: number,
): { first: number; last: number }[] {
  const out: { first: number; last: number }[] = [];
  let unclosed = 0;
  for (let i = open + 1; i <= close; i++) {
    // The closing line holds a member only before its closing brace (`  @Trace age = 0 }`).
    const line = i === close ? code[i].slice(0, code[i].lastIndexOf('}')) : code[i];
    const startsMember = !/^\s*(?:\{|$)/.test(line); // a body brace on its own line continues the member above
    if (depthBefore[i] === depth + 1 && unclosed === 0 && startsMember) {
      out.push({ first: i, last: i });
    } else if (out.length > 0) {
      out[out.length - 1].last = i;
    }
    const touchesMembers =
      depthBefore[i] === depth + 1 || depthBefore[i] + count(line, '{') - count(line, '}') === depth + 1;
    if (touchesMembers) {
      unclosed = Math.max(0, unclosed + count(line, '(') + count(line, '[') - count(line, ')') - count(line, ']'));
    }
  }
  return out;
}

/** A class, interface or object type alias declared on line: its name, type parameter text, and where its header continues
 *  (after the type parameters). */
function typeHeader(
  line: string,
): { kind: 'class' | 'interface' | 'type'; name: string; typeParams?: string; end: number } | undefined {
  const m = line.match(/\b(class|interface|type)\s+(\w+)\s*/);
  if (!m) {
    return undefined;
  }
  let end = (m.index ?? 0) + m[0].length;
  let typeParams: string | undefined;
  if (line[end] === '<') {
    const close = end + splitTopLevel(line.slice(end + 1), '>')[0].length + 1;
    typeParams = line.slice(end + 1, close);
    end = close + 1;
  }
  if (m[1] === 'type' && !/^\s*=\s*\{/.test(line.slice(end))) {
    return undefined;
  }
  return { kind: m[1] as 'class' | 'interface' | 'type', name: m[2], typeParams, end };
}

/** Splits text at separators outside (), [], {} and type arguments. A < opens type arguments only right after a name
 *  (`Map<`, not `a < b`), and a > closes only an open < (not an arrow's =>). With afterBlock, a top-level } followed by a
 *  name or decorator also ends a part (a method body in a one-line class). */
function splitTopLevel(text: string, separators: string, afterBlock = false): string[] {
  const parts: string[] = [];
  const open: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c) || (c === '<' && /\w/.test(text[i - 1] ?? ''))) {
      open.push(c);
    } else if (c in CLOSES && open.at(-1) === CLOSES[c] && !(c === '>' && text[i - 1] === '=')) {
      open.pop();
      if (afterBlock && c === '}' && open.length === 0 && /^\s*[@\w$]/.test(text.slice(i + 1))) {
        parts.push(text.slice(start, i + 1));
        start = i + 1;
      }
    } else if (open.length === 0 && separators.includes(c)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Feeds a member-level line to pending decorators: true when the line is blank or holds only decorators. */
function decoratorLine(line: string, pending: string[]): boolean {
  if (line.trim() === '') {
    return true;
  }
  if (DECORATOR_ONLY.test(line)) {
    pending.push(...decoratorsOf(line));
    return true;
  }
  return false;
}

function decoratorsOf(s: string): string[] {
  return (s.match(DECORATOR) ?? []).map((d) => d.replace(/\(.*$/, ''));
}

function assignedValue(tail: string): WriteFact['value'] {
  const value = tail.match(/^\s*=\s*(.*)$/)?.[1];
  return value?.startsWith('{') ? 'object-literal' : value !== undefined && /^new\b/.test(value) ? 'new' : 'other';
}

/** An assignment or update operator after a target: =, compound and logical assignments, ++ and --. */
const ASSIGN_OP = String.raw`(?:(?:\?\?|\|\||&&|\*\*|<<|>>>?|[-+*/%&|^])?=(?![=>])|\+\+|--)`;
const ASSIGNED_AFTER = new RegExp(`^\\s*${ASSIGN_OP}`);
const FIELD_REASSIGNED = /\bthis\.([\w$]+)\s*=(?![=>])/g;

const SETTER = new RegExp(String.raw`^\s*${MODIFIERS}set\s+([\w$]+)\s*\(`);

/** What a member's first line (decorators removed) declares. */
function memberKind(
  rest: string,
): { kind: 'setter' | 'method'; name: string } | { kind: 'field'; fm: RegExpMatchArray } | undefined {
  const setter = rest.match(SETTER)?.[1];
  if (setter !== undefined) {
    return { kind: 'setter', name: setter };
  }
  const mm = rest.match(METHOD);
  if (mm && !/^\s*\w+\s*[?!]?\s*:/.test(rest)) {
    return { kind: 'method', name: mm[1] };
  }
  const fm = rest.match(FIELD);
  return fm ? { kind: 'field', fm } : undefined;
}

/** A member line's leading decorators and the code after them. */
function splitDecorators(line: string): { decorators: string[]; rest: string } {
  const prefix = line.match(DECORATOR_PREFIX)?.[0] ?? '';
  return { decorators: decoratorsOf(prefix), rest: line.slice(prefix.length) };
}

function disabledRulesAt(raw: string[], index: number): string[] {
  const prev = raw[index - 1] ?? '';
  const m = prev.match(/arkui-sem-disable-next-line\s+([\w\s,]+)/);
  return m ? m[1].split(/[\s,]+/).filter((r) => /^R\d+$/.test(r)) : [];
}

export class NaiveExtractor implements FactExtractor {
  readonly name = 'naive';

  extract(file: string, text: string): FileFacts {
    const raw = text.split(/\r?\n/);
    const blanked = blank(text);
    const code = blanked.split(/\r?\n/);
    const { depthBefore, depthAfter } = braceDepths(code);
    const observed = [
      ...blanked.matchAll(/@Observed(V2)?\s+(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)/g),
    ];

    const components: ComponentFact[] = [];
    for (let i = 0; i < code.length; i++) {
      const sm = code[i].match(/\bstruct\s+(\w+)/);
      if (!sm) {
        continue;
      }
      const header = code.slice(Math.max(0, i - 4), i + 1).join(' ');
      const decos = decoratorsOf(header);
      if (!decos.includes('@Component') && !decos.includes('@ComponentV2')) {
        continue;
      }

      const structDepth = depthBefore[i];
      let end = i;
      while (end + 1 < code.length && !(end > i && depthAfter(end) <= structDepth)) {
        end++;
      }

      components.push(
        this.component(
          file,
          sm[1],
          decos.includes('@ComponentV2') ? 'V2' : 'V1',
          i,
          end,
          structDepth,
          raw,
          code,
          depthBefore,
        ),
      );
      i = end;
    }
    const objectLinkTypes = components.flatMap((c) =>
      c.fields.flatMap((f) =>
        f.decorators.includes('@ObjectLink') && f.type ? [className(f.type).replace(/\[\]$/, '')] : [],
      ),
    );
    return {
      file,
      components,
      observedClasses: observed.filter((m) => !m[1]).map((m) => m[2]),
      observedV2Classes: observed.filter((m) => m[1]).map((m) => m[2]),
      objectLinkTypes,
      ...this.classes(code, depthBefore, depthAfter),
      lines: raw,
    };
  }

  private classes(
    code: string[],
    depthBefore: number[],
    depthAfter: (i: number) => number,
  ): Pick<FileFacts, 'declaredClasses' | 'declaredTypes' | 'classMembers' | 'classParents' | 'arrayClasses'> {
    const declaredClasses: string[] = [];
    const declaredTypes: string[] = [];
    const classMembers: FileFacts['classMembers'] = {};
    const classParents: FileFacts['classParents'] = {};
    const arrayClasses: FileFacts['arrayClasses'] = {};
    for (let i = 0; i < code.length; i++) {
      const decl = typeHeader(code[i]);
      if (!decl) {
        continue;
      }
      const { name, typeParams } = decl;
      (decl.kind === 'class' ? declaredClasses : declaredTypes).push(name);
      let open = i; // the header may wrap; its body opens on this line
      while (open + 1 < code.length && open < i + 4 && !code[open].includes('{')) {
        open++;
      }
      const header = code
        .slice(i, open + 1)
        .join(' ')
        .slice(decl.end)
        .replace(/\{.*$/, '');
      const parents = splitTopLevel(header.match(/^\s*extends\s+(.*?)(?:\bimplements\b.*)?$/)?.[1] ?? '', ',')
        .map((p) => p.trim().match(/^\w+/)?.[0])
        .filter((p): p is string => p !== undefined && p !== 'Array');
      if (parents.length > 0) {
        classParents[name] = parents;
      }
      const am = header.match(/\bextends\s+Array\s*<(.+?)>\s*(?:implements\b.*)?$/);
      if (am) {
        arrayClasses[name] = {
          element: am[1].trim(),
          params: splitTopLevel(typeParams ?? '', ',')
            .map((p) => p.trim().split(/\s/)[0])
            .filter(Boolean),
        };
      }
      const classDepth = depthBefore[open];
      const memberFacts: Record<string, ClassMember> = {};
      classMembers[name] = memberFacts;
      let end = open;
      // Each member's first line, and its text through to the next member (parameters, body).
      let members: { head: string; text: string }[];
      if (code[open].includes('{') && depthAfter(open) <= classDepth) {
        const body = code[open].slice(code[open].indexOf('{') + 1, code[open].lastIndexOf('}'));
        members = splitTopLevel(body, ';,', true).map((m) => ({ head: m, text: m }));
      } else {
        while (end + 1 < code.length && !(end > open && depthAfter(end) <= classDepth)) {
          end++;
        }
        members = memberRanges(code, depthBefore, open, end, classDepth).map(({ first, last }) => ({
          head: code[first],
          text: code.slice(first, last + 1).join('\n'),
        }));
      }
      let pending: string[] = [];
      const bodies: string[] = []; // method and arrow-function property texts
      for (const member of members) {
        if (decoratorLine(member.head, pending)) {
          continue;
        }
        const { decorators, rest } = splitDecorators(member.head);
        const all = [...pending, ...decorators];
        pending = [];
        const kind = memberKind(rest);
        if (kind?.kind === 'setter') {
          memberFacts[kind.name] = { decorators: all, setter: true };
          bodies.push(member.text);
        } else if (kind?.kind === 'method') {
          memberFacts[kind.name] = { decorators: all, setter: false };
          bodies.push(member.text);
        } else if (kind?.kind === 'field') {
          const { fm } = kind;
          const arrow = fm[3]?.includes('=>');
          memberFacts[fm[1]] = {
            decorators: all,
            setter: false,
            type: fieldType(fm),
            literal: literalOf(fm),
          };
          if (arrow) {
            bodies.push(member.text);
          }
        }
      }
      // A literal initializer is the value only while no method or constructor reassigns the field.
      const assigned = new Set(bodies.flatMap((b) => [...b.matchAll(FIELD_REASSIGNED)].map((m) => m[1])));
      for (const [n, m] of Object.entries(memberFacts)) {
        if (m.literal !== undefined && assigned.has(n)) {
          memberFacts[n] = { ...m, literal: undefined };
        }
      }
      i = end;
    }
    return { declaredClasses, declaredTypes, classMembers, classParents, arrayClasses };
  }

  private component(
    file: string,
    name: string,
    version: 'V1' | 'V2',
    start: number,
    end: number,
    structDepth: number,
    raw: string[],
    code: string[],
    depthBefore: number[],
  ): ComponentFact {
    const fields: FieldFact[] = [];
    const methods: Method[] = [];
    let pending: string[] = [];
    let pendingStart = -1;

    for (const { first: i, last } of memberRanges(code, depthBefore, start, end, structDepth)) {
      const line = code[i];
      const pendingBefore = pending.length;
      if (decoratorLine(line, pending)) {
        if (pendingBefore === 0 && pending.length > 0) {
          pendingStart = i;
        }
        continue;
      }

      const { decorators: inline, rest } = splitDecorators(line);
      const decorators = [...pending, ...inline];
      // The disable comment may sit above the decorator lines or directly above the field name.
      const disabledRules = [
        ...new Set([...disabledRulesAt(raw, i), ...(pending.length ? disabledRulesAt(raw, pendingStart) : [])]),
      ];
      pending = [];

      const kind = memberKind(rest);
      if (kind?.kind === 'method') {
        methods.push({ name: kind.name, decorators, firstLine: i, lastLine: last });
        continue;
      }
      if (kind?.kind === 'field') {
        const { fm } = kind;
        fields.push({
          name: fm[1],
          line: i + 1,
          decorators,
          type: fieldType(fm),
          hasInitializer: fm[3] !== undefined,
          literal: literalOf(fm),
          readsInBuild: [],
          writes: [],
          disabledRules,
        });
      }
    }

    const byName = new Map(fields.map((f) => [f.name, f]));
    for (const m of methods) {
      this.scanMethod(m, raw, code, byName);
    }
    const external = externalMethods(methods, code);
    for (const f of fields) {
      for (const w of f.writes) {
        w.external = external.has(w.method);
      }
    }

    return { name, file, line: start + 1, version, fields, resources: this.resources(methods, raw) };
  }

  private scanMethod(m: Method, raw: string[], code: string[], fields: Map<string, FieldFact>) {
    const isBuild = m.name === 'build' || m.decorators.includes('@Builder');
    for (let i = m.firstLine; i <= m.lastLine; i++) {
      const line = code[i];
      for (const hit of line.matchAll(/this\.([\w$]+)/g)) {
        const field = fields.get(hit[1]);
        if (!field) {
          continue;
        }
        const after = line.slice((hit.index ?? 0) + hit[0].length);
        const chain = after.match(/^((?:\??\.[\w$]+|\[[^\]]*\])*)/)?.[1] ?? '';
        const tail = after.slice(chain.length);
        const before = line.slice(0, hit.index ?? 0);

        const lastCall = chain.match(/\.([\w$]+)$/)?.[1];
        const mutatingCall = lastCall !== undefined && MUTATING_CALLS.has(lastCall) && /^\s*\(/.test(tail);
        const assigned = ASSIGNED_AFTER.test(tail) || /(?:\+\+|--)\s*$/.test(before);

        if (!assigned && !mutatingCall) {
          if (isBuild && !field.readsInBuild.includes(i + 1)) {
            field.readsInBuild.push(i + 1);
          }
          continue;
        }
        const nested = mutatingCall ? `${chain.replace(/\.[\w$]+$/, '')}[]` : chain;
        const window = code.slice(Math.max(m.firstLine, i - 3), i + 1).join('\n');
        const isAsync = ASYNC_MARKERS.test(window);
        const context: WriteContext = isAsync
          ? 'async-callback'
          : isBuild
            ? 'build-closure'
            : LIFECYCLE.has(m.name)
              ? 'lifecycle'
              : 'method';
        field.writes.push({
          line: i + 1,
          context,
          method: m.name,
          nestedPath: nested || undefined,
          value: mutatingCall ? undefined : assignedValue(tail),
          disabledRules: disabledRulesAt(raw, i),
        });
      }
    }
  }

  private resources(methods: Method[], raw: string[]): ResourceFact[] {
    function body(m: Method) {
      return raw.slice(m.firstLine, m.lastLine + 1).join('\n');
    }
    // A lifecycle hook plus the same-component helpers it calls directly (one level), e.g. aboutToDisappear → this.unregisterAll().
    function scope(hooks: Set<string>) {
      return methods
        .filter((m) => hooks.has(m.name))
        .flatMap((h) => [
          { m: h, via: h.name },
          ...[...new Set([...body(h).matchAll(/\bthis\.([\w$]+)\s*\(/g)].map((x) => x[1]))]
            .map((n) => methods.find((m) => m.name === n && !LIFECYCLE.has(n)))
            .filter((m): m is Method => m !== undefined)
            .map((m) => ({ m, via: `${h.name}→${m.name}` })),
        ]);
    }
    const released = scope(RELEASE_HOOKS)
      .map((s) => body(s.m))
      .join('\n');
    const out: ResourceFact[] = [];
    const seen = new Set<string>();
    function add(r: ResourceFact) {
      if (!seen.has(r.key)) {
        seen.add(r.key);
        out.push(r);
      }
    }
    for (const { m, via } of scope(ACQUIRE_HOOKS)) {
      for (let i = m.firstLine; i <= m.lastLine; i++) {
        const line = raw[i];
        if (/^\s*(\/\/|\*)/.test(line)) {
          continue;
        }
        // Event listeners: target.on('event' | CONST.EVENT, handler) ↔ target.off(same event).
        for (const on of line.matchAll(/([\w$.]+(?:\(\))?)\.on\(\s*((['"])[^'"]+\3|[\w$.]+)\s*[,)]/g)) {
          const [, target, event] = on;
          const name = event.replace(/^['"]|['"]$/g, '');
          const off = new RegExp(`\\.off\\(\\s*(['"]${esc(name)}['"]|${esc(name)})\\s*[,)]`);
          add({
            kind: 'listener',
            key: `${target}.on:${name}`,
            acquireLine: i + 1,
            acquireIn: via,
            released: off.test(released),
            release: `${target}.off(${event}, <same handler>)`,
          });
        }
        // Registrations: registerX ↔ unregisterX, subscribe ↔ unsubscribe, addXListener/Observer ↔ removeX.
        for (const reg of line.matchAll(
          /([\w$.]+(?:\(\))?)\.(register\w*|subscribe\w*|add\w*(?:Listener|Observer|Callback))\(/g,
        )) {
          const [, target, method] = reg;
          const undo = method.startsWith('add') ? `remove${method.slice(3)}` : `un${method}`;
          const releasedHere = new RegExp(`\\b${esc(undo)}\\s*\\(`, 'i').test(released);
          add({
            kind: 'subscription',
            key: `${target}.${method}`,
            acquireLine: i + 1,
            acquireIn: via,
            released: releasedHere,
            release: `${target}.${undo}(...)`,
          });
        }
        const timer = line.match(/(this\.\w+)\s*=\s*setInterval\(/);
        if (timer) {
          add({
            kind: 'timer',
            key: `timer:${timer[1]}`,
            acquireLine: i + 1,
            acquireIn: via,
            released: released.includes(`clearInterval(${timer[1]}`),
            release: `clearInterval(${timer[1]})`,
          });
        } else if (/\bsetInterval\(/.test(line)) {
          add({
            kind: 'timer',
            key: `timer:anonymous@${i + 1}`,
            acquireLine: i + 1,
            acquireIn: via,
            released: false,
            release: 'clearInterval(<the interval id>)',
          });
        }
      }
    }
    return out;
  }
}

// --- Rules ---

export type RuleId = 'R1' | 'R2' | 'R3';

export type CandidateKind =
  | 'undecorated-mutated-rendered' // R1: plain member written after init and read in build()
  | 'nested-write-unobserved' // R1: in-place write deeper than the state decorator observes
  | 'ownership-intent' // R2: passed-in field; candidates() does not emit it (callers build it)
  | 'unreleased-resource'; // R3: acquired in a lifecycle hook, no matching release

/** A field candidate (R1, R2) or a resource candidate (R3). */
export type Candidate = CandidateBase &
  ({ field: FieldFact; resource?: never } | { resource: ResourceFact; field?: never });

/** Why V2 misses a write: its owner is a plain class, a plain object type (interface or object type alias), an object
 *  literal, an @ObservedV2 class whose property lacks @Trace, or a container nested in another. owner is the class that
 *  declares the property, or for an object literal or nested container the path that holds it. */
export interface V2Gap {
  kind: 'class' | 'object-type' | 'object-literal' | 'untraced' | 'nested-container';
  owner: string;
  property: string;
}

interface CandidateBase {
  rule: RuleId;
  kind: CandidateKind;
  file: string;
  component: ComponentFact;
  line: number;
  /** Nested-write: every unobserved write, in source order. */
  writes?: WriteFact[];
  /** V2 nested-write: why V2 misses the writes, one entry per distinct gap. */
  gaps?: V2Gap[];
  /** Stable across runs: dedupe, cache, dismissals. */
  fingerprint: string;
}

const REACTIVE_V1 = new Set([
  '@State',
  '@Prop',
  '@Link',
  '@ObjectLink',
  '@Provide',
  '@Consume',
  '@StorageLink',
  '@StorageProp',
  '@LocalStorageLink',
  '@LocalStorageProp',
]);
/** V2 state the component itself initializes. */
const OWNED_V2 = new Set(['@Local']);
const REACTIVE_V2 = new Set(['@Local', '@Param', '@Provider', '@Consumer']);
// Fields that never hold renderable state.
const NON_STATE = new Set(['@BuilderParam', '@Event', '@Require']);

function isReactive(f: FieldFact) {
  return f.decorators.some((d) => REACTIVE_V1.has(d) || REACTIVE_V2.has(d));
}
function isReactiveV1(f: FieldFact) {
  return f.decorators.some((d) => REACTIVE_V1.has(d));
}

/** The property name of a `.x` or `?.x` segment; undefined for an index. */
function segmentProp(s: string): string | undefined {
  return s.match(/^\??\.([\w$]+)$/)?.[1];
}

/** Text as a RegExp source. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function segments(path?: string) {
  return path?.match(/\??\.[\w$]+|\[[^\]]*\]/g) ?? [];
}

/** Levels below the field a write reaches: ".title" → 1, ".address.city" → 2, "[i].title" → 2, "[]" (array call) → 1. */
export function nestedDepth(path?: string) {
  return segments(path).length;
}

function nonNull(t: string) {
  return t.replace(/\s*\|\s*(?:undefined|null)\b/g, '').trim();
}
function className(t: string) {
  return nonNull(t).replace(/<.*>$/, '').trim();
}
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** The class a field of type t holds: the element class for an array, without null, undefined or type arguments. */
export function typeClass(t: string, facts: FileFacts): string {
  const held = nonNull(t);
  return className(elementType(held, facts) ?? held);
}

/** Element type of X[], Array<X>, or a file class extending Array<…> (its type parameters bound from t's arguments). */
function elementType(t: string, facts: FileFacts): string | undefined {
  const builtin = (t.match(/^(.+)\[\]$/) ?? t.match(/^Array<(.+)>$/))?.[1].trim();
  if (builtin !== undefined) {
    return builtin;
  }
  const cls = own(facts.arrayClasses, className(t));
  if (!cls) {
    return undefined;
  }
  const args = splitTopLevel(t.match(/<(.+)>$/)?.[1] ?? '', ',').map((a) => a.trim());
  const param = cls.params.indexOf(cls.element);
  return param < 0 ? cls.element : args[param];
}

/** cls, then the types it extends, nearest first; some may be declared in another file. */
function ancestry(cls: string, facts: FileFacts): string[] {
  const chain = [cls];
  for (let i = 0; i < chain.length; i++) {
    for (const p of own(facts.classParents, chain[i]) ?? []) {
      if (!chain.includes(p)) {
        chain.push(p);
      }
    }
  }
  return chain;
}

/** Declared type of this.<field><segs>, from the field's type and the file's class fields; undefined when unknown. */

interface Step {
  type?: string;
  /** Text of the object literal the object here comes from: a plain object. */
  literal?: string;
}

/** The object at each prefix of this.<field><segs> (segs.length + 1 steps). Inside a literal, a property's own value text
 *  decides: `{…}` stays plain, `new X(…)` is an X, anything else takes the declared type and is not known to be plain. A
 *  property at a path in replaced (normalPath) is assigned elsewhere, so no initializer decides its value. */
function walk(
  fieldType: string | undefined,
  literal: string | undefined,
  segs: string[],
  facts: FileFacts,
  replaced = new Set<string>(),
): Step[] {
  const steps: Step[] = [{ type: fieldType && nonNull(fieldType), literal }];
  for (const [i, s] of segs.entries()) {
    const prev = steps[steps.length - 1];
    const prop = segmentProp(s);
    let next: Step;
    if (prop === undefined) {
      next = { type: prev.type && (elementType(prev.type, facts) ?? recordValue(prev.type)) };
    } else {
      const cls = prev.type && className(prev.type);
      const declared = cls ? declaredMember(ancestry(cls, facts), prop, facts) : undefined;
      if (replaced.has(normalPath(segs.slice(0, i + 1)))) {
        next = { type: declared?.type }; // assigned elsewhere: its initializer is no longer the value
      } else if (prev.literal === undefined) {
        next = { type: declared?.type, literal: declared?.member?.literal };
      } else {
        const value = literalValue(prev.literal, prop);
        const created = value?.match(NEW_INSTANCE)?.[1];
        next = value?.startsWith('{') ? { type: declared?.type, literal: value } : { type: created ?? declared?.type };
      }
    }
    steps.push({ ...next, type: next.type && nonNull(next.type) });
  }
  return steps;
}

/** Segments with every index as [] and no ?., so writes through different indexes share one path. */
function normalPath(segs: string[]): string {
  return segs.map((s) => (s.startsWith('[') ? '[]' : `.${segmentProp(s)}`)).join('');
}

/** What a field's writes share when judged: the field's literal value (see v2Gap) and the paths it assigns. */
interface FieldContext {
  literal?: string;
  replaced: Set<string>;
}

function fieldContext(f: FieldFact): FieldContext {
  // The initializer's literal is the value only for state the component alone sets (a @Param, @Consumer or @Provider can
  // get its value from elsewhere), and only until a reassignment: one that assigns literals keeps the object plain, with
  // its contents unknown.
  const reassignments = f.writes.filter((x) => x.nestedPath === undefined);
  const owned = f.decorators.some((d) => OWNED_V2.has(d)) && f.literal !== undefined;
  const literal = !owned
    ? undefined
    : reassignments.length === 0
      ? f.literal
      : reassignments.every((x) => x.value === 'object-literal')
        ? '{}'
        : undefined;
  const replaced = new Set(
    f.writes
      .filter((x) => x.nestedPath !== undefined && x.value !== undefined && x.value !== 'object-literal')
      .map((x) => normalPath(segments(x.nestedPath))),
  );
  return { literal, replaced };
}

/** The value type of Record<K, V>. */
function recordValue(t: string): string | undefined {
  const args = t.match(/^Record\s*<(.+)>$/)?.[1];
  return args === undefined ? undefined : splitTopLevel(args, ',')[1]?.trim();
}

/** Inline object types and records: plain objects whatever they hold. */
function isPlainType(t: string): boolean {
  return t.startsWith('{') || /^(?:Record|Object|object)\b/.test(t);
}

/** Types whose index writes and API calls V2 observes on an observed property. */
function isContainer(t: string, facts: FileFacts): boolean {
  return elementType(t, facts) !== undefined || /^(?:Map|Set|Date|WeakMap|WeakSet)$/.test(className(t));
}

/** Whether build() or a @Builder reads this.<field><path> or deeper; any index matches any index, with or without ?. before
 *  it. For an array call ("…[]") only reads of the contents count, so passing the array itself to a child does not. */
function rendersPath(f: FieldFact, path: string, facts: FileFacts): boolean {
  const arrayCall = path.endsWith('[]');
  const tail = segments(arrayCall ? path.slice(0, -2) : path)
    .map((s) => (s.startsWith('[') ? '(?:\\?\\.)?\\[[^\\]]*\\]' : `\\??\\.${esc(segmentProp(s) ?? '')}`))
    .join('');
  const read = new RegExp(
    `\\bthis\\.${esc(f.name)}${tail}${arrayCall ? '(?:(?:\\?\\.)?\\[|\\??\\.[\\w$])' : '(?![\\w$])'}`,
  );
  return f.readsInBuild.some((l) => read.test(facts.lines[l - 1] ?? ''));
}

/** V1: a property change on an @Observed object reaches every @ObjectLink bound to that object (OpenHarmony @Observed/@ObjectLink
 *  docs), so a deep write is seen when a child in the file takes the owning class as @ObjectLink, unless the parent renders the
 *  path itself. */
function seenByObjectLink(f: FieldFact, nestedPath: string, facts: FileFacts): boolean {
  const owner = walk(f.type, undefined, segments(nestedPath).slice(0, -1), facts).at(-1)?.type;
  if (owner === undefined) {
    return false;
  }
  const cls = className(owner);
  return (
    facts.observedClasses.includes(cls) &&
    facts.objectLinkTypes.some((t) => className(t) === cls) &&
    !rendersPath(f, nestedPath, facts)
  );
}

/** OpenHarmony docs (@Local, @ObservedV2 and @Trace): V2 sees an array's index writes and API calls (also Map, Set, Date)
 *  when the container itself is observed, and a property write only when the property is @Trace (or a setter) on an
 *  @ObservedV2 class, inherited ones included; plain objects are never observed. Undefined when V2 sees the write, or when it
 *  can't be judged: the owner type is unknown, declared elsewhere, or an interface whose object may be a class instance. A
 *  container inside another container (`grid[i]`) is not proxied: its writes are missed. */
function v2Gap(f: FieldFact, w: WriteFact, facts: FileFacts, field: FieldContext): V2Gap | undefined {
  const segs: string[] = segments(w.nestedPath);
  const steps = walk(f.type, field.literal, segs.slice(0, -1), facts, field.replaced);
  let ownerSegs = segs.slice(0, -1);
  let last = segs.at(-1) ?? '';
  if (last.startsWith('[')) {
    const { type: containerType, literal: containerLiteral } = steps[ownerSegs.length];
    const unknown = containerType === undefined && containerLiteral === undefined;
    if (unknown || (containerType !== undefined && isContainer(containerType, facts))) {
      // The write changes the container (an unknown type is taken for one) held by the property before it.
      if (ownerSegs.length === 0) {
        return undefined;
      }
      if (ownerSegs[ownerSegs.length - 1].startsWith('[')) {
        if (unknown) {
          return undefined; // an element of unknown type may be any object
        }
        const outer = steps[ownerSegs.length - 1];
        if (outer.literal !== undefined || (outer.type !== undefined && isPlainType(outer.type))) {
          // The container sits in a plain object (a record): the object is what V2 misses.
          const holder = ownerSegs.slice(0, -1);
          return { kind: 'object-literal', owner: ownerPath(f, holder), property: ownerSegs[ownerSegs.length - 1] };
        }
        return { kind: 'nested-container', owner: ownerPath(f, ownerSegs), property: '' };
      }
      last = ownerSegs[ownerSegs.length - 1];
      ownerSegs = ownerSegs.slice(0, -1);
    } else if (last === '[]') {
      return undefined; // a call named like a container mutation on some other object: not judged
    }
  }
  const { type: owner, literal } = steps[ownerSegs.length];
  if (owner !== undefined && elementType(owner, facts) !== undefined) {
    return undefined;
  }
  const property = segmentProp(last) ?? last;
  const cls = owner && className(owner);
  const objectType = cls !== undefined && factSets(facts).types.has(cls);
  if (literal !== undefined || (owner !== undefined && isPlainType(owner))) {
    if (objectType) {
      return { kind: 'object-type', owner: cls, property };
    }
    return { kind: 'object-literal', owner: ownerPath(f, ownerSegs), property };
  }
  if (cls === undefined || objectType || last.startsWith('[')) {
    return undefined; // a computed key on a class instance names no known member
  }
  const chain = ancestry(cls, facts);
  const { declaring, member } = declaredMember(chain, property, facts);
  if (!member && !allKnown(chain, facts)) {
    return undefined;
  }
  const traced = member?.setter || member?.decorators.includes('@Trace');
  if ((traced && chain.some((c) => isV2(c, facts))) || !rendersPath(f, [...ownerSegs, last].join(''), facts)) {
    return undefined; // observed, or a property nothing renders: leaving it untraced is the point of per-property @Trace
  }
  // @Trace compiles only inside an @ObservedV2 class.
  return { kind: isV2(declaring, facts) ? 'untraced' : 'class', owner: declaring, property };
}

/** this.<field><segs> as a normalPath, so writes through different indexes share one owner. */
function ownerPath(f: FieldFact, segs: string[]): string {
  return `this.${f.name}${normalPath(segs)}`;
}

/** The facts' name lists as sets, built once per FileFacts. */
const factSetsCache = new WeakMap<FileFacts, { classes: Set<string>; types: Set<string>; v2: Set<string> }>();
function factSets(facts: FileFacts) {
  let sets = factSetsCache.get(facts);
  if (!sets) {
    sets = {
      classes: new Set(facts.declaredClasses),
      types: new Set(facts.declaredTypes),
      v2: new Set(facts.observedV2Classes),
    };
    factSetsCache.set(facts, sets);
  }
  return sets;
}

const isV2 = (c: string, facts: FileFacts) => factSets(facts).v2.has(c);
/** Every class in chain is declared in the facts (none comes from an unread module). */
const allKnown = (chain: string[], facts: FileFacts) => chain.every((c) => factSets(facts).classes.has(c));

/** The nearest class in chain that declares property, with its member facts and declared type; chain[0] when none does. */
function declaredMember(
  chain: string[],
  property: string,
  facts: FileFacts,
): { declaring: string; member?: ClassMember; type?: string } {
  for (const c of chain) {
    const members = own(facts.classMembers, c);
    const member = members && own(members, property);
    if (member) {
      return { declaring: c, member, type: member.type };
    }
  }
  return { declaring: chain[0] };
}

/** Writes the decorator can't see, minus writes under a disable comment. V1: deeper than the first layer, even with @Observed
 *  classes, unless an @ObjectLink child sees them. V2: see v2Gap, whose distinct gaps come back too. */
function unobservedWrites(f: FieldFact, facts: FileFacts): { writes: WriteFact[]; gaps?: V2Gap[] } {
  const writes = f.writes.filter((w) => !w.disabledRules.includes('R1'));
  if (isReactiveV1(f)) {
    return {
      writes: writes.filter(
        (w) =>
          w.nestedPath !== undefined && nestedDepth(w.nestedPath) >= 2 && !seenByObjectLink(f, w.nestedPath, facts),
      ),
    };
  }
  const field = fieldContext(f);
  const unseen: WriteFact[] = [];
  const gaps = new Map<string, V2Gap>();
  for (const w of writes) {
    const gap = w.nestedPath === undefined ? undefined : v2Gap(f, w, facts, field);
    if (gap) {
      unseen.push(w);
      gaps.set(`${gap.kind} ${gap.owner} ${gap.kind === 'untraced' ? gap.property : ''}`, {
        ...gap,
      });
    }
  }
  return { writes: unseen, gaps: [...gaps.values()] };
}

export function candidates(facts: FileFacts): Candidate[] {
  const out: Candidate[] = [];
  for (const c of facts.components) {
    for (const f of c.fields) {
      if (f.decorators.some((d) => NON_STATE.has(d))) {
        continue;
      }

      if (!isReactive(f) && f.readsInBuild.length > 0 && f.writes.length > 0 && !f.disabledRules.includes('R1')) {
        out.push({
          rule: 'R1',
          kind: 'undecorated-mutated-rendered',
          file: facts.file,
          component: c,
          field: f,
          line: f.line,
          fingerprint: `${facts.file}#${c.name}.${f.name}#R1-undecorated`,
        });
      }

      const { writes: nested, gaps } = isReactive(f) ? unobservedWrites(f, facts) : { writes: [] };
      if (nested.length > 0 && f.readsInBuild.length > 0 && !f.disabledRules.includes('R1')) {
        out.push({
          rule: 'R1',
          kind: 'nested-write-unobserved',
          file: facts.file,
          component: c,
          field: f,
          line: nested[0].line,
          writes: nested,
          gaps,
          fingerprint: `${facts.file}#${c.name}.${f.name}#R1-nested`,
        });
      }
    }
    for (const r of c.resources) {
      if (r.released) {
        continue;
      }
      if (disabledRulesAt(facts.lines, r.acquireLine - 1).includes('R3')) {
        continue;
      }
      out.push({
        rule: 'R3',
        kind: 'unreleased-resource',
        file: facts.file,
        component: c,
        resource: r,
        line: r.acquireLine,
        fingerprint: `${facts.file}#${c.name}#R3-${r.key}`,
      });
    }
  }
  return out;
}
