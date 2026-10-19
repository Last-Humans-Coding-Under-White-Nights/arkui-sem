// Candidates → judgments (cached) → findings/questions, and their text for agents.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { Questions } from '@typesafe-ai/sdk';
import {
  type Candidate,
  candidates,
  type FactExtractor,
  type FileFacts,
  NaiveExtractor,
  nestedDepth,
  type V2Gap,
} from './analysis.js';
import { buildSlice, Q_R1, Q_R2, Q_R3, type SystemOneBackend } from './judge.js';

// --- Formatting ---

function pct(p: number | null) {
  return p === null ? 'judge unavailable' : `p=${p.toFixed(2)}`;
}

export function formatForAgent(findings: Finding[], cwd = process.cwd()): string {
  if (findings.length === 0) {
    return '';
  }
  const out: string[] = [];
  const confident = findings.filter((f) => f.band === 'finding');
  const questions = findings.filter((f) => f.band === 'question');
  out.push(`arkui-sem: ${confident.length} finding(s), ${questions.length} question(s) about ArkUI state semantics.`);

  for (const f of confident) {
    out.push(`- [${f.rule} ${f.kind}] ${relative(cwd, f.file)}:${f.line} ${f.subject} (${pct(f.p)}, ${f.backend})`);
    out.push(`  why: ${f.evidence}`);
    out.push(`  fix: ${f.fix}`);
  }
  for (const f of questions) {
    out.push(`- [${f.rule}?] ${relative(cwd, f.file)}:${f.line} ${f.subject} (${pct(f.p)}, ${f.backend})`);
    out.push(`  ${f.evidence}. Is this intended? If it should behave reactively/be released: ${f.fix}`);
    const where =
      f.kind === 'nested-write-unobserved'
        ? "above each write it lists, or above the field's decorators for all of them"
        : `above line ${f.line}`;
    out.push(
      `  If it is intentional, leave it and add \`// arkui-sem-disable-next-line ${f.rule} -- <reason>\` ${where}.`,
    );
  }
  return out.join('\n');
}

// --- Engine ---

export type Band = 'finding' | 'question';

export interface Finding {
  fingerprint: string;
  rule: Candidate['rule'];
  kind: Candidate['kind'];
  file: string;
  line: number;
  component: string;
  subject: string;
  /** P(violation); null when the judge failed. */
  p: number | null;
  band: Band;
  backend: string;
  evidence: string;
  fix: string;
}

export interface EngineOptions {
  backend: SystemOneBackend;
  extractor?: FactExtractor;
  /** P ≥ finding → reported as a finding; question ≤ P < finding → asked as a question; below → dropped. */
  thresholds?: { finding: number; question: number };
  cachePath?: string;
  taskContext?: string;
  judgeTimeoutMs?: number;
}

const QUESTIONS: Record<Candidate['rule'], Questions> = { R1: Q_R1, R2: Q_R2, R3: Q_R3 };
const VIOLATION_LABEL: Record<Candidate['rule'], string> = {
  R1: 'desync_bug',
  R2: 'shared_with_parent',
  R3: 'leak_bug',
};
// R2 label assumes the @Link → @Prop mismatch (shared intent); callers map the other intent × decorator pairs.

class JudgmentCache {
  private entries: Record<string, number> = {};
  constructor(private readonly path?: string) {
    if (!path) {
      return;
    }
    try {
      this.entries = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      /* empty or missing cache */
    }
  }
  get(key: string): number | undefined {
    return this.entries[key];
  }
  set(key: string, p: number) {
    this.entries[key] = p;
  }
  save() {
    if (!this.path) {
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.entries));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`judge timed out after ${ms} ms`)), ms)),
  ]);
}

/** "line 4", "lines 4 and 9", "lines 4, 7 and 9". */
function lineList(lines: number[]): string {
  if (lines.length === 1) {
    return `line ${lines[0]}`;
  }
  return `lines ${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`;
}

function gapReason(g: V2Gap): string {
  switch (g.kind) {
    case 'class':
    case 'untraced':
      return 'V2 sees a property write only when the property is @Trace on an @ObservedV2 class';
    case 'object-type':
    case 'object-literal':
      return 'V2 never observes plain objects';
    case 'nested-container':
      return "V2 doesn't observe containers nested in containers";
  }
}

function gapFix(g: V2Gap): string {
  switch (g.kind) {
    case 'class':
      return `mark class ${g.owner} @ObservedV2 and the mutated properties @Trace`;
    case 'object-type':
      return `make ${g.owner} an @ObservedV2 class with @Trace on the mutated properties and create its objects with new`;
    case 'object-literal':
      return `reassign ${g.owner} with a new object, or make it an @ObservedV2 class instance with @Trace on the mutated properties`;
    case 'nested-container':
      return `assign a new inner array or map to ${g.owner} instead of changing it in place`;
    case 'untraced':
      return `mark ${g.owner}.${g.property} @Trace`;
  }
}

