/**
 * Nearby machines — asking another Mac for a look at its threads.
 *
 * The whole screen is one handshake, walked one step at a time, because the
 * awkward truth of this feature is that you cannot pick a space you have never
 * seen. So: ask to look (a short preview, approved over there), browse names
 * and dates only, tick what you want, then ask for read access to that.
 *
 * Two things stay on screen the whole way through. The VERIFICATION CODE, so
 * the person approving on the other machine can tell it is this laptop asking
 * and not someone else on the same Wi-Fi. And what step we are on, since every
 * wait here is a wait on a human, not on a network.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ColorValue,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  grantDevice,
  catalogSpaces,
  catalogThreads,
  listAccess,
  peerState,
  pollAsk,
  revokeGrant,
  setDiscoverable,
  timeLeft,
  requestPreview,
  requestRead,
  type AskResult,
  type CatalogSpace,
  type CatalogThread,
  type DiscoveryState,
  type Grant,
  type PendingAsk,
  type Peer,
  type Scope,
} from "@pounce/app/services/peers";
import {
  addDeviceConfig,
  listDeviceConfigs,
  removeDeviceConfig,
  syncLiveDataStreaming,
  type DeviceConfig,
} from "@pounce/app/services/bridge";
import { COLOR } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";

type Step =
  | { name: "browse-peers" }
  | { name: "awaiting-preview"; peer: Peer; ask: PendingAsk }
  | { name: "catalog"; peer: Peer; token: string; grantId: string }
  | { name: "awaiting-read"; peer: Peer; ask: PendingAsk; scope: Scope }
  | { name: "connected"; peer: Peer; summary: string }
  | { name: "refused"; peer: Peer; why: string };

/** Both waits are on a person noticing a dialog, so poll gently and give up
 *  well after anyone reasonable would have clicked. */
const POLL_MS = 2_000;
const GIVE_UP_MS = 5 * 60_000;

