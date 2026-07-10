/**
 * Voice capture — desktop implementation. expo-speech-recognition has no
 * macOS/Windows build; the voice UI checks isVoiceAvailable() first, so
 * returning false keeps the feature hidden, and startDictation reports
 * "unavailable" for any caller that reaches it anyway.
 */
export interface Dictation {
  /** Stop listening and deliver the final transcript. */
  stop: () => void;
}

/** Why dictation couldn't run, so the UI can show the right message. */
export type VoiceErrorKind = "permission" | "unavailable" | "error";

export async function isVoiceAvailable(): Promise<boolean> {
  return false;
}

export async function listenOnce(): Promise<string> {
  throw new Error("voice-unavailable");
}

export async function startDictation(cb: {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (kind: VoiceErrorKind) => void;
}): Promise<Dictation> {
  cb.onError("unavailable");
  return { stop: () => {} };
}
