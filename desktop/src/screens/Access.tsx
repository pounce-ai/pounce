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
          <View style={s.section}>
            <Text style={s.sectionTitle}>Waiting on you</Text>
            <View style={s.stack}>
              {pending.map((r) => (
                <RequestCard key={r.id} request={r} spaces={spaces} onDone={() => void refresh()} />
              ))}
            </View>
          </View>
        ) : null}

        <View style={[s.section, pending.length ? s.sectionGap : null]}>
          <Text style={s.sectionTitle}>
            {grants.length ? "Machines with access" : "Nobody has access"}
          </Text>
          <View style={s.card}>
            {grants.length ? (
              groupByMachine(grants).map((m, i) => (
                <MachineGrants
                  key={m.bridgeId}
                  machine={m}
                  divided={i > 0}
                  onDone={() => void refresh()}
                />
              ))
            ) : (
              <View style={s.empty}>
                <Ionicons name="key-outline" size={22} color={COLOR.fgFaint} />
                <Text style={s.emptyText}>Nobody has access</Text>
                <Text style={s.emptyHint}>
                  When another Mac asks to read this machine's threads, it shows up here.
                </Text>
              </View>
            )}
          </View>
        </View>
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
  /** What this machine already granted them — null for a first-time asker. */
  const existing = request.existing ?? null;
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
    <View style={s.requestCard}>
      <View style={s.cardHead}>
        <View style={existing ? s.badgeMore : s.badge}>
          <Ionicons
            name={existing ? "add-circle-outline" : "laptop-outline"}
            size={17}
            color={existing ? T.warning : COLOR.accent}
          />
        </View>
        <View style={s.grow}>
          <Text style={s.cardTitle}>
            {existing
              ? `${request.requester.hostName} wants more access`
              : `${request.requester.hostName} wants ${isPreview ? "a look at what's here" : "read access"}`}
          </Text>
          <Text style={s.cardMeta}>
            {isPreview
              ? "Space and thread names only — no messages, for a few minutes."
              : existing
                ? // Both halves, in order: what they have, then what they are
                  // asking for. Approval REPLACES the old grant, so the second
                  // number is the whole answer and not an increment.
                  `Reads ${existing.summary} now · asking for ${summarize(suggested)}`
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
          <View style={s.optGroup}>
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
          </View>

          {/* Scrolls, and must: a working machine has dozens of spaces, and a
              plain capped View does not clip its children on macOS — the list
              spilled straight over the duration row and the buttons below it. */}
          {!everything ? (
            // The filter and the list it filters are one control; the card's
            // 14pt rhythm is for separate groups, not for the inside of one.
            <View style={s.pickGroup}>
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
            </View>
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

interface MachineAccess {
  bridgeId: string;
  hostName: string;
  grants: Grant[];
}

/**
 * One entry per MACHINE, not per grant.
 *
 * A machine holding two grants used to render as two sibling rows, each titled
 * with the same host name and distinguished only by a faint scope line. That
 * reads as two machines at a glance — the one thing this list must never be
 * ambiguous about is WHO can read this Mac — and it buries the answer to "what
 * does this machine have?" in a subtitle you have to assemble yourself.
 */
function groupByMachine(grants: Grant[]): MachineAccess[] {
  const byId = new Map<string, MachineAccess>();
  for (const g of grants) {
    // Fall back to the host name for a grant issued before requesters carried
    // an id, so an old row groups as itself rather than collapsing every
    // unidentified machine into one.
    const key = g.requester.bridgeId || `name:${g.requester.hostName}`;
    const hit = byId.get(key);
    if (hit) hit.grants.push(g);
    else byId.set(key, { bridgeId: key, hostName: g.requester.hostName, grants: [g] });
  }
  return [...byId.values()];
}

/** What a single grant covers, in the words the rest of the app uses. */
function grantLine(g: Grant): string {
  const what = g.kind === "preview" ? "Browsing names" : g.summary;
  return `${what} · ${timeLeft(g.expiresAt)}${g.lastUsedAt ? "" : " · not used yet"}`;
}

function MachineGrants({
  machine,
  divided,
  onDone,
}: {
  machine: MachineAccess;
  divided: boolean;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const revoke = async (ids: string[]) => {
    setBusy(true);
    try {
      for (const id of ids) await revokeGrant(id);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  const only = machine.grants.length === 1 ? machine.grants[0] : null;

  return (
    <View style={divided ? s.rowDivided : undefined}>
      <View style={s.grantRow}>
        <View style={s.badgeQuiet}>
          <Ionicons name="laptop-outline" size={16} color={COLOR.fgMuted} />
        </View>
        <View style={s.grow}>
          <Text style={s.cardTitle}>{machine.hostName}</Text>
          {/* One grant is the common case, and nesting a lone child under a
              header is just an indent for nothing — so it collapses inline. */}
          <Text style={s.cardMeta}>
            {only
              ? grantLine(only)
              : `${machine.grants.length} grants${machine.grants.some((g) => !g.lastUsedAt) ? " · some not used yet" : ""}`}
          </Text>
        </View>
        <Pressable
          disabled={busy}
          onPress={() => void revoke(machine.grants.map((g) => g.id))}
          style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]}
        >
          <Text style={s.ghostLabel}>{only ? "Revoke" : "Revoke all"}</Text>
        </Pressable>
      </View>

      {only
        ? null
        : machine.grants.map((g) => (
            <View key={g.id} style={s.subRow}>
              <Text style={s.subName} numberOfLines={1}>
                {g.kind === "preview" ? "Browsing names" : g.summary}
              </Text>
              <Text style={s.cardMeta}>{timeLeft(g.expiresAt)}</Text>
              <Pressable
                disabled={busy}
                onPress={() => void revoke([g.id])}
                style={({ pressed }) => [s.subBtn, pressed && s.pressed]}
              >
                <Text style={s.ghostLabel}>Revoke</Text>
              </Pressable>
            </View>
          ))}
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
  // No `gap` here: a container gap applies to section titles and cards alike,
  // so the label sat as far from its own card as the cards sat from each other
  // and nothing read as grouped. Sections own their spacing instead.
  body: { padding: 20, paddingBottom: 28 },

  section: { marginTop: 0 },
  sectionGap: { marginTop: 24 },
  stack: { gap: 10 },
  sectionTitle: {
    marginBottom: 8,
    marginLeft: 2,
    fontSize: 10.5,
    fontWeight: "600",
    letterSpacing: 0.7,
    textTransform: "uppercase",
    color: T.fgFaint,
  },

  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surfaceAlt,
    overflow: "hidden",
  },
  rowDivided: { borderTopWidth: 1, borderTopColor: T.border },
  empty: { alignItems: "center", gap: 5, paddingVertical: 26, paddingHorizontal: 24 },
  emptyText: { fontSize: 13, fontWeight: "500", color: T.fgMuted },
  emptyHint: { textAlign: "center", fontSize: 11.5, color: T.fgFaint },

  // The request card sets its OWN rhythm rather than a flat 8 between every
  // element: a form is groups of things, and an even gap between a label and
  // its control and between one group and the next flattens that structure.
  requestCard: {
    gap: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surfaceAlt,
    padding: 16,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  badge: {
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: T.accentSoft,
  },
  // Neutral: this is a standing fact about a machine, not a call to action.
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
  // Amber, not red: widening access is a normal ask and often the right thing
  // to approve. It wants a second look, not an alarm.
  badgeMore: {
    height: 32,
    width: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: T.warningSoft,
  },
  cardTitle: { fontSize: 13.5, fontWeight: "600", color: T.fg },
  cardMeta: { marginTop: 1, fontSize: 11.5, color: T.fgMuted },
  code: { fontFamily: "JetBrainsMono", fontSize: 13, letterSpacing: 1, color: T.fgMuted },
  note: { marginTop: -4, fontSize: 12, fontStyle: "italic", color: T.fgMuted },

  // A label belongs to what follows it, so it sits close to that and far from
  // whatever came before — hence the negative bottom against the parent gap.
  fieldLabel: {
    marginBottom: -6,
    fontSize: 10.5,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: T.fgFaint,
  },
  optRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 5 },
  optGroup: { marginTop: -4 },
  pickGroup: { gap: 8 },
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
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    // Five whole 28pt rows, the 6pt padding above and below them, and then a
    // 5pt sliver of the sixth. The old 180 landed mid-row, so the last thing
    // you saw was the top half of a word — which reads as a rendering bug, not
    // as "scroll me". 5pt is inside that row's leading, so what peeks is blank
    // space: unmistakably "there is more" without showing half a glyph.
    maxHeight: 6 + 28 * 5 + 6 + 5,
    // Belt and braces with the ScrollView: RN does not clip overflowing
    // children by default on macOS, and this list is taller than its cap.
    overflow: "hidden",
  },
  spaceBoxInner: { paddingVertical: 6, paddingHorizontal: 6 },
  groupLabel: {
    marginTop: 8,
    marginBottom: 2,
    marginLeft: 6,
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: T.fgFaint,
  },
  search: {
    borderRadius: 9,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface,
    paddingHorizontal: 11,
    paddingVertical: 7,
    fontSize: 12.5,
    color: T.fg,
  },
  // 28pt tall, which is what spaceBox's cap is measured in. Cramped rows were
  // the other half of the list looking broken: 4pt apart with no padding of
  // their own, so the checkboxes ran together into a column of noise.
  spaceRow: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderRadius: 7,
    paddingHorizontal: 6,
  },
  spaceName: { flex: 1, fontSize: 12.5, color: T.fg },
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

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipOn: { backgroundColor: COLOR.accent, borderColor: COLOR.accent },
  chipLabel: { fontSize: 12, color: T.fgMuted },
  chipLabelOn: { color: T.onAccent, fontWeight: "600" },

  // Separated from the form by a rule, not by a guess at whitespace: these two
  // buttons commit everything above them and should read as the end of it.
  actions: {
    marginTop: 2,
    marginHorizontal: -16,
    marginBottom: -16,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: T.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  grantRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  // A machine's individual grants, indented under its name so they read as
  // belonging to it rather than as more machines.
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 56,
    paddingRight: 14,
    paddingBottom: 10,
  },
  subName: { flex: 1, fontSize: 12.5, color: T.fgMuted },
  subBtn: { paddingHorizontal: 8, paddingVertical: 3 },
  primaryBtn: {
    borderRadius: 999,
    backgroundColor: COLOR.accent,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  primaryLabel: { fontSize: 13, fontWeight: "600", color: T.onAccent },
  ghostBtn: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: T.borderStrong,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  ghostLabel: { fontSize: 13, color: T.fgMuted },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
