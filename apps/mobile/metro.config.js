// Metro config: monorepo-aware.
const { getDefaultConfig } = require("expo/metro-config");
const { getBundleModeMetroConfig } = require("react-native-worklets/bundleMode");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// Keep hierarchical lookup ON: bun uses symlinked node_modules.

// expo-router vendors its own @react-navigation/core fork and rewrites every
// bare '@react-navigation/core' import to it — but only on the DEV SERVER.
// `expo export:embed` (what release/EAS builds run) skips that rewrite in this
// monorepo, so libraries with a core peer dep (@lodev09/react-native-true-sheet)
// bundled the REAL package alongside the fork: two SingleNavigatorContext
// instances, root TrueSheet navigator can't see expo-router's container, and
// every store build aborted at launch ("Couldn't register the navigator" →
// expo-updates ErrorRecovery → SIGABRT). Pin the rewrite here so dev and
// release bundles agree on the vendored copy.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@react-navigation/core") {
    return context.resolveRequest(context, "expo-router/react-navigation", platform);
  }
  // Web mounts the DESKTOP shell (see boot.web.ts), which has no router — the
  // shared screens' expo-router imports resolve to the shell's shim, exactly
  // as desktop/metro.config.js does for macOS/Windows. Only the bare specifier
  // exists in the shell's graph (grep 'from "expo-router' — no subpaths), and
  // native still gets the real package.
  if (platform === "web" && moduleName === "expo-router") {
    return {
      type: "sourceFile",
      filePath: path.resolve(workspaceRoot, "desktop/src/shims/router.tsx"),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Worklets Bundle Mode (see babel.config.js): shims react-native/TurboModuleRegistry
// for secondary runtimes and pins module ids so worklet runtimes can address the
// shared bundle.
//
// Its resolver rewrites EVERY bare 'react-native' import to its own shim with no
// platform check, which on web replaces react-native-web with the real RN core —
// InitializeCore then calls TurboModuleRegistry.get('NativePerformanceCxx') and
// dies on "__fbBatchedBridgeConfig is not set" before the first render. Babel's
// half of bundle mode is already native-only; this is the resolver half. Web has
// no secondary runtimes to serve, so it just uses the base resolution.
const nativeResolveRequest = config.resolver.resolveRequest;
const bundleModeConfig = getBundleModeMetroConfig(config);
const bundleModeResolveRequest = bundleModeConfig.resolver.resolveRequest;
bundleModeConfig.resolver.resolveRequest = (context, moduleName, platform) =>
  platform === "web"
    ? nativeResolveRequest(context, moduleName, platform)
    : bundleModeResolveRequest(context, moduleName, platform);

module.exports = bundleModeConfig;
