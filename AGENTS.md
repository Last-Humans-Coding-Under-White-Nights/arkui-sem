# arkui-sem: ArkTS semantic linting with System One models

Prototype stage. This project tests whether System One decision models (TypeSafe Jev, Cloudflare Clef / Clef-flash, and DeepSeek flash acting as System One) help lint **ArkUI declarative-state bugs**: ArkEval v1 category 1, "UI state desynchronization". The linter runs inside coding agents as an **opencode v1 plugin**. Claude Code plugin support was removed on purpose.

This repo is public. The bench (datasets, runs, results, eval scripts) is the private submodule `bench/`, with its own `AGENTS.md`; public clones work without it.

This file is the map for every coding agent (opencode and Codex read `AGENTS.md`; Claude Code reads it through `CLAUDE.md`). Keep it short: details belong in the docs it points to.

## Rules for working here

- **Never read `~/.config/arkui-sem/config.json`.** It holds the user's API keys. Don't use any tool, interpreter or encoding to get at it, and never print or echo keys.
  - Deny rules are committed for Claude Code (`.claude/settings.json`), opencode (`opencode.json`) and Codex (`.codex/rules/arkui-sem.rules`; Codex loads it only for a trusted project).
  - For offline runs, set `ARKUI_SEM_CONFIG` to a nonexistent or temp file, or use `--backend heuristic`.
- **Live model calls (Clef, DeepSeek, Laya):** agents may run them themselves.
  - The arkui-sem process (plugin, CLI or bench scripts) loads the keys from the config on its own. The agent never opens the config.
  - Don't run `arkui-sem config`: it prints masked key fragments.
  - Pass all output through key redaction.
- **Nothing from `bench/` goes into this repo**: no dataset paths, ids, numbers, code excerpts or results. Point to `bench/docs/...` by path only.
- **Plan before implementing.** For research or eval work, give the reasoning and plan first, ending with the open decisions. Don't download, clone, run scripts or edit until the user says go. Answers to open questions are not a go. When the task is to write a handoff, the handoff is the whole deliverable: don't start its steps.
- **Use few tokens**: short commands, no large dumps.
- **Code comments** everywhere follow `arkui-sem/AGENTS.md` → Comments.
- Use they/them for the user.

## Setup

- `node scripts/setup.mjs` on a fresh clone: builds the linter and installs the plugin into the demo project `sandbox/demo`. With the bench checked out (`git submodule update --init bench`, team members only) it also runs `node bench/setup.mjs` (dataset clones, `items.jsonl`, leak checks; `--datasets <names>` restores only those).
- `node scripts/setup.mjs --doctor` reports what is missing and changes nothing.
- Each person creates their own key file (`node arkui-sem/dist/cli.js config --init`, then fills it in by hand) and uses their own Cloudflare account.
- Codex users: trust the project so `.codex/rules/` loads. On macOS, Linux, WSL, or Windows with the elevated sandbox, also add this to `~/.codex/config.toml`: the sandbox then blocks the key file for every command (on the default Windows sandbox Codex refuses to run with it):
  ```toml
  default_permissions = "arkui-sem"
  [permissions.arkui-sem]
  extends = ":workspace"
  [permissions.arkui-sem.filesystem]
  "~/.config/arkui-sem" = "deny"
  ```

## Git workflow

- Branch, open a PR, merge when a reviewer approved and the offline tests pass (`npm test` in `arkui-sem/`). Commit messages and PRs here are public.
- Bench changes are committed and pushed inside `bench/` (its own repo). Bump the `bench` pointer here only when the public side needs a specific bench version.
- Commit linter changes before a bench run, so run records name a real linter version (`tree:<hash>` of `arkui-sem/`).

## Map

| Where | What |
|---|---|
| `README.md`, `CONTRIBUTING.md` | for humans: what the project is; setup, PRs, the bench |
| `ARCHITECTURE.md` | how the linter works; full file layout |
| `arkui-sem/AGENTS.md`, `arkui-sem/README.md` | linter: build, test, code map, conventions |
| `docs/PLANS.md` | how plans and handoffs work; index of exec plans; open decisions |
| `docs/exec-plans/active/roadmap.md` | **the forward plan**: plugin status, plugin roadmap (P-A), rule coverage R1–R5, phases 0–6 |
| `docs/exec-plans/tech-debt-tracker.md` | known gaps (`@ObjectLink`, nested-write citation, unimplemented judge chain, ...) |
| `docs/design-docs/index.md` | design docs with status: decisions, core beliefs, agentic plugin, parked ideas |
| `docs/design-docs/decisions.md` | decisions made (judge chain, scope, repos, docs) |
| `sandbox/demo/` | the demo project (R1 pages) and `DEMO.md`, the demo kit for opencode and DevEco Code; the rest of `sandbox/` is ignored scratch |
| `bench/` (private) | `bench/README.md` (layout), `bench/docs/RESULTS.md` (results, evaluation status), `bench/docs/evaluation-method.md`, eval scripts |

## Keeping docs fresh

- A finished task updates the doc it changed: the exec plan's status for progress, `decisions.md` for decisions, the tech-debt tracker for gaps; results go to `bench/docs/RESULTS.md`.
- Move an exec plan to `docs/exec-plans/completed/` (with a Result section) when it is done, and update `docs/PLANS.md`.
- New files get a line in the matching index (`docs/PLANS.md`, `docs/design-docs/index.md`, `ARCHITECTURE.md`).
