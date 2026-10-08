// R1 positive: classic undecorated counter.
// Negative: `label` is rendered but never written after init.
@Component
struct Counter {
  count: number = 0
  label: string = 'Clicks'

  build() {
    Column() {
      Text(`${this.label}: ${this.count}`)
      Button('Increment')
        .onClick(() => {
          this.count++
        })
    }
  }
}

// Negative: correct V1 state.
@Component
struct GoodCounter {
  @State count: number = 0

  build() {
    Button(`${this.count}`).onClick(() => { this.count += 1 })
  }
}

// Negative: correct V2 state.
@ComponentV2
struct GoodCounterV2 {
  @Local count: number = 0

  build() {
    Button(`${this.count}`).onClick(() => { this.count += 1 })
  }
}
