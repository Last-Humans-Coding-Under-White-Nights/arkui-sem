---
name: arkui-state-management
description: ArkTS/ArkUI state-management and lifecycle rules for .ets components. Use when writing, editing, reviewing, or migrating ArkUI components that use @State, @Prop, @Link, @ObjectLink, @Observed, @Provide/@Consume, V2 @ComponentV2/@Local/@Param/@Event/@ObservedV2/@Trace, or aboutToAppear/aboutToDisappear listeners and timers, and when arkui-sem findings or questions appear after an edit or at the end of a turn.
---

# ArkUI state management: what re-renders and who owns state

ArkTS looks like TypeScript, but ArkUI only re-renders when **decorated state** changes. Patterns that work in React or plain TypeScript silently fail here. Decide **who owns** a value and **who may change it** before choosing a decorator.

## V1 (`@Component`)

| Intent | Mechanism |
|---|---|
| Local state this component owns and changes | `@State x: T = init` |
| Value from the parent, child only reads it (local edits are overwritten when the parent updates) | `@Prop x: T` |
| Value owned by the parent, child must change it and the parent must see the change | `@Link x: T` (no local initializer) |
| State shared across several levels without passing it down | `@Provide` in the ancestor, `@Consume` in the descendant |
| Nested object or array-item properties that change in place | `@Observed` on the class, `@ObjectLink` in a child component that renders the item |
| Never changes what is displayed | undecorated member (a cache, id, controller, debug value) |

`@State` observes reassignment and first-level property changes (`this.user.name = 'x'` works). `this.user.address.city = 'x'` is two levels deep and does **not** re-render. **Adding `@Observed` to the classes alone does nothing for this.** Either:
- reassign at the first layer, e.g. build a new `Address` and set `this.user.address = newAddress`; or
- render the nested object in a child component that takes it as `@ObjectLink address: Address` (class `@Observed`), and mutate it there.

## V2 (`@ComponentV2`)

| Intent | Mechanism |
|---|---|
| Local reactive state | `@Local x: T = init` |
| Input from the parent (read-only in the child) | `@Param x: T`; add `@Once` to allow one-time local initialization |
| Child asks the parent to change its state | `@Event onChange: (v: T) => void`; the parent updates its own `@Local` |
| Deeply observed class properties | `@ObservedV2` on the class, `@Trace` on each observed property |
| Cross-level sharing | `@Provider` / `@Consumer` |

Don't mix V1 and V2 decorators in one component.

## Lifecycle obligations

Anything registered in `aboutToAppear()` (`emitter.on`, `xxx.on('event', cb)`, `setInterval`, sensor or display listeners) must be released in `aboutToDisappear()`: `off(...)` with the same handler reference, or `clearInterval(id)`. Store the handler and the timer id in fields so the release can reach them.

## When arkui-sem reports something

- A **finding** (`[R1 …]`, `[R3 …]`) is high-confidence. Apply the suggested fix, or explain why it doesn't apply.
- A **question** (`[R1?]`, `[R3?]`) means intent is unclear. You know the task, so decide:
  - If the value should update the UI or the resource should be released, apply the fix.
  - Otherwise add `// arkui-sem-disable-next-line R1 -- <reason>` on the line above the reported line. For a nested write, put
    it above each write it lists, or above the field's decorators to accept all writes to that field.
- Don't silence findings by making everything `@State`. Needless state causes extra re-renders and hides ownership mistakes.
- Before changing how state flows through a component, call the `arkui_facts` tool on its file to see who reads and writes each field.
- To check files yourself, call the `arkui_check` tool (optionally with `paths`).
