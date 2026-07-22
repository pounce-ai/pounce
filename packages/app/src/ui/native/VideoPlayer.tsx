import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface VideoPlayerProps {
  uri: string;
  style?: StyleProp<ViewStyle>;
}

/** Desktop/default fallback: no native player (expo-video is iOS/Android
 *  only) — show a labeled placeholder instead of crashing the bundle. */
export function VideoPlayer({ style }: VideoPlayerProps) {
  return (
    <View style={[s.fallback, style]}>
      <Text style={s.label}>Video playback isn't available on this device yet.</Text>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  fallback: { alignItems: "center", justifyContent: "center", backgroundColor: "#000" },
  label: { color: theme.colors.fgMuted, fontSize: 13, textAlign: "center", padding: 24 },
}));
