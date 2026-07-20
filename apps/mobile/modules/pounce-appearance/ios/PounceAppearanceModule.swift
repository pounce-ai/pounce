import ExpoModulesCore
import UIKit

public class PounceAppearanceModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PounceAppearance")

    // Sets overrideUserInterfaceStyle on every connected window so UIKit
    // chrome (nav bars, tab bar, sheets, keyboard) matches the app's forced
    // light/dark, not just RN-resolved colors. "unspecified" returns control
    // to the system setting.
    Function("setStyle") { (style: String) in
      let override: UIUserInterfaceStyle =
        style == "light" ? .light : style == "dark" ? .dark : .unspecified
      DispatchQueue.main.async {
        for scene in UIApplication.shared.connectedScenes {
          guard let windowScene = scene as? UIWindowScene else { continue }
          for window in windowScene.windows {
            window.overrideUserInterfaceStyle = override
          }
        }
      }
    }
  }
}
