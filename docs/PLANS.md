# Plans

The user sets direction; agents plan and execute. Plans live in the repo so every agent sees them.

- **Exec plans** sit in `exec-plans/active/` while work is open and move to `exec-plans/completed/` with a Result section when done.
- **Handoffs** are exec plans written for another session: goal, budget in calls, backends, done-when, out of scope.
  The session that receives one plans, runs, then commits runs and report together (in the private bench)
  and adds a line to `bench/docs/RESULTS.md`.
- **Known gaps** go to `exec-plans/tech-debt-tracker.md`; decisions go to `design-docs/decisions.md`.

## Active

| Plan | About |
|---|---|
| [roadmap.md](exec-plans/active/roadmap.md) | the one forward plan: plugin status and P-A roadmap, rule coverage R1–R5 and phases 0–6 (evaluation status: `bench/docs/RESULTS.md`) |

## Completed

None in this repo yet. The dataset plans are in the private bench, `bench/docs/plans/`.

## Open decisions

- Which phase of `exec-plans/active/roadmap.md` comes next (each phase starts only after an explicit go).
