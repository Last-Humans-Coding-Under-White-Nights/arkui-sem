// R3 positive: listener and timer registered in aboutToAppear, never released.
import { emitter } from '@kit.BasicServicesKit'

@Component
struct Ticker {
  @State now: number = 0
  private pollId: number = -1

  aboutToAppear(): void {
    emitter.on('refresh', () => { this.now = Date.now() })
    this.pollId = setInterval(() => { this.now = Date.now() }, 1000)
  }

  build() {
    Text(`${this.now}`)
  }
}

// R3 negatives: released in aboutToDisappear, or deliberately disabled with a reason.
@Component
struct GoodTicker {
  @State now: number = 0
  private pollId: number = -1
  private onRefresh = () => { this.now = Date.now() }

  aboutToAppear(): void {
    display.on('change', this.onRefresh)
    // arkui-sem-disable-next-line R3 -- app-lifetime channel owned by EntryAbility
    emitter.on('appEvent', this.onRefresh)
    this.pollId = setInterval(this.onRefresh, 1000)
  }

  aboutToDisappear(): void {
    display.off('change', this.onRefresh)
    clearInterval(this.pollId)
  }

  build() {
    Text(`${this.now}`)
  }
}
