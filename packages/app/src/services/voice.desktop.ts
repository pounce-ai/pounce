/**
 * Voice capture — desktop implementation.
 *
 * The mobile RN speech libraries (expo-speech-recognition, react-native-ai)
 * ship iOS-only native binaries, so this bridges to PounceSpeech — a small
 * native macOS module (macos/PounceDesktop-macOS/PounceSpeech.mm) wrapping
 * Apple's own Speech framework (SFSpeechRecognizer + AVAudioEngine), which IS
 * available on macOS 10.15+. Recognition runs ON-DEVICE (audio never leaves
 * the machine, no model download). Windows has no equivalent yet — the seam
 * degrades gracefully there via isVoiceAvailable() → false.
 */
import { NativeEventEmitter, NativeModules, Platform } from "react-native";

const PounceSpeech = NativeModules.PounceSpeech as
  | {
      isAvailable: () => Promise<boolean>;
      start: () => void;
      stop: () => void;
    }
  | undefined;

export interface Dictation {
  /** Stop listening and deliver the final transcript. */
  stop: () => void;
}

/** Why dictation couldn't run, so the UI can show the right message. */
export type VoiceErrorKind = "permission" | "unavailable" | "error";

export async function isVoiceAvailable(): Promise<boolean> {
  // Only macOS has the native module; Windows falls through to unavailable.
  if (Platform.OS !== "macos" || !PounceSpeech) return false;
  try {
    return await PounceSpeech.isAvailable();
  } catch {
    return false;
  }
}

export async function startDictation(cb: {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (kind: VoiceErrorKind) => void;
}): Promise<Dictation> {
  if (!PounceSpeech) {
    cb.onError("unavailable");
    return { stop: () => {} };
  }

  const emitter = new NativeEventEmitter(NativeModules.PounceSpeech);
  let done = false;
  const subs = [
    emitter.addListener("speechPartial", (text: string) => cb.onPartial(text)),
    emitter.addListener("speechFinal", (text: string) => {
      if (done) return;
      done = true;
      cleanup();
      cb.onFinal(text);
    }),
    emitter.addListener("speechError", (kind: VoiceErrorKind) => {
      if (done) return;
      done = true;
      cleanup();
      cb.onError(kind);
    }),
  ];
  const cleanup = () => subs.forEach((s) => s.remove());

  PounceSpeech.start();

  return {
    stop: () => {
      // Ask the recognizer to finalize; the native side emits speechFinal,
      // which runs cleanup. Guard against a stop() after we've already settled.
      if (!done) PounceSpeech.stop();
    },
  };
}
