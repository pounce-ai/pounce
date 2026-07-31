//
// PounceGlass — see PounceGlass.h.
//
#import "PounceGlass.h"

#import <React/RCTConvert.h>

#pragma mark - PounceGlassNSView

@implementation PounceGlassNSView

- (instancetype)initWithFrame:(NSRect)frameRect {
  if (self = [super initWithFrame:frameRect]) {
    self.material = NSVisualEffectMaterialSidebar;
    self.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    // Dim together with the window, like every native sidebar/panel.
    self.state = NSVisualEffectStateFollowsWindowActiveState;
    self.wantsLayer = YES;
  }
  return self;
}

// react-native-macos lays children out with top-left-origin Yoga frames.
- (BOOL)isFlipped {
  return YES;
}

@end

#pragma mark - PounceGlassViewManager

/// Rounded-rect mask that clips the blur backdrop itself — layer cornerRadius
/// only clips content, NSVisualEffectView's sampled backdrop needs maskImage.
static NSImage *PounceGlassRoundedMask(CGFloat radius) {
  CGFloat d = radius * 2 + 1;
  NSImage *img = [NSImage imageWithSize:NSMakeSize(d, d)
                                flipped:NO
                         drawingHandler:^BOOL(NSRect rect) {
                           [[NSColor blackColor] set];
                           [[NSBezierPath bezierPathWithRoundedRect:rect
                                                            xRadius:radius
                                                            yRadius:radius] fill];
                           return YES;
                         }];
  img.capInsets = NSEdgeInsetsMake(radius, radius, radius, radius);
  img.resizingMode = NSImageResizingModeStretch;
  return img;
}

@implementation PounceGlassViewManager

RCT_EXPORT_MODULE(PounceGlassView)

- (NSView *)view {
  return [[PounceGlassNSView alloc] initWithFrame:NSZeroRect];
}

static NSVisualEffectMaterial PounceGlassMaterial(NSString *name) {
  static NSDictionary<NSString *, NSNumber *> *map;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    map = @{
      @"sidebar" : @(NSVisualEffectMaterialSidebar),
      @"titlebar" : @(NSVisualEffectMaterialTitlebar),
      @"headerView" : @(NSVisualEffectMaterialHeaderView),
      @"menu" : @(NSVisualEffectMaterialMenu),
      @"popover" : @(NSVisualEffectMaterialPopover),
      @"sheet" : @(NSVisualEffectMaterialSheet),
      @"hudWindow" : @(NSVisualEffectMaterialHUDWindow),
      @"toolTip" : @(NSVisualEffectMaterialToolTip),
      @"contentBackground" : @(NSVisualEffectMaterialContentBackground),
      @"windowBackground" : @(NSVisualEffectMaterialWindowBackground),
      @"underWindowBackground" : @(NSVisualEffectMaterialUnderWindowBackground),
      @"underPageBackground" : @(NSVisualEffectMaterialUnderPageBackground),
      @"selection" : @(NSVisualEffectMaterialSelection),
      @"fullScreenUI" : @(NSVisualEffectMaterialFullScreenUI),
    };
  });
  NSNumber *m = name ? map[name] : nil;
  return m ? (NSVisualEffectMaterial)m.integerValue : NSVisualEffectMaterialSidebar;
}

RCT_CUSTOM_VIEW_PROPERTY(material, NSString, PounceGlassNSView) {
  view.material = PounceGlassMaterial(json ? [RCTConvert NSString:json] : nil);
}

RCT_CUSTOM_VIEW_PROPERTY(blendingMode, NSString, PounceGlassNSView) {
  NSString *mode = json ? [RCTConvert NSString:json] : nil;
  view.blendingMode = [mode isEqualToString:@"withinWindow"]
                          ? NSVisualEffectBlendingModeWithinWindow
                          : NSVisualEffectBlendingModeBehindWindow;
}

RCT_CUSTOM_VIEW_PROPERTY(cornerRadius, CGFloat, PounceGlassNSView) {
  CGFloat radius = json ? [RCTConvert CGFloat:json] : 0;
  view.maskImage = radius > 0 ? PounceGlassRoundedMask(radius) : nil;
  // Clip React children too (they draw above the blur backdrop).
  view.wantsLayer = YES;
  view.layer.cornerRadius = radius;
  view.layer.masksToBounds = radius > 0;
}

@end

#pragma mark - PounceAppearance

@implementation PounceAppearance

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

// Same contract as the mobile expo module: "light" | "dark" | "unspecified".
// "unspecified" clears the override so the app follows the system setting.
RCT_EXPORT_METHOD(setStyle:(NSString *)style) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSAppearance *appearance = nil;
    if ([style isEqualToString:@"dark"]) {
      appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    } else if ([style isEqualToString:@"light"]) {
      appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    }
    // AppDelegate pins the window dark so the pre-mount "Loading from Metro"
    // view matches the brand; a per-window appearance out-prioritizes
    // NSApp.appearance, so release the pin the moment JS takes over.
    for (NSWindow *window in NSApp.windows) {
      window.appearance = nil;
    }
    NSApp.appearance = appearance;
  });
}

@end

#pragma mark - PounceDragRegionView

@implementation PounceDragRegionNSView

// react-native-macos lays children out with top-left-origin Yoga frames.
- (BOOL)isFlipped {
  return YES;
}

// This view is a bare backdrop with no React children — the chrome's controls
// are later siblings painted above it, so anything that reaches here really is
// empty titlebar space. (An earlier version wrapped the controls and tried to
// hitTest its way out; react-native-macos routes touches through a root gesture
// recognizer rather than per-view mouseDown, so every button press was eaten
// and became a window drag instead.)
- (void)mouseDown:(NSEvent *)event {
  // Matches the system titlebar: double-click runs the user's
  // "double-click a window's title bar to…" preference (zoom or minimize).
  if (event.clickCount == 2) {
    NSString *action = [[NSUserDefaults standardUserDefaults]
        stringForKey:@"AppleActionOnDoubleClick"];
    if ([action isEqualToString:@"Minimize"]) {
      [self.window miniaturize:nil];
    } else if (![action isEqualToString:@"None"]) {
      [self.window zoom:nil];
    }
    return;
  }
  [self.window performWindowDragWithEvent:event];
}

@end

@implementation PounceDragRegionViewManager

RCT_EXPORT_MODULE(PounceDragRegionView)

- (NSView *)view {
  return [[PounceDragRegionNSView alloc] initWithFrame:NSZeroRect];
}

@end
