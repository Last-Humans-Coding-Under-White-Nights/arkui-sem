// R1 nested positive: in-place write below @State into a class that is not @Observed.
class Address {
  city: string = ''
}

class User {
  name: string = ''
  address: Address = new Address()
}

@Observed
class Settings {
  dark: boolean = false
}

@Component
struct Profile {
  @State user: User = new User()
  @State settings: Settings = new Settings()

  build() {
    Column() {
      Text(this.user.address.city)
      Toggle({ type: ToggleType.Switch, isOn: this.settings.dark })
      Button('Move').onClick(() => {
        this.user.address.city = 'Shenzhen'
      })
      // Negative: Settings is @Observed.
      Button('Theme').onClick(() => {
        this.settings.dark = !this.settings.dark
      })
    }
  }
}
