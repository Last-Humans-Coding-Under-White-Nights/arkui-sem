// Curated canonical ArkUI code exemplars for Code-to-Code k-NN matching.
// Sourced from OpenHarmony ArkTS documentation, best-practice guides, and framework idioms.
// Completely independent of benchmark datasets.

export interface CodeExemplar {
  id: string;
  rule: "R1" | "R3";
  label: "bug" | "clean";
  kind: string;
  description: string;
  code: string;
}

export const CODE_EXEMPLARS: CodeExemplar[] = [
  // --- R1 BUGS: Nested writes under V1 @State ---
  {
    id: "r1_bug_nested_address",
    rule: "R1",
    label: "bug",
    kind: "nested-write",
    description: "Mutating nested property 2 levels deep under @State does not trigger re-render.",
    code: `@Component
struct ProfileCard {
  @State user: User = new User()
  build() {
    Column() {
      Text(this.user.address.street)
      Button("Update").onClick(() => {
        this.user.address.street = "Main Street"
      })
    }
  }
}`,
  },
  {
    id: "r1_bug_nested_settings",
    rule: "R1",
    label: "bug",
    kind: "nested-write",
    description: "Deep mutation in configuration object not observed by @State.",
    code: `@Component
struct SettingsView {
  @State config: AppConfig = new AppConfig()
  build() {
    Column() {
      Text(\`Theme: \${this.config.theme.palette.dark}\`)
      Button("Toggle").onClick(() => {
        this.config.theme.palette.dark = !this.config.theme.palette.dark
      })
    }
  }
}`,
  },
  {
    id: "r1_bug_nested_cart_item",
    rule: "R1",
    label: "bug",
    kind: "nested-write",
    description: "Mutating object inside an array held in @State.",
    code: `@Component
struct CartList {
  @State cart: Cart = new Cart()
  build() {
    Column() {
      ForEach(this.cart.items, (item: CartItem, idx: number) => {
        Text(\`\${item.name}: \${item.quantity}\`)
        Button("+").onClick(() => {
          this.cart.items[idx].quantity++
        })
      })
    }
  }
}`,
  },
  {
    id: "r1_bug_nested_author",
    rule: "R1",
    label: "bug",
    kind: "nested-write",
    description: "Direct mutation of nested object property.",
    code: `@Component
struct ArticleView {
  @State post: Post = new Post()
  build() {
    Column() {
      Text(this.post.author.nickname)
      Button("Edit").onClick(() => {
        this.post.author.nickname = "Author"
      })
    }
  }
}`,
  },
  {
    id: "r1_bug_nested_task_done",
    rule: "R1",
    label: "bug",
    kind: "nested-write",
    description: "Mutating task status property within list item.",
    code: `@Component
struct TaskBoard {
  @State board: Board = new Board()
  build() {
    Column() {
      ForEach(this.board.tasks, (t: Task) => {
        Text(t.title)
        Button("Complete").onClick(() => {
          t.completed = true
        })
      })
    }
  }
}`,
  },

  // --- R1 BUGS: Undecorated mutated fields ---
  {
    id: "r1_bug_undecorated_counter",
    rule: "R1",
    label: "bug",
    kind: "undecorated-state",
    description: "Counter field incremented in onClick without @State decorator.",
    code: `@Component
struct Counter {
  private count: number = 0
  build() {
    Column() {
      Text(\`Count: \${this.count}\`)
      Button("Add").onClick(() => {
        this.count++
      })
    }
  }
}`,
  },
  {
    id: "r1_bug_undecorated_tab",
    rule: "R1",
    label: "bug",
    kind: "undecorated-state",
    description: "Current tab index updated without reactivity decorator.",
    code: `@Component
struct TabContainer {
  private currentTab: number = 0
  build() {
    Column() {
      Text(\`Tab: \${this.currentTab}\`)
      Button("Next Tab").onClick(() => {
        this.currentTab = (this.currentTab + 1) % 3
      })
    }
  }
}`,
  },
  {
    id: "r1_bug_undecorated_toggle",
    rule: "R1",
    label: "bug",
    kind: "undecorated-state",
    description: "Boolean visibility flag mutated without decorator.",
    code: `@Component
struct ExpandablePanel {
  private isExpanded: boolean = false
  build() {
    Column() {
      if (this.isExpanded) {
        Text("Expanded Content")
      }
      Button("Toggle").onClick(() => {
        this.isExpanded = !this.isExpanded
      })
    }
  }
}`,
  },
  {
    id: "r1_bug_undecorated_async_items",
    rule: "R1",
    label: "bug",
    kind: "undecorated-state",
    description: "List loaded asynchronously into undecorated member.",
    code: `@Component
struct Feed {
  private items: Item[] = []
  aboutToAppear() {
    fetchItems().then((res: Item[]) => {
      this.items = res
    })
  }
  build() {
    Column() {
      ForEach(this.items, (it: Item) => {
        Text(it.title)
      })
    }
  }
}`,
  },
  {
    id: "r1_bug_undecorated_search",
    rule: "R1",
    label: "bug",
    kind: "undecorated-state",
    description: "Search keyword bound to input but not reactive.",
    code: `@Component
struct SearchBar {
  private keyword: string = ""
  build() {
    Column() {
      Text(\`Searching for: \${this.keyword}\`)
      TextInput().onChange((val: string) => {
        this.keyword = val
      })
    }
  }
}`,
  },

  // --- R1 CLEAN / NEGATIVES: Clean first-layer, controllers, static cache/telemetry ---
  {
    id: "r1_clean_first_layer_reassign",
    rule: "R1",
    label: "clean",
    kind: "clean-reassign",
    description: "Reassigning the whole object at the first layer under @State is observed correctly.",
    code: `@Component
struct ProfileCard {
  @State user: User = new User()
  build() {
    Column() {
      Text(this.user.name)
      Button("Update").onClick(() => {
        this.user = new User("Alice", "New Address")
      })
    }
  }
}`,
  },
  {
    id: "r1_clean_scroller_controller",
    rule: "R1",
    label: "clean",
    kind: "clean-controller",
    description: "Scroller controller does not need state decorators.",
    code: `@Component
struct ScrollableList {
  private scroller: Scroller = new Scroller()
  build() {
    Column() {
      Scroll(this.scroller) {
        Column() { /* items */ }
      }
      Button("Top").onClick(() => {
        this.scroller.scrollEdge(Edge.Top)
      })
    }
  }
}`,
  },
  {
    id: "r1_clean_webview_controller",
    rule: "R1",
    label: "clean",
    kind: "clean-controller",
    description: "WebviewController instance managed by component without reactivity.",
    code: `@Component
struct WebBrowser {
  private webController: WebviewController = new WebviewController()
  build() {
    Column() {
      Web({ src: "https://example.com", controller: this.webController })
      Button("Reload").onClick(() => {
        this.webController.refresh()
      })
    }
  }
}`,
  },
  {
    id: "r1_clean_debug_telemetry",
    rule: "R1",
    label: "clean",
    kind: "clean-bookkeeping",
    description: "Debug timestamp or metrics log intentionally non-reactive.",
    code: `@Component
struct AnalyticsPage {
  private lastClickTs: number = 0
  private sessionId: string = "sess_123"
  build() {
    Column() {
      Button("Track").onClick(() => {
        this.lastClickTs = Date.now()
        reportEvent(this.sessionId, this.lastClickTs)
      })
    }
  }
}`,
  },
  {
    id: "r1_clean_cache_map",
    rule: "R1",
    label: "clean",
    kind: "clean-bookkeeping",
    description: "Internal cache map not meant to trigger re-renders directly.",
    code: `@Component
struct ImageGallery {
  private cache: Map<string, object> = new Map()
  build() {
    Column() {
      Button("Load").onClick(() => {
        this.cache.set("key", { loaded: true })
      })
    }
  }
}`,
  },
  {
    id: "r1_clean_immutable_config",
    rule: "R1",
    label: "clean",
    kind: "clean-bookkeeping",
    description: "Static configuration or constant page parameters.",
    code: `@Component
struct DataGrid {
  private readonly pageSize: number = 20
  private requestIndex: number = 0
  build() {
    Column() {
      Button("Next Page").onClick(() => {
        this.requestIndex += this.pageSize
      })
    }
  }
}`,
  },

  // --- R3 BUGS: Lifecycle resource leaks ---
  {
    id: "r3_bug_unreleased_interval",
    rule: "R3",
    label: "bug",
    kind: "lifecycle-leak",
    description: "setInterval acquired in aboutToAppear without clearInterval in aboutToDisappear.",
    code: `@Component
struct TimerView {
  private timerId: number = -1
  aboutToAppear() {
    this.timerId = setInterval(() => {
      // tick
    }, 1000)
  }
  build() {
    Text("Active Timer")
  }
}`,
  },
  {
    id: "r3_bug_unreleased_emitter",
    rule: "R3",
    label: "bug",
    kind: "lifecycle-leak",
    description: "Event listener registered in aboutToAppear without off in aboutToDisappear.",
    code: `@Component
struct EventWatcher {
  aboutToAppear() {
    emitter.on({ eventId: 1001 }, (data) => {
      // handle
    })
  }
  build() {
    Text("Watcher")
  }
}`,
  },
  {
    id: "r3_bug_unreleased_sensor",
    rule: "R3",
    label: "bug",
    kind: "lifecycle-leak",
    description: "Sensor subscription never released in teardown hook.",
    code: `@Component
struct Compass {
  aboutToAppear() {
    sensor.subscribeCompass((data) => {
      // sensor update
    })
  }
  build() {
    Text("Compass")
  }
}`,
  },

  // --- R3 CLEAN: Correctly released resources or app-scoped singletons ---
  {
    id: "r3_clean_interval_cleared",
    rule: "R3",
    label: "clean",
    kind: "clean-lifecycle",
    description: "Timer properly cleared in aboutToDisappear.",
    code: `@Component
struct TimerView {
  private timerId: number = -1
  aboutToAppear() {
    this.timerId = setInterval(() => {
      // tick
    }, 1000)
  }
  aboutToDisappear() {
    if (this.timerId !== -1) {
      clearInterval(this.timerId)
      this.timerId = -1
    }
  }
  build() {
    Text("Clean Timer")
  }
}`,
  },
  {
    id: "r3_clean_emitter_off",
    rule: "R3",
    label: "clean",
    kind: "clean-lifecycle",
    description: "Event listener unregistered in aboutToDisappear.",
    code: `@Component
struct EventWatcher {
  private onEvent = (d: object) => { /* handle */ }
  aboutToAppear() {
    emitter.on({ eventId: 1001 }, this.onEvent)
  }
  aboutToDisappear() {
    emitter.off(1001)
  }
  build() {
    Text("Clean Watcher")
  }
}`,
  },
  {
    id: "r3_clean_app_storage_singleton",
    rule: "R3",
    label: "clean",
    kind: "clean-lifecycle",
    description: "Global AppStorage listener intended for full application lifetime.",
    code: `@Component
struct GlobalSync {
  aboutToAppear() {
    AppStorage.setOrCreate("globalSyncState", true)
  }
  build() {
    Text("Global Sync")
  }
}`,
  },
];
