# Decisions made

- **Judge fallback chain:** Jev → Clef-flash → Clef → DeepSeek flash as System One (2026-10-05).
  - The DeepSeek step uses structured output only (strict tool schema, then `json_object`). The logprobs mode was removed on 2026-10-07: the user found it doesn't make sense. Don't reintroduce it without asking.
  - DeepSeek only ever uses `deepseek-flash`, with thinking disabled.
  - Every record notes which backend and mode answered.
  - The chain is not implemented yet (planned in `src/judge.ts`, with `backend` allowed to be a list).
- **Evaluation scope:** masked-decorator-prediction (MDP) datasets. Each component field's real decorator is the label, and the model sees the component with that decorator and its clues masked. The datasets, their numbers and the runs are in the private bench (`bench/docs/decisions.md`).
- **Decorator prediction dropped** (2026-10-08): no decorator-choice model runs, no large-LLM comparison on that task; the MDP datasets now supply items for the judge questions R1–R3.
- **Later:** an ArkAnalyzer extractor behind the `FactExtractor` interface; then re-run on the union of candidates.
- **Repos: this repo is public, the bench is a private submodule** (2026-10-08).
  - GitHub's free organization plan gives branch protection (required reviews, rulesets) only to public repos, so the code lives in the public repo, where those gates work. CI is not set up yet.
  - `bench/` is the private repo `arkui-sem-bench`, a git submodule (relative URL `../arkui-sem-bench.git`). It holds the datasets, runs, results, the eval scripts and the evaluation docs. Public clones work without it.
  - The bench needs no gates of its own: it holds experiments, and code shared with the linter lives here.
  - Ignored here: `refs/`, and everything in `sandbox/` except the demo project `sandbox/demo/` (2026-10-08: one demo project with the R1 pages; the R3 fixture and the separate copies were dropped).
- **History** (2026-10-08): both repos start from one commit. Run records made earlier name commits from before that.
- **Docs layout** (2026-10-08): `AGENTS.md` is a short map; knowledge lives in `docs/` (design docs, exec plans), the
  bench's in `bench/docs/` (results, dataset plans, evaluation method, costs); the `jev_arkts_` file prefix was dropped.
