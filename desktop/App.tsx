import "./global.css";
import { useEffect } from "react";
import { AppState } from "react-native";
import { StatusBar } from "expo-status-bar";
import { Providers } from "@litter/app/components/Providers";
import { Shell } from "./src/shell/Shell";
import { bootstrap } from "@litter/app/services/runtime";
import { ensureLocalBridge } from "./src/services/localBridge";
import { heartbeat } from "./src/services/heartbeat";
import { UpdateConsent } from "./src/components/UpdateConsent";

export default function App() {
  useEffect(() => {
    // Adopt the machine-local bridge (zero-config pairing) before the shared
    // bootstrap connects whatever devices are configured.
    void ensureLocalBridge().finally(() => void bootstrap());
    // Aggressive early re-syncs while the embedded bridge + daemon warm up
    // (fresh=1 bypasses the bridge's cache), then a steady refresh cadence.
    const warm = [3_000, 7_000, 12_000, 20_000, 30_000].map((ms) =>
      setTimeout(() => void heartbeat(true).catch(() => {}), ms),
    );
    const steady = setInterval(() => void heartbeat(false).catch(() => {}), 10_000);
    // Timers can stall while the app is inactive — always sync immediately on
    // (re)activation so the window is fresh the moment the user looks at it.
    const activation = AppState.addEventListener("change", (state) => {
      if (state === "active") void heartbeat(true).catch(() => {});
    });
    return () => {
      warm.forEach(clearTimeout);
      clearInterval(steady);
      activation.remove();
    };
  }, []);

  return (
    <Providers>
      <StatusBar style="light" />
      <Shell />
      <UpdateConsent />
    </Providers>
  );
}
