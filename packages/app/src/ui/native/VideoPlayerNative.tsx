import { useVideoPlayer, VideoView } from "expo-video";
import type { VideoPlayerProps } from "./VideoPlayer";

/** iOS/Android: real AVPlayer/ExoPlayer via expo-video, with native controls.
 *  Referenced only from VideoPlayer.ios/.android so desktop never resolves
 *  the native module. */
export function VideoPlayer({ uri, style }: VideoPlayerProps) {
  const player = useVideoPlayer(uri, (p) => {
    p.play();
  });
  return <VideoView player={player} style={style} contentFit="contain" nativeControls />;
}
