/**
 * First run: getting from an empty app to your agents.
 *
 * One card that advances itself through the only three states a new user is
 * ever in, so nothing on screen asks them to know a word they haven't been
 * taught yet:
 *
 *   1. NOTHING FOUND — the single instruction, `npx use-pounce`, with a copy
 *      button. It keeps looking while you read it.
 *   2. FOUND — "Dirghas-Mac-mini is ready · Connect". Appears on its own the
 *      moment step 1 finishes on the computer; nobody has to come back and
 *      press refresh.
 *   3. WAITING — a code to match, and a sentence saying to approve it there.
 *
 * The words it avoids are the point. "Sync" meant nothing before there was
 * anything to sync; "bridge" and "token" name our plumbing, not the user's
 * intent, which is "put my Mac's agents on my phone". What replaced them is a
 * command they can run and a machine name they recognise.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  // eslint-disable-next-line @react-native/no-deprecated-api -- core Clipboard is
  // the only clipboard already inside shipped binaries (OTA-safe).
  Clipboard,
  Pressable,
  Text,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { PounceIcon } from "../ui/native/Icon";
import { IS_DESKTOP } from "../ui";
import { discoverBridges, type FoundBridge } from "../services/discovery";
import { pollPairing, requestPairing, type PairAsk } from "../services/pairRequest";
import { connectBridge, fetchPairing, saveBridgeConfig } from "../services/bridge";
import { savePairing } from "../services/runtime";

/** The whole setup, in one line the user can paste. */
const COMMAND = "npx use-pounce";

/** How long to keep asking "approved yet?" before giving up on a request the
 *  bridge would itself expire at 15 minutes. */
const WAIT_MS = 3 * 60_000;
const POLL_MS = 1_500;
/** Re-sweep while the user is reading the instruction, backing off so a phone
 *  left on this screen isn't sweeping the subnet every few seconds forever. */
const RESCAN_MS = [8_000, 15_000, 30_000, 60_000];

type Phase =
  | { kind: "looking" }
  | { kind: "found"; devices: FoundBridge[] }
  | { kind: "waiting"; bridge: FoundBridge; ask: PairAsk };

