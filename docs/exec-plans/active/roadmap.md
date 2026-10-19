# Roadmap

The one forward plan: plugin status and roadmap, rule coverage and phases. Design background: `docs/design-docs/` (core beliefs, agentic plugin). Evaluation status, method and results are in the private bench: `bench/docs/RESULTS.md`, `bench/docs/evaluation-method.md`.

## Prototype (current state)

The linter lives in `arkui-sem/` (package `arkui-sem` 0.2.0); see `ARCHITECTURE.md` for the layout and `arkui-sem/README.md` for install and usage. Coverage by rule, and what is still missing, is tracked under Rule coverage below.

**Status:**
- Rules: R1 undecorated-mutated-rendered, R1 nested-write-unobserved (depth-aware, V1/V2), R3 unreleased-resource. R2 has a judge slice (used by the bench) but is not emitted yet.
- Backends: Jev, Clef, Clef-flash (also through OpenRouter: `or-clef`, `or-clef-flash`), DeepSeek flash (structured output), heuristic, Laya. The fallback chain is not implemented.
- Tests: `npm test` (offline). Plugin tools `arkui_check` / `arkui_facts` and the skill load in opencode 1.18.30 and in DevEco Code 0.2.1 (an opencode fork; plugin and skill under `.deveco/`).
- DevEco demo (2026-10-08, `sandbox/demo/DEMO.md`): Clef flagged the agent's nested write, the idle gate re-sent it for the old button, and the agent fixed both. The DevEco TUI hides tool output, so the demo prompt asks the agent to quote findings verbatim.
- Live opencode runs 1–4 (logs removed 2026-10-08; run 4 called DeepSeek and found the @Observed-only false negative that led to the depth-aware rule).

**Known limits:**
- **Single-file text analysis.** No aliasing, no cross-component pass edges (so no R2 yet), and class types are resolved only within the file.
- **The heuristic judge's probabilities are placeholders.**
- **The gate under `opencode run`.** The non-interactive run may exit at idle before the follow-up is processed [I]. Use the TUI or `opencode serve` + SDK for gate tests.
---

## Prototype roadmap

P-A2…P-A4 (intent tool, cross-file facts, LSP) are broken down further under Rule coverage below.

