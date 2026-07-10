module.exports = function (api) {
  api.cache(true);
  return {
    // Uniwind needs no Babel plugin (build-time Metro transform).
    // babel-preset-expo (SDK 54+) auto-injects the Reanimated 4 / worklets plugin.
    presets: ["babel-preset-expo"],
    // react-native-boost: build-time optimization of RN core components. Must run
    // before other plugins, so keep it first in the list.
    plugins: ["react-native-boost/plugin"],
  };
};
