/**
 * Native boot sequence. (Web boots differently — see boot.web.ts; the split
 * lives here rather than in index.ts because Expo does not platform-resolve
 * the package.json "main" entry itself, only the modules it imports.)
 *
 * Order is load-bearing:
 *  1. registerViewConfigs — RCTText/RCTView view configs before first render
 *     (the boost × unistyles workaround; see that file).
 *  2. unistyles configure — StyleSheet.configure must run before expo-router
 *     mounts anything; a config import in _layout.tsx is too late because
 *     routes resolve first.
 *  3. expo-router entry.
 */
import "./registerViewConfigs";
import "@pounce/app/ui/unistyles";
import "expo-router/entry";
