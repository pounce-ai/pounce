import { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { AgentLogo, COLOR } from "@/ui";

function Dot({ delay }: { delay: number }) {
  const o = useSharedValue(0.3);
  useEffect(() => {
    o.value = withDelay(
      delay,
      withRepeat(withSequence(withTiming(1, { duration: 380 }), withTiming(0.3, { duration: 380 })), -1),
    );
  }, [o, delay]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[style, { width: 5, height: 5, borderRadius: 3, backgroundColor: COLOR.fgMuted }]} />;
}

/**
 * A quiet "the agent is working" row for the tail of the timeline during a turn —
 * the immediate feedback that a message was received and is being handled. The
 * label reflects the phase (thinking vs. responding).
 */
export function WorkingIndicator({ agent, label = "Working…" }: { agent?: string; label?: string }) {
  return (
    <View className="flex-row items-center gap-2 py-1.5">
      {agent ? <AgentLogo agent={agent} size={14} /> : null}
      <Text className="text-[12px] text-fg-muted">{label}</Text>
      <View className="flex-row items-center gap-1">
        <Dot delay={0} />
        <Dot delay={140} />
        <Dot delay={280} />
      </View>
    </View>
  );
}
