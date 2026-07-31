//
// PounceGlass — native vibrancy + appearance override for the macOS desktop app.
//
// react-native-macos has no NSVisualEffectView component and expo-glass-effect
// is iOS-only, so this file exposes two small pieces of AppKit to JS:
//   • PounceGlassView  — an NSVisualEffectView-backed <PounceGlassView>
//     component (material / blendingMode / cornerRadius props) behind the
//     sidebar's vibrancy and the desktop GlassCard.
//   • PounceAppearance — NSApp.appearance override so the in-app Light/Dark
//     setting themes AppKit chrome (titlebar, menus, vibrancy materials) and
//     re-resolves every PlatformColor; mirrors the mobile expo module of the
//     same name (apps/mobile/modules/pounce-appearance).
//   • PounceDragRegionView — a <PounceDragRegionView> whose empty areas drag
//     the window (and double-click to zoom), which the unified titlebar took
//     away when the app started drawing its own top chrome.
//
#import <AppKit/AppKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTViewManager.h>

/// NSVisualEffectView that can host React children (flipped so Yoga's
/// top-left-origin frames land where the shadow tree computed them).
@interface PounceGlassNSView : NSVisualEffectView
@end

@interface PounceGlassViewManager : RCTViewManager
@end

@interface PounceAppearance : NSObject <RCTBridgeModule>
@end

/// NSView that forwards drags on its own background to the window. React
/// children still receive their own clicks — only pixels no subview claimed
/// start a window drag.
@interface PounceDragRegionNSView : NSView
@end

@interface PounceDragRegionViewManager : RCTViewManager
@end
