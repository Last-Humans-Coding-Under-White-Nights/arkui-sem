# arkui-sem: notes for coding agents

Semantic lint for ArkTS/ArkUI declarative state (opencode v1 plugin + CLI). See `README.md` for what it does.

## Build and test

- `npm install`, then `npm test` (builds `dist/`, runs `test/arkui-sem.test.mjs`).
- Tests are offline. Run them with `ARKUI_SEM_CONFIG` pointing at a nonexistent file so no user config or key is loaded.
- `dist/` is build output: edit `src/`, never `dist/`. Rebuild before using the CLI or the plugin.

## API keys

- Keys live in `~/.config/arkui-sem/config.json`. **Never read, print or encode that file**, with any tool.
- Don't run `arkui-sem config`: it prints masked key fragments.
- Live model calls are fine when the arkui-sem process (plugin or CLI) loads the keys itself.
  Pass all output through key redaction.
- Prefer `--backend heuristic` for anything that doesn't need a model.

## Code map

- `src/analysis.ts`: fact types, `.ets` discovery, the naive fact extractor, the rules.
- `src/judge.ts`: System One backends, questions, slices; the backend registry (`BACKENDS`).
- `src/engine.ts`: candidates → slices → judge → findings (≥ 0.8) and questions (0.5–0.8).
- `src/opencode.ts`: the plugin (post-edit feedback, idle gate, tools `arkui_check` / `arkui_facts`).
- `src/config.ts`: settings merge order; `src/cli.ts`: `check`, `config`.
- `skills/arkui-state-management/`: the skill installed next to the plugin; `scripts/install.mjs` installs both.

## Conventions

- ESM TypeScript. Match the surrounding style.
- A rule or backend change comes with a test in `test/arkui-sem.test.mjs` that runs offline.
- Commit messages describe the linter change only.

## Comments

Code explains itself where it can: clear names, small functions, named constants. A comment says only what the code can't.

- **Write** the why, a constraint, an invariant, a unit or format, an outside fact (an API limit, ArkUI behavior with its source).
- **File header**: one line on what the file is for; scripts add their usage lines (arguments, flags, output). Nothing else.
- **Don't restate** the code, a name or a type. Before writing a comment, try a better name, a named constant or an extracted
  function; if that says it, no comment.
- **No history, status or plans**: no dates, "now", "yet", "was", "new", TODOs, run ids or names of plans. Git holds history; the
  issue tracker and docs hold plans.
- **Don't narrate the change** ("fixed", "switched to X"): that is the commit message.
- **One line by default.** A block only for an algorithm or a public contract. Trailing comments stay under one clause.
- A wrong comment is worse than none: change it with the code, or delete it.
