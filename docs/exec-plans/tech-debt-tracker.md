# Tech debt and known gaps

- `@ObjectLink` children are not recognized yet, so a correct `@ObjectLink`-based fix may still be flagged.
- The R1 nested-write finding cites only the first nested write in a file, not every one (seen in the DevEco demo).
- The judge fallback chain is decided but not implemented (`docs/design-docs/decisions.md`).
- The fact extractor is naive (regex-level); ArkAnalyzer behind `FactExtractor` is planned.
- Only the undecorated-mutated-rendered kind of R1 is measured; nested-write has no benchmark yet.
- Comparing with DevEco's built-in `arkts_check` needs DevEco Studio 6.0+ and `DEVECO_HOME`, not installed yet (deferred).
- No licence yet: the owner picks one before the repo goes public.
