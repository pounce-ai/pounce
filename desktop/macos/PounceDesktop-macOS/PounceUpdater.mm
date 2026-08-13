//
// PounceUpdater — see PounceUpdater.h.
//
#import "PounceUpdater.h"
#import <Sparkle/Sparkle.h>

@implementation PounceUpdater

RCT_EXPORT_MODULE();

// Sparkle must live on the main thread.
+ (BOOL)requiresMainQueueSetup { return YES; }

// The one shared updater controller (starts the updater, which reads SUFeedURL /
// SUPublicEDKey from Info.plist). Automatic checks stay OFF until the user opts
// in — SUEnableAutomaticChecks=NO in Info.plist suppresses Sparkle's own
// first-run prompt so our consent modal is the single source. Shared with the
// menu-bar tray so both trigger the same updater. Main-thread only.
+ (SPUStandardUpdaterController *)sharedController {
  static SPUStandardUpdaterController *controller = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    @try {
      controller = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:YES
                                                                 updaterDelegate:nil
                                                              userDriverDelegate:nil];
    } @catch (NSException *e) {
      NSLog(@"[updater] failed to start Sparkle: %@", e);
    }
  });
  return controller;
}

+ (void)startAtLaunch {
  (void)[self sharedController];
}

- (SPUStandardUpdaterController *)controllerOrNil {
  return [PounceUpdater sharedController];
}

RCT_EXPORT_METHOD(isSupported:(RCTPromiseResolveBlock)resolve
                    rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    resolve(@([self controllerOrNil] != nil));
  });
}

RCT_EXPORT_METHOD(isAutomaticEnabled:(RCTPromiseResolveBlock)resolve
                           rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    SPUStandardUpdaterController *c = [self controllerOrNil];
    resolve(@(c != nil && c.updater.automaticallyChecksForUpdates));
  });
}

RCT_EXPORT_METHOD(setAutomaticEnabled:(BOOL)enabled) {
  dispatch_async(dispatch_get_main_queue(), ^{
    SPUStandardUpdaterController *c = [self controllerOrNil];
    if (c == nil) return;
    c.updater.automaticallyChecksForUpdates = enabled;
    // Opting in → do a silent check now so a pending update surfaces promptly.
    if (enabled) [c.updater checkForUpdatesInBackground];
  });
}

// User-initiated check — shows Sparkle's standard progress/prompt UI.
RCT_EXPORT_METHOD(checkForUpdates) {
  dispatch_async(dispatch_get_main_queue(), ^{
    SPUStandardUpdaterController *c = [self controllerOrNil];
    if (c != nil) [c checkForUpdates:nil];
  });
}

@end
