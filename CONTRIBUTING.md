# Contributing

This repo asks whether small "System One" decision models can catch ArkUI state bugs while a coding agent edits
ArkTS code. It holds:

- **`arkui-sem/`**: the linter, an opencode plugin and a CLI.
- **`sandbox/demo/`**: a small opencode demo project with buggy pages, and the demo guide.
- **`docs/`**: design notes, decisions and the roadmap.

The bench that measures the linter on real code (datasets, model runs, results, evaluation scripts) is a private
repo, checked out as the submodule `bench/` by team members. Everything else works without it.

Coding agents get the same rules from `AGENTS.md`.

## Getting started

You need git, a recent Node.js, and [opencode](https://opencode.ai) if you want to run agent sessions.

```sh
node scripts/setup.mjs            # build the linter, install the plugin into sandbox/demo
node scripts/setup.mjs --doctor   # show what is missing, change nothing
cd arkui-sem && npm test          # offline tests
```

Model calls need your own API keys. Run `node arkui-sem/dist/cli.js config --init` and fill in the file it creates
(`~/.config/arkui-sem/config.json`) by hand. The keys never go into the repo, and the agent configs in this repo
stop coding agents from reading that file.

### Team members: the bench

```sh
git clone --recurse-submodules <this repo's URL>      # or, in an existing clone:
git submodule update --init bench
node scripts/setup.mjs                               # now also restores the datasets (downloads, large)
```

The bench has its own `README.md` and `AGENTS.md`. Commit and push bench changes inside `bench/`: it is a separate
repo. Update the `bench` pointer in this repo only when the public side needs a specific bench version.

## Finding your way

- `ARCHITECTURE.md`: how the linter works, and where every file lives.
- `docs/exec-plans/active/roadmap.md`: what comes next.
- `docs/PLANS.md`: how plans are written, and the decisions that are still open.
- `AGENTS.md`: the short map that agents read; useful for humans too.

## Making a change

1. Branch from `main` and commit the way you normally do.
2. Run the offline tests (`cd arkui-sem && npm test`) and open a pull request.
3. Push more commits during review. Merge when a reviewer approved.

**This repo is public.** Keep bench data out of code, docs, commit messages and PR text: no dataset paths or ids,
no numbers from runs, no code from private projects. Point to a bench file by its path (`bench/docs/...`) if you
need to.

## Experiments

Experiments live in the bench. A plan comes first (the format is in `docs/PLANS.md`), then the run, then its records
and report are committed together in the bench, with a line in `bench/docs/RESULTS.md`.

Each run record names the linter version as `tree:<hash>`, a hash of the `arkui-sem/` folder. Commit your linter
change here before a run so the hash points at real code; `node bench/linter-tree.mjs <tree:hash>` finds the commit
later.

## Working with coding agents

Claude Code, opencode and Codex all read `AGENTS.md` (Claude Code through `CLAUDE.md`). The repo also carries deny
rules for each of them, so they cannot read your key file. Codex loads its rules only after you trust the project;
`AGENTS.md` has the details. You are responsible for what your agent commits.

## Code style

The linter is TypeScript (ESM); the scripts are plain Node.js. Name things so the code explains itself, and comment
only what it cannot say. The full rules are in `arkui-sem/AGENTS.md` under "Comments". A change to a linter rule or
backend comes with an offline test in `arkui-sem/test/`.
