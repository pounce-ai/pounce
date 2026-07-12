#import "AppDelegate.h"
#import "PounceUpdater.h"

#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <Sparkle/Sparkle.h>

// Menu-bar (tray) status item. Kept alive for the app's lifetime so the icon
// stays in the menu bar; a released NSStatusItem drops out of it.
// NSWindowDelegate so the red close button hides the window (keeping the app —
// and the bridge child process — alive) instead of destroying it.
@interface AppDelegate () <NSWindowDelegate>
@property (nonatomic, strong) NSStatusItem *statusItem;
@end

// The Pounce bridge (apps/bridge/server.mjs, bundled into Resources/bridge by
// the "Bundle Pounce Bridge" build phase) runs as a child process for the
// app's lifetime. If a bridge is already listening on the port (CLI or the
// tray app), the child notices EADDRINUSE and exits; the app then talks to
// the existing instance — either way 127.0.0.1:8099 serves the app.
static NSTask *gBridgeTask = nil;

static void PounceStartBridge(void)
{
  NSString *server = [[NSBundle mainBundle] pathForResource:@"launcher"
                                                     ofType:@"mjs"
                                                inDirectory:@"bridge"];
  if (server == nil) {
    NSLog(@"[bridge] launcher.mjs not bundled; expecting an external bridge on 8099");
    return;
  }
  NSTask *task = [NSTask new];
  // Find a *working* node: login shells miss version managers initialized in
  // .zshrc (fnm/nvm), and a half-upgraded Homebrew node can fail dyld — so
  // probe candidates with `--version` and use the first that actually runs.
  task.executableURL = [NSURL fileURLWithPath:@"/bin/sh"];
  NSString *script = [NSString stringWithFormat:
    @"candidates=\"$(command -v node 2>/dev/null) "
    @"$(ls -1dr \"$HOME\"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null) "
    @"$(ls -1dr \"$HOME\"/.nvm/versions/node/*/bin/node 2>/dev/null) "
    @"/opt/homebrew/bin/node /usr/local/bin/node\"; "
    @"for n in $candidates; do "
    @"  [ -x \"$n\" ] && \"$n\" --version >/dev/null 2>&1 && exec \"$n\" \"%@\"; "
    @"done; "
    @"echo '[bridge] no working node found' >&2; exit 127", server];
  task.arguments = @[ @"-c", script ];
  NSMutableDictionary *env = [[NSProcessInfo processInfo].environment mutableCopy];
  if (env[@"BRIDGE_PORT"] == nil) env[@"BRIDGE_PORT"] = @"8099";
  // Drive Pounce-initiated live turns over ACP (richer tool status, plans,
  // permission prompts) using the adapters bundled in Resources/bridge/adapters.
  // The runner falls back to the stream-json path if an adapter isn't available.
  if (env[@"BRIDGE_ACP"] == nil) env[@"BRIDGE_ACP"] = @"1";
  task.environment = env;
  task.terminationHandler = ^(NSTask *t) {
    NSLog(@"[bridge] exited with status %d", t.terminationStatus);
  };
  NSError *err = nil;
  if (![task launchAndReturnError:&err]) {
    NSLog(@"[bridge] failed to launch: %@", err);
    return;
  }
  gBridgeTask = task;
  [[NSNotificationCenter defaultCenter]
      addObserverForName:NSApplicationWillTerminateNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification *_Nonnull note) {
                [gBridgeTask terminate];
              }];
}

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  PounceStartBridge();

  self.moduleName = @"main";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};
  self.dependencyProvider = [RCTAppDependencyProvider new];

  [super applicationDidFinishLaunching:notification];
// @generated begin expo-desktop-window-title - expo prebuild (DO NOT MODIFY) sync-9fba3e468db8e9a5641169b506a34de62335cbd3
  self.window.title = @"Pounce";
