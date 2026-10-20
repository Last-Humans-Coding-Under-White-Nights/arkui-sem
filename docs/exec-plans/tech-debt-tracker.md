# Tech debt and known gaps

- `@ObjectLink` children are recognized only in the same file as the parent and the `@Observed` class. A child in another file, or a class declared elsewhere, still gets a correct parent write flagged.
- V2 nested writes are judged only when the owner of the written property (and each class it extends) is declared in the file; owners from other files or of unknown type are skipped, so a missing `@ObservedV2` or `@Trace` there goes unreported. Cross-file owners are planned through ace-server `definition` on the written property.
- The extractor's type facts are separate lists (`declaredClasses`, `declaredTypes`, `observed*Classes` from whole-file regexes; `classFields`, `classMembers`, `classParents`, `arrayClasses` from a line scan) that can disagree (interfaces are in `classFields` but not `declaredClasses`). One per-type record (kind, decorators, parent, fields with their decorators) would replace them.
- V1 nested writes don't use the V2 owner logic: no inherited `@Observed`, and an owner of unknown type or from another file is flagged, where V2 skips it.
- Plain objects are known only from initializers: arrays of literals (`User[] = [{…}]`) and literals assigned later are not detected, and an interface-typed value from a factory call is skipped (it may be a class instance).
- Type inference covers `new X(…)` and object-literal initializers only (not factory calls or `as` casts); an inline object type is followed one level deep; a type alias of a class (`type U = User`) is not resolved, so writes through it are skipped.
- The direct-render check for `@ObjectLink` sees only `this.<field>.<path>` reads: not reads through a `ForEach` item variable or a local alias, and for an array call not `ForEach(this.<field>.<array>, …)` in the parent.
- The judge fallback chain is decided but not implemented (`docs/design-docs/decisions.md`).
- The fact extractor is naive (regex-level); ArkAnalyzer behind `FactExtractor` is planned.
  - Its comment, string and regex blanking is a hand-written scanner (`blank()`); TypeScript's scanner would replace it.
  - `v2Gap` handles index writes (unknown container, nested container, container in a plain object, other calls) as separate branches; one rule (walk up to the nearest non-container owner, then classify it) would cover them.
- Only the undecorated-mutated-rendered kind of R1 is measured with a model; nested-write has only a small offline contract benchmark (`bench/docs/plans/r1-nested.md`).
- Writes inside functions in field initializers (arrow-function properties, listener objects) are not scanned.
- Comparing with DevEco's built-in `arkts_check` needs DevEco Studio 6.0+ and `DEVECO_HOME`, not installed yet (deferred).
- LSP client (`arkui-sem/src/lsp/`) is not wired into the plugin: after the agent edits a file, the plugin must call
  `open(file)` with the new text before asking the server anything (the API supports it).
- The LSP client skips `hvigor sync`: modules come from a folder scan (up to four levels below the project root) and
  no package dependency records are sent, so imports by package name don't resolve: `oh_modules` packages, and other
  modules of the same project (listing them from `oh-package.json5` alone was not enough, nor was the server's own
  `--projectPath` mode). Cross-module facts are missing for R1 nested-write classes and `@ObjectLink` children, R2 call
  sites, R3 releases in helpers and R4 writers; the fix is planned in the roadmap (P-A3, package index).
- On legacy ace-server (DevEco 6.x) `references` and `callers` see usages in open files only (queried and edited ones), so
  usages in other files are missed; the standard server (DevEco 26+) searches the whole project.
- No licence yet: the owner picks one before the repo goes public.