export function ConnectFlow() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "looking" });
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  // Keep looking, slower each time. Stops the moment something is found or the
  // user starts a pairing — a sweep during either would be wasted radio.
  useEffect(() => {
    alive.current = true;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scan = async (attempt: number) => {
      const devices = await discoverBridges({ signal: ac.signal });
      if (!alive.current || ac.signal.aborted) return;
      if (devices.length && phaseRef.current.kind === "looking") {
        setPhase({ kind: "found", devices });
        return;
      }
      if (phaseRef.current.kind !== "looking") return;
      timer = setTimeout(
        () => void scan(attempt + 1),
        RESCAN_MS[Math.min(attempt, RESCAN_MS.length - 1)],
      );
    };
    void scan(0);

    return () => {
      alive.current = false;
      ac.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);

  const copy = useCallback(() => {
    Clipboard.setString(COMMAND);
    setCopied(true);
    setTimeout(() => alive.current && setCopied(false), 2000);
  }, []);

  /** Ask, then wait for the human at that machine. */
  const connect = useCallback(
    async (bridge: FoundBridge) => {
      let ask: PairAsk;
      try {
        ask = await requestPairing(bridge.url);
      } catch (e) {
        Alert.alert("Couldn't ask", e instanceof Error ? e.message : String(e));
        return;
      }
      setPhase({ kind: "waiting", bridge, ask });

      const deadline = Date.now() + WAIT_MS;
      while (alive.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (!alive.current) return;
        const verdict = await pollPairing(bridge.url, ask).catch(() => ({
          state: "pending" as const,
        }));
        if (verdict.state === "approved" && verdict.token) {
          await finishPairing(bridge, verdict.token, router);
          return;
        }
        if (verdict.state === "denied" || verdict.state === "expired") {
          setPhase({ kind: "found", devices: [bridge] });
          Alert.alert(
            verdict.state === "denied" ? "Not approved" : "Nothing happened",
            verdict.state === "denied"
              ? `${bridge.hostName} turned it down.`
              : `Nobody approved it on ${bridge.hostName}.`,
          );
          return;
        }
      }
      if (alive.current) setPhase({ kind: "found", devices: [bridge] });
    },
    [router],
  );

  // Never on desktop. That app SHIPS the bridge and adopts it on launch, so
  // "run npx use-pounce on your computer" is being said TO the computer, and
  // there is no phone to pair. Its own not-connected state is a local host
  // still starting — see the callers.
  if (IS_DESKTOP) return null;

  if (phase.kind === "waiting") {
    return (
      <View style={s.card}>
        <Text style={s.title}>Approve it on {phase.bridge.hostName}</Text>
        {phase.ask.code ? (
          <>
            <Text style={s.code}>{phase.ask.code}</Text>
            <Text style={s.hint}>Check this matches, then approve.</Text>
          </>
        ) : (
          <Text style={s.hint}>Approve this phone on that computer.</Text>
        )}
        <View style={s.waitRow}>
          <ActivityIndicator size="small" color={theme.colors.accent} />
          <Text style={s.hint}>Waiting…</Text>
        </View>
      </View>
    );
  }

  if (phase.kind === "found") {
    const one = phase.devices.length === 1;
    return (
      <View style={s.card}>
        <Text style={s.title}>
          {one ? `${phase.devices[0].hostName} is ready` : "Pick a computer"}
        </Text>
        <Text style={s.hint}>
          {one ? "Connecting asks it to approve this phone." : "All on this Wi-Fi."}
        </Text>
        {phase.devices.map((b) => (
          <Pressable
            key={b.bridgeId}
            onPress={() => void connect(b)}
            accessibilityLabel={`Connect to ${b.hostName}`}
            style={({ pressed }) => [s.primary, pressed && s.pressed]}
          >
            <Text style={s.primaryLabel}>{one ? "Connect" : `Connect to ${b.hostName}`}</Text>
          </Pressable>
        ))}
      </View>
    );
  }

  return (
    <View style={s.card}>
      <Text style={s.title}>Run this on your computer</Text>
      <Pressable
        onPress={copy}
        accessibilityLabel={`Copy ${COMMAND}`}
        style={({ pressed }) => [s.command, pressed && s.pressed]}
      >
        <Text style={s.commandText}>{COMMAND}</Text>
        <PounceIcon
          name={copied ? "checkmark" : "copy-outline"}
          size={16}
          color={copied ? theme.colors.success : theme.colors.fgMuted}
        />
      </Pressable>
      <View style={s.waitRow}>
        <ActivityIndicator size="small" color={theme.colors.fgFaint} />
        <Text style={s.hint}>This phone will find it automatically.</Text>
      </View>
      {/* For a computer that isn't on this Wi-Fi — the code path still exists,
          it just stops being the headline. */}
      <Pressable
        onPress={() => router.push("/settings/devices")}
        style={({ pressed }) => pressed && s.pressed}
      >
        <Text style={s.secondary}>Not on this network?</Text>
      </Pressable>
    </View>
  );
}

/** Same landing as a scanned code: save it, capture the machine's tunnel
 *  identity so it still works off this Wi-Fi, then sync. */
async function finishPairing(
  bridge: FoundBridge,
  token: string,
  router: ReturnType<typeof useRouter>,
) {
  const cfg = { url: bridge.url, token };
  try {
    await saveBridgeConfig(cfg);
    const ok = await connectBridge(cfg);
    if (!ok) throw new Error("Approved, but that computer stopped answering.");
    const pairing = await fetchPairing(cfg);
    if (pairing?.nodeId) await savePairing(pairing);
    router.navigate("/");
  } catch (e) {
    Alert.alert("Couldn't finish", e instanceof Error ? e.message : String(e));
  }
}

const s = StyleSheet.create((theme) => ({
  card: {
    gap: 12,
    width: "100%",
    borderRadius: 24,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 20,
  },
  title: { fontSize: 18, fontWeight: "600", color: theme.colors.fg },
  hint: { fontSize: 14, lineHeight: 19, color: theme.colors.fgMuted },
  command: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderRadius: 12,
    borderCurve: "continuous",
    backgroundColor: theme.colors.bg,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  commandText: { fontFamily: "JetBrainsMono", fontSize: 15, color: theme.colors.fg },
  waitRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  primary: {
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderCurve: "continuous",
    backgroundColor: theme.colors.accent,
  },
  primaryLabel: { fontSize: 16, fontWeight: "600", color: theme.colors.onAccent },
  secondary: { fontSize: 14, color: theme.colors.accent },
  /* Big enough to read across a desk — the person approving is at the computer,
     not holding the phone. */
  code: { fontSize: 34, fontWeight: "700", letterSpacing: 6, color: theme.colors.fg },
  pressed: { opacity: 0.6 },
}));
