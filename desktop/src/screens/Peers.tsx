/**
 * Connect — asking another Mac for a look at its threads.
 *
 * Named for what you came here to do. It was "Nearby machines", which described
 * the list rather than the errand and left the two standing sections (access you
 * hold, access you gave) filed under a heading they have nothing to do with.
 *
 * This machine leads — one switch, one line — and the machines you can reach
 * follow. Crucially the second list does NOT depend on the first switch: they
 * are separate settings, and conflating them used to greet a person who just
 * wanted to reach their other laptop with an empty page and a toggle.
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
  type DeviceGrant,
} from "@pounce/app/services/bridge";
import { Toggle } from "@pounce/app/components/Toggle";
import { COLOR } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";

type Step =
  | { name: "browse-peers" }
  | { name: "awaiting-preview"; peer: Peer; ask: PendingAsk }
  // `grantId` is the PREVIEW that got us here, and is empty when we arrived
  // holding a read grant instead — it only exists so approving the read can
  // retire the preview. `have` is the scope already held, pre-ticked so asking
  // for more is additive: approval replaces the old grant outright, so a
  // request that forgot what you already had would quietly take it away.
  | { name: "catalog"; peer: Peer; token: string; grantId: string; have: Scope | null }
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
  // Every configured device, not just the granted ones — a machine on the
  // network might already be paired outright (QR), and asking it for access
  // again is nonsense we were happily offering.
  const [devices, setDevices] = useState<DeviceConfig[]>([]);
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
      void listDeviceConfigs().then((d) => {
        if (!live) return;
        setDevices(d);
        // An expired grant is about to be swept by the next sync — don't list
        // it as access you hold in the meantime.
        setHeld(
          d.filter(
            (c) => c.grant && (!c.grant.expiresAt || Date.parse(c.grant.expiresAt) > Date.now()),
          ),
        );
      });
    };
    tick();
    const t = setInterval(tick, 3_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [step.name]);

  /**
   * Start the ask.
   *
   * A machine we already hold a grant from skips the preview entirely and goes
   * straight to its catalog, using the token it already gave us. Raising a
   * fresh connection request there was the wrong shape: you are not asking to
   * be let in, you are already in and want another space — so the thing to put
   * on screen is the space list, not a second "may I?" waiting on a human.
   */
  const ask = useCallback(async (peer: Peer, dev?: DeviceConfig) => {
    const grant = liveGrant(dev);
    setBusy(true);
    try {
      if (dev && grant) {
        // PROBE, don't assume. Whether a read grant may browse the catalog is
        // enforced by the PEER, so the shortcut only exists if that machine is
        // running a bridge new enough to allow it (older ones kept the catalog
        // preview-only). A peer that says no is not an error to show the user —
        // it just means this pair still has to do the long handshake, so fall
        // through to it silently.
        try {
          await catalogSpaces(peer.url, dev.token);
          setStep({
            name: "catalog",
            peer,
            token: dev.token,
            grantId: "",
            have: (grant.scope as Scope | null) ?? null,
          });
          return;
        } catch {
          // older peer — the preview handshake below still works everywhere
        }
      }
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
        <Text style={s.headerTitle}>Connect</Text>
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
          devices={devices}
          busy={busy}
          onAsk={ask}
          onRevoke={async (id) => {
            await revokeGrant(id);
            setGiven((await listAccess()).grants);
          }}
          onForget={async (id) => {
            await removeDeviceConfig(id);
            const next = await listDeviceConfigs();
            setDevices(next);
            setHeld(next.filter((c) => c.grant));
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
                  have: null,
                })
              : setStep({ name: "refused", peer: step.peer, why: refusal(r.state) })
          }
        />
      ) : step.name === "catalog" ? (
        <Catalog
          peer={step.peer}
          token={step.token}
          have={step.have}
          onRequest={async (scope) => {
            setBusy(true);
            try {
              // No preview grant when we came in already connected — it is only
              // there to exempt the second half of a handshake from the rate
              // limit and to be retired on approval, and there was no first
              // half here.
              const a = await requestRead(step.peer.url, scope, {
                previewGrant: step.grantId || undefined,
              });
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

/** The two standing lists, shown whether or not anyone is on the network.
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
        // "Not on this network" and not simply "Access you hold": what is on
        // the network is shown on its own row above, so this section is now
        // specifically the machines you hold access to that aren't here.
        <Section title="Access you hold · not on this network">
          {held.map((d, i) => (
            <View key={d.id} style={[s.row, i > 0 && s.rowDivided]}>
              <View style={s.badgeQuiet}>
                <Ionicons name="link" size={16} color={COLOR.fgMuted} />
              </View>
              <View style={s.grow}>
                <Text style={s.rowName}>{d.grant?.issuedBy || d.name}</Text>
                <Text style={s.rowMeta}>
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
        </Section>
      ) : null}
      {given.length ? (
        <Section title="Machines with access to this one">
          {given.map((g, i) => (
            <View key={g.id} style={[s.row, i > 0 && s.rowDivided]}>
              <View style={s.badgeQuiet}>
                <Ionicons name="laptop-outline" size={16} color={COLOR.fgMuted} />
              </View>
              <View style={s.grow}>
                <Text style={s.rowName}>{g.requester.hostName}</Text>
                <Text style={s.rowMeta}>
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
        </Section>
      ) : null}
    </>
  );
}

/** A titled group of rows in one bordered card — the shape every section on this
 *  screen takes, so they read as a settings page rather than as a pile of
 *  floating tiles. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.card}>{children}</View>
    </View>
  );
}

/** A grant with time left on it, or null. Expiry is checked here rather than
 *  trusted from the list, so a row can't offer "you can read this" a minute
 *  after it stopped being true. */
function liveGrant(dev: DeviceConfig | undefined): DeviceGrant | null {
  const g = dev?.grant;
  if (!g) return null;
  return !g.expiresAt || Date.parse(g.expiresAt) > Date.now() ? g : null;
}

function PeerList({
  peers,
  discovery,
  given,
  held,
  devices,
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
  devices: DeviceConfig[];
  busy: boolean;
  /** The configured device is passed along so the ask can skip the preview for
   *  a machine we already hold access to. */
  onAsk: (p: Peer, dev?: DeviceConfig) => void;
  onToggle: () => void;
  onRevoke: (grantId: string) => void;
  onForget: (deviceId: string) => void;
}) {
  if (peers === null) {
    return <Centered spinner title="Looking for machines on this network…" />;
  }
  // `bridgeId` is the machine's stable identity and the same value the beacon
  // carries, which is exactly why discovery broadcasts it — a machine you have
  // already got, discovered again, is the SAME row, not a new stranger.
  const byBridgeId = new Map(devices.filter((d) => d.bridgeId).map((d) => [d.bridgeId!, d]));
  // Access you hold from a machine that is right here belongs on that machine's
  // row, not in a second list underneath repeating it.
  const heldElsewhere = held.filter((d) => !peers.some((p) => p.bridgeId === d.bridgeId));
  return (
    <ScrollView contentContainerStyle={s.list}>
      {/* This machine first: whether you are findable is the fact that colours
          how you read everything under it, and it is the one row here that is
          about you rather than about somebody else. */}
      <View style={s.sectionFirst}>
        <Text style={s.sectionTitle}>This machine</Text>
        <Discoverable discovery={discovery} busy={busy} onToggle={onToggle} />
      </View>

      <Section title="Machines on this network">
        {peers.length ? (
          peers.map((p, i) => {
            const dev = byBridgeId.get(p.bridgeId);
            const grant = liveGrant(dev);
            // Three different machines, as far as this row is concerned: one
            // you are already paired with outright, one that has granted you a
            // scoped read, and one you have never met. Offering "Ask for
            // access" to all three was the bug — for the first two you already
            // have access, and the only thing left to want is MORE of it.
            return (
              <View key={p.bridgeId} style={[s.row, i > 0 && s.rowDivided]}>
                <View style={grant || dev ? s.badgeOn : s.badge}>
                  <Ionicons
                    name={p.platform === "darwin" ? "laptop-outline" : "desktop-outline"}
                    size={17}
                    color={grant || dev ? T.success : COLOR.accent}
                  />
                </View>
                <View style={s.grow}>
                  <Text style={s.rowName}>{p.hostName}</Text>
                  <Text style={s.rowMeta} numberOfLines={1}>
                    {grant
                      ? `Connected · ${grant.summary} · ${timeLeft(grant.expiresAt)}`
                      : dev
                        ? "Connected"
                        : p.address}
                  </Text>
                </View>
                {/* Forget lives on the row for a granted machine that is here,
                    because this row is now the only place it appears. */}
                {grant && dev ? (
                  <Pressable
                    disabled={busy}
                    onPress={() => onForget(dev.id)}
                    style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]}
                  >
                    <Text style={s.ghostLabel}>Forget</Text>
                  </Pressable>
                ) : null}
                {/* Nothing left to ask for: a machine paired outright, or one
                    whose grant is already the whole machine. */}
                {(dev && !grant) || (grant?.scope as Scope | null)?.kind === "full" ? null : (
                  <Pressable
                    disabled={busy}
                    onPress={() => onAsk(p, dev)}
                    style={({ pressed }) => [s.primaryBtn, pressed && s.pressed]}
                  >
                    <Text style={s.primaryLabel}>{grant ? "Ask for more" : "Ask for access"}</Text>
                  </Pressable>
                )}
              </View>
            );
          })
        ) : (
          // The empty state must not blame this machine's own setting — it can
          // see the network either way, so what is missing is the OTHER computer.
          <View style={s.empty}>
            <Ionicons name="scan-outline" size={22} color={COLOR.fgFaint} />
            <Text style={s.emptyText}>Nothing found yet</Text>
            <Text style={s.emptyHint}>Other computers need Pounce running and discoverable.</Text>
          </View>
        )}
      </Section>

      <Standing
        given={given}
        held={heldElsewhere}
        busy={busy}
        onRevoke={onRevoke}
        onForget={onForget}
      />
    </ScrollView>
  );
}

/**
 * Whether other computers can find THIS one — the mirror of the list below, and
 * deliberately not a gate on it.
 *
 * A SWITCH with a FIXED label. The label used to flip between "Discoverable"
 * and "Not discoverable", which is the switch's job to say: a control that
 * renames itself as you use it gives you two things to read where one would do,
 * and for a moment you cannot tell whether the words describe the state or the
 * action. "Discover Me" names the setting once and lets the switch carry the
 * state — the same shape as the auto-update toggle in Settings.
 *
 * One line under it, and only the fact that matters: what other people get.
 * Discovery broadcasts the machine name and nothing else (agents/discovery.mjs
 * — "No token, no repo names, no thread titles"), and the argument for why that
 * is safe belongs in the docs, not in a row you read every time.
 */
function Discoverable({
  discovery,
  busy,
  onToggle,
}: {
  discovery: DiscoveryState | null;
  busy: boolean;
  onToggle: () => void;
}) {
  if (!discovery) return null;
  return (
    <View style={s.card}>
      <View style={s.row}>
        <View style={s.badge}>
          <Ionicons name="wifi" size={17} color={COLOR.accent} />
        </View>
        <View style={s.grow}>
          <Text style={s.rowName}>Discover Me</Text>
          <Text style={s.rowMeta}>Computers here can see this Mac's name and ask for access.</Text>
        </View>
        {!discovery.eligible ? (
          <Text style={s.rowNote}>not available here</Text>
        ) : discovery.locked ? (
          <Text style={s.rowNote}>set on this machine</Text>
        ) : (
          <Toggle
            value={discovery.on}
            onValueChange={onToggle}
            disabled={busy}
            accessibilityLabel="Discover me"
          />
        )}
      </View>
    </View>
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
  have,
  busy,
  onRequest,
}: {
  peer: Peer;
  token: string;
  /** Scope already granted to us, or null when this is a first ask. */
  have: Scope | null;
  busy: boolean;
  onRequest: (scope: Scope) => void;
}) {
  const [spaces, setSpaces] = useState<CatalogSpace[] | null>(null);
  // Pre-ticked with what we already hold. Approval REPLACES the grant rather
  // than adding to it, so an "ask for more" that started from blank would hand
  // back the spaces you already had the moment it was approved.
  const [pickedSpaces, setPickedSpaces] = useState<Set<string>>(
    () => new Set(have?.kind === "scoped" ? have.repoKeys : []),
  );
  const [pickedThreads, setPickedThreads] = useState<Map<string, CatalogThread>>(new Map());
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CatalogThread[]>([]);
  // The REASON, not just the fact. This used to be a bare boolean and the
  // screen guessed out loud ("the preview may have run out") — which is one
  // possible cause among several, was stated as though it were known, and is
  // simply wrong on the connected path where there is no preview at all.
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    catalogSpaces(peer.url, token)
      .then(setSpaces)
      .catch((e) => setFailed(String((e as Error)?.message || e)));
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
        title={`Couldn't read ${peer.hostName}'s catalog`}
        body={
          have
            ? // Reached with a read grant, so nothing has "run out". Overwhelmingly
              // the peer is on a bridge that keeps the catalog preview-only.
              `${peer.hostName} wouldn't show its space list to the access you hold — it's probably running an older Pounce. Start over to ask it the long way.`
            : "The preview may have already run out — they're deliberately short. Start over to ask again."
        }
        detail={failed}
      />
    );
  }
  if (!spaces) return <Centered spinner title={`Reading ${peer.hostName}'s catalog…`} />;

  return (
    <View style={s.grow}>
      <Text style={s.sectionHint}>
        {have
          ? `What you already read is ticked. Add anything else you want from ${peer.hostName}.`
          : `${peer.hostName} is showing names and dates only. Pick what you want to read.`}
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
  detail,
  spinner,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  // ColorValue, not string: the theme's tokens are PlatformColors on macOS.
  tint?: ColorValue;
  title: string;
  body?: string;
  /** The underlying error, in small type. The sentence above it is a guess at
   *  what it MEANS; this is what actually happened, and it is the difference
   *  between a bug report and "it just says it didn't work". */
  detail?: string | null;
  spinner?: boolean;
}) {
  return (
    <View style={s.center}>
      {spinner ? <ActivityIndicator color={COLOR.accent} /> : null}
      {icon ? <Ionicons name={icon} size={40} color={tint ?? COLOR.fgFaint} /> : null}
      <Text style={s.waitTitle}>{title}</Text>
      {body ? <Text style={s.waitBody}>{body}</Text> : null}
      {detail ? (
        <Text selectable style={s.waitDetail}>
          {detail}
        </Text>
      ) : null}
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
    paddingLeft: 16,
    // The shell floats a close button over every modal at top:10/right:10,
    // 24pt square — so it owns everything right of `width - 34`. "Start over"
    // was laid out to `width - 16` and the two drew on top of each other.
    // 42 = 34 for the button, plus 8 of air so they read as separate controls.
    paddingRight: 42,
  },
  headerTitle: { fontSize: 15, fontWeight: "600", color: T.fg },
  link: { fontSize: 13, color: COLOR.accent },

  list: { padding: 20, paddingBottom: 28 },

  // Sections carry their own spacing so the ScrollView doesn't need a `gap`
  // that would also push apart the rows inside a card.
  section: { marginTop: 22 },
  sectionFirst: { marginTop: 0 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surfaceAlt,
    // Rows draw edge-to-edge dividers; without this they'd poke past the
    // rounded corners.
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  // Hairline BETWEEN rows only — a border on every row would double up against
  // the card's own edge.
  rowDivided: { borderTopWidth: 1, borderTopColor: T.border },
  // A tinted square keeps the icon from floating loose against the label, and
  // gives the accent somewhere to appear other than the button.
  badge: {
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: T.accentSoft,
  },
  // Green rather than accent: this machine is already connected, which is a
  // state, not the call to action the accent is reserved for.
  badgeOn: {
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: T.successSoft,
  },
  badgeQuiet: {
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
  },
  rowName: { fontSize: 13.5, fontWeight: "600", color: T.fg },
  rowMeta: { marginTop: 1, fontSize: 11.5, color: T.fgMuted },
  rowNote: { fontSize: 11, color: T.fgFaint },

  empty: { alignItems: "center", gap: 5, paddingVertical: 26, paddingHorizontal: 20 },
  emptyText: { fontSize: 13, fontWeight: "500", color: T.fgMuted },
  emptyHint: { textAlign: "center", fontSize: 11.5, color: T.fgFaint },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
  },

  waitTitle: { textAlign: "center", fontSize: 15, fontWeight: "600", color: T.fg },
  waitBody: { textAlign: "center", fontSize: 13, lineHeight: 19, color: T.fgMuted },
  waitDetail: {
    fontFamily: "JetBrainsMono",
    textAlign: "center",
    fontSize: 10.5,
    lineHeight: 15,
    color: T.fgFaint,
  },

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
  sectionTitle: {
    marginBottom: 8,
    marginLeft: 2,
    fontSize: 10.5,
    fontWeight: "600",
    letterSpacing: 0.7,
    textTransform: "uppercase",
    color: T.fgFaint,
  },
  // Still used by the catalog step, whose picker rows are a flat list rather
  // than a card.
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
  // `onAccent`, never `bg`: bg is the PAGE colour, which happens to be white in
  // light mode and near-black in dark — so a label written against it turned
  // into black text on a vivid purple pill the moment the theme flipped.
  // onAccent exists for exactly this and is white in both.
  primaryLabel: { fontSize: 13, fontWeight: "600", color: T.onAccent },
  // Revoke and Forget: destructive-ish actions that must not read as the thing
  // to do on the screen.
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