function describe(c: Candidate): { subject: string; evidence: string; fix: string } {
  const v2 = c.component.version === 'V2';
  if (c.resource) {
    const r = c.resource;
    const release = r.release;
    return {
      subject: `${c.component.name} ${r.key}`,
      evidence: `${r.kind} acquired in ${r.acquireIn}() at line ${r.acquireLine}; no matching release in aboutToDisappear/onPageHide`,
      fix: `release it in aboutToDisappear(): ${release}.${r.kind === 'listener' ? ' Keep the handler in a field so off() receives the same reference.' : ''}`,
    };
  }
  const f = c.field;
  const writes = f.writes
    .slice(0, 2)
    .map((w) => `${w.context} in ${w.method}() line ${w.line}`)
    .join('; ');
  if (c.kind === 'nested-write-unobserved') {
    const [w, ...rest] = c.writes?.length ? c.writes : f.writes;
    const path = w?.nestedPath ?? '';
    const first = path.match(/^\??\.(\w+)/)?.[1];
    const otherLines = [...new Set(rest.map((x) => x.line))].filter((l) => l !== w.line);
    const also = otherLines.length ? `; also written in place at ${lineList(otherLines)}` : '';
    const at = `${w?.context} in ${w?.method}() line ${w?.line}${also}`;
    if (c.gaps) {
      return {
        subject: `${c.component.name}.${f.name}${path}`,
        evidence: `${f.decorators.join(' ')} field's property written in place (${at}); ${[...new Set(c.gaps.map(gapReason))].join('; ')}`,
        fix: `${[...new Set(c.gaps.map(gapFix))].join('; ')}.`,
      };
    }
    return {
      subject: `${c.component.name}.${f.name}${path}`,
      evidence: `${f.decorators.join(' ')} field written ${nestedDepth(path)} levels deep (${at}); V1 state decorators observe only first-layer changes, and @Observed on the classes alone does not change that`,
      fix: `change it at the first layer instead, e.g. build a new object and assign this.${f.name}${first ? `.${first}` : ''} = <new object> (or reassign this.${f.name}); or render the nested object in a child component that receives it as @ObjectLink (its class @Observed) and mutate it there.`,
    };
  }
  return {
    subject: `${c.component.name}.${f.name}`,
    evidence: `rendered in build() (line ${f.readsInBuild[0]}) and written after init (${writes}); no state decorator`,
    fix: v2
      ? `declare it @Local; if the value comes from the parent, use @Param plus an @Event callback instead.`
      : `declare it @State; if the value comes from the parent, use @Prop (one-way) or @Link (two-way) instead.`,
  };
}

export async function checkFiles(
  files: string[],
  opts: EngineOptions,
): Promise<{ findings: Finding[]; errors: string[] }> {
  const extractor = opts.extractor ?? new NaiveExtractor();
  const thresholds = opts.thresholds ?? { finding: 0.8, question: 0.5 };
  const cache = new JudgmentCache(opts.cachePath);
  const findings: Finding[] = [];
  const errors: string[] = [];

  for (const file of files) {
    let facts: FileFacts;
    try {
      facts = extractor.extract(file, readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`);
      continue;
    }
    for (const c of candidates(facts)) {
      const slice = buildSlice(facts, c, opts.taskContext);
      const questions = QUESTIONS[c.rule];
      const key = createHash('sha256')
        .update(opts.backend.name)
        .update(JSON.stringify(slice))
        .update(Object.keys(questions).join())
        .digest('hex');

      let p: number | null = cache.get(key) ?? null;
      if (p === null) {
        try {
          const { answers } = await withTimeout(opts.backend.systemOne(slice, questions), opts.judgeTimeoutMs ?? 8000);
          const verdict = answers.verdict;
          if (verdict?.type === 'choice') {
            p = verdict.probabilities[VIOLATION_LABEL[c.rule]] ?? null;
            if (p !== null) {
              cache.set(key, p);
            }
          }
        } catch (e) {
          errors.push(`${opts.backend.name}: ${(e as Error).message}`);
        }
      }

      // Judge unavailable → degrade to deterministic-only and ask rather than assert.
      const band: Band | null =
        p === null ? 'question' : p >= thresholds.finding ? 'finding' : p >= thresholds.question ? 'question' : null;
      if (band === null) {
        continue;
      }
      findings.push({
        fingerprint: c.fingerprint,
        rule: c.rule,
        kind: c.kind,
        file,
        line: c.line,
        component: c.component.name,
        p,
        band,
        backend: opts.backend.name,
        ...describe(c),
      });
    }
  }
  cache.save();
  return { findings, errors };
}
