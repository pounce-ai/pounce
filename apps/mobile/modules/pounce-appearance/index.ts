import { requireOptionalNativeModule } from "expo-modules-core";

const native = requireOptionalNativeModule<{
  setStyle(style: "light" | "dark" | "unspecified"): void;
}>("PounceAppearance");

/** Apply overrideUserInterfaceStyle to every window — RN's
 *  Appearance.setColorScheme only re-resolves RN-managed colors; native chrome
 *  (navigation bars, the tab bar, form sheets, the keyboard) follows the
 *  window's trait, which this sets. No-op where the module isn't built. */
export function setWindowInterfaceStyle(style: "light" | "dark" | "unspecified"): void {
  native?.setStyle(style);
}
