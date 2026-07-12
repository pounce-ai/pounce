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

@interface PounceUpdater : NSObject <RCTBridgeModule>
@end
