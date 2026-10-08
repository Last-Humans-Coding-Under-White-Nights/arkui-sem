@Component
struct Toast {
  shownCount: number = 0
  timeoutFlag: number = 0

  build() {
    Column() {
      Text(`Shown ${this.shownCount} times`)
      Button('Show toast').onClick(() => {
        this.shownCount++
        if (this.timeoutFlag !== 0) {
          clearTimeout(this.timeoutFlag)
        }
        this.timeoutFlag = setTimeout(() => {
          this.timeoutFlag = 0
        }, 3000)
      })
    }
  }
}
