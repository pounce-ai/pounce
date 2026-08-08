/**
 * Shared access — the other end of Peers.tsx, running on the machine being
 * asked.
 *
 * Two jobs. Answer the people knocking, and see who currently holds a key.
 *
 * The scope picker lives HERE and not on the requesting machine, which is the
 * whole shape of the feature: this is the side that already has the space list,
 * so this is the only side that can offer a real choice without first handing a
 * stranger a directory of everything on the disk. A read request arrives with a
 * suggestion attached; the sheet starts from it and the person at this keyboard
 * decides what actually goes.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  approveAccess,
  denyAccess,
  DURATIONS,
  expiryFor,
  listAccess,
  ownSpaces,
  ownThreads,
  revokeGrant,
  summarize,
  timeLeft,
  type AccessRequest,
  type CatalogSpace,
  type CatalogThread,
  type Grant,
  type Scope,
} from "@pounce/app/services/peers";
import { COLOR } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";

export default function AccessScreen() {
  const [pending, setPending] = useState<AccessRequest[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [spaces, setSpaces] = useState<CatalogSpace[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const { pending: p, grants: g } = await listAccess();
    setPending(p);
    setGrants(g);
    setLoaded(true);
  }, []);

  // A request can arrive while this window is already open, and a grant can
  // lapse while it is being looked at, so both lists are polled.
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    void ownSpaces().then(setSpaces);
  }, []);

  if (!loaded) {
    return (
      <View style={[s.root, s.center]}>
        <ActivityIndicator color={COLOR.accent} />
      </View>
    );
  }

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.headerTitle}>Shared access</Text>
      </View>
      <ScrollView contentContainerStyle={s.body}>
        {pending.length ? (
          <>
            <Text style={s.sectionTitle}>Waiting on you</Text>
            {pending.map((r) => (
              <RequestCard key={r.id} request={r} spaces={spaces} onDone={() => void refresh()} />
            ))}
          </>
        ) : null}

        <Text style={[s.sectionTitle, pending.length ? s.sectionGap : null]}>
          {grants.length ? "Machines with access" : "Nobody has access"}
        </Text>
        {grants.length ? (
          grants.map((g) => <GrantRow key={g.id} grant={g} onDone={() => void refresh()} />)
        ) : (
          <Text style={s.hint}>
            When another Mac asks to read this machine's threads, the request shows up here.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

// --- answering a request ---------------------------------------------------------

function RequestCard({
  request,
  spaces,
  onDone,
}: {
  request: AccessRequest;
  spaces: CatalogSpace[];
  onDone: () => void;
}) {
  const suggested = request.scope;
  const [everything, setEverything] = useState(!suggested || suggested.kind === "full");
  // Start from what they asked for. It is a suggestion, not a decision — but
  // starting from blank would make the common "yes, that's fine" case a chore.
  const [picked, setPicked] = useState<Set<string>>(
    new Set(suggested && suggested.kind === "scoped" ? suggested.repoKeys : []),
  );
  const [hours, setHours] = useState<number | null>(24);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CatalogThread[]>([]);

  const isPreview = request.kind === "preview";
  // Threads they picked by name from the catalog. Kept as a map so the approver
  // can drop individual ones — the request is a suggestion here too — and so
  // threads found by the search below can be added to the same set.
  const [threads, setThreads] = useState<Map<string, { agent: string; id: string; name?: string }>>(
    () =>
      new Map(
        (suggested && suggested.kind === "scoped" ? suggested.threads : []).map((t) => [t.id, t]),
      ),
  );

  // A machine with thirty spaces makes the list a haystack, so the box filters.
  // The same query also searches thread NAMES, which is the only way to grant a
  // single thread from this side — the peer asked by name, and so do you.
  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(
      () =>
        void ownThreads(q)
          .then(setHits)
          .catch(() => setHits([])),
      250,
    );
    return () => clearTimeout(t);
  }, [q]);

  const shownSpaces = q.trim()
    ? spaces.filter((sp) => sp.repoKey.toLowerCase().includes(q.trim().toLowerCase()))
    : spaces;

  const scope: Scope = everything
    ? { kind: "full" }
    : {
        kind: "scoped",
        repoKeys: [...picked],
        threads: [...threads.values()].map((t) => ({ agent: t.agent, id: t.id })),
      };
  const nothingPicked = !everything && !picked.size && !threads.size;

  const act = async (approve: boolean) => {
    setBusy(true);
    try {
      if (approve) {
        await approveAccess(request.id, {
          scope: isPreview ? undefined : scope,
          expiresAt: isPreview ? null : expiryFor(hours),
        });
      } else {
        await denyAccess(request.id);
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.card}>
      <View style={s.cardHead}>
        <Ionicons name="laptop-outline" size={18} color={COLOR.fgMuted} />
        <View style={s.grow}>
          <Text style={s.cardTitle}>
            {request.requester.hostName} wants {isPreview ? "a look at what's here" : "read access"}
          </Text>
          <Text style={s.cardMeta}>
            {isPreview
              ? "Space and thread names only — no messages, for a few minutes."
              : `Asked for: ${summarize(suggested)}`}
          </Text>
        </View>
        {/* Shown on both machines. If these don't match, it isn't their laptop. */}
        <Text selectable style={s.code}>
          {request.code.slice(0, 3)}-{request.code.slice(3)}
        </Text>
      </View>

      {request.note ? <Text style={s.note}>“{request.note}”</Text> : null}

      {!isPreview ? (
        <>
          <Text style={s.fieldLabel}>They can read</Text>
          <Pressable
            onPress={() => setEverything(true)}
            style={({ pressed }) => [s.optRow, pressed && s.pressed]}
          >
            <Radio on={everything} />
            <Text style={s.optLabel}>Everything on this machine</Text>
          </Pressable>
          <Pressable
            onPress={() => setEverything(false)}
            style={({ pressed }) => [s.optRow, pressed && s.pressed]}
          >
            <Radio on={!everything} />
            <Text style={s.optLabel}>Only what I pick</Text>
          </Pressable>

          {/* Scrolls, and must: a working machine has dozens of spaces, and a
              plain capped View does not clip its children on macOS — the list
              spilled straight over the duration row and the buttons below it. */}
          {!everything ? (
            <>
              <TextInput
                value={q}
                onChangeText={setQ}
                placeholder="Filter spaces, or search thread names…"
                placeholderTextColor={COLOR.fgFaint}
                style={s.search}
              />
              <ScrollView
                style={s.spaceBox}
                contentContainerStyle={s.spaceBoxInner}
                nestedScrollEnabled
              >
                {shownSpaces.map((sp) => (
                  <Pressable
                    key={sp.repoKey}
                    onPress={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(sp.repoKey)) next.add(sp.repoKey);
                        return next;
                      })
                    }
                    style={({ pressed }) => [s.spaceRow, pressed && s.pressed]}
                  >
                    <Check on={picked.has(sp.repoKey)} />
                    <Text style={s.spaceName} numberOfLines={1}>
                      {sp.repoKey}
                    </Text>
                    <Text style={s.cardMeta}>{sp.threadCount}</Text>
                  </Pressable>
                ))}

                {/* Individual threads, found by the same query. Ticking one
                    grants exactly it, without the space around it. */}
                {hits.length ? <Text style={s.groupLabel}>Threads</Text> : null}
                {hits.map((t) => (
                  <Pressable
                    key={`${t.agent}:${t.id}`}
                    onPress={() =>
                      setThreads((prev) => {
                        const next = new Map(prev);
                        if (!next.delete(t.id)) {
                          next.set(t.id, { agent: t.agent, id: t.id, name: t.name ?? undefined });
                        }
                        return next;
                      })
                    }
                    style={({ pressed }) => [s.spaceRow, pressed && s.pressed]}
                  >
                    <Check on={threads.has(t.id)} />
                    <Text style={s.spaceName} numberOfLines={1}>
                      {t.name || "Untitled thread"}
                    </Text>
                    <Text style={s.cardMeta}>{t.repoKey}</Text>
                  </Pressable>
                ))}

                {q.trim() && !shownSpaces.length && !hits.length ? (
                  <Text style={s.cardMeta}>Nothing matches “{q.trim()}”.</Text>
                ) : null}
              </ScrollView>
              {threads.size ? (
                <Text style={s.cardMeta}>
                  {threads.size} single thread{threads.size === 1 ? "" : "s"} selected
                </Text>
              ) : null}
            </>
          ) : null}

          <Text style={s.fieldLabel}>Until</Text>
          <View style={s.chipRow}>
            {DURATIONS.map((d) => (
              <Pressable
                key={d.label}
                onPress={() => setHours(d.hours)}
                style={({ pressed }) => [
                  s.chip,
                  hours === d.hours && s.chipOn,
                  pressed && s.pressed,
                ]}
              >
                <Text style={[s.chipLabel, hours === d.hours && s.chipLabelOn]}>{d.label}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}

      <View style={s.actions}>
        <Pressable
          disabled={busy}
          onPress={() => void act(false)}
          style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]}
        >
          <Text style={s.ghostLabel}>Deny</Text>
        </Pressable>
        <Pressable
          disabled={busy || nothingPicked}
          onPress={() => void act(true)}
          style={({ pressed }) => [
            s.primaryBtn,
            (busy || nothingPicked) && s.disabled,
            pressed && s.pressed,
          ]}
        >
          <Text style={s.primaryLabel}>
            {isPreview ? "Let them look" : `Approve · ${summarize(scope)}`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// --- who holds a key -------------------------------------------------------------

function GrantRow({ grant, onDone }: { grant: Grant; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <View style={s.grantRow}>
      <View style={s.grow}>
        <Text style={s.cardTitle}>{grant.requester.hostName}</Text>
        <Text style={s.cardMeta}>
          {grant.kind === "preview" ? "Browsing names" : grant.summary} ·{" "}
          {timeLeft(grant.expiresAt)}
          {grant.lastUsedAt ? "" : " · not used yet"}
        </Text>
      </View>
      <Pressable
        disabled={busy}
        onPress={async () => {
          setBusy(true);
          try {
            await revokeGrant(grant.id);
            onDone();
          } finally {
            setBusy(false);
          }
        }}
        style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]}
      >
        <Text style={s.ghostLabel}>Revoke</Text>
      </Pressable>
    </View>
  );
}

