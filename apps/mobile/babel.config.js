module.exports = function (api) {
  // The plugin set depends on the target platform (see the web-only plugin
  // below), so cache per-platform rather than the blanket api.cache(true).
  const platform = api.caller((caller) => (caller ? caller.platform : null));
  api.cache.using(() => platform);
  const isWeb = platform === "web";

  return {
    // Uniwind needs no Babel plugin (build-time Metro transform).
    // Native disables babel-preset-expo's auto-injected worklets plugin so we
    // can pass it bundleMode options below; web keeps the preset's default.
    presets: [["babel-preset-expo", { native: { worklets: false } }]],
    plugins: [
      // react-native-boost: build-time optimization of RN core components. Must run
      // before other plugins, so keep it first in the list.
      //
      // Native-only: it rewrites <Text>/<View> to react-native/Libraries/Text/
      // TextNativeComponent and .../View/ViewNativeComponent, which on web drags
      // the real RN core in alongside react-native-web. Its InitializeCore then
      // reaches for a TurboModule and dies on "__fbBatchedBridgeConfig is not
      // set" before anything renders.
      ...(isWeb ? [] : ["react-native-boost/plugin"]),
      // react-native-unistyles: rewrites StyleSheet.create((theme) => …) sheets
      // with dependency metadata and swaps RN components for self-updating ones
      // (theme flips repaint via ShadowTree, no re-render/activity restart).
      // `root` covers the router files in app/; autoProcessPaths reaches the
      // shared @pounce/app sources, which live OUTSIDE this project root
      // (Metro transforms them under their real ../../packages/app path).
      // All platforms. This was native-only back when the web bundle was just
      // the Expo DOM components; the web bundle is now the whole app, and
      // without the plugin every themed sheet resolves to nothing — the app
      // renders as unstyled flow text. Unistyles supports web itself (`browser`
      // export condition, and the plugin rewrites react-native-web/dist/exports
      // components the same way it rewrites the RN ones).
      // desktop/src is in the list for WEB, which mounts the desktop Shell
      // (see index.web.ts) — its themed sheets need the same rewrite. Native
      // never imports desktop/src, so the extra path is inert there.
      [
        "react-native-unistyles/plugin",
        { root: "app", autoProcessPaths: ["packages/app/src", "desktop/src"] },
      ],
      // Web = the Expo DOM components (only PatchDiffDOM). @pierre/diffs → shiki
      // lazy-loads its highlighter/wasm via static import(); Metro splits those
      // into an async __common-*.js chunk that Expo's DOM HTML serializer never
      // emits, which breaks `expo export` — and therefore every OTA update.
      // Inline those imports as synchronous requires on web only; native keeps
      // its async imports (that path bundles fine and ships in the app-store build).
      ...(isWeb ? ["babel-plugin-dynamic-import-node"] : []),
      // Worklets Bundle Mode: secondary runtimes load the whole bytecode bundle
      // instead of eval'ing per-worklet code strings (also sidesteps the Hermes v1
      // 512KB-per-eval metadata regression). Must stay LAST in this list. Pairs
      // with getBundleModeMetroConfig in metro.config.js and the metro/
      // metro-runtime patches in /patches.
      // importForwarding lets worklets call remend (react-native-streamdown's
      // repair pass) by re-requiring it on the worklet runtime — without it the
      // import is closure-captured as a Remote Function and throws on first
      // stream. (Newer worklets docs call this option `workletizableModules`.)
      ...(isWeb
        ? []
        : [
            [
              "react-native-worklets/plugin",
              {
                bundleMode: true,
                strictGlobal: true,
                importForwarding: { moduleNames: ["remend"] },
              },
            ],
          ]),
    ],
  };
};
