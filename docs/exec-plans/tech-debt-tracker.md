# Tech debt and known gaps

- `@ObjectLink` children are recognized only in the same file as the parent and the `@Observed` class. A child in another file, or a class declared elsewhere, still gets a correct parent write flagged.
- The direct-render check for `@ObjectLink` sees only `this.<field>.<path>` reads: not reads through a `ForEach` item variable or a local alias, and for an array call not `ForEach(this.<field>.<array>, …)` in the parent.
- The judge fallback chain is decided but not implemented (`docs/design-docs/decisions.md`).
- The fact extractor is naive (regex-level); ArkAnalyzer behind `FactExtractor` is planned.
- Only the undecorated-mutated-rendered kind of R1 is measured with a model; nested-write has only a small offline contract benchmark (`bench/docs/plans/r1-nested.md`).
- Writes inside functions in field initializers (arrow-function properties, listener objects) are not scanned.
- Comparing with DevEco's built-in `arkts_check` needs DevEco Studio 6.0+ and `DEVECO_HOME`, not installed yet (deferred).
- No licence yet: the owner picks one before the repo goes public.
