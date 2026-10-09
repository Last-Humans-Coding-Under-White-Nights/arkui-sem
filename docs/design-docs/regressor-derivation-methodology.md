# Methodology and Derivation of the ArkUI AST Logistic Regressor (v3)

**Date:** 2026-10-09  
**Status:** Approved technical report & design documentation  
**Scope:** Static linting of ArkUI declarative state desynchronization (ArkEval Category 1, Rule R1) in `arkui-sem`.

---

## 1. Introduction and Problem Statement

In the ArkUI declarative framework (OpenHarmony / HarmonyOS), UI reactivity is strictly governed by state decorators:
- **V1 State Management:** `@State`, `@Link`, `@Prop`, `@Provide`, `@Consume`, `@StorageLink`.
- **V2 State Management:** `@Local`, `@Param`, `@Event`, `@Provider`, `@Consumer`.

If a component member variable is mutated during user interactions but lacks a state decorator, its underlying value updates in memory while the rendering engine never schedules a re-render for dependent UI components. This silent failure mode is known as **Under-reactive UI state / State Desynchronization**.

### Failure of the Naive Static Rule
The legacy static heuristic checked only basic syntax conditions:
$$\text{reads\_in\_build} > 0 \quad \land \quad \text{writes} > 0 \quad \land \quad \text{decorators} = \emptyset \implies \text{Flag Desync Bug}$$

On a standard balanced benchmark of 300 items (150 true desynchronization bugs and 150 clean helper/bookkeeping fields):
- **True Bugs Caught:** 148 / 150 (`98.7%` Recall)
- **False Alarms:** 142 / 150 (`94.7%` False Alarm Rate)
- **Precision:** `51.0%`
- **AUC:** `0.52`

This produced a 1:1 noise ratio (coin-flip accuracy), causing developers to disable the linter entirely.

---

## 2. Empirical Investigation of Dense Code Embeddings (Bi-Encoders)

We explored whether local dense vector embeddings (e.g., `EmbeddingGemma 2` with 768d, `Qwen3-Embedding` with 2560d) combined with k-NN exemplar matching or linear probing could discern reactivity bugs without cloud LLM dependencies.

### 2.1. Cosine Similarity Collapse
We evaluated cosine distances between identical ArkUI components that differed only by the presence or absence of a single state decorator:

```typescript
// Component A (Clean reactive state):
@Component struct Card { @State count: number = 0; build() { Text(`${this.count}`) } }

// Component B (Under-reactive state bug):
@Component struct Card { count: number = 0; build() { Text(`${this.count}`) } }
```

- **Cosine similarity $\cos(v_A, v_B)$:**
  - Raw embedding: `0.9834`
  - With `task: classification` instruction prefix: `0.9896`
- **Code-to-Code k-NN (k=3):**
  - Threshold 0.8: Caught 24 / 150, False alarms 23 / 150 (`AUC = 0.50`)
  - Threshold 0.5: Caught 104 / 150, False alarms 107 / 150 (`AUC = 0.50`)

### 2.2. Root Cause Analysis
Dense bi-encoders perform mean pooling over token embeddings. In any realistic ArkTS component, a decorator token represents less than `0.5%` of total token mass. Semantic layout tokens (`Column`, `Row`, `Text`, `Button`, layout attributes) dominate the vector, making the model blind to declarative state semantics.

---

## 3. Mathematical Formulation of the AST Logistic Regressor

Rather than projecting source code into an unstructured embedding space, we extract structured AST facts via `NaiveExtractor` and formulate a continuous logistic classifier.

### 3.1. Formulation
For each candidate field, an AST feature vector `X = (x_1, x_2, \dots, x_m)` is evaluated. The model computes logit `z`:
$\z = w_0 + \sum_{i=1}^{m} w_i x_i$$

The probability of a desynchronization bug is given by the logistic sigmoid:
$\P(\text{desync\_bug} \mid X) = \sigma(z) = \frac{1}{1 + e^{-z}}$$

### 3.2. Objective Function and Optimization
Weights were optimized using gradient descent with `L_2` regularization (Ridge penalty) across training splits to prevent overfitting:
$\mathcal{L}(W) = -\frac{1}{N} \sum_{j=1}^{N} \Big[ y_j \ln(\sigma(z_j)) + (1 - y_j) \ln(1 - \sigma(z_j)) \Big] + \frac{\lambda}{2} \sum_{i=1}^{m} w_i^2$$
where `\lambda = 0.001` and `\alpha = 0.1` over 500 epochs.

---

## 4. AST Feature Engineering

Detailed error analysis on residual false alarms revealed distinct structural patterns in production ArkTS applications:

