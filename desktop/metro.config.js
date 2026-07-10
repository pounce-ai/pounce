// Metro config: out-of-tree desktop platforms (rnx-kit) + Expo + Uniwind.
//
// The desktop app renders the SAME sources as mobile (packages/app); platform
// divergence lives in .macos/.windows platform files inside that package, so
// this config only needs to (1) resolve the monorepo packages, (2) map
// expo-router onto the desktop shell's shim, and (3) keep dependency
// resolution pinned to desktop/node_modules — the root workspace hoists
// mobile's newer react/react-native, which must never leak into this bundle.
const { getDefaultConfig } = require("@expo/metro-config");
const { makeMetroConfig } = require("@rnx-kit/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = makeMetroConfig(getDefaultConfig(projectRoot));

// Shared sources live in ../packages — watch them for fast refresh.
config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.resolve(workspaceRoot, "packages"),
];

// @expo/metro-config pins resolver.platforms to ios/android; the desktop
// platforms must be listed or the bundler rejects ?platform=macos requests.
config.resolver.platforms = [
  ...new Set([...(config.resolver.platforms ?? []), "macos", "windows"]),
];

// Package-exports condition mapping only covers ios/android/web by default, so
// packages with a "react-native" condition would resolve to their web builds
// on the desktop platforms.
config.resolver.unstable_conditionsByPlatform = {
  ...config.resolver.unstable_conditionsByPlatform,
  macos: ["react-native"],
  windows: ["react-native"],
};

config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

/** Monorepo packages, resolved from source. The desktop app sits outside the
 *  bun workspace (different RN/react pins), so these can't come from a normal
 *  install. Exact-name entries map to a file; prefix entries to a directory. */
const PKG = (...p) => path.resolve(workspaceRoot, "packages", ...p);
const EXACT = {
  "expo-router": path.resolve(projectRoot, "src/shims/router.tsx"),
  "@litter/shared": PKG("shared/src/index.ts"),
  "@litter/runtime": PKG("runtime/src/index.ts"),
  "@litter/transcript": PKG("transcript/src/index.js"),
  "@litter/nitro": PKG("nitro/src/index.ts"),
};
const PREFIX = {
  "@litter/app/": PKG("app/src"),
};

const prevResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const exact = EXACT[moduleName];
  if (exact) return { type: "sourceFile", filePath: exact };
  const next = prevResolveRequest ?? context.resolveRequest;
  for (const [prefix, dir] of Object.entries(PREFIX)) {
    if (moduleName.startsWith(prefix)) {
      // Delegate as an absolute path so extension/platform resolution
      // (.macos.tsx etc.) still applies.
      return next(context, path.join(dir, moduleName.slice(prefix.length)), platform);
    }
  }
  // Bare imports made FROM the shared ../packages sources must resolve against
  // THIS app's node_modules (RN 0.81 line) — hierarchical lookup from their
  // real location would land in the workspace root's node_modules, which
  // hoists mobile's RN 0.86 / react 19.2. Re-anchor the origin inside the
  // desktop project so the normal resolver (including rnx-kit's out-of-tree
  // platform mapping) does the rest.
  const bare = !moduleName.startsWith(".") && !path.isAbsolute(moduleName);
  const origin = context.originModulePath ?? "";
  if (bare && origin.startsWith(workspaceRoot + path.sep) && !origin.startsWith(projectRoot + path.sep)) {
    // Clone via descriptors: a plain spread evaluates/loses getters on the
    // resolution context, which breaks Expo CLI's wrapped resolver.
    const anchored = Object.create(
      Object.getPrototypeOf(context),
      Object.getOwnPropertyDescriptors(context),
    );
    Object.defineProperty(anchored, "originModulePath", {
      value: path.join(projectRoot, "index.ts"),
      configurable: true,
      enumerable: true,
      writable: true,
    });
    return next(anchored, moduleName, platform);
  }
  return next(context, moduleName, platform);
};

// withUniwindConfig must be the OUTERMOST metro wrapper.
module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
});
