// Metro config: out-of-tree desktop platforms (rnx-kit) + Expo.
//
// The desktop app renders the SAME sources as mobile (packages/app); platform
// divergence lives in .macos/.windows platform files inside that package, so
// this config only needs to (1) resolve the monorepo packages, (2) map
// expo-router onto the desktop shell's shim, and (3) keep dependency
// resolution pinned to desktop/node_modules — the root workspace hoists
// mobile's newer react/react-native, which must never leak into this bundle.
const { getDefaultConfig } = require("@expo/metro-config");
const { makeMetroConfig } = require("@rnx-kit/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = makeMetroConfig(getDefaultConfig(projectRoot));

// Shared sources live in ../packages — watch them for fast refresh.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(workspaceRoot, "packages")];

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
  // unistyles has no macos/windows support; the shim resolves theme functions
  // once against the AppKit-PlatformColor theme (see src/shims/unistyles.ts).
  "react-native-unistyles": path.resolve(projectRoot, "src/shims/unistyles.ts"),
  "@pounce/shared": PKG("shared/src/index.ts"),
  "@pounce/runtime": PKG("runtime/src/index.ts"),
  "@pounce/transcript": PKG("transcript/src/index.js"),
  // Pin the native markdown renderer to DESKTOP's copy.
  //
  // It is installed twice — the workspace root hoists one for apps/mobile, and
  // desktop has its own outside that workspace. Shared code under packages/app
  // imports it by bare name, and Metro resolves that by walking up from the
  // importing FILE, which lands on the root copy; the native side, autolinked
  // from desktop, registers the desktop copy. Two JS modules then register the
  // same Fabric components and RN throws "Tried to register two views with the
  // same name EnrichedMarkdownText". The component survives that but measures
  // every message to zero height, so the transcript renders as empty bubbles.
  "react-native-enriched-markdown": path.resolve(
    projectRoot,
    "node_modules/react-native-enriched-markdown/src/index.tsx",
  ),
};
const PREFIX = {
  "@pounce/app/": PKG("app/src"),
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
  if (
    bare &&
    origin.startsWith(workspaceRoot + path.sep) &&
    !origin.startsWith(projectRoot + path.sep)
  ) {
    // Clone via descriptors: a plain spread evaluates/loses getters on the
    // resolution context, which breaks Expo CLI's wrapped resolver. The
    // original originModulePath descriptor may be non-configurable, so it is
    // excluded from the copy and replaced rather than redefined.
    const descriptors = Object.getOwnPropertyDescriptors(context);
    delete descriptors.originModulePath;
    descriptors.originModulePath = {
      value: path.join(projectRoot, "index.ts"),
      configurable: true,
      enumerable: true,
      writable: true,
    };
    const anchored = Object.create(Object.getPrototypeOf(context), descriptors);
    return next(anchored, moduleName, platform);
  }
  return next(context, moduleName, platform);
};

module.exports = config;
