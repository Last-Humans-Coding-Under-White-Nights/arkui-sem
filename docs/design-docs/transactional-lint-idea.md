# Idea: transactional linting in the opencode plugin

Status: **parked**. Build it only if live agent sessions show real evidence of the problems below: findings on in-between states, wasted judge calls, or agents distracted by findings they were about to fix. Written 2026-10-07.

## Current behaviour (arkui-sem 0.2.0)

- **`tool.execute.after`** (`src/opencode.ts`) runs after every edit tool call on a `.ets` file.
  - It re-reads the whole file from disk, so partial edits are fine: the tool has already written the file.
  - It extracts facts with `NaiveExtractor` (~1 ms per field on a large real project; ≤ 10 ms for a 2,700-line file).
  - It judges every R1/R2/R3 candidate in the file. Verdicts are cached by `sha256(backend + slice + question ids)`.
  - Findings whose fingerprint hasn't been reported yet are appended to the tool output.
- **`session.idle`** re-checks every touched file and sends one follow-up while confident findings remain (≤ 3 per session). This is already a last-gate transaction.

## Problems with judging after every edit

1. **In-between states.** Edit 1 adds `count = 0` plus a write; edit 3 adds `@State`. After edit 1 the field is a textbook R1 candidate, so a judge call is paid for and the agent is distracted by a finding it was about to fix.
2. **Line shifts defeat the cache.** Slice excerpts carry line numbers (`"28: this.x = …"`). One inserted line near the top changes every slice hash below it, so unchanged fields are judged again.
3. **Old problems in untouched code** are filtered only by fingerprint de-duplication. They are still sent to the judge.

## Proposed pipeline

```
agent edit tool call
  └─ tool.execute.before  (first touch of a file in this transaction)
       └─ baseline[file] = candidates(extract(file))          # snapshot, no judge calls
  └─ tool.execute.after   (every edit; synchronous, ~1 ms)
       ├─ facts = extract(read whole file)                    # partial edits OK
       ├─ pending[file] = candidates(facts)                   # no judge calls
       ├─ cached verdicts only → report hits (optional)
       └─ optional hybrid: judge now only rule hits on lines this edit changed
  └─ COMMIT trigger (first that fires)
       1. tool.execute.before on bash matching build/test (hvigor, ohpm, test runners)
       2. debounce: no edit to the file for N s, or the agent moved to other files
       3. session.idle (the existing gate becomes the final commit)
       4. the agent calls arkui_check explicitly
  └─ commit(file)
       ├─ delta = pending[file] − baseline[file]   (new candidates, or candidates whose code changed)
       ├─ scope: components edited in this transaction only
       ├─ judge(delta) with a line-free cache key
       │     key = sha256(backend + slice with line numbers stripped from excerpts + question ids)
       ├─ bands 0.8 / 0.5 → findings / questions → agent (next tool output or promptAsync)
       └─ baseline[file] = pending[file]           # start the next transaction
```

## Expected effect

One turn of 5 edits to a component with 3 candidate fields:

| | Judge calls |
|---|---|
| Today | up to 15 (5 × 3), because of line shifts and in-between states |
| Transactional | ≤ 3, often 1 (only the field the agent changed) |

Latency isn't an issue: extraction is ~1 ms per edit, and the judge (Clef ~0.5 s per call) runs only at commit.

## Trade-off

The agent hears about a bug later, at commit rather than right after the edit, and may keep building on it. The hybrid option above (judge right away only rule hits on lines this edit changed) limits that.

## Evidence to collect before building

From live opencode sessions (`bench/eval/run-session.mjs`), log per session:
- judge calls per edit, and how many were cache misses caused only by line shifts;
- findings that the agent's own later edit resolved without being told (in-between false alarms);
- findings on code the transaction didn't touch.

If these are rare, keep the current design.

## Files that would change

- `src/opencode.ts`: before-hook baseline, commit triggers, pending state per session.
- `src/engine.ts`: line-free cache key, `checkDelta(baseline, current)`.
- `test/opencode.test.ts`: replay an edit sequence and assert the judge call count and that there are no in-between findings.
