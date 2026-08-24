//
// PounceUpdater — see PounceUpdater.h.
//
#import "PounceUpdater.h"
#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>

// Sparkle's user-driver delegate, which exists for one reason: an update found
// by the SCHEDULED check is, by Sparkle's design, shown without focus.
// SPUStandardUserDriverDelegate.h is explicit that for a background-running app
// the alert is shown "behind other running applications or behind the app's own
// windows", and it only grants immediate focus when the app was launched
// recently or the machine has been idle a while.
//
// Pounce closes to the tray instead of quitting, so that alert routinely had
// nothing to sit in front of and nothing to announce it but a single Dock
// bounce. The observed result: 1.6.6 stayed staged and unseen for over a day —
// Sparkle had done every part of its job, downloaded and verified, behind a
// window nobody was shown.
//
// So we keep Sparkle's own alert and only bring the app forward for it. This is
// the same fix, for the same reason, as -[AppDelegate openMainWindow:] — see the
// note there about activation being a no-op from a background context.
@interface PounceUpdaterUserDriverDelegate : NSObject <SPUStandardUserDriverDelegate>
@end

@implementation PounceUpdaterUserDriverDelegate

// Declares that this delegate implements the scheduled-reminder hooks below.
// Sparkle documents this as how a delegate opts into handling gentle reminders,
// so leave it YES for as long as either method below exists.
- (BOOL)supportsGentleScheduledUpdateReminders { return YES; }

// YES = Sparkle still owns the alert. We want it in front, not replaced.
- (BOOL)standardUserDriverShouldHandleShowingScheduledUpdate:(SUAppcastItem *)update
                                         andInImmediateFocus:(BOOL)immediateFocus
{
  return YES;
}

- (void)standardUserDriverWillHandleShowingUpdate:(BOOL)handleShowingUpdate
                                        forUpdate:(SUAppcastItem *)update
                                            state:(SPUUserUpdateState *)state
{
  // A user-initiated check is already frontmost — Sparkle activates for those
  // itself. Only the scheduled path is shown behind, so only it needs the nudge.
  // If the delegate ever stops handling the alert, activating would raise a
  // window that isn't coming.
  if (!handleShowingUpdate || state.userInitiated) return;
  [NSApp activate];
}

@end

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
  static PounceUpdaterUserDriverDelegate *userDriverDelegate = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    @try {
      // Kept in a static alongside the controller: Sparkle does not retain its
      // delegates, and one that deallocates takes the fix with it silently —
      // updates would go back to appearing behind everything with nothing to
      // show for it in the logs.
      userDriverDelegate = [[PounceUpdaterUserDriverDelegate alloc] init];
      controller = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:YES
                                                                 updaterDelegate:nil
                                                              userDriverDelegate:userDriverDelegate];
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