| Step | Deliverable | Effort | Exit criterion |
|---|---|---|---|
| **P-A1** ✓ | opencode plugin vertical slice: post-edit feedback, idle gate, `arkui_check`, `arkui_facts`, skill, installer, tests | done | tests pass; tools and skill registered in opencode |
| **P-A2** | Label log (fixes, dismissals with reasons) + `arkui_explain(id)` + `arkui_ownership_intent(component, field)` tools | 1–2 d | Labels written for every gate/finding outcome in a session |
| **P-A3** | ArkAnalyzer + APAK extractor kept warm in the plugin process; incremental updates on edit; cross-file, including across modules via a package index; parent→child edges → **R2** | 4–5 d | p95 ≤ 1.5 s per edit on the big project; E0 fact-precision ≥ 0.95 |
| **P-A4** | LSP channel: an `arkui-sem` LSP server registered via `opencode.json` `lsp` for `.ets`, optionally alongside the community ArkTS language server for L0 | 3 d | A/B vs the `tool.execute.after` channel; no duplicate reports |
| **P-A5** | Intent-aware slices: task text from the session's first user message (via `chat.message` / SDK), opt-in | 1 d | MDP / ArkState-200 lift with task context ≥ 5 pts [H] |
| **P-A6** | Real backends calibrated: Jev, Clef-flash, fine-tuned Laya (local HTTP sidecar; Laya is Python); the zero-shot Laya baseline is in the bench | 2–3 d | Per-rule ECE ≤ 0.10; τ_hi gives precision ≥ 0.9 on dev (the bench's dev-split tooling tunes it) |
| **P-A7** | Agent eval harness on `opencode serve` + `@opencode-ai/sdk` (`docs/design-docs/agentic-plugin.md` §6.3) | ~1 w | Variance estimate from a pilot of 20 tasks × 3 seeds |
| **P-A8** | Portability: MCP server wrapper for other agents, SARIF output, pre-commit | 2 d | Same findings via CLI, MCP and plugin on the fixtures |

The earlier offline prototypes keep their role as **gates that set thresholds before any live agent run**:
- P0.5 toolchain sweep;
- ArkState-200;
- ArkMut;
- masked-decorator prediction;
- ArkEval pairs.

The localizer (P5) becomes an `arkui_locate(issue_text)` tool.

---

## Rule coverage

Status as of 2026-10-13. Scope: ArkEval v1 category 1, "UI state desynchronization" (plus R3 for category 3).
Background: `docs/design-docs/core-beliefs.md` §3–§4 (rungs, rule families, architecture), `docs/design-docs/agentic-plugin.md`.

### Rules (RN)

| Rule | Name | Detects (facts) | Question for the judge or agent | Status |
|---|---|---|---|---|
| **R1** | Under-reactive state | A value rendered in `build()` and written after construction with no reactive path. Two kinds: an undecorated field, and a nested write the decorator can't see. | Q_R1: is it UI state or intentionally static? Verdict, severity. | Implemented, single file |
| **R2** | Ownership mismatch | A child field initialised from parent state, where the sync direction the code gives ≠ the direction needed. | Q_R2: `child_local_copy` / `shared_with_parent` / `parent_display_only`. The engine maps intent × V1/V2 → decorator. | Q_R2 slice + spec cards; evaluated in the bench (`bench/docs/RESULTS.md`); not emitted by the plugin |
| **R3** | Lifecycle obligation | A resource acquired with no release in `aboutToDisappear`. | Q_R3: app-lifetime? Released elsewhere? | Implemented (category 3): timers, listeners, constant-event `on`/`off`, register/subscribe pairs, helper-called releases. Evaluated in the bench (`bench/docs/RESULTS.md`) |
| **R4** | Over-reactive state | Decorated state never written after init, or a large `@State` mutated at high frequency. | Is reactivity needed? Perf severity. | Not started |
| **R5** | Issue → component mapping | Component list + summaries. | Which component owns the reported behaviour? (Rung 3) | Not started; not part of this plan |

#### R2 shapes

| Shape | Bug | Decided by |
|---|---|---|
| **a** R2-down | The parent changes `x` after init, but the child keeps an `@State` or undecorated copy, so the child shows a stale value. | Facts + judge: "is a snapshot intended?" |
| **b** R2-up | The child writes an `@Prop` (or a local copy), and the parent or a sibling reads `x`. The edit is lost. | Intent (judge or agent) |
| **c** R2-leak | A `@Link` used for a draft with cancel semantics, so edits leak to the parent. | Intent (judge or agent) |
| **d** Event unwired | V2: the child calls `this.onX(v)` (`@Event`), but no call site passes `onX`. | Facts only |
| **e** V2 `@Param` mutated in place | Only visible with `@ObservedV2` + `@Trace`, and it breaks one-way ownership. | Facts + intent for the fix |
| **f** Multiple parents | The same child gets different sync needs from different parents. | Facts; the fix choice needs a judgment |

The compiler already rejects writes to a V2 `@Param` and `@Link` without `$` (category 2), so the linter skips them.

### Coverage table

✅ done · ⚠️ partial · ❌ missing. The LSP column assumes the spike (phase 1) passes.

| Item | Today | With an LSP server | Left after LSP |
|---|---|---|---|
| R1 undecorated field, mutated and rendered (V1/V2) | ✅ Facts + Q_R1; MDP runs in the bench | – | Intent verdict (judge/agent) |
| R1 nested write, V1 (depth ≥ 2) | ✅ Same file | Field's class resolved across files | Aliasing (`const it = this.list[i]; it.x = …`): ArkAnalyzer |
| R1 nested write, V2 (class not `@ObservedV2`) | ⚠️ Same file; cross-file through ace-server (follow-up) | ✅ Cross-file class lookup | – |
| `@Trace` per property | ⚠️ Same file (mutated + rendered property, inherited `@Trace` included); cross-file through ace-server (follow-up) | ✅ Class (LSP) + property decorator (our parse) | Eval |
| `@Observed` / `@ObjectLink` children | ⚠️ Same file only (class, child and parent) | ✅ Cross-file `@Observed` class + child `@ObjectLink` | – |
| `@Track` | ❌ | Class lookup only | Rule design |
| R2 facts: call-site edges | ❌ | ✅ `references` on struct → call sites; our parse of the object literal | Bench scale needs a one-pass index |
| R2-a | ❌ | ✅ Detected (`references` + `documentHighlight` write kinds) | Judge: snapshot intended? |
| R2-d | ❌ | ✅ Fully decidable | – |
| R2-f | ❌ | ✅ Facts | Fix choice |
| R2-b / R2-c | ❌ | Evidence (sibling readers, dialog-ness) | Intent: judge, or agent via `arkui_ownership_intent` |
| Read/write kind and context | Regex extractor | Read/write kind: `documentHighlight` | Context (handler/`build`/lifecycle/async), reach via `@Builder`/`ForEach`: our parse / ArkAnalyzer |
| String-keyed links: AppStorage/LocalStorage keys, `@Provide`/`@Consume` aliases, `@Watch` names, `@Monitor` paths | ❌ | ❌ | Own key index (grep-level) |
| Derived state: `@Watch`, `@Monitor`, `@Computed` | ❌ | Locating only | New rule + dataset (MDP doesn't cover them) |
| R3 unreleased resource | ✅ | Release in another file or owner object | Judge: app-lifetime or released elsewhere |
| R4 over-reactive | ❌ | "Never written" via `references` | Rule; perf judgment |
| Imports by package name across modules | ❌ | ❌ Needs `hvigor sync` / `ohpm install` output | Own package index: `oh-package.json5` name → module, `Index.ets` re-exports, then our parse. Without it, cross-module R1 nested-write classes, `@ObjectLink` children, R2 call sites, R3 releases and R4 writers are missed |

**LSP fit:** good for the per-edit plugin, where the server stays warm and runs a few queries per edit. Poor for bench scale (thousands of items and sequential `references` calls, warm-up nondeterminism), so the bench uses a one-pass index instead.

### Plan

Each phase starts only after an explicit go.

#### Phase 0: infrastructure already in place
- [x] R1 rules (undecorated, nested write) and R3 in `analysis.ts` / `engine.ts`
- [x] Judge backends: Clef, DeepSeek flash (structured), heuristic, Laya
- [x] MDP datasets and R1 recall/precision runs (bench)
- [ ] Judge fallback chain Jev → Clef-flash → Clef → DeepSeek flash (`backend` as a list)

#### Phase 1: LSP spike (decides how much LSP can do)
- [ ] Pick a headless ArkTS language server
- [ ] Probe on `sandbox/demo`:
  - [ ] `references` on a struct
  - [ ] `references` on a child field: does it return the call-site property? (**decisive probe**)
  - [ ] `documentHighlight` Write kinds
  - [ ] `typeDefinition` across files
  - [ ] `references` on an `@Event`
- [ ] Time the probes on one module of a large real project
- [ ] Score against the E0 fact sample (LSP vs regex vs ArkAnalyzer; `bench/docs/evaluation-method.md`)
- [ ] Decide: LSP behind `FactExtractor` for the plugin, or grep for struct names + our parse

#### Phase 2: cross-file facts
- [ ] `FactExtractor` gains cross-file class resolution (LSP in the plugin, index in the bench)
- [ ] Call-site edge index: parent, child, field, expression form (`this.x` / `$x` / `this.x.y` / literal / callback)
- [ ] Parent-side facts: decorator of `x`, writes after init, readers (parent, siblings)
- [ ] Child-side facts: writes to `f` with context, invoked callbacks/`@Event`s, `@CustomDialog`/controller
- [ ] String-key index: storage keys, `@Provide`/`@Consume` aliases, `@Watch`/`@Monitor` targets

#### Phase 3: rules from facts alone
- [ ] V2 nested write with cross-file `@ObservedV2` classes
- [ ] `@Trace` per property (mutated + rendered property without `@Trace`); evaluate on the bench's trace items (same-file rule done, rendered properties only)
- [ ] `@Observed` / `@ObjectLink` recognition across files (the same-file case is done)
- [ ] R2-d event unwired
- [ ] R2-f multiple parents

#### Phase 4: R2 with intent
- [ ] Emit R2-a / R2-b / R2-c candidates with fact-summary slices (fit the Laya ~424-token limit)
- [ ] Engine mapping intent × V1/V2 × current decorator → finding / question / silent (0.8 / 0.5)
- [ ] `arkui_ownership_intent(component, field, intent)` tool; intents stored as in-code annotations (`// arkui-sem: intent …`) or in a label log (choice open)
- [ ] Questions to the agent phrased as intent, not decorator; listed once at `session.idle`
- [ ] Skill `arkui-state-management`: declare intent before writing a child component

#### Phase 5: R2 evaluation
- [x] MDP labels as intent proxies (only fields with a call-site edge); child-only vs + call site, evaluated in the bench (2026-10-08):
  - `@Link`, `@ObjectLink` with a write, `@Consume` → shared
  - `@Prop`/`@Param` with no child write → display-only
  - `@State` initialised from the parent, a written `@Prop`, `@Param @Once` + `@Local` → draft
- [ ] Mutation positives: `@Link` → `@Prop` on a child-written field (M3); a removed `onX` at a call site
- [x] R3 mutants (release line deleted) + real candidates, a labelled subset reviewed (bench)
- [ ] End to end: an opencode "edit dialog" run in `sandbox/demo` (does the agent declare intent; is the code correct)

#### Phase 6: left after LSP (later)
- [ ] Aliasing / dataflow via the ArkAnalyzer extractor
- [ ] Derived-state rule (`@Watch` / `@Monitor` / `@Computed`) + dataset
- [ ] `@Track` rule
- [ ] R4 over-reactive state
- [ ] R5 issue → component mapping (Rung 3)
