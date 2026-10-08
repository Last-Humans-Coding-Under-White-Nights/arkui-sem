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

@Component
struct GoodCounter {
  @State count: number = 0

  build() {
    Button(`${this.count}`).onClick(() => { this.count += 1 })
  }
}

@ComponentV2
struct GoodCounterV2 {
  @Local count: number = 0

  build() {
    Button(`${this.count}`).onClick(() => { this.count += 1 })
  }
}
