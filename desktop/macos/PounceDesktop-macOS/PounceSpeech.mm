//
// PounceSpeech — see PounceSpeech.h.
//
#import "PounceSpeech.h"
#import <Speech/Speech.h>
#import <AVFoundation/AVFoundation.h>

@interface PounceSpeech ()
@property (nonatomic, strong) SFSpeechRecognizer *recognizer;
@property (nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *request;
@property (nonatomic, strong) SFSpeechRecognitionTask *task;
@property (nonatomic, strong) AVAudioEngine *engine;
@property (nonatomic, assign) BOOL hasListeners;
@end

@implementation PounceSpeech

RCT_EXPORT_MODULE();

// Emit on the JS thread; `startDictation` in JS subscribes before calling start.
- (NSArray<NSString *> *)supportedEvents {
  return @[ @"speechPartial", @"speechFinal", @"speechError" ];
}
- (void)startObserving { self.hasListeners = YES; }
- (void)stopObserving { self.hasListeners = NO; }
+ (BOOL)requiresMainQueueSetup { return NO; }

- (void)emit:(NSString *)name body:(id)body {
  if (self.hasListeners) [self sendEventWithName:name body:body];
}

// Whether dictation can run at all: a recognizer exists for the locale AND the
// OS supports on-device recognition (we require on-device to keep audio local).
RCT_EXPORT_METHOD(isAvailable:(RCTPromiseResolveBlock)resolve
                      rejecter:(RCTPromiseRejectBlock)reject) {
  SFSpeechRecognizer *r = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:@"en-US"]];
  BOOL ok = r != nil && r.isAvailable && r.supportsOnDeviceRecognition;
  resolve(@(ok));
}

// Request Speech + Microphone permission, then begin continuous recognition.
// Streams partial transcripts via `speechPartial` and the settled text via
// `speechFinal`; any failure comes back as `speechError` with a kind string.
RCT_EXPORT_METHOD(start) {
  [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
    if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
      [self emit:@"speechError" body:@"permission"];
      return;
    }
    // AVCaptureDevice gates the mic on macOS; AVAudioEngine won't prompt itself.
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
      if (!granted) { [self emit:@"speechError" body:@"permission"]; return; }
      dispatch_async(dispatch_get_main_queue(), ^{ [self beginSession]; });
    }];
  }];
}

- (void)beginSession {
  [self teardown];

  self.recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:@"en-US"]];
  if (self.recognizer == nil || !self.recognizer.isAvailable) {
    [self emit:@"speechError" body:@"unavailable"];
    return;
  }

  self.request = [SFSpeechAudioBufferRecognitionRequest new];
  self.request.shouldReportPartialResults = YES;
  if (self.recognizer.supportsOnDeviceRecognition) {
    self.request.requiresOnDeviceRecognition = YES; // keep audio local
  }

  self.engine = [AVAudioEngine new];
  AVAudioInputNode *input = self.engine.inputNode;
  AVAudioFormat *format = [input outputFormatForBus:0];
  __weak PounceSpeech *weakSelf = self;
  [input installTapOnBus:0 bufferSize:1024 format:format
                   block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
    [weakSelf.request appendAudioPCMBuffer:buffer];
  }];

  self.task = [self.recognizer recognitionTaskWithRequest:self.request
                                            resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
    if (result != nil) {
      NSString *text = result.bestTranscription.formattedString ?: @"";
      if (result.isFinal) {
        [weakSelf emit:@"speechFinal" body:text];
        [weakSelf teardown];
      } else {
        [weakSelf emit:@"speechPartial" body:text];
      }
    }
    if (error != nil) {
      // A user-initiated stop cancels the task; that surfaces here as an error
      // but isn't a real failure — teardown() already delivered the final.
      if (weakSelf.task != nil) [weakSelf emit:@"speechError" body:@"error"];
      [weakSelf teardown];
    }
  }];

  [self.engine prepare];
  NSError *startErr = nil;
  if (![self.engine startAndReturnError:&startErr]) {
    [self emit:@"speechError" body:@"error"];
    [self teardown];
  }
}

// Stop capturing and force the recognizer to finalize what it has. The result
// handler then fires once more with isFinal=YES → speechFinal.
RCT_EXPORT_METHOD(stop) {
  if (self.engine.isRunning) {
    [self.engine stop];
    [self.engine.inputNode removeTapOnBus:0];
  }
  [self.request endAudio];
}

- (void)teardown {
  if (self.engine.isRunning) {
    [self.engine stop];
    [self.engine.inputNode removeTapOnBus:0];
  }
  [self.task cancel];
  self.task = nil;
  self.request = nil;
  self.engine = nil;
}

- (void)invalidate {
  [self teardown];
  [super invalidate];
}

@end
