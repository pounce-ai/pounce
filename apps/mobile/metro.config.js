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
  return context.resolveRequest(context, moduleName, platform);
};

// Worklets Bundle Mode (see babel.config.js): shims react-native/TurboModuleRegistry
// for secondary runtimes and pins module ids so worklet runtimes can address the
// shared bundle.
module.exports = getBundleModeMetroConfig(config);
