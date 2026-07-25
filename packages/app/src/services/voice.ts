/**
 * Speech-to-text capture seam.
 *
 * Backed by `expo-speech-recognition`, which wraps the native on-device speech
 * engines — `SFSpeechRecognizer` on iOS and `SpeechRecognizer` on Android — so
 * there's no model to download. `listenOnce()` records the mic once and resolves
 * the final transcript; callers feed it to the rule-based command interpreter.
 *
 * Requires a native build (the module ships native code), so it activates from
 * the next store/dev-client build, not over-the-air.
 */
import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionResultEvent,
  type ExpoSpeechRecognitionErrorEvent,
} from "expo-speech-recognition";

export interface Dictation {
  /** Stop listening and deliver the final transcript. */
  stop: () => void;
}

/** Why dictation couldn't run, so the UI can show the right message. */
export type VoiceErrorKind = "permission" | "unavailable" | "error";

/**
 * Whether dictation can run at all — the UI hides the mic when it can't (an
 * old build / Expo Go without the native module). Side-effect-free: it never
 * prompts for permission (that happens at {@link startDictation} time), just
 * checks the native module is linked and callable.
 */
export async function isVoiceAvailable(): Promise<boolean> {
  try {
    return typeof ExpoSpeechRecognitionModule?.start === "function";
  } catch {
    return false;
  }
}

/**
 * Continuous dictation for text input: streams the growing transcript through
 * `onPartial` so the field fills as you speak, keeps listening until you stop
 * (or the engine ends on a long silence), then delivers `onFinal`. Returns a
 * handle whose `stop()` ends it on demand. Unlike {@link listenOnce}, this is
 * built for a visible "listening" affordance the user controls.
 */
export async function startDictation(cb: {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (kind: VoiceErrorKind) => void;
}): Promise<Dictation> {
  const noop = { stop: () => {} };
  let perm;
  try {
    perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  } catch {
    cb.onError("unavailable"); // native module absent (old build / Expo Go)
    return noop;
  }
  if (!perm.granted) {
    cb.onError("permission");
    return noop;
  }

  let best = "";
  let done = false;
  const subs: { remove: () => void }[] = [];
  const cleanup = () => {
    subs.forEach((s) => s.remove());
    subs.length = 0;
  };
  const finish = () => {
    if (done) return;
    done = true;
    cleanup();
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {}
    cb.onFinal(best.trim());
  };

  subs.push(
    ExpoSpeechRecognitionModule.addListener("result", (e: ExpoSpeechRecognitionResultEvent) => {
      const t = e.results?.[0]?.transcript ?? "";
      if (t) {
        best = t;
        cb.onPartial(t);
      }
    }),
    ExpoSpeechRecognitionModule.addListener("error", (e: ExpoSpeechRecognitionErrorEvent) => {
      if (e.error === "no-speech" || e.error === "aborted") finish();
      else if (!done) {
        done = true;
        cleanup();
        cb.onError("error");
      }
    }),
    ExpoSpeechRecognitionModule.addListener("end", () => finish()),
  );

  try {
    ExpoSpeechRecognitionModule.start({ lang: "en-US", interimResults: true, continuous: true });
  } catch {
    cleanup();
    cb.onError("unavailable");
    return noop;
  }

  return { stop: finish };
}
