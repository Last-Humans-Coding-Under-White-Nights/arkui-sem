# arkui-sem

Semantic linting of ArkTS/ArkUI declarative state inside coding agents. A fact extractor finds candidate bugs
(a field that is written and rendered but not reactive, a nested write the state decorator does not observe, a
resource that is never released), and a small "System One" decision model (Cloudflare Clef, TypeSafe Jev, DeepSeek
flash as System One, ...) judges each one. Confident verdicts go back to the agent as findings, uncertain ones as
questions. It ships as an [opencode](https://opencode.ai) plugin and a CLI. **Prototype.**

## Quick start

```sh
node scripts/setup.mjs                          # build the linter, install it into the demo project sandbox/demo
node arkui-sem/scripts/install.mjs <your-project>   # or install the plugin + skill into your own opencode project
node arkui-sem/dist/cli.js check <file.ets> --backend heuristic   # offline check from the shell
```

Model backends need your own API keys: `node arkui-sem/dist/cli.js config --init` writes a starter file to fill in.
Details: [`arkui-sem/README.md`](arkui-sem/README.md).

## What is here

| Path | What |
|---|---|
| [`arkui-sem/`](arkui-sem/) | the linter: opencode plugin, CLI, skill, tests |
| [`sandbox/demo/`](sandbox/demo/) | an opencode demo project with buggy pages, and the demo guide for opencode and DevEco Code |
| [`docs/`](docs/) | design notes, decisions, roadmap |
| `bench/` | the evaluation bench: a private submodule, not needed to build or use the linter |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | how it works, and the full layout |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | how to work on it |
| [`AGENTS.md`](AGENTS.md) | the map coding agents read |
