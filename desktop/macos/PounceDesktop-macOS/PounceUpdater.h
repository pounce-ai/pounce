//
// PounceUpdater — desktop auto-update, bridging Sparkle to JS.
//
// Sparkle (the macOS standard) does the download → EdDSA-verify → install →
// relaunch; this module just exposes the consent + trigger surface the app
// needs: enable/disable automatic checks (driven by a first-launch prompt and
// a Settings toggle) and a manual "check now". Feed URL + public EdDSA key live
// in Info.plist (SUFeedURL / SUPublicEDKey).
//
#import <React/RCTBridgeModule.h>

@class SPUStandardUpdaterController;

@interface PounceUpdater : NSObject <RCTBridgeModule>

/// The single Sparkle updater controller, shared between this RN module and the
/// menu-bar (tray) "Check for Updates…" item so there's one updater — one feed,
/// one consent state. Lazily created on the main thread; nil if Sparkle failed
/// to start. Call only from the main thread.
+ (SPUStandardUpdaterController *)sharedController;

/// Arm Sparkle's scheduled check. Must be called once at launch: the controller
/// above is created lazily and every other caller is something the user has to
/// go and click, so without this the background check is never scheduled and a
/// released version sits unannounced however the "Automatic updates" toggle
/// reads. Named rather than left as a bare `[PounceUpdater sharedController];`
/// in the app delegate, where a statement that discards its result reads as
/// dead code and invites tidying away.
+ (void)startAtLaunch;

@end
