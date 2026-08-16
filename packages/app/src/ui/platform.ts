/**
 * Leaf platform predicates — importable from services without dragging in the
 * component-heavy ui/index barrel.
 */
import { Platform } from "react-native";

/** True where the DESKTOP SHELL hosts the screens — macOS/Windows, and web,
 *  which mounts the same shell (apps/mobile/WebApp.tsx). Layout forks only:
 *  the sidebar is always visible so screens drop their back buttons and
 *  headers, menus anchor to the pointer, labels are mouse-selectable — and
 *  the shell owns the sync heartbeat (see runtime.startForegroundSync).
 *  macOS-native quirks (enableFocusRing, PlatformColor) keep their own
 *  explicit platform checks — web must not inherit those. */
export const IS_DESKTOP =
  Platform.OS === "macos" || Platform.OS === "windows" || Platform.OS === "web";