export default function PeersScreen() {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);
  // The two standing lists: access this Mac has GIVEN, and access it HOLDS.
  // Neither was reachable before — the grants you'd handed out were only
  // visible while somebody happened to be asking.
  const [given, setGiven] = useState<Grant[]>([]);
  const [held, setHeld] = useState<DeviceConfig[]>([]);
  const [step, setStep] = useState<Step>({ name: "browse-peers" });
  const [busy, setBusy] = useState(false);

  // Discovery is a live picture: a machine that wakes up should appear without
  // the user reopening the window.
  useEffect(() => {
    if (step.name !== "browse-peers") return;
    let live = true;
    const tick = () => {
      void peerState().then((r) => {
        if (!live) return;
        setPeers(r.peers);
        setDiscovery(r.discovery);
      });
      void listAccess().then((a) => live && setGiven(a.grants));
      void listDeviceConfigs().then(
        (d) =>
          live &&
          // An expired grant is about to be swept by the next sync — don't list
          // it as access you hold in the meantime.
          setHeld(
            d.filter(
              (c) => c.grant && (!c.grant.expiresAt || Date.parse(c.grant.expiresAt) > Date.now()),
            ),
          ),
      );
    };
    tick();
    const t = setInterval(tick, 3_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [step.name]);

  const ask = useCallback(async (peer: Peer) => {
    setBusy(true);
    try {
      setStep({ name: "awaiting-preview", peer, ask: await requestPreview(peer) });
    } catch (e) {
      setStep({ name: "refused", peer, why: String((e as Error)?.message || e) });
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Nearby machines</Text>
        {step.name !== "browse-peers" ? (
          <Pressable onPress={() => setStep({ name: "browse-peers" })} hitSlop={8}>
            <Text style={s.link}>Start over</Text>
          </Pressable>
        ) : null}
      </View>

      {step.name === "browse-peers" ? (
        <PeerList
          peers={peers}
          discovery={discovery}
          given={given}
          held={held}
          busy={busy}
          onAsk={ask}
          onRevoke={async (id) => {
            await revokeGrant(id);
            setGiven((await listAccess()).grants);
          }}
          onForget={async (id) => {
            await removeDeviceConfig(id);
            setHeld((await listDeviceConfigs()).filter((c) => c.grant));
            void syncLiveDataStreaming();
          }}
          onToggle={async () => {
            if (!discovery) return;
            setDiscovery(await setDiscoverable(!discovery.on));
          }}
        />
      ) : step.name === "awaiting-preview" ? (
        <Waiting
          peer={step.peer}
          ask={step.ask}
          what="a look at what's there"
          onResolved={(r) =>
            r.state === "approved" && r.token
              ? setStep({
                  name: "catalog",
                  peer: step.peer,
                  token: r.token,
                  grantId: r.grantId ?? "",
                })
              : setStep({ name: "refused", peer: step.peer, why: refusal(r.state) })
          }
        />
      ) : step.name === "catalog" ? (
        <Catalog
          peer={step.peer}
          token={step.token}
          onRequest={async (scope) => {
            setBusy(true);
            try {
              const a = await requestRead(step.peer.url, scope, { previewGrant: step.grantId });
              setStep({ name: "awaiting-read", peer: step.peer, ask: a, scope });
            } catch (e) {
              setStep({
                name: "refused",
                peer: step.peer,
                why: String((e as Error)?.message || e),
              });
            } finally {
              setBusy(false);
            }
          }}
          busy={busy}
        />
      ) : step.name === "awaiting-read" ? (
        <Waiting
          peer={step.peer}
          ask={step.ask}
          what="read access"
          onResolved={async (r) => {
            if (r.state !== "approved" || !r.token) {
              setStep({ name: "refused", peer: step.peer, why: refusal(r.state) });
              return;
            }
            // The token arrives EXACTLY ONCE — the peer drops it after this
            // poll. So a failure here is not retryable by waiting, and leaving
            // the spinner up would strand the user on a grant that has already
            // been spent. Say what went wrong and send them round again.
            try {
              const { url, token, extras } = grantDevice(r, step.peer.url);
              const dev = await addDeviceConfig(url, token, extras);
              // Pull immediately rather than waiting for the next heartbeat —
              // the point of the last two minutes was to see these threads.
              void syncLiveDataStreaming();
              setStep({ name: "connected", peer: step.peer, summary: dev.grant?.summary ?? "" });
            } catch (e) {
              setStep({
                name: "refused",
                peer: step.peer,
                why: `They approved it, but saving the access failed: ${String(
                  (e as Error)?.message || e,
                )}. Ask again.`,
              });
            }
          }}
        />
      ) : step.name === "connected" ? (
        <Centered
          icon="checkmark-circle-outline"
          tint={T.success}
          title={`Connected to ${step.peer.hostName}`}
          body={`You can read ${step.summary}. Its threads are syncing into your sidebar now.`}
        />
      ) : (
        <Centered
          icon="close-circle-outline"
          tint={T.fgFaint}
          title={`${step.peer.hostName} didn't grant access`}
          body={step.why}
        />
      )}
    </View>
  );
}

function refusal(state: AskResult["state"]): string {
  if (state === "denied") return "The request was declined on that machine.";
  if (state === "expired") return "Nobody answered, so the request timed out.";
  if (state === "revoked") return "The access was withdrawn before it could be used.";
  return "The request didn't complete.";
}

// --- step 0: who is out there ------------------------------------------------

/** The two standing lists, shown under Nearby whether or not anyone is nearby.
 *  Reachable at all times — revoking access you gave should never depend on
 *  somebody happening to be asking for more. */
function Standing({
  given,
  held,
  busy,
  onRevoke,
  onForget,
}: {
  given: Grant[];
  held: DeviceConfig[];
  busy: boolean;
  onRevoke: (id: string) => void;
  onForget: (id: string) => void;
}) {
  if (!given.length && !held.length) return null;
  return (
    <>
      {held.length ? (
        <>
          <Text style={[s.sectionTitle, s.sectionGap]}>Access you hold</Text>
          {held.map((d) => (
            <View key={d.id} style={s.peerRow}>
              <Ionicons name="link-outline" size={18} color={COLOR.fgMuted} />
              <View style={s.grow}>
                <Text style={s.peerName}>{d.grant?.issuedBy || d.name}</Text>
                <Text style={s.peerMeta}>
                  {d.grant?.summary} · {timeLeft(d.grant?.expiresAt)}
                </Text>
              </View>
              <Pressable
                disabled={busy}
                onPress={() => onForget(d.id)}
                style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]}
              >
                <Text style={s.ghostLabel}>Forget</Text>
              </Pressable>
            </View>
          ))}
        </>
      ) : null}
      {given.length ? (
        <>
          <Text style={[s.sectionTitle, s.sectionGap]}>Machines with access to this one</Text>
          {given.map((g) => (
            <View key={g.id} style={s.peerRow}>
              <Ionicons name="laptop-outline" size={18} color={COLOR.fgMuted} />
              <View style={s.grow}>
                <Text style={s.peerName}>{g.requester.hostName}</Text>
                <Text style={s.peerMeta}>
                  {g.summary} · {timeLeft(g.expiresAt)}
                  {g.lastUsedAt ? "" : " · not used yet"}
                </Text>
              </View>
              <Pressable
                disabled={busy}
                onPress={() => onRevoke(g.id)}
                style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]}
              >
                <Text style={s.ghostLabel}>Revoke</Text>
              </Pressable>
            </View>
          ))}
        </>
      ) : null}
    </>
  );
}

