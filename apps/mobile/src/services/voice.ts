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

/** True when speech recognition is usable (granted, or we can still ask). */
export async function isVoiceAvailable(): Promise<boolean> {
  try {
    const perm = await ExpoSpeechRecognitionModule.getPermissionsAsync();
    return perm.granted || perm.canAskAgain;
  } catch {
    return false; // native module absent (e.g. Expo Go / old build)
  }
}

/**
 * Record the mic once and resolve the transcript. Resolves "" when nothing was
 * heard (callers treat that as "didn't catch that"); rejects only on a real
 * failure or a denied permission, which the UI surfaces as a friendly notice.
 */
export async function listenOnce(): Promise<string> {
  const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  if (!perm.granted) throw new Error("voice-permission-denied");

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let best = "";
    const subs: { remove: () => void }[] = [];
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      subs.forEach((s) => s.remove());
      try { ExpoSpeechRecognitionModule.abort(); } catch {}
      run();
    };

    subs.push(
      ExpoSpeechRecognitionModule.addListener("result", (e: ExpoSpeechRecognitionResultEvent) => {
        const t = e.results?.[0]?.transcript ?? "";
        if (t) best = t; // keep the latest (interim or final) transcript
        if (e.isFinal) finish(() => resolve(best.trim()));
      }),
      ExpoSpeechRecognitionModule.addListener("error", (e: ExpoSpeechRecognitionErrorEvent) => {
        // Silence isn't an error worth shouting about — treat as nothing heard.
        if (e.error === "no-speech" || e.error === "aborted") finish(() => resolve(best.trim()));
        else finish(() => reject(new Error(e.message || e.error || "voice-error")));
      }),
      ExpoSpeechRecognitionModule.addListener("end", () => {
        // Ended without a final result — resolve whatever we captured.
        finish(() => resolve(best.trim()));
      }),
    );

    try {
      ExpoSpeechRecognitionModule.start({
        lang: "en-US",
        interimResults: true,
        continuous: false, // stop on the first final result — it's a single command
      });
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error("voice-start-failed")));
    }

    // Safety net: never let the mic hang the UI.
    const to = setTimeout(() => finish(() => resolve(best.trim())), 12000);
    subs.push({ remove: () => clearTimeout(to) });
  });
}

export interface Dictation {
  /** Stop listening and deliver the final transcript. */
  stop: () => void;
}

/** Why dictation couldn't run, so the UI can show the right message. */
export type VoiceErrorKind = "permission" | "unavailable" | "error";

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
  const cleanup = () => { subs.forEach((s) => s.remove()); subs.length = 0; };
  const finish = () => {
    if (done) return;
    done = true;
    cleanup();
    try { ExpoSpeechRecognitionModule.stop(); } catch {}
    cb.onFinal(best.trim());
  };

  subs.push(
    ExpoSpeechRecognitionModule.addListener("result", (e: ExpoSpeechRecognitionResultEvent) => {
      const t = e.results?.[0]?.transcript ?? "";
      if (t) { best = t; cb.onPartial(t); }
    }),
    ExpoSpeechRecognitionModule.addListener("error", (e: ExpoSpeechRecognitionErrorEvent) => {
      if (e.error === "no-speech" || e.error === "aborted") finish();
      else if (!done) { done = true; cleanup(); cb.onError("error"); }
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
