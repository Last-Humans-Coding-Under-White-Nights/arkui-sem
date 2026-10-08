# arkui-sem

Semantic lint for ArkTS/ArkUI declarative state, built for the coding-agent loop. It ships as an
[opencode](https://opencode.ai) v1 plugin and a CLI. Prototype.

It targets UI state desynchronization: a field that is written and rendered but not reactive, a nested write
that V1 `@State` does not observe, a resource that is never released. A fact extractor finds candidates; a
small "System One" judge model scores each one; scores of 0.8 and above become findings, scores from 0.5 to 0.8
become questions back to the agent.

## Build and test

```sh
npm install
npm test          # builds, then runs test/arkui-sem.test.mjs (offline, heuristic backend)
```

## Use in opencode

```sh
node scripts/install.mjs <project-dir>     # .opencode/plugins/arkui-sem.ts + the arkui-state-management skill
node scripts/install.mjs --global          # ~/.config/opencode/
node scripts/install.mjs <project-dir> --uninstall
```

The plugin re-exports this checkout's `dist/opencode.js`: rebuild, then restart opencode. It reviews `.ets`
edits after each tool call, gates the session once on idle while findings remain open, and adds the tools
`arkui_check` and `arkui_facts`.

## CLI

```sh
node dist/cli.js check <file.ets|dir>... [--format agent|json] [--backend <name>]
node dist/cli.js config [--init]           # prints masked key fragments
```

## Backends and configuration

| Backend | What it is |
|---|---|
| `clef` (default) | Cloudflare Clef |
| `clef-flash` | Cloudflare Clef-flash |
| `or-clef`, `or-clef-flash` | the same Clef models through OpenRouter's Decisions API (`OPENROUTER_API_KEY` or `openrouter.apiKey`) |
| `jev` | TypeSafe Jev |
| `deepseek-flash` | DeepSeek flash with structured output |
| `laya` | a local TypeSafe-compatible server (`laya.baseUrl`, default `http://127.0.0.1:8080`) |
| `heuristic` | offline rules, no model; used by the tests |

Any backend can be tried on your own files: `node dist/cli.js check <file.ets> --backend <name>`.

Settings merge in this order: defaults < `~/.config/arkui-sem/config.json` < `.opencode/arkui-sem.json`
< environment (`ARKUI_SEM_*`; `ARKUI_SEM_CONFIG` points at another config file) < plugin options.
API keys belong in the user config file only; `node dist/cli.js config --init` writes a starter file.
