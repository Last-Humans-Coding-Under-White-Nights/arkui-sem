# Whitepaper: Why Code Embeddings Failed on ArkUI Reactivity Bugs and How Calibrated AST Logistic Regression Solved It

**Date:** 2026-10-09  
**Status:** Approved design decision  
**Context:** Linter rule R1 (UI State Desynchronization / Under-reactive state) in `arkui-sem`.

---

## 1. Executive Summary

We investigated whether local System One decision models—specifically local dense vector embeddings (`text-embedding-embeddinggemma-2`, `qwen3-embedding`) paired with k-NN exemplar matching and linear probing—could reliably detect ArkUI declarative state bugs without relying on cloud LLM APIs.

**Key Findings:**
1. **Raw Code Embeddings Fail on State Desynchronization ($AUC \approx 0.50$):**
   Dense bi-encoders measure semantic and topical token overlap. In an ArkTS component, the difference between `@State count: number = 0` and `count: number = 0` represents $<0.5\%$ of token mass. The cosine similarity between buggy and clean versions is $>0.985$. Consequently, code-to-code k-NN produced a random-guess baseline (Precision $51.0\%$, $AUC = 0.50$).
2. **The Calibrated AST Logistic Regression Breakthrough ($AUC = 0.81$, Precision $81.6\%$, $0\text{ ms}$):**
   By analyzing the exact lifecycle and execution context of field writes extracted from AST, we formulated a calibrated logistic regression model. On the standardized benchmark, this model reduced false alarms from **142 down to 23** (an $84\%$ noise reduction), caught **102/150** bugs, and outperformed cloud models (`Cloudflare Clef` AUC 0.79, `DeepSeek-flash` AUC 0.76) with zero runtime latency and zero external dependencies.

---

## 2. Problem Statement: The R1 Reactivity Gap

In ArkUI (HarmonyOS), UI updates are driven strictly by decorated state (`@State`, `@Link`, `@Prop` in V1; `@Local`, `@Param` in V2). If a component field is mutated during user interaction but lacks a state decorator, the internal value changes while the screen remains stale—a silent UI desynchronization bug (ArkEval category 1).

A naive static linter checks:
$$\text{Is field read in } \texttt{build()} \land \text{Is field written?} \implies \text{Flag Bug}$$

On the 300-item balanced benchmark (`bench/sceneboard`):
- **True Bugs Caught:** 148 / 150
- **False Alarms:** 142 / 150
- **Precision:** $51.0\%$ (Essentially coin-flip noise; developers disable such linters).

---

## 3. The Dense Embedding Failure Analysis

We tested code-to-code k-NN ($k=3$) and linear probes on `EmbeddingGemma 2` (768d) and `Qwen3-Embedding` (2560d):

### Empirical Observations:
- **Cosine Similarity:**
  - Component with `@State`: $v_1$
  - Identical component without `@State`: $v_2$
  - $\cos(v_1, v_2) = 0.9896$.
- **Why bi-encoders cannot see reactivity bugs:**
  1. **Topic Dominance:** Embeddings encode the domain semantics of the component (e.g., e-commerce cart, profile header, grid list). The presence or absence of `@State` is drowned out by layout containers (`Column`, `Row`, `Text`, `Button`).
  2. **Lexical Bias:** When matching against curated bug exemplars, a clean candidate component with rich UI layout matches an exemplar containing layout tokens more strongly than it matches the abstract concept of missing reactivity.

---

## 4. The Calibrated Logistic AST Solution (v3)

Instead of passing raw source text to an embedding model, we extract AST structural facts and feed them into a logistic regression model trained via gradient descent:

$$P(\text{desync\_bug}) = \sigma(z) = \frac{1}{1 + e^{-z}}$$

$$z = -0.30 + \Delta_{\text{context}} + \Delta_{\text{name}} + \Delta_{\text{build}}$$

### Feature Weights and Semantic Rationale:

| Fact / Feature | Delta / Weight | Semantic Mechanism |
| :--- | :---: | :--- |
| **Architectural Hard Filter** | $P = 0.05$ | Types or names matching `Controller`, `Scroller`, `Context`, `Worker`, `Mutex`, `Client`, `Reporter`, `ViewModel`, `Manager`, `Service` are internal framework handlers or business logic singletons; decorating them with `@State` causes runtime crashes or infinite re-renders. |
| **`onlyLifecycle` / `allInitHelpers`** | $\Delta = -2.00$ | Fields mutated **only** in `aboutToAppear()` or helper initialization methods (`init*`, `calculate*`, `compute*`, `setup*`, `process*`) represent one-time startup configurations, not reactive state. |
| **`hasInteractive`** | $\Delta = +2.10$ | Fields mutated inside methods, async callbacks, or event closures declared in `build()` (e.g. `onClick`, `onTouch`) represent interactive UI state that must trigger re-renders. |
| **`isStaticName`** | $\Delta = -1.40$ | Suffixes/names indicating bookkeeping flags or telemetry (`Flag`, `Timer`, `Timeout`, `Cache`, `Ref`, `Listener`, `Config`, `Style`, `Id`, `Ms`, `Ts`). |
| **`hasDirectBuildWrite`** | $\Delta = -0.60$ | Direct assignments occurring during the build render pass itself (render buffers/proxies). |

---

## 5. Comprehensive Benchmark Verification

Evaluated across three independent datasets in the test bench:

### 1. `sceneboard` (300 items: 150 positives, 150 negatives)
- **Heuristic (Original):** Caught 148, False alarms 142, Precision $51.0\%$, AUC $0.52$.
- **EmbeddingGemma 2 (k-NN):** Caught 24, False alarms 23, Precision $51.1\%$, AUC $0.50$.
- **DeepSeek-flash (API):** Caught 63, False alarms 15, Precision $80.8\%$, AUC $0.76$.
- **Cloudflare Clef (Cloud):** Caught 107, False alarms 40, Precision $72.8\%$, AUC $0.79$.
- **Calibrated Hybrid v3 (Ours):** Caught 102, False alarms 23, **Precision $81.6\%$**, **AUC $0.81$**, **Latency $0\text{ ms}$**.

### 2. `openharmony/vignette` (339 items: V1 @State / @Link)
- **Recall @ 0.8:** $82\%$ (outperforms Clef-flash $47\%$ and DeepSeek $67\%$).
- **Hard negatives:** Suppressed $5/6$ tricky false alarms (e.g. `Index.context` $p=0.05$, `ReadPage.storyController` $p=0.05$).

### 3. `openharmony/coolmall` (19 items: V2 @ComponentV2 / @Local)
- **Recall @ 0.8:** $100\%$ ($19/19$ true reactive bugs caught).
- **False alarms:** $0$.

---

## 6. Architecture & Deployment Decision

- **Default Engine:** The calibrated AST logistic regressor is deployed inside `HeuristicBackend` in `arkui-sem/src/judge.ts`.
- **Zero Overhead:** No model downloads, no Python/LM Studio runtime required for end-users. Lint checks run in $<1\text{ ms}$ per file in DevEco Studio / OpenCode / CLI.
- **Graceful Extension:** The optional embedding backend remains available in configuration for research and semantic clustering without penalizing standard linting workflows.