function PeerList({
  peers,
  discovery,
  given,
  held,
  busy,
  onAsk,
  onToggle,
  onRevoke,
  onForget,
}: {
  peers: Peer[] | null;
  discovery: DiscoveryState | null;
  given: Grant[];
  held: DeviceConfig[];
  busy: boolean;
  onAsk: (p: Peer) => void;
  onToggle: () => void;
  onRevoke: (grantId: string) => void;
  onForget: (deviceId: string) => void;
}) {
  if (peers === null) {
    return <Centered spinner title="Looking for machines on this network…" />;
  }
  // Being findable is opt-in, so the switch leads. Plain words on purpose:
  // "visible" and "hidden" are things people already understand, where
  // "announcing" and "broadcasting" sound like something is leaking.
  const toggle = discovery ? (
    <View style={s.peerRow}>
      <Ionicons
        name={discovery.on ? "eye-outline" : "eye-off-outline"}
        size={20}
        color={COLOR.fgMuted}
      />
      <View style={s.grow}>
        <Text style={s.peerName}>
          {discovery.on ? "Other computers here can see this Mac" : "This Mac is hidden"}
        </Text>
        <Text style={s.peerMeta}>
          {discovery.on
            ? "They see its name, and can ask to read the projects you choose."
            : "Turn this on to let another computer on your network find it."}
        </Text>
      </View>
      {!discovery.eligible ? (
        <Text style={s.peerMeta}>not available here</Text>
      ) : discovery.locked ? (
        <Text style={s.peerMeta}>set on this machine</Text>
      ) : (
        <Pressable
          disabled={busy}
          onPress={onToggle}
          style={({ pressed }) => [discovery.on ? s.ghostBtn : s.primaryBtn, pressed && s.pressed]}
        >
          <Text style={discovery.on ? s.ghostLabel : s.primaryLabel}>
            {discovery.on ? "Hide" : "Make visible"}
          </Text>
        </Pressable>
      )}
    </View>
  ) : null;

  if (!peers.length) {
    return (
      <ScrollView contentContainerStyle={s.list}>
        {toggle}
        <Text style={s.sectionHint}>
          {discovery && !discovery.on
            ? "You can still connect to a computer you already know, and it can still ask you. This only decides whether you show up in its list on your own."
            : "Nothing here yet. The other computer needs Pounce running and set to visible too, on the same Wi-Fi."}
        </Text>
        <Standing given={given} held={held} busy={busy} onRevoke={onRevoke} onForget={onForget} />
      </ScrollView>
    );
  }
  return (
    <ScrollView contentContainerStyle={s.list}>
      {toggle}
      {peers.map((p) => (
        <View key={p.bridgeId} style={s.peerRow}>
          <Ionicons
            name={p.platform === "darwin" ? "laptop-outline" : "desktop-outline"}
            size={20}
            color={COLOR.fgMuted}
          />
          <View style={s.grow}>
            <Text style={s.peerName}>{p.hostName}</Text>
            <Text style={s.peerMeta}>{p.address}</Text>
          </View>
          <Pressable
            disabled={busy}
            onPress={() => onAsk(p)}
            style={({ pressed }) => [s.primaryBtn, pressed && s.pressed]}
          >
            <Text style={s.primaryLabel}>Ask for access</Text>
          </Pressable>
        </View>
      ))}
      <Standing given={given} held={held} busy={busy} onRevoke={onRevoke} onForget={onForget} />
    </ScrollView>
  );
}

// --- steps 1 and 3: waiting on a person --------------------------------------

