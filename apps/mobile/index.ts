/**
 * Custom entry: unistyles must be configured (StyleSheet.configure) BEFORE
 * expo-router mounts anything — per the unistyles Expo Router guide, a config
 * import in _layout.tsx is too late because routes resolve first.
 */
import "@pounce/app/ui/unistyles";
import "expo-router/entry";
