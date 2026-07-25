import { useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { PounceIcon } from "../ui/native/Icon";
import { INPUT_TWEAKS, IS_DESKTOP } from "../ui";

const DOCS_URL = "https://use-pounce.com/how-it-works.html";

interface Faq {
  q: string;
  a: string;
}

/** Grounded in the real docs (docs/how-it-works.html). Keep answers accurate to
 *  how the app actually behaves — this is the "correct answer" source. */
const FAQS: Faq[] = [
  {
    q: "What is Pounce?",
    a: "Pounce is a remote control for the coding agents running on your own machines. It doesn't run agents in the cloud and nothing is routed through a Pounce server — the app talks straight to the Pounce Bridge on your computer, which talks to the agents (Claude, Codex, opencode) there. Your code and conversations stay on your devices.",
  },
  {
    q: "How do I connect my Mac?",
    a: "Install the free, notarized Pounce Bridge on your Mac and run it — it shows a QR pairing code. In the app go to Settings → Pair a device → Scan pairing code (or enter it manually). Your sessions then sync automatically.",
  },
  {
    q: "Can I use it away from home, off Wi‑Fi?",
    a: "Same Wi‑Fi is easiest. To connect remotely, expose the Bridge through a tunnel (Tailscale, ngrok, or a Cloudflare tunnel) and scan the same code — Pounce connects to whatever address the Bridge advertises.",
  },
  {
    q: "How do I start a task?",
    a: "Tap New, describe the task, and browse to the folder on your Mac it should run in. Choose the agent (Claude, Codex, or opencode), then send.",
  },
  {
    q: "How are my threads organized?",
    a: "Each thread is one agent working in one folder. On Home, threads are grouped by that folder; anything that needs your attention floats to the top.",
  },
  {
    q: "What do the status labels mean?",
    a: "Running / Streaming = the agent is actively working. Needs you = it's awaiting your input or a decision. Failed = the run errored. Done = it completed.",
  },
  {
    q: "How do voice commands work?",
    a: "Open a tab's quick actions and tap Voice command, then speak — you can navigate and filter your threads hands‑free.",
  },
  {
    q: "How do I find a specific thread?",
    a: "The Search tab finds any thread across your paired machines — by title, folder, branch, host, or agent — and you can filter by device or agent.",
  },
  {
    q: "Can I review and ship from my phone?",
    a: "Yes — watch agents work live, reply or redirect by voice, approve permission prompts, review the diff, then commit, push, or open a PR, all from the app.",
  },
  {
    q: "Nothing is syncing / I can't connect",
    a: "Make sure the Pounce Bridge is running on your Mac and both are on the same Wi‑Fi (or your tunnel is up). Pull to refresh on Home, or tap Refresh in Settings. If the Bridge's code changed, pair again.",
  },
  {
    q: "Is my code private?",
    a: "Yes. Nothing is routed through a Pounce server. Each machine pairs with its own private token and the app connects directly to your Bridge, so your code and conversations stay between your own devices.",
  },
];

export default function HelpScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { theme } = useUnistyles();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());

  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const results = useMemo(() => {
    const t = query.trim().toLowerCase();
    const items = FAQS.map((f, i) => ({ ...f, i }));
    if (!t) return items;
    return items.filter((f) => f.q.toLowerCase().includes(t) || f.a.toLowerCase().includes(t));
  }, [query]);

  return (
    <View style={[s.root, IS_DESKTOP ? { paddingTop: insets.top + 8 } : { paddingTop: 8 }]}>
      {/* Mobile shows the native modal navigation bar; this row is desktop chrome. */}
      {IS_DESKTOP ? (
        <View style={s.headerRow}>
          <Text style={s.headerTitle}>Help</Text>
          <Pressable onPress={() => router.back()} style={({ pressed }) => pressed && s.pressed60}>
            <Text style={s.doneLabel}>Done</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Search */}
      <View style={s.searchRow}>
        <PounceIcon name="search" size={16} color={theme.colors.fgFaint} />
        <TextInput
          {...INPUT_TWEAKS}
          value={query}
          onChangeText={setQuery}
          placeholder="Search help…"
          placeholderTextColor={theme.colors.fgFaint}
          autoCapitalize="none"
          autoCorrect={false}
          style={[s.searchInput, IS_DESKTOP && s.inputDesktop]}
        />
        {query ? (
          <Pressable
            onPress={() => setQuery("")}
            style={({ pressed }) => [s.clearBtn, pressed && s.pressed60]}
          >
            <PounceIcon name="close-circle" size={16} color={theme.colors.fgFaint} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 24, gap: 8 }}
        keyboardDismissMode="on-drag"
      >
        {results.length ? (
          results.map((f) => {
            const isOpen = open.has(f.i);
            return (
              <Pressable
                key={f.i}
                onPress={() => toggle(f.i)}
                style={({ pressed }) => [s.card, pressed && s.pressed90]}
              >
                <View style={s.cardHeader}>
                  <Text style={s.question}>{f.q}</Text>
                  <PounceIcon
                    name={isOpen ? "chevron-up" : "chevron-down"}
                    size={16}
                    color={theme.colors.fgFaint}
                  />
                </View>
                {isOpen ? <Text style={s.answer}>{f.a}</Text> : null}
              </Pressable>
            );
          })
        ) : (
          <View style={s.empty}>
            <Text style={s.emptyEmoji}>🔍</Text>
            <Text style={s.emptyTitle}>No matches</Text>
            <Text style={s.emptyBody}>Try another word, or open the full docs below.</Text>
          </View>
        )}

        <Pressable
          onPress={() => void Linking.openURL(DOCS_URL)}
          style={({ pressed }) => [s.docsBtn, pressed && s.pressed80]}
        >
          <PounceIcon name="book-outline" size={16} color={theme.colors.accent} />
          <Text style={s.docsLabel}>Open the full docs</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerTitle: { fontSize: 22, fontWeight: "700", color: theme.colors.fg },
  doneLabel: { fontSize: 15, color: theme.colors.fgMuted },
  pressed60: { opacity: 0.6 },
  pressed80: { opacity: 0.8 },
  pressed90: { opacity: 0.9 },
  searchRow: {
    marginHorizontal: 16,
    marginBottom: 8,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 16,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 12,
  },
  searchInput: { flex: 1, fontSize: 15, color: theme.colors.fg, height: 44 },
  // Desktop keeps the input's intrinsic height (centered by the row) — see inputH in ui/index.tsx.
  inputDesktop: { height: "auto" as const, paddingVertical: 0 },
  clearBtn: { padding: 4 },
  scroll: { flex: 1, paddingHorizontal: 16 },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  question: { flex: 1, fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  answer: { marginTop: 8, fontSize: 14, lineHeight: 21, color: theme.colors.fgMuted },
  empty: { alignItems: "center", paddingHorizontal: 32, paddingVertical: 64 },
  emptyEmoji: { fontSize: 40 },
  emptyTitle: {
    marginTop: 12,
    textAlign: "center",
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.fg,
  },
  emptyBody: { marginTop: 4, textAlign: "center", fontSize: 13, color: theme.colors.fgMuted },
  docsBtn: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  docsLabel: { fontSize: 14, fontWeight: "500", color: theme.colors.accent },
}));
