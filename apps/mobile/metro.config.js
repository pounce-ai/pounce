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

// Worklets Bundle Mode (see babel.config.js): shims react-native/TurboModuleRegistry
// for secondary runtimes and pins module ids so worklet runtimes can address the
// shared bundle.
module.exports = getBundleModeMetroConfig(config);
