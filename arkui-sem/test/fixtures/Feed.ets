// R1 positive: `items` is rendered and assigned in an async callback, but not reactive.
// R1 hard negative: `lastFetchMs` is a debug value (the judge should rate it low or ask).
import { api, Item } from '../model/Api';

@Entry
@Component
struct Feed {
  private items: Item[] = []
  private lastFetchMs: number = 0
  @State title: string = 'Feed'

  build() {
    Column() {
      Text(this.title)
      if (DEBUG) {
        Text(`fetched ${this.lastFetchMs}`)
      }
      ForEach(this.items, (it: Item) => {
        Text(it.name)
      })
    }
    .onAppear(() => {
      api.load().then((r: Item[]) => {
        this.items = r
        this.lastFetchMs = Date.now()
      })
    })
  }
}
