import { useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { cn, COLOR } from "@/ui";

const DOCS_URL = "https://peppyhop.github.io/pounce/how-it-works.html";

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
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top + 8 }}>
      <View className="flex-row items-center justify-between px-4 pb-3">
        <Text className="text-[22px] font-bold text-fg">Help</Text>
        <Pressable onPress={() => router.back()} className="active:opacity-60">
          <Text className="text-[15px] text-fg-muted">Done</Text>
        </Pressable>
      </View>

      {/* Search */}
      <View className="mx-4 mb-2 flex-row items-center gap-2 rounded-2xl bg-surface-alt px-3">
        <Ionicons name="search" size={16} color={COLOR.fgFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search help…"
          placeholderTextColor={COLOR.fgFaint}
          autoCapitalize="none"
          autoCorrect={false}
          className="h-11 flex-1 text-[15px] text-fg"
        />
        {query ? (
          <Pressable onPress={() => setQuery("")} className="active:opacity-60 p-1">
            <Ionicons name="close-circle" size={16} color={COLOR.fgFaint} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView
        className="flex-1 px-4"
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
                className="active:opacity-90 rounded-2xl border border-border bg-surface px-4 py-3.5"
              >
                <View className="flex-row items-center gap-2">
                  <Text className="flex-1 text-[15px] font-semibold text-fg">{f.q}</Text>
                  <Ionicons
                    name={isOpen ? "chevron-up" : "chevron-down"}
                    size={16}
                    color={COLOR.fgFaint}
                  />
                </View>
                {isOpen ? (
                  <Text className="mt-2 text-[14px] leading-[21px] text-fg-muted">{f.a}</Text>
                ) : null}
              </Pressable>
            );
          })
        ) : (
          <View className="items-center px-8 py-16">
            <Text className="text-[40px]">🔍</Text>
            <Text className="mt-3 text-center text-[15px] font-semibold text-fg">No matches</Text>
            <Text className="mt-1 text-center text-[13px] text-fg-muted">
              Try another word, or open the full docs below.
            </Text>
          </View>
        )}

        <Pressable
          onPress={() => void Linking.openURL(DOCS_URL)}
          className={cn(
            "active:opacity-80 mt-2 flex-row items-center justify-center gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5",
          )}
        >
          <Ionicons name="book-outline" size={16} color={COLOR.accent} />
          <Text className="text-[14px] font-medium text-accent">Open the full docs</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
