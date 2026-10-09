# Design docs

| Doc | Status | What it holds |
|---|---|---|
| [decisions.md](decisions.md) | current | decisions made, with dates: judge chain, scope, repos, docs |
| [regressor-derivation-methodology.md](regressor-derivation-methodology.md) | current | technical derivation and benchmark validation of the AST Logistic Regressor v3 (AUC 0.81, 0ms) |
| [core-beliefs.md](core-beliefs.md) | current (condensed from the 2026-10-05 deep dive) | ArkTS tooling, decidability ladder (Rung 0–3), deep architecture, evaluation hygiene, risks |
| [agentic-plugin.md](agentic-plugin.md) | current | opencode plugin architecture, agent-first evaluation, risks of the agent loop |
| [transactional-lint-idea.md](transactional-lint-idea.md) | parked: build only on evidence | judge once per edit transaction instead of per edit |

A new design doc gets a row here. When a doc is superseded, its status says by what. The evaluation method (tasks, splits, metrics) and the removed-docs list are in the private bench: `bench/docs/evaluation-method.md`, `bench/docs/history.md`.