// @generated end expo-desktop-window-title

  // Pounce is a dark-themed app (#0B0B0F). Until the React root mounts — which
  // in Debug means downloading the ~10MB dev bundle from Metro — the window
  // shows react-native-macos's default LIGHT-grey loading view ("Loading from
  // Metro…"), which looks off-brand. Force the window into dark appearance and
  // paint its background/content in the app's background color so the pre-mount
  // state matches the app. (Release loads the embedded bundle near-instantly,
  // but this keeps the dev window consistent too.)
  NSColor *bg = [NSColor colorWithSRGBRed:0x0B / 255.0 green:0x0B / 255.0 blue:0x0F / 255.0 alpha:1.0];
  self.window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
  self.window.backgroundColor = bg;
  self.window.contentView.wantsLayer = YES;
  self.window.contentView.layer.backgroundColor = bg.CGColor;

  // Own the window's lifecycle: the red close button should hide the window
  // (app + bridge keep running, reachable from the tray), not tear it down.
  // releasedWhenClosed=NO is belt-and-suspenders so `self.window` stays valid.
  self.window.delegate = self;
  self.window.releasedWhenClosed = NO;

  [self setupStatusItem];
}

#pragma mark - Window lifecycle

// Hide instead of close, so closing the window never quits the app or drops the
// bridge — and the same window is always there for the tray to re-show.
- (BOOL)windowShouldClose:(NSWindow *)sender
{
  [sender orderOut:nil];
  return NO;
}

// Even if some path does close the last window for real, keep the app (and the
// bridge child process) alive — Quit from the tray is the only way out.
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender
{
  return NO;
}

#pragma mark - Menu-bar tray

// A persistent menu-bar icon so Pounce stays one click away even when its window
// is closed (the app keeps running to host the bridge). The menu offers the two
// things you'd reach for from the menu bar: reopen the window and check for
// updates — plus Quit.
- (void)setupStatusItem
{
  self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];

  // Template image → the system tints it for light/dark menu bars automatically.
  NSImage *icon = [NSImage imageWithSystemSymbolName:@"pawprint.fill"
                            accessibilityDescription:@"Pounce"];
  if (icon != nil) {
    [icon setTemplate:YES]; // dot-syntax `.template` is a C++ keyword in this .mm
    self.statusItem.button.image = icon;
  } else {
    self.statusItem.button.title = @"Pounce"; // keep the item visible if the symbol is unavailable
  }
  self.statusItem.button.toolTip = @"Pounce";

  NSMenu *menu = [[NSMenu alloc] init];

  NSMenuItem *open = [[NSMenuItem alloc] initWithTitle:@"Open Pounce"
                                                action:@selector(openMainWindow:)
                                         keyEquivalent:@"o"];
  open.target = self;
  [menu addItem:open];

  NSMenuItem *update = [[NSMenuItem alloc] initWithTitle:@"Check for Updates…"
                                                  action:@selector(checkForUpdatesFromTray:)
                                           keyEquivalent:@"u"];
  update.target = self;
  [menu addItem:update];

  [menu addItem:[NSMenuItem separatorItem]];

  NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"Quit Pounce"
                                                action:@selector(terminate:)
                                         keyEquivalent:@"q"];
  quit.target = NSApp;
  [menu addItem:quit];

  self.statusItem.menu = menu;
}

// Reveal the main window and bring the app forward. The window object survives a
// close (strong ref + releasedWhenClosed=NO), so re-ordering it front is enough.
// Use -[NSApplication activate] (macOS 14+): activateIgnoringOtherApps: is
// deprecated and a no-op from a background context on Sonoma+, which is why the
// tray item appeared to "do nothing".
- (void)openMainWindow:(id)sender
{
  [NSApp activate];
  [self.window makeKeyAndOrderFront:sender];
}

- (void)checkForUpdatesFromTray:(id)sender
{
  SPUStandardUpdaterController *updater = [PounceUpdater sharedController];
  [updater checkForUpdates:sender];
}

// Clicking the Dock icon (or reopening) with no visible window should bring the
// main window back rather than no-op.
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag
{
  if (!flag) {
    [NSApp activate];
    [self.window makeKeyAndOrderFront:nil];
  }
  return YES;
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@".expo/.virtual-metro-entry"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

/// This method controls whether the `concurrentRoot`feature of React18 is turned on or off.
///
/// @see: https://reactjs.org/blog/2022/03/29/react-v18.html
/// @note: This requires to be rendering on Fabric (i.e. on the New Architecture).
/// @return: `true` if the `concurrentRoot` feature is enabled. Otherwise, it returns `false`.
- (BOOL)concurrentRootEnabled
{
#ifdef RN_FABRIC_ENABLED
  return true;
#else
  return false;
#endif
}

@end
