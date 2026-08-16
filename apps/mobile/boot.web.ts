/**
 * Web boot sequence — replaces boot.ts wholesale (see index.ts for why the
 * split lives here). Web mounts the desktop Shell instead of expo-router (see
 * WebApp.tsx), and skips view-config registration — that's native-only
 * (registerViewConfigs.ts). unistyles must configure before the first
 * StyleSheet.create resolves, so its import stays first.
 */
import "@pounce/app/ui/unistyles";
import { registerRootComponent } from "expo";
import WebApp from "./WebApp";

registerRootComponent(WebApp);
