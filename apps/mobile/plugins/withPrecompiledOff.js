// Persist EXPO_USE_PRECOMPILED_MODULES=false across prebuilds (ios/ is
// generated+gitignored). Expo's prebuilt ExpoVideo links a core symbol the
// published precompiled ExpoModulesCore lacks — building from source is the
// only working combination until upstream ships a matched pair.
const { withPodfileProperties } = require("expo/config-plugins");
module.exports = (config) =>
  withPodfileProperties(config, (c) => {
    c.modResults.EXPO_USE_PRECOMPILED_MODULES = "false";
    return c;
  });
