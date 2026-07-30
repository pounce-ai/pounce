/**
 * Capturing a view as an image and handing it to the OS share sheet.
 *
 * Both libraries are NATIVE modules, so a JS-only (OTA) update can't add them
 * to an already-installed binary. Every entry point here is behind a literal
 * `require` in a try/catch plus `captureAvailable()`, so on a build whose native
 * side predates them the share button simply doesn't render instead of the
 * screen crashing.
 *
 * The requires must be LITERAL: Metro resolves them statically and rejects
 * `require(someVariable)` outright ("Invalid call at line N"). They still can't
 * be top-level imports, because view-shot's spec calls
 * `TurboModuleRegistry.getEnforcing`, which THROWS at import time when the
 * native module is missing — the try/catch is what turns that into a
 * feature flag.
 */
import type { View } from "react-native";
import { NativeModules, Platform, Share } from "react-native";
import { SHARE_CARD_WIDTH } from "../components/DashboardShareCard";

type CaptureFn = (ref: unknown, opts?: Record<string, unknown>) => Promise<string>;

let capture: CaptureFn | null | undefined;

/** view-shot's captureRef, or null when this binary lacks the native module. */
function captureFn(): CaptureFn | null {
  if (capture !== undefined) return capture;
  capture = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-view-shot") as { captureRef?: CaptureFn };
    // New arch: the require above already threw if RNViewShot is missing.
    // Old arch: TurboModuleRegistry isn't consulted, so check the bridge module
    // directly — otherwise we'd offer a button that fails on first tap.
    // globalThis, not `global`: the desktop app's tsconfig has no Node globals.
    const turbo = (globalThis as { __turboModuleProxy?: unknown }).__turboModuleProxy != null;
    const native = !!NativeModules.RNViewShot || turbo;
    if (native && typeof mod.captureRef === "function") capture = mod.captureRef;
  } catch {
    // Native side not in this build — stays null.
  }
  return capture;
}

/** Whether this binary can rasterize a view at all — gates the share button. */
export function captureAvailable(): boolean {
  return captureFn() != null;
}

/**
 * Capture `ref` as a PNG and offer it to the share sheet. Resolves false on
 * cancel or on any failure — a failed share should never surface a stack trace
 * over a stats screen.
 */
export async function shareDashboard(ref: React.RefObject<View | null>): Promise<boolean> {
  const captureRef = captureFn();
  if (!captureRef || !ref.current) return false;
  let uri: string;
  try {
    uri = await captureRef(ref, {
      format: "png",
      quality: 1,
      // 3× the card's logical size → 1080×1350, the resolution social feeds want.
      width: SHARE_CARD_WIDTH * 3,
      result: "tmpfile",
    });
  } catch {
    return false;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharing = require("expo-sharing") as {
      isAvailableAsync: () => Promise<boolean>;
      shareAsync: (url: string, opts?: Record<string, unknown>) => Promise<void>;
    };
    if (await sharing.isAvailableAsync()) {
      await sharing.shareAsync(uri, {
        mimeType: "image/png",
        dialogTitle: "Share your activity",
        UTI: "public.png",
      });
      return true;
    }
  } catch {
    // Fall through to the core Share API below.
  }
  try {
    // iOS takes a file url; Android's Share has no file support, so there's
    // nothing to fall back to there.
    if (Platform.OS !== "ios") return false;
    await Share.share({ url: uri });
    return true;
  } catch {
    return false;
  }
}
