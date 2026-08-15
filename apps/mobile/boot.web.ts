/**
 * Web boot sequence — replaces boot.ts wholesale on web. (index.ts dispatches
 * to "./boot" precisely so Metro's platform resolution can make this swap;
 * Expo does not platform-resolve the package.json "main" entry itself.)
 *
 * Web does NOT go through expo-router: it mounts the desktop Shell instead
 * (see WebApp.tsx), cloning how the macOS app works — persistent sidebar,
 * session tabs, docks — rather than the phone's stack navigation. So there is
 * no "expo-router/entry" here, and none of index.ts's view-config registration
 * either (that exists for the boost × unistyles rewrites, both of which are
 * native-only — see registerViewConfigs.ts).
 *
 * unistyles must still configure before the first StyleSheet.create resolves,
 * so its import stays first.
 */
import "@pounce/app/ui/unistyles";
import { registerRootComponent } from "expo";
import WebApp from "./WebApp";

registerRootComponent(WebApp);
