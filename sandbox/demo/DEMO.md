# arkui-sem demo: the plugin corrects an agent's ArkUI edit

Based on live run 4 (2026-10-05). In that run, opencode got a plain feature request on `Profile.ets`. The plugin judged the edit with a live model (DeepSeek flash, p = 0.90) and reported that the screen would not update. The agent changed its edit in response.

Its fix (adding `@Observed` to the classes) was still wrong, and the linter of that day accepted it. Today's linter is depth-aware: it flags that fix too and points to one that works. So a rerun now shows the full loop.

## The project

`sandbox/demo/` is a minimal opencode project. Its pages in `entry/src/main/ets/pages/` are the committed baselines, each with an R1 bug (a state change the UI never sees):

- `Profile.ets`: the main demo. The `Move` button writes `this.user.address.city`, two levels below the `@State` field, so ArkUI never re-renders. A new button written the same way has the same bug.
- `Counter.ets`: a simpler backup demo. `count` has no state decorator, so the counter never updates on screen.
- `Feed.ets`: `items` is loaded asynchronously and rendered by `ForEach`, but has no decorator. `lastFetchMs` is rendered only behind a debug flag.
- `Toast.ets`: a precision example. `shownCount` is rendered and written without a decorator (a bug). `timeoutFlag` is only used in the click handler, never rendered, so it must stay undecorated: the text-based extractor still raises it (the handler sits inside `build()`), and the model judge has to reject it. The offline heuristic judges by name and flags it.

Everything else in `sandbox/` is local scratch and git-ignored.

## Setup

1. `node scripts/setup.mjs` builds the linter and installs the plugin and the skill into `sandbox/demo/.opencode/` (ignored). The plugin loads `arkui-sem/dist/`, so rebuild after linter changes.
2. Reset the pages before each take: `git checkout -- sandbox/demo/entry`.
3. Choose the judge. Clef is the default backend, and its keys come from your arkui-sem config. To be explicit: `$env:ARKUI_SEM_BACKEND = "clef"` (PowerShell).
4. Start opencode in `sandbox/demo`. Run 4 used the model `opencode/big-pickle`.

## Prompt (run 4, verbatim)

```
On the Profile page (entry/src/main/ets/pages/Profile.ets), add a 'Move to Beijing' button that changes the user's city to Beijing. Keep the change minimal.
```

Backup demo with `Counter.ets`:

```
On the Counter page (entry/src/main/ets/pages/Counter.ets), add a 'Reset' button that sets the count back to 0. Keep the change minimal.
```

## What to expect

1. The agent adds the button the obvious way: `this.user.address.city = 'Beijing'`.
2. The plugin appends a finding to the edit result, for example:
   ```
   arkui-sem: 1 finding(s), 0 question(s) about ArkUI state semantics.
   - [R1 nested-write-unobserved] …Profile.ets:25 Profile.user.address.city (p=0.95, @cf/cloudflare/clef)
     why: @State field written 2 levels deep …; V1 state decorators observe only first-layer changes, and @Observed on the classes alone does not change that
     fix: change it at the first layer instead, e.g. build a new object and assign this.user.address = <new object> …
   ```
3. The agent fixes it. The correct fix assigns a new object at the first layer:
   `const address = new Address(); address.city = 'Beijing'; this.user.address = address`
   That passes with no findings.
4. If the agent adds only `@Observed`, as in run 4, the plugin flags that too (Clef p = 0.96 in a check on 2026-10-08). After that it sends one follow-up when the session goes idle.

For `Counter.ets`, the finding is `[R1 undecorated-mutated-rendered] Counter.count` (Clef p = 0.96), and the fix is `@State count: number = 0`.

Checked on 2026-10-08 with the CLI, no agent:

| File state | heuristic | Clef |
|---|---|---|
| `Profile.ets` baseline | finding, p 0.85 | finding, p 0.95 |
| `@Observed` on the classes only | finding, p 0.85 | finding, p 0.96 |
| New object assigned at the first layer | no findings | not run |
| `Counter.ets` baseline | finding, p 0.85 | finding, p 0.96 |
| `Counter.ets` with `@State` | no findings | not run |

## DevEco Code (the opencode fork)

DevEco Code loads plugins and skills from `.deveco/` instead of `.opencode/`. Set it up in the demo project (both folders are ignored):

```powershell
node arkui-sem/scripts/install.mjs sandbox/demo
mkdir sandbox/demo/.deveco
Copy-Item -Recurse sandbox/demo/.opencode/plugins, sandbox/demo/.opencode/skills sandbox/demo/.deveco/
Set-Content sandbox/demo/.opencode/arkui-sem.json '{"backend": "clef"}'
```

The last line pins the judge; without it the user config's backend applies. Checked on 2026-10-08 with DevEco Code 0.2.1, without a model call: `deveco debug config` lists the plugin, `deveco debug skill` lists the skill, and `deveco debug agent build` shows `arkui_check` and `arkui_facts` registered.

Run `deveco` in `sandbox/demo` and paste this prompt. The DevEco TUI hides tool output, so the last sentence makes the findings visible in chat:

```
On the Profile page (entry/src/main/ets/pages/Profile.ets), add a 'Move to Beijing' button that changes the user's city to Beijing. Keep the change minimal. This machine has no HarmonyOS SDK: do not run devecocli build or arkts_check. Whenever a tool result contains arkui-sem feedback, quote it verbatim in your reply before acting on it.
```

After the run, `deveco export <sessionID>` prints the whole session, including the tool output; search it for `arkui-sem:`. Reset between takes with `git checkout -- sandbox/demo/entry`.

DevEco differs in two ways that affect the demo:

- **A competing skill.** Its built-in skill `hmos-arkui-develop-skill` already says that `@State` only tracks the first layer, and it recommends an `@Observed` class plus an `@ObjectLink` child.
  - The agent may get it right on the first try. Then no finding appears.
  - It may also take the `@ObjectLink` route, which hits the known risk below.
  - `Counter.ets` with the backup prompt is the safer take.
- **Its own checker.** DevEco has a built-in `arkts_check` for syntax and compile errors. This bug compiles fine, so that checker should pass while arkui-sem flags it.
  Not shown yet: `arkts_check` needs DevEco Studio 6.0+ and `DEVECO_HOME`, so the prompt tells the agent to skip it.

### Result on 2026-10-08 (Clef)

1. The agent added the button with the nested write `this.user.address.city = 'Beijing'`.
2. Clef flagged it (p 0.96). The agent quoted the finding and replaced the address object in the new button.
3. At idle the gate re-sent the finding (p 0.95) for the original Move button; the agent fixed that one too.
4. Final code: both buttons build a new `Address` and assign `this.user.address`. This is correct per the OpenHarmony `@State` docs (top-level property assignment is observed; nested writes are not).

Known flaw in that run: the finding cited only line 25 (the first nested write), not the line the agent just wrote. The linter lists every unobserved write of the field.

## Known risk

If the agent fixes it with a child component that takes the address as `@ObjectLink`, the linter accepts the fix only when the child and the `@Observed` class are in the same file as the page, and the page no longer renders `this.user.address.city` itself. A child in its own file is still flagged. For a clean demo, steer towards replacing the object or keeping the child in the page file, or use `Counter.ets`.
