module.exports = function (api) {
  // The plugin set depends on the target platform (see the web-only plugin
  // below), so cache per-platform rather than the blanket api.cache(true).
  const platform = api.caller((caller) => (caller ? caller.platform : null));
  api.cache.using(() => platform);
  const isWeb = platform === "web";

  return {
    // Uniwind needs no Babel plugin (build-time Metro transform).
    // babel-preset-expo (SDK 54+) auto-injects the Reanimated 4 / worklets plugin.
    presets: ["babel-preset-expo"],
    plugins: [
      // react-native-boost: build-time optimization of RN core components. Must run
      // before other plugins, so keep it first in the list.
      "react-native-boost/plugin",
      // react-native-unistyles: rewrites StyleSheet.create((theme) => …) sheets
      // with dependency metadata and swaps RN components for self-updating ones
      // (theme flips repaint via ShadowTree, no re-render/activity restart).
      // `root` covers the router files in app/; autoProcessPaths reaches the
      // shared @pounce/app sources, which live OUTSIDE this project root
      // (Metro transforms them under their real ../../packages/app path).
      // Native-only: the web bundle is just the Expo DOM components.
      ...(isWeb
        ? []
        : [["react-native-unistyles/plugin", { root: "app", autoProcessPaths: ["packages/app/src"] }]]),
      // Web = the Expo DOM components (only PatchDiffDOM). @pierre/diffs → shiki
      // lazy-loads its highlighter/wasm via static import(); Metro splits those
      // into an async __common-*.js chunk that Expo's DOM HTML serializer never
      // emits, which breaks `expo export` — and therefore every OTA update.
      // Inline those imports as synchronous requires on web only; native keeps
      // its async imports (that path bundles fine and ships in the app-store build).
      ...(isWeb ? ["babel-plugin-dynamic-import-node"] : []),
    ],
  };
};
