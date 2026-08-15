/**
 * Nothing to register on web.
 *
 * Both babel rewrites that make the native registration necessary are off here
 * (react-native-boost and the unistyles plugin — see babel.config.js), so
 * react-native-web's own components are what render. Importing the native
 * counterpart's deep react-native paths would pull the real react-native in
 * beside react-native-web, and its InitializeCore reaches for a TurboModule and
 * dies on "__fbBatchedBridgeConfig is not set" before the first render.
 */
export {};
