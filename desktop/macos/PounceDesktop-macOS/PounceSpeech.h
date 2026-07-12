//
// PounceSpeech — on-device speech-to-text for the macOS desktop app.
//
// react-native-macos has no speech module and the mobile RN speech libraries
// (expo-speech-recognition, react-native-ai) ship iOS-only binaries, so this
// wraps Apple's own Speech framework (SFSpeechRecognizer + AVAudioEngine),
// which IS available on macOS 10.15+. On-device recognition keeps audio local
// (no network, no model download). Exposed to JS behind the `voice` seam.
//
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface PounceSpeech : RCTEventEmitter <RCTBridgeModule>
@end
