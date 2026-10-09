// Canonical ArkUI anti-patterns and vector math for embedding-based matching.

export interface AntiPattern {
  id: string;
  rule: "R1" | "R2" | "R3";
  name: string;
  category: "bug" | "benign";
  description: string;
  canonicalCode: string;
  summary: string;
}

export const CANONICAL_PATTERNS: AntiPattern[] = [
  {
    id: "r1_nested_write_v1",
    rule: "R1",
    name: "Nested Object Property Mutation under V1 @State",
    category: "bug",
    description: "Mutating nested properties two or more levels deep (this.obj.nested.field = ...) in a class under @State. V1 only observes first-level changes; the UI fails to re-render.",
    canonicalCode: `@Component
struct ProfileCard {
  @State profile: UserProfile = new UserProfile()
  build() {
    Column() {
      Text(this.profile.settings.nickname)
      Button("Update").onClick(() => {
        this.profile.settings.nickname = "New Name"
      })
    }
  }
}`,
    summary: "Nested write 2+ levels deep on @State object without @Observed/@ObjectLink. Fails to trigger UI re-render in ArkUI V1.",
  },
  {
    id: "r1_undecorated_mutated",
    rule: "R1",
    name: "Undecorated Mutated State Rendered in UI",
    category: "bug",
    description: "A plain struct field rendered in build() and updated in an event handler without any state decorator (@State/@Local). Mutations never trigger UI re-rendering.",
    canonicalCode: `@Component
struct Counter {
  private count: number = 0
  build() {
    Column() {
      Text(\`Count: \${this.count}\`)
      Button("Increment").onClick(() => {
        this.count++
      })
    }
  }
}`,
    summary: "Undecorated component field rendered in build() and mutated in user event handler. State is desynchronized because no reactivity decorator is present.",
  },
  {
    id: "r3_unreleased_resource",
    rule: "R3",
    name: "Unreleased Timer or Event Listener in Component Teardown",
    category: "bug",
    description: "A subscription, timer (setInterval), or event listener (emitter.on) registered in aboutToAppear with no release (clearInterval/off) in aboutToDisappear. Causes memory leaks and duplicate callbacks.",
    canonicalCode: `@Component
struct Ticker {
  private timerId: number = -1
  aboutToAppear() {
    this.timerId = setInterval(() => {
      // tick
    }, 1000)
  }
  // Missing aboutToDisappear to clearInterval(this.timerId)
  build() {
    Text("Ticker")
  }
}`,
    summary: "Resource or timer acquired in component lifecycle hook with no release in aboutToDisappear teardown. Causes lifecycle leak.",
  },
  {
    id: "r1_benign_bookkeeping",
    rule: "R1",
    name: "Intentionally Static Bookkeeping or Cache",
    category: "benign",
    description: "A field used for background caching, metrics, session IDs, or debug logging that is intentionally non-reactive and not meant to trigger UI updates.",
    canonicalCode: `@Component
struct Feed {
  private lastFetchTs: number = 0
  private cacheKey: string = ""
  build() {
    Column() {
      // debug or internal bookkeeping
    }
  }
}`,
    summary: "Technical bookkeeping, internal timestamp, or background cache intentionally not bound to reactive UI.",
  },
  {
    id: "r3_benign_app_scope",
    rule: "R3",
    name: "Intentionally App-Scoped Persistent Resource",
    category: "benign",
    description: "An app-lifetime singleton or global service subscription intended to outlive the individual component.",
    canonicalCode: `@Component
struct GlobalSync {
  aboutToAppear() {
    AppStorage.setOrCreate("globalSyncActive", true)
  }
  build() {
    Text("Sync")
  }
}`,
    summary: "App-wide global resource or singleton that intentionally persists beyond component lifecycle.",
  },
];

export function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

export function norm(a: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const normA = norm(a);
  const normB = norm(b);
  if (normA === 0 || normB === 0) return 0;
  return dotProduct(a, b) / (normA * normB);
}

export function describePatternForEmbedding(pattern: AntiPattern): string {
  return `${pattern.name}\n${pattern.description}\nSummary: ${pattern.summary}\nCode:\n${pattern.canonicalCode}`;
}
