# Methodology and Architecture of the ArkUI AST Logistic Regressor

**Status:** Current  
**Scope:** Static linting of ArkUI declarative state desynchronization (ArkEval Category 1, Rule R1) in `arkui-sem`.

---

## 1. Introduction and Problem Statement

In the ArkUI declarative framework (OpenHarmony / HarmonyOS), UI reactivity is strictly governed by state decorators:
- **V1 State Management:** `@State`, `@Link`, `@Prop`, `@Provide`, `@Consume`, `@StorageLink`.
- **V2 State Management:** `@Local`, `@Param`, `@Event`, `@Provider`, `@Consumer`.

If a component member variable is mutated during user interactions but lacks a state decorator, its underlying value updates in memory while the rendering engine never schedules a re-render for dependent UI components. This silent failure mode is known as **Under-reactive UI state / State Desynchronization**.

### The Limits of Naive Static Rules

A naive static heuristic flagging all unadorned fields:

$$\text{reads\_in\_build} > 0 \land \text{writes} > 0 \land \text{decorators} = \emptyset \implies \text{Flag Desync Bug}$$

exhibits an unacceptably high false alarm rate. In production codebases, many non-reactive fields are legitimately read in `build()` and mutated:
- One-time initialization in lifecycle hooks (e.g., `aboutToAppear()`).
- Internal UI controllers (e.g., `Scroller`, `WebviewController`).
- Temporary computation values and rendering caches.

Flagging all such fields causes developer fatigue and linter abandonment.

---

## 2. Dense Code Embeddings vs. Structural Facts

Early experiments evaluated whether local dense vector embeddings (e.g., code bi-encoders) combined with k-NN exemplar matching or linear probing could classify reactivity intent without cloud LLM dependencies.

### Cosine Similarity Collapse

Dense bi-encoders compute vector representations by pooling token embeddings across entire code blocks. In realistic ArkTS components, a decorator keyword (like `@State`) represents less than 0.5% of the total token count. Layout elements (`Column`, `Row`, `Text`, `Button`) and styling attributes dominate the embedding space.

Consequently, components differing solely by the presence or absence of a state decorator exhibit near-identical cosine similarities ($\cos(v_A, v_B) \approx 0.98\text{--}0.99$). Token-level dense encoders lack sensitivity to fine-grained declarative state semantics.

---

## 3. Mathematical Formulation of the AST Logistic Regressor

Instead of embedding raw tokens, `arkui-sem` extracts structured AST facts via `NaiveExtractor` and applies a continuous logistic scoring model in `HeuristicBackend`.

### Formulation

For each candidate field, an AST feature vector $X = (x_1, x_2, \dots, x_m)$ is evaluated. The model computes logit $z$:

$$z = w_0 + \sum_{i=1}^{m} w_i x_i$$

The probability of a desynchronization bug is given by the standard logistic sigmoid:

$$P(\text{desync\_bug} \mid X) = \sigma(z) = \frac{1}{1 + e^{-z}}$$

To prevent extreme overconfidence on noisy edge cases, the probability is clamped within $[0.05, 0.95]$.

---

## 4. Name-Free AST Feature Engineering

Rather than relying on brittle naming conventions (such as `on*` or `init*` prefixes that fail to generalize across differing codebases and teams), the feature model relies purely on structural syntax and call-graph reachability:

### 1. Controller / Scroller Architectural Gate
Certain framework classes are passed to UI components to control scroll positions or views, but do not represent reactive state:
- Framework controllers: `Scroller`, `Controller` types.
- Unconditionally gated to a minimal prior ($P = 0.05$).

### 2. Structural External-Method Reachability
To identify event handlers, callbacks, and listener targets without matching method names, `NaiveExtractor` builds an intra-component reachability call graph:
- **Roots:**
  - `build()` and `@Builder` methods (traversing direct calls and method references such as `.onClick(this.handleClick)`).
  - Lifecycle hooks (`aboutToAppear`, `aboutToDisappear`, `onPageShow`, `onPageHide`, etc.).
- **External Methods:** Any component method not reachable from `build()`, `@Builder`, or lifecycle hooks is marked as an external entry point (`external: true`). These are methods called by external listeners, async callbacks, or other classes.
- Writes occurring inside markup closures (`build-closure`) or in `external` methods indicate interactive mutations that require reactive re-rendering.

### 3. Lifecycle-Only Mutation Penalty
Mutations confined strictly to lifecycle hooks (`contexts.every(c => c === "lifecycle")`) are typical of one-time setup and reduce the desynchronization logit.

### 4. Deep Nested Mutation Penalty
ArkUI V1 `@State` only observes first-level property reassignments. In-place mutations two or more levels deep (`this.a.b.c = ...`) do not trigger re-render on the parent component unless using `@Observed` / `@ObjectLink`. Fields with nested writes are penalized to avoid false positives on unobserved nested paths.

### 5. Type Indicators with Word Boundaries
Primitive types exhibit different likelihoods of being reactive state:
- `\bboolean\b` and `\bnumber\b`: typically represent toggle flags, counters, or indices (+0.7).
- `\bstring\b`: often used for static labels or identifiers (-0.6).
- Arrays (`[]`, `Array<`): (-0.4).

### 6. Declarative UI Modifiers in Build Excerpts
Excerpts capturing uses in `build()` are inspected for reactive ArkUI UI patterns:
- Control flow: `ForEach(...)` (+1.8).
- Visual state attributes: `.visibility()`, `.opacity()` (+1.4).
- Animations / transformations: `.scale()`, `.rotate()`, `.translate()` (+0.6).
- Styling / interaction state: `.color()`, `.backgroundColor()`, `.fontColor()`, `.enabled()` (+0.6).

### 7. Time / Performance Bookkeeping Suppression
Fields associated with `Date.now()`, `performance.now()`, or timer handles (`setTimeout`, `setInterval`) represent internal measurement or scheduling and are penalized (-1.4).

---

## 5. Calibrated Logit Weights

The calibrated feature weights in `HeuristicBackend` operate as follows:

- Base logit: $z_0 = 1.05$
- Type adjustments:
  - $\text{type} \sim \text{\textbackslash bboolean\textbackslash b}$: $+0.7$
  - $\text{type} \sim \text{\textbackslash bnumber\textbackslash b}$: $+0.7$
  - $\text{type} \sim \text{\textbackslash bstring\textbackslash b}$: $-0.6$
  - $\text{type} \sim \text{Array}$: $-0.4$
- Event / Reachability:
  - `hasEventHandler` (`build-closure` or `external` method): $+1.6$
  - `onlyLifecycle`: $-1.8$
  - `hasNestedMutation`: $-0.7$
  - Multiple writes: $>1$ write ($+0.3$), $>3$ writes ($+0.7$)
- Markup indicators in excerpts:
  - `ForEach`: $+1.8$
  - `visibility` / `opacity`: $+1.4$
  - `scale` / `rotate` / `translate`: $+0.6$
  - `color` / `backgroundColor` / `fontColor` / `enabled`: $+0.6$
  - Timers / timestamps: $-1.4$

---

## 6. Evaluation and Verification

All quantitative benchmark evaluations, cross-application datasets, run records, and comparative metrics are maintained separately in the private benchmark repository.

For evaluation methodology, metric definitions, and benchmark results, see:
- `bench/docs/evaluation-method.md`
- `bench/docs/RESULTS.md`