function Radio({ on }: { on: boolean }) {
  return <View style={[s.radio, on && s.radioOn]}>{on ? <View style={s.radioDot} /> : null}</View>;
}

function Check({ on }: { on: boolean }) {
  return (
    <View style={[s.check, on && s.checkOn]}>
      {on ? <Ionicons name="checkmark" size={12} color={T.bg} /> : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  grow: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  header: {
    height: 48,
    justifyContent: "center",
    borderBottomWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 16,
  },
  headerTitle: { fontSize: 15, fontWeight: "600", color: T.fg },
  body: { padding: 16, gap: 8 },

  sectionTitle: { fontSize: 11, fontWeight: "600", textTransform: "uppercase", color: T.fgFaint },
  sectionGap: { marginTop: 20 },
  hint: { fontSize: 13, lineHeight: 19, color: T.fgMuted },

  card: {
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    padding: 14,
  },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  cardTitle: { fontSize: 14, fontWeight: "500", color: T.fg },
  cardMeta: { fontSize: 11, color: T.fgFaint },
  code: { fontFamily: "JetBrainsMono", fontSize: 14, letterSpacing: 1, color: T.fgMuted },
  note: { fontSize: 12, fontStyle: "italic", color: T.fgMuted },

  fieldLabel: { marginTop: 4, fontSize: 11, fontWeight: "600", color: T.fgFaint },
  optRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 },
  optLabel: { fontSize: 13, color: T.fg },
  radio: {
    height: 16,
    width: 16,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: T.border,
  },
  radioOn: { borderColor: COLOR.accent },
  radioDot: { height: 8, width: 8, borderRadius: 999, backgroundColor: COLOR.accent },

  spaceBox: {
    borderRadius: 10,
    backgroundColor: T.surfaceAlt ?? T.bg,
    maxHeight: 180,
    // Belt and braces with the ScrollView: RN does not clip overflowing
    // children by default on macOS, and this list is taller than its cap.
    overflow: "hidden",
  },
  spaceBoxInner: { gap: 4, padding: 8 },
  groupLabel: { marginTop: 6, fontSize: 10, fontWeight: "600", color: T.fgFaint },
  search: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 12,
    color: T.fg,
  },
  spaceRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  spaceName: { flex: 1, fontSize: 12, color: T.fg },
  check: {
    height: 16,
    width: 16,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
    borderWidth: 1,
    borderColor: T.border,
  },
  checkOn: { backgroundColor: COLOR.accent, borderColor: COLOR.accent },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipOn: { backgroundColor: COLOR.accent, borderColor: COLOR.accent },
  chipLabel: { fontSize: 12, color: T.fgMuted },
  chipLabelOn: { color: T.bg, fontWeight: "600" },

  actions: { marginTop: 4, flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  grantRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 10,
    backgroundColor: T.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  primaryBtn: {
    borderRadius: 10,
    backgroundColor: COLOR.accent,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  primaryLabel: { fontSize: 13, fontWeight: "600", color: T.bg },
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
