/**
 * Voice capture — desktop implementation. expo-speech-recognition has no
 * macOS/Windows build; the voice UI checks isVoiceAvailable() first, so
 * returning false keeps the feature hidden.
 */
export async function isVoiceAvailable(): Promise<boolean> {
  return false;
}

export async function listenOnce(): Promise<string> {
  throw new Error("voice-unavailable");
}