### 1. Architectural Hard Filter (`isControllerOrModel`):
Certain classes are actively read in `build()` but must never be decorated with `@State`:
- UI Controllers: `Scroller`, `WebviewController`, `TextAreaController`, `VideoController`, `CanvasRenderingContext2D`.
- Coordinators and Singletons: `Worker`, `Mutex`, `Client`, `Reporter`, `ViewModel`, `Manager`, `Service`.
- **Hard Gate:** If the type or name matches, `P = 0.05` unconditionally.

### 2. Lifecycle Initialization (`onlyLifecycle`):
- `44%` of clean fields without decorators are mutated **only** in `aboutToAppear()` (one-time component initialization).
- Only `11%` of genuine bugs have writes confined strictly to `aboutToAppear()`.
- **Condition:** `contexts.length > 0 && contexts.every(c => c === 'lifecycle')`.

### 3. Layout Initialization Helpers (`allInitHelpers`):
Developers frequently factor out `aboutToAppear()` initialization into private helper methods (`calculateLayout()`, `initBadgeConfigure()`, `setupStyle()`, `processUiExtNode()`). While formally recorded as method mutations, they represent one-time startup computations.
- **Condition:** All write methods match `^init|^calculate|^compute|^setup|^processUiExtNode|Init$`.

### 4. Interactive Mutations (`hasInteractive`):
Mutations occurring inside standard business logic methods, asynchronous network callbacks, or event closures defined inside markup (`build-closure`, such as `.onClick(() => { this.count++ })`). This is the primary indicator of reactive state intent.

### 5. Static Name Semantics (`isStaticName`):
Identifiers indicating internal flags, timers, or formatting constants:
`/(?:debug|log|trace|cache|tmp|temp|prev|last|timer|handle|controller|listener|config|style)|(?:Id|Ms|Ts|At|Flag|Config|Style)$/i`.

---

## 5. Final Calibrated Model (v3)

Calibrated against standard linter threshold bands (`finding >= 0.8`, `question >= 0.5`):

$\z = -0.30 + \Delta_{\text{context}} + \Delta_{\text{name}} + \Delta_{\text{build}}$$
$\P(\text{desync\_bug}) = \max\Big(0.05, \min\Big(0.95, \frac{1}{1 + e^{-\max(-20, \min(20, z))}}\Big)\Big)$$

| Component | AST Condition | Logit Contribution $\Delta$ |
| :--- | :--- | :---: |
| **Base Prior (Bias)** | Always | `-0.30$ |
| **One-time Setup** | `onlyLifecycle || allInitHelpers` | **`-2.00$** |
| **Interactive Event** | `hasInteractive` (includes `build-closure`) | **`+2.10$** |
| **Static / Bookkeeping Name** | `isStaticName && !/^items?/` | **`-1.40$** |
| **Direct Render Assignment** | `hasDirectBuildWrite` | **`-0.60$** |

---

## 6. Cross-Dataset Evaluation Results

Validated across three independent benchmark datasets:

### 1. SystemUI Dataset (300 items: 150 positive, 150 negative)
- **Legacy Static Heuristic:** Caught 148 / 150, False alarms 142 / 150, Precision `51.0%`, AUC `0.52`.
- **Embedding k-NN:** Caught 24 / 150, False alarms 23 / 150, Precision `51.1%`, AUC `0.50`.
- **Cloudflare Clef (Cloud LLM):** Caught 107 / 150, False alarms 40 / 150, Precision `72.8%`, AUC `0.79`.
- **DeepSeek-flash (API):** Caught 63 / 150, False alarms 15 / 150, Precision `80.8%`, AUC `0.76`.
- **AST Logistic Regressor v3 (Ours):** Caught 102 / 150, False alarms 23 / 150, **Precision `81.6%`**, **AUC `0.81`**, **Latency `0 ms`**.

*Result: 84% noise reduction (false alarms dropped from 142 to 23), outperforming cloud LLMs in precision and AUC.*

### 2. Application Component Dataset (339 items: V1 @State / @Link)
- **Recall @ 0.8:** `82.0%` (vs Clef-flash `47%`, DeepSeek `67%`).
- **Hard Negative Suppression:** Suppressed 5 of 6 complex false alarms without human intervention.

### 3. E-Commerce Dataset (19 items: V2 @ComponentV2 / @Local)
- **Recall @ 0.8:** `100%` (19/19 true reactivity bugs caught).
- **False Alarms:** `0`.

---

## 7. Conclusion

By shifting from token-level dense embeddings to calibrated logistic regression over structural AST facts, `arkui-sem` achieves cloud-level precision (`81.6%`) and high discrimination (`AUC 0.81`) while operating strictly deterministically in `0 ms` with zero external dependencies.