function Waiting({
  peer,
  ask,
  what,
  onResolved,
}: {
  peer: Peer;
  ask: PendingAsk;
  what: string;
  onResolved: (r: AskResult) => void;
}) {
  // The callback identity changes on every parent render; holding it in a ref
  // keeps the poll from being torn down and restarted underneath itself.
  const cb = useRef(onResolved);
  cb.current = onResolved;

  useEffect(() => {
    let live = true;
    const startedAt = Date.now();
    const t = setInterval(async () => {
      if (!live) return;
      if (Date.now() - startedAt > GIVE_UP_MS) {
        clearInterval(t);
        cb.current({ state: "expired" });
        return;
      }
      try {
        const r = await pollAsk(ask);
        if (!live || r.state === "pending") return;
        clearInterval(t);
        cb.current(r);
      } catch {
        // The peer went quiet mid-wait. Keep polling: it is far more likely to
        // be a laptop lid than a real answer, and the timeout above is the
        // backstop that ends this either way.
      }
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [ask]);

  return (
    <View style={s.center}>
      <ActivityIndicator color={COLOR.accent} />
      <Text style={s.waitTitle}>Waiting for {peer.hostName}</Text>
      <Text style={s.waitBody}>Asking for {what}. Approve it on that machine.</Text>
      <View style={s.codeCard}>
        <Text style={s.codeLabel}>Check this code matches</Text>
        <Text selectable style={s.code}>
          {ask.code.slice(0, 3)}-{ask.code.slice(3)}
        </Text>
      </View>
    </View>
  );
}

// --- step 2: the catalog -------------------------------------------------------

function Catalog({
  peer,
  token,
  busy,
  onRequest,
}: {
  peer: Peer;
  token: string;
  busy: boolean;
  onRequest: (scope: Scope) => void;
}) {
  const [spaces, setSpaces] = useState<CatalogSpace[] | null>(null);
  const [pickedSpaces, setPickedSpaces] = useState<Set<string>>(new Set());
  const [pickedThreads, setPickedThreads] = useState<Map<string, CatalogThread>>(new Map());
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CatalogThread[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    catalogSpaces(peer.url, token)
      .then(setSpaces)
      .catch(() => setFailed(true));
  }, [peer.url, token]);

  // Debounced: the peer's bridge searches its whole history per keystroke
  // otherwise, and the preview grant is short enough without wasting it.
  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      void catalogThreads(peer.url, token, q)
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, peer.url, token]);

  const toggleSpace = (key: string) =>
    setPickedSpaces((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const toggleThread = (t: CatalogThread) =>
    setPickedThreads((prev) => {
      const next = new Map(prev);
      if (!next.delete(t.id)) next.set(t.id, t);
      return next;
    });

  const count = pickedSpaces.size + pickedThreads.size;

  if (failed) {
    return (
      <Centered
        icon="alert-circle-outline"
        tint={T.fgFaint}
        title="Couldn't read the catalog"
        body="The preview may have already run out — they're deliberately short. Start over to ask again."
      />
    );
  }
  if (!spaces) return <Centered spinner title={`Reading ${peer.hostName}'s catalog…`} />;

  return (
    <View style={s.grow}>
      <Text style={s.sectionHint}>
        {peer.hostName} is showing names and dates only. Pick what you want to read.
      </Text>
      <ScrollView contentContainerStyle={s.list}>
        <Text style={s.sectionTitle}>Spaces</Text>
        {spaces.map((sp) => (
          <Pressable
            key={sp.repoKey}
            onPress={() => toggleSpace(sp.repoKey)}
            style={({ pressed }) => [s.pickRow, pressed && s.pressed]}
          >
            <Check on={pickedSpaces.has(sp.repoKey)} />
            <View style={s.grow}>
              <Text style={s.pickName}>{sp.repoKey}</Text>
              <Text style={s.pickMeta}>
                {sp.threadCount} thread{sp.threadCount === 1 ? "" : "s"} ·{" "}
                {span(sp.firstActivityAt, sp.lastActivityAt)}
              </Text>
            </View>
          </Pressable>
        ))}

        <Text style={[s.sectionTitle, s.sectionGap]}>Or find single threads</Text>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search thread names…"
          placeholderTextColor={COLOR.fgFaint}
          style={s.search}
        />
        {q.trim() && !hits.length ? <Text style={s.pickMeta}>No thread names match.</Text> : null}
        {hits.map((t) => (
          <Pressable
            key={`${t.agent}:${t.id}`}
            onPress={() => toggleThread(t)}
            style={({ pressed }) => [s.pickRow, pressed && s.pressed]}
          >
            <Check on={pickedThreads.has(t.id)} />
            <View style={s.grow}>
              <Text style={s.pickName} numberOfLines={1}>
                {t.name || "Untitled thread"}
              </Text>
              <Text style={s.pickMeta}>
                {t.repoKey} · {span(t.createdAt, t.lastActivityAt)}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>

      <View style={s.footer}>
        <Text style={s.pickMeta}>{count ? `${count} selected` : "Nothing selected yet"}</Text>
        <Pressable
          disabled={busy || !count}
          onPress={() =>
            onRequest({
              kind: "scoped",
              repoKeys: [...pickedSpaces],
              threads: [...pickedThreads.values()].map((t) => ({ agent: t.agent, id: t.id })),
            })
          }
          style={({ pressed }) => [
            s.primaryBtn,
            (!count || busy) && s.disabled,
            pressed && s.pressed,
          ]}
        >
          <Text style={s.primaryLabel}>Request read access</Text>
        </Pressable>
      </View>
    </View>
  );
}

// --- bits ----------------------------------------------------------------------

function Check({ on }: { on: boolean }) {
  return (
    <View style={[s.check, on && s.checkOn]}>
      {on ? <Ionicons name="checkmark" size={13} color={T.bg} /> : null}
    </View>
  );
}

function Centered({
  icon,
  tint,
  title,
  body,
  spinner,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  // ColorValue, not string: the theme's tokens are PlatformColors on macOS.
  tint?: ColorValue;
  title: string;
  body?: string;
  spinner?: boolean;
}) {
  return (
    <View style={s.center}>
      {spinner ? <ActivityIndicator color={COLOR.accent} /> : null}
      {icon ? <Ionicons name={icon} size={40} color={tint ?? COLOR.fgFaint} /> : null}
      <Text style={s.waitTitle}>{title}</Text>
      {body ? <Text style={s.waitBody}>{body}</Text> : null}
    </View>
  );
}

/** "Jun 30 → today" — the dates are the whole reason a name is choosable, so
 *  they get rendered as a span rather than a raw timestamp. */
function span(from: string | null, to: string | null): string {
  const day = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const a = day(from);
  const b = day(to);
  return a === b ? a : `${a} → ${b}`;
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  grow: { flex: 1 },
  header: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 16,
  },
  headerTitle: { fontSize: 15, fontWeight: "600", color: T.fg },
  link: { fontSize: 13, color: COLOR.accent },

  list: { padding: 16, gap: 8 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
  },

  peerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 12,
    backgroundColor: T.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  peerName: { fontSize: 14, fontWeight: "500", color: T.fg },
  peerMeta: { fontFamily: "JetBrainsMono", fontSize: 11, color: T.fgFaint },

  waitTitle: { textAlign: "center", fontSize: 15, fontWeight: "600", color: T.fg },
  waitBody: { textAlign: "center", fontSize: 13, lineHeight: 19, color: T.fgMuted },

  codeCard: {
    marginTop: 8,
    alignItems: "center",
    gap: 2,
    borderRadius: 12,
    backgroundColor: T.surface,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  codeLabel: { fontSize: 11, color: T.fgFaint },
  code: { fontFamily: "JetBrainsMono", fontSize: 24, letterSpacing: 2, color: T.fg },

  sectionHint: { paddingHorizontal: 16, paddingTop: 12, fontSize: 12, color: T.fgMuted },
  sectionTitle: { fontSize: 11, fontWeight: "600", textTransform: "uppercase", color: T.fgFaint },
  sectionGap: { marginTop: 16 },
  search: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    color: T.fg,
  },

  pickRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 10,
    backgroundColor: T.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pickName: { fontSize: 13, color: T.fg },
  pickMeta: { fontSize: 11, color: T.fgFaint },
  check: {
    height: 18,
    width: 18,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 5,
    borderWidth: 1,
    borderColor: T.border,
  },
  checkOn: { backgroundColor: COLOR.accent, borderColor: COLOR.accent },

  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryBtn: {
    borderRadius: 10,
    backgroundColor: COLOR.accent,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  primaryLabel: { fontSize: 13, fontWeight: "600", color: T.bg },
  // Used by the announcing switch when it is already on, where the action is
  // "stop" and should not read as the thing to do.
  ghostBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  ghostLabel: { fontSize: 13, color: T.fgMuted },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
