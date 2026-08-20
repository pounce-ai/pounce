/**
 * What filled the window — the breakdown behind the Claude quota card's block.
 *
 * `QuotaCard` reports plan PRESSURE: how much of a rolling window is gone. This
 * page answers the obvious next question — which tools, which shell commands,
 * and how much fixed preamble filled it. It opens from the block box on the
 * Claude card, which is the only part of that card these numbers explain.
 *
 * A page rather than a sheet, for the same reason `Metric.tsx` is one: there
 * are five things to say (the total, its composition, its breakdown, what to
 * change, and what the numbers can't claim) and a sheet holds two.
 *
 * The rule this page is built around: TOTALS ARE EXACT, THE SPLIT IS
 * APPORTIONED. Claude publishes no per-segment token counts, so how a request's
 * billed input divides across the things in its prefix is derived — and this
 * codebase does not dress a derivation as a reading (see `blocks.mjs`, which
 * refuses to show a percentage rather than infer a ceiling). The caveats
 * section is therefore always rendered, never behind a disclosure.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  type Attribution,
  type AttributionNode,
  exportAttribution,
  RouteMissingError,
  streamAttribution,
} from "../services/bridge";
import { newDraft } from "../state/drafts";
import { ActivitySkeleton } from "../components/Skeleton";
import { AgentLogo, IS_DESKTOP } from "../ui";
import { alpha, mix, readableOn } from "../ui/color";
import { fmtCount, fmtTokens } from "../ui/format";

/**
 * Ranges the page can show.
 *
 * "This window" is the agent's OWN rolling block — the one the quota card
 * reports, which opens at your first message and runs five hours from there. It
 * is deliberately not "the last five hours": those are different sets of
 * requests, and reporting the trailing version under this label made the page
 * disagree with the card that opened it by 140M tokens on a block seventeen
 * minutes old. The other two are plain trailing windows and say so.
 */
const WINDOWS = [
  { id: "block", label: "This window" },
  { id: 24, label: "Last 24h" },
  { id: 168, label: "Last 7 days" },
  { id: 720, label: "Last 30 days" },
  { id: 8760, label: "Last year" },
] as const;

/**
 * A year is the longest range, and it means "up to a year, if it's there".
 *
 * Claude prunes its own transcripts — on this machine the oldest was 30 days
 * old — so asking for a year mostly returns less than one. That is fine as long
 * as the page never implies otherwise, which is why the hero reports
 * `earliestAt` (the oldest turn actually found) rather than the start of the
 * range that was requested.
 */

type WindowId = (typeof WINDOWS)[number]["id"];

/** True when the data runs out well before the range asked for — the honest
 *  signal that "last year" returned a month because a month is all there is. */
function spansLessThanAsked(a: Attribution): boolean {
  const asked = Date.parse(a.windowStartedAt);
  const got = Date.parse(a.earliestAt ?? "");
  if (!Number.isFinite(asked) || !Number.isFinite(got)) return false;
  // An hour of slack, so a range that is effectively full doesn't nag.
  return got - asked > 3_600_000;
}

/** "09:12" / "Mon 4 Aug" — what the report actually covers. */
function sinceLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ageH = (Date.now() - d.getTime()) / 3_600_000;
  return ageH < 24
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/**
 * A hue per line item, fixed by NAME rather than by position.
 *
 * Ranking by size means a row moves when the window changes; a colour assigned
 * by rank would then recolour the whole chart between refreshes and make two
 * readings of the same machine look like two different machines.
 */
const HUES: Record<string, string> = {
  "Tools · content read in": "#7c6ff0",
  "Model output": "#3fb950",
  "System prompt & tool schemas": "#d29922",
  "Shell commands": "#2f9ecf",
  "Tools · content written out": "#c86fd0",
  "Images & attachments": "#e0724d",
  "Harness & reminders": "#8c8c99",
  "My typing": "#d0566f",
};
const FALLBACK_HUE = "#8c8c99";
const hueOf = (item: string) => HUES[item] ?? FALLBACK_HUE;

/** Ramp a column's hue for the blocks inside it. `mix` clamps and accepts
 *  `#rgb`, which the hand-rolled version this replaces did neither of;
 *  ContributionGraph builds its ramp exactly this way. */
const shade = (hex: string, t: number) =>
  t >= 0 ? mix(hex, "#ffffff", t) : mix(hex, "#000000", -t);

/** Chart geometry. The mosaic is proportional in BOTH axes, so it needs real
 *  pixels to decide what it can label — see `Mosaic`. */
const CHART_HEIGHT = IS_DESKTOP ? 264 : 208;
/** A column narrower than this can't carry a footer, so the chart is allowed to
 *  outgrow its container and scroll sideways instead. Every column scales by
 *  the same factor, so widths stay proportional — only the viewport is smaller
 *  than the chart. */
const MIN_COL_WIDTH = 62;
/** Below these a block gets no label rather than a clipped one. */
const LABEL_MIN_H = 20;
const LABEL_MIN_W = 52;
/** Where the Pareto marker goes: the first column at which the running total
 *  crosses this. "These few line items are most of your bill." */
const PARETO = 0.8;

/** Share of the bill, for a row that is worth a percentage at all. */
const pct = (n: number, total: number) => (total > 0 ? (100 * n) / total : 0);

/**
 * The one or two things worth doing about this window.
 *
 * Deliberately derived from the data rather than written as static advice: the
 * largest deletable line is different on a machine drowning in tool output than
 * on one carrying a huge MCP surface, and telling both the same thing would
 * make the section decoration.
 */
function advice(a: Attribution): string[] {
  const out: string[] = [];
  const find = (name: string) => a.items.find((i) => i.key === name);
  const readIn = find("Tools · content read in");
  const shell = find("Shell commands");
  const preamble = find("System prompt & tool schemas");
  const typing = find("My typing");

  const intake = (readIn?.tokens ?? 0) + (shell?.tokens ?? 0);
  if (intake > 0 && typing?.tokens) {
    out.push(
      `Cut the intake, not the output. ${fmtTokens(intake)} tokens came in through tools and shell — ${Math.round(
        intake / typing.tokens,
      )}× everything you typed. Tool output lands in the prefix whole and is re-billed until it falls out, so ask for narrower slices.`,
    );
  }
  if (preamble && a.requests > 0) {
    out.push(
      `Trim the preamble. ${fmtTokens(preamble.tokens)} tokens of fixed overhead — ${fmtTokens(
        a.preamblePerRequest,
      )} on every one of ${fmtCount(a.requests)} requests. It is the only line you can delete once and stop paying for.`,
    );
  }
  if (a.carryMultiplier && a.carryMultiplier > 1.5) {
    out.push(
      `Compact sooner. The model's own output was re-billed ${a.carryMultiplier.toFixed(
        1,
      )}× over as input. Carry cost is linear in how long a result survives, not in how big it looked.`,
    );
  }
  return out;
}

/**
 * The mosaic — every line item and every row of it, in one picture.
 *
 * A Marimekko: COLUMN WIDTH is the item's share of the bill, BLOCK HEIGHT is a
 * row's share of that column. Two levels at once, which a stacked bar can't do
 * — a bar shows that Shell is 15% but not that `rtk` is most of it.
 *
 * No SVG: both axes are proportions, so `flex` on nested views IS the layout,
 * which also means it reflows correctly on every platform for free.
 *
 * Columns are sorted largest-first, so the footer's running total doubles as a
 * Pareto reading: the marked column is where the bill is mostly accounted for.
 */
function Mosaic({
  items,
  total,
  onPick,
  picked,
  baseHue,
}: {
  items: AttributionNode[];
  total: number;
  onPick: (item: string) => void;
  picked: string | null;
  /** Set once the chart is zoomed in: the colour of the ancestor we drilled
   *  through. Columns then ramp within THAT family instead of each looking up
   *  a name the palette has never heard of — which turned every column grey the
   *  moment you drilled past the top level. */
  baseHue: string | null;
}) {
  const [width, setWidth] = useState(0);
  // The chart may be wider than the viewport so that narrow columns stay
  // legible; every column grows by the same factor, so proportions hold.
  const chartWidth = Math.max(width, items.length * MIN_COL_WIDTH);
  let running = 0;
  const columns = items.map((item, idx) => {
    running += item.tokens;
    const share = item.tokens / total;
    const colWidth = chartWidth * share;
    // A column with no breakdown is still one block — the item itself.
    const rows = item.children.length ? item.children : [{ key: item.key, tokens: item.tokens }];
    return { item, idx, share, colWidth, rows, cumulative: running / total };
  });
  // Read off the running total the columns already carry, rather than walking
  // `items` a second time with a side-effecting predicate.
  const paretoAt = columns.findIndex((c) => c.cumulative >= PARETO);

  const body = (
    <View style={{ width: chartWidth || "100%" }}>
      <View style={[s.mosaicRow, { height: CHART_HEIGHT }]}>
        {columns.map(({ item, idx, share, colWidth, rows }) => {
          // Zoomed in, columns are steps within the ancestor's family; at the
          // root each item owns its hue.
          const base = baseHue ? shade(baseHue, -0.12 + idx * 0.1) : hueOf(item.key);
          const dim = picked !== null && picked !== item.key;
          return (
            <Pressable
              key={item.key}
              onPress={() => onPick(item.key)}
              accessibilityRole="button"
              accessibilityLabel={`${item.key}, ${(100 * share).toFixed(0)} percent of the window`}
              // Without this the block labels (RCTText) swallow the click on
              // macOS and the column reads as dead — the trap ToolAccordion and
              // RunSummary already hit.
              pointerEvents="box-only"
              style={{ flexGrow: share, flexShrink: 1, flexBasis: 0, opacity: dim ? 0.4 : 1 }}
            >
              {rows.map((r, i) => {
                const fill = shade(base, Math.min(0.52, i * 0.115));
                const h = CHART_HEIGHT * (r.tokens / item.tokens);
                const room = h >= LABEL_MIN_H && colWidth >= LABEL_MIN_W;
                return (
                  <View
                    key={r.key}
                    style={[s.block, { flexGrow: r.tokens, backgroundColor: fill }]}
                  >
                    {room ? (
                      <Text
                        style={[s.blockLabel, { color: alpha(readableOn(fill), 0.94) }]}
                        numberOfLines={1}
                      >
                        {r.key}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </Pressable>
          );
        })}
      </View>

      {/* The footer is the legend. It carries the running total as well as the
          share, because "what accounts for most of this" is the question the
          ranking invites and a per-column percentage alone can't answer. */}
      <View style={s.mosaicRow}>
        {columns.map(({ item, idx, share, colWidth, cumulative }) => (
          <View key={item.key} style={[s.foot, { flexGrow: share, flexShrink: 1, flexBasis: 0 }]}>
            {/* A sliver of a column gets NO footer at all. Rendering one anyway
                wrapped "2.6M" and "1.8%" to one character per line, which reads
                as a column of debris rather than a number — and the row is
                listed in full in the breakdown below regardless. */}
            {colWidth >= LABEL_MIN_W ? (
              <>
                <Text style={s.footName} numberOfLines={2}>
                  {item.key}
                </Text>
                <Text style={s.footValue}>{fmtTokens(item.tokens)}</Text>
                <View style={s.footPcts}>
                  <Text style={s.footShare}>{(100 * share).toFixed(1)}%</Text>
                  <Text style={[s.footCum, idx === paretoAt && s.footCumMark]}>
                    {idx === paretoAt ? "◂" : ""}
                    {Math.round(100 * cumulative)}%
                  </Text>
                </View>
              </>
            ) : (
              <View style={[s.footTick, { backgroundColor: baseHue ?? hueOf(item.key) }]} />
            )}
          </View>
        ))}
      </View>
    </View>
  );

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {chartWidth > width && width > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </View>
  );
}

/**
 * The opening message for a "Dive deep" thread.
 *
 * The JSON is embedded rather than referenced by path so the thread works
 * wherever it is started — no cwd to get right, no file that might have been
 * moved. At ~14KB it costs roughly 4k tokens, which against a report measuring
 * billions is not worth a round trip to avoid.
 *
 * The framing matters more than the data: an agent handed a bare blob will
 * confidently over-read it, so the prompt states up front which numbers are
 * exact, which one is apportioned, and what the residual actually contains.
 */
function divePrompt(a: Attribution, json: string): string {
  const range = a.windowIsBlock
    ? `Claude's current ${a.windowHours}h rolling window`
    : `a trailing ${a.windowHours}h window`;
  return `Here is a token-attribution report for my Claude Code usage on this machine, covering ${range}. I'd like to understand where my tokens go and where the savings are.

How to read it:
- Every number is TOKENS, not dollars.
- \`items\` is a tree: line item → row → detail. Children sum to their parent.
- Totals are exact, read from each request's own usage record. The SPLIT across line items is apportioned — Claude reports one token count per request for the whole prefix, never per tool — so treat shares as good estimates and totals as facts.
- \`carryMultiplier\` is the important one: every request re-bills the whole context, so a thing that enters context early is paid for on every later request. ${a.carryMultiplier ? `Here it is ${a.carryMultiplier.toFixed(2)}×.` : ""}
- "System prompt & tool schemas" is a RESIDUAL, not a reading: it is everything billed in the prefix that the transcript doesn't record — system prompt, tool schemas, CLAUDE.md, memory, the skills listing. It is charged on every request (${fmtTokens(a.preamblePerRequest)} each here), so it is the one line that can be cut once and stop costing forever.
- \`coverage\` says how much was actually read; \`earliestAt\` is the oldest turn found, which may be far newer than the range requested.

Please start by telling me the three changes that would save the most, in order, with the numbers behind each. Then I'll ask follow-ups.

\`\`\`json
${json}
\`\`\``;
}

/** One line item, expandable to its rows. */
function ItemRow({
  item,
  total,
  open,
  onToggle,
}: {
  item: AttributionNode;
  total: number;
  open: boolean;
  onToggle: () => void;
}) {
  const share = pct(item.tokens, total);
  const hue = hueOf(item.key);
  const expandable = item.children.length > 0;
  const body = (
    <>
      <View style={s.rowHead}>
        <View style={[s.swatch, { backgroundColor: hue }]} />
        <Text style={s.rowLabel} numberOfLines={1}>
          {item.key}
        </Text>
        <Text style={s.rowPct}>{share.toFixed(1)}%</Text>
        <Text style={s.rowValue}>{fmtTokens(item.tokens)}</Text>
      </View>
      <View style={s.rowTrack}>
        <View style={[s.rowFill, { width: `${Math.max(1, share)}%`, backgroundColor: hue }]} />
      </View>
      {/* Per-request is the number that makes a fixed cost legible: a total is
          a consequence of how long you worked, this is a property of the setup. */}
      <Text style={s.rowSub}>
        {fmtTokens(item.perRequest)} per request
        {expandable ? ` · ${item.children.length} row${item.children.length === 1 ? "" : "s"}` : ""}
      </Text>
      {open
        ? item.children.map((c) => (
            <View key={c.key} style={s.child}>
              <Text style={s.childLabel} numberOfLines={1}>
                {c.key}
              </Text>
              <Text style={s.childValue}>{fmtTokens(c.tokens)}</Text>
            </View>
          ))
        : null}
    </>
  );
  if (!expandable) return <View style={s.row}>{body}</View>;
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${item.key}, ${share.toFixed(0)} percent`}
      accessibilityState={{ expanded: open }}
      style={({ pressed }) => [s.row, pressed && s.pressed]}
    >
      {body}
    </Pressable>
  );
}

export default function AttributionScreen() {
  // `key` is the pane-identity param desktop's `screenKey` remounts on, so the
  // host is carried in it rather than a name of our own.
  const params = useLocalSearchParams<{ key?: string }>();
  const hostId = params.key ?? "";
  const [win, setWin] = useState<WindowId>("block");
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  /** Only failure is worth saying: on success the OS save panel already told
   *  them where the file went, so repeating the path is noise. */
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Which node the chart is zoomed into, as keys from the root. Empty is the
   *  whole window. Held here rather than in the route so that going deeper
   *  doesn't push a tab per level on desktop. */
  const [path, setPath] = useState<string[]>([]);

  /**
   * How far the host has got through the window's transcripts.
   *
   * Reading a window is a walk of every transcript it touched, which on a busy
   * machine is minutes. This used to be one silent request with a 30s abort, so
   * a working machine mid-scan was reported as one that "didn't answer in
   * time". The read streams now and this is what it says while it fills — kept
   * out of the query so a progress frame doesn't re-render the finished tree.
   */
  const [progress, setProgress] = useState<{ scanned: number; total: number } | null>(null);

  const q = useQuery({
    queryKey: ["attribution", hostId, win],
    queryFn: async () => {
      setProgress(null);
      try {
        return await streamAttribution(hostId, win, setProgress);
      } finally {
        // Whatever happened, the scan is over — a stale bar under a rendered
        // report reads as one still running.
        setProgress(null);
      }
    },
    enabled: !!hostId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const a = q.data ?? null;
  const tips = useMemo(() => (a ? advice(a) : []), [a]);

  /** Walk `path` into the tree. Falls back to the root if a key no longer
   *  exists — switching window can drop a row out from under the zoom. */
  const view = useMemo(() => {
    let nodes = a?.items ?? [];
    let tokens = a?.total ?? 0;
    const reached: string[] = [];
    for (const key of path) {
      const hit = nodes.find((n) => n.key === key);
      if (!hit || !hit.children.length) break;
      nodes = hit.children;
      tokens = hit.tokens;
      reached.push(key);
    }
    return { nodes, tokens, reached };
  }, [a, path]);

  return (
    <ScrollView
      style={s.root}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[s.content, s.contentPad]}
    >
      <View style={s.header}>
        <View style={s.shrink}>
          {IS_DESKTOP ? <Text style={s.title}>What filled the window</Text> : null}
          <View style={s.agentRow}>
            <AgentLogo agent="claude" size={13} />
            <Text style={s.subtitle}>
              {a
                ? `${fmtCount(a.requests)} requests · ${a.scannedSessions} session${
                    a.scannedSessions === 1 ? "" : "s"
                  }`
                : "Claude"}
            </Text>
          </View>
        </View>
        {/* The report can only ever say the same few things about itself.
              Anything past that is a conversation, and the machine it describes
              already has an agent on it — so the handover sits with the title
              rather than at the far end of a long scroll. */}
        {a ? (
          <View style={s.actions}>
            <Pressable
              onPress={() => {
                const draft = newDraft({
                  hostId,
                  agent: "claude",
                  text: divePrompt(a, JSON.stringify(a, null, 2)),
                });
                router.push({ pathname: "/new", params: { draft: draft.id } });
              }}
              accessibilityRole="button"
              accessibilityLabel="Open a new Claude thread with this report attached"
              style={({ pressed }) => [s.actionPrimary, pressed && s.pressed]}
            >
              <Text style={s.actionPrimaryLabel}>Dive deep</Text>
            </Pressable>
            <Pressable
              disabled={saving}
              onPress={async () => {
                setSaving(true);
                setFailed(false);
                try {
                  // null = the panel was dismissed, which needs no report.
                  await exportAttribution(hostId, win);
                } catch {
                  setFailed(true);
                } finally {
                  setSaving(false);
                }
              }}
              accessibilityRole="button"
              style={({ pressed }) => [s.action, (pressed || saving) && s.pressed]}
            >
              <Text style={s.actionLabel}>{saving ? "Saving…" : "Download JSON"}</Text>
            </Pressable>
            {failed ? (
              <Text style={s.actionNote} numberOfLines={1}>
                Couldn&apos;t save
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      <View style={s.windows}>
        {WINDOWS.map((w) => (
          <Pressable
            key={String(w.id)}
            onPress={() => {
              setWin(w.id);
              setPath([]);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: win === w.id }}
            style={({ pressed }) => [s.window, win === w.id && s.windowOn, pressed && s.pressed]}
          >
            <Text style={[s.windowLabel, win === w.id && s.windowLabelOn]}>{w.label}</Text>
          </Pressable>
        ))}
      </View>

      {q.isPending ? (
        <>
          {/* Say what it is doing and how far it has got. A scan that takes a
              minute is fine; a minute of nothing is what made a working machine
              look broken. */}
          {progress ? (
            <Text style={s.progressLabel}>
              {`Reading this window — ${progress.scanned} of ${progress.total} session${
                progress.total === 1 ? "" : "s"
              }`}
            </Text>
          ) : null}
          <ActivitySkeleton />
        </>
      ) : q.error instanceof RouteMissingError ? (
        // The machine answered instantly and said it has no such route: its
        // Pounce predates this report. That is not a timeout, and it used to be
        // described as one — under a "Try again" that could never work, because
        // no amount of retrying adds a route to a running bridge. The quota
        // card that links here keeps working throughout, which is what makes
        // the page look reachable and then fail.
        <View style={s.errorBox}>
          <Text style={s.errorTitle}>That machine&apos;s bridge is too old</Text>
          <Text style={s.errorBody}>
            It answered, and it has no token report — so it&apos;s running an older Pounce than this
            one. Updating the app is often not enough: if a bridge was already running on its port,
            the new app attaches to that one instead of starting its own. Restart the bridge on that
            machine and this page will fill in.
          </Text>
        </View>
      ) : q.isError ? (
        <View style={s.errorBox}>
          <Text style={s.errorTitle}>Couldn&apos;t read this window</Text>
          <Text style={s.errorBody}>
            The machine stopped answering partway through. Reading a window means walking every
            transcript it touched, so this can take a moment on a busy day.
          </Text>
          <Pressable
            onPress={() => void q.refetch()}
            style={({ pressed }) => [s.retryBtn, pressed && s.pressed]}
          >
            <Text style={s.retryLabel}>Try again</Text>
          </Pressable>
        </View>
      ) : !a || !a.items.length ? (
        // Nothing ran, which is a real answer and not a failure — say it plainly
        // rather than rendering an empty chart that looks broken.
        <View style={s.empty}>
          <Text style={s.emptyTitle}>Nothing in this window</Text>
          <Text style={s.emptyBody}>No Claude turns on this machine in this range.</Text>
        </View>
      ) : (
        <>
          <View style={s.hero}>
            <Text style={s.heroValue}>{fmtTokens(a.total)}</Text>
            <Text style={s.heroMeta}>
              tokens billed · {fmtTokens(a.billedInput)} in, {fmtTokens(a.billedOutput)} out
            </Text>
            {/* Name the range rather than implying one. The card's window and a
                trailing window are different sets of requests, and a reader
                comparing the two numbers deserves to know which this is. */}
            <Text style={s.heroRange}>
              {a.windowIsBlock
                ? `Claude's current ${a.windowHours}h window · opened ${sinceLabel(a.windowStartedAt)}`
                : a.earliestAt
                  ? `Oldest turn found: ${sinceLabel(a.earliestAt)}${
                      spansLessThanAsked(a) ? " — Claude keeps no more than this" : ""
                    }`
                  : `Trailing window · since ${sinceLabel(a.windowStartedAt)}`}
            </Text>
          </View>

          {/* The finding, not a statistic: output written once and paid for many
              times is the thing a reader can act on. */}
          {a.carryMultiplier ? (
            <View style={s.callout}>
              <Text style={s.calloutValue}>×{a.carryMultiplier.toFixed(2)}</Text>
              <Text style={s.calloutBody}>
                A carry bill, not a usage bill. Every request re-bills the whole context, so the
                model&apos;s own output was paid for {a.carryMultiplier.toFixed(1)}× over.
              </Text>
            </View>
          ) : null}

          {/* Composition before detail: the shape of the window reads at a
              glance, and the list below is the evidence for it. */}
          <View style={s.section}>
            <View style={s.chartHead}>
              <Text style={s.sectionTitle}>
                Column width = share · block height = share of column
              </Text>
              {/* The breadcrumb IS the zoom control. Every crumb goes back to
                  that level, so there is no separate "up" affordance to find. */}
              <View style={s.crumbs}>
                <Pressable onPress={() => setPath([])} accessibilityRole="button">
                  <Text style={[s.crumb, !view.reached.length && s.crumbOn]}>all</Text>
                </Pressable>
                {/* `reached` rather than `path`: a zoom whose row no longer
                    exists (switching window can drop one) resolves to the
                    deepest prefix that does, so the trail always matches the
                    chart without writing state back during render. */}
                {view.reached.map((key, i) => (
                  <Pressable
                    key={key}
                    onPress={() => setPath(view.reached.slice(0, i + 1))}
                    accessibilityRole="button"
                  >
                    <Text
                      style={[s.crumb, i === view.reached.length - 1 && s.crumbOn]}
                      numberOfLines={1}
                    >
                      {" / "}
                      {key}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <Mosaic
              items={view.nodes}
              total={view.tokens}
              picked={open}
              // Identity follows the TOP-LEVEL ancestor, so a drill-down still
              // reads as part of the line item it came from.
              baseHue={view.reached.length ? hueOf(view.reached[0]) : null}
              // A column with something under it ZOOMS; a leaf can only be
              // highlighted, so it selects its row in the breakdown instead.
              onPick={(key) => {
                const hit = view.nodes.find((n) => n.key === key);
                if (hit?.children.length) {
                  setPath([...view.reached, key]);
                  setOpen(null);
                } else setOpen(open === key ? null : key);
              }}
            />
          </View>

          <View style={s.section}>
            <Text style={s.sectionTitle}>Breakdown</Text>
            {/* Follows the chart. A list still showing the whole window under a
                zoomed chart is two answers to one question. */}
            {view.nodes.map((i) => (
              <ItemRow
                key={i.key}
                item={i}
                total={view.tokens}
                open={open === i.key}
                onToggle={() => setOpen(open === i.key ? null : i.key)}
              />
            ))}
          </View>

          {tips.length ? (
            <View style={s.section}>
              <Text style={s.sectionTitle}>What to change</Text>
              {tips.map((t) => (
                <Text key={t.slice(0, 24)} style={s.tip}>
                  {t}
                </Text>
              ))}
            </View>
          ) : null}

          {/* Always rendered. A page whose split is apportioned has to say so
              where the numbers are, not behind a tap. */}
          <View style={s.section}>
            <Text style={s.sectionTitle}>What these numbers can and can&apos;t say</Text>
            <Text style={s.caveat}>
              Totals are exact. The split across line items is apportioned — Claude records one
              token count per request for the whole prefix, never per tool, so how it divides is
              derived rather than read.
            </Text>
            <Text style={s.caveat}>
              {a.preambleFittedShare >= 1
                ? "The preamble was solved for from this machine's own requests, not assumed from a fixed ratio."
                : `${Math.round(
                    100 * (1 - a.preambleFittedShare),
                  )}% of the preamble figure is estimated — those sessions were too short to solve.`}{" "}
              It also absorbs anything billed in the prefix that the transcript doesn&apos;t record,
              which includes tool schemas and injected context as well as the system prompt.
            </Text>
            <Text style={s.caveat}>
              Cache writes are read from the transcript at the TTL Claude recorded —{" "}
              {fmtTokens(a.cacheWrite1h)} at 1h, {fmtTokens(a.cacheWrite5m)} at 5m — not repriced by
              us.
            </Text>
            <Text style={s.caveat}>
              Only this machine, and only what its transcripts still hold — Claude prunes them, so
              there is no history here older than about a month.{" "}
              {a.coverage.truncated > 0
                ? `${a.coverage.truncated} of ${a.coverage.files} transcripts were too large to read in full for this range, so their oldest turns are missing from these totals.`
                : `All ${a.coverage.files} transcripts in range were read in full.`}
            </Text>
            {Math.abs(a.unattributed) > 0 ? (
              <Text style={s.caveat}>
                {fmtTokens(Math.abs(a.unattributed))} tokens of rounding sit outside the breakdown.
              </Text>
            ) : null}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create((theme, rt) => ({
  contentPad: { paddingTop: IS_DESKTOP ? 14 : 0, paddingBottom: rt.insets.bottom + 32 },
  root: { flex: 1, backgroundColor: theme.colors.bg },
  content: { paddingHorizontal: 16, gap: 14 },
  header: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  shrink: { flexShrink: 1 },
  title: { fontSize: 24, fontWeight: "700", color: theme.colors.fg },
  agentRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  subtitle: { fontSize: 12, color: theme.colors.fgFaint },
  pressed: { opacity: 0.7 },

  windows: { flexDirection: "row", gap: 2, alignSelf: "flex-start" },
  window: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  windowOn: { backgroundColor: theme.colors.accent },
  windowLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.fgMuted },
  windowLabelOn: { color: theme.colors.onAccent },

  hero: { gap: 2 },
  heroValue: {
    fontFamily: "JetBrainsMono",
    fontSize: 34,
    fontWeight: "700",
    color: theme.colors.accent,
  },
  heroMeta: { fontSize: 12, color: theme.colors.fgFaint },
  heroRange: { fontSize: 11, color: theme.colors.fgFaint, marginTop: 1 },

  callout: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
  calloutValue: {
    fontFamily: "JetBrainsMono",
    fontSize: 22,
    fontWeight: "700",
    color: theme.colors.accent,
  },
  calloutBody: { flex: 1, fontSize: 12.5, lineHeight: 17, color: theme.colors.fgMuted },

  // --- mosaic ---
  chartHead: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  crumbs: { flexDirection: "row", alignItems: "center", marginLeft: "auto", flexShrink: 1 },
  crumb: { fontSize: 11.5, color: theme.colors.fgFaint },
  crumbOn: { color: theme.colors.fg, fontWeight: "600" },
  mosaicRow: { flexDirection: "row", gap: 2 },
  // `overflow: hidden` matters: a label longer than its block would otherwise
  // paint over the neighbouring column and read as that column's row.
  block: { flexBasis: 0, overflow: "hidden", justifyContent: "flex-start" },
  blockLabel: { fontSize: 9.5, paddingHorizontal: 5, paddingTop: 3 },
  foot: { paddingTop: 7, paddingRight: 4, gap: 1 },
  footName: { fontSize: 10.5, fontWeight: "600", color: theme.colors.fg, lineHeight: 13 },
  footValue: { fontFamily: "JetBrainsMono", fontSize: 11, color: theme.colors.fgMuted },
  footPcts: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  footShare: { fontFamily: "JetBrainsMono", fontSize: 9.5, color: theme.colors.fgFaint },
  // The running total, and the one column where it crosses 80%.
  footCum: {
    fontFamily: "JetBrainsMono",
    fontSize: 9.5,
    marginLeft: "auto",
    color: theme.colors.fgFaint,
  },
  footCumMark: { color: theme.colors.accent, fontWeight: "700" },
  /** All a sliver column can carry: a stub of its own hue, so the eye still
   *  ties it to the block above and to its row in the breakdown. */
  footTick: { height: 3, borderRadius: 2, marginTop: 1 },

  section: { gap: 8 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },

  row: {
    gap: 5,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 12,
  },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 7 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  rowLabel: { flex: 1, fontSize: 13.5, color: theme.colors.fg },
  rowPct: { fontFamily: "JetBrainsMono", fontSize: 12, color: theme.colors.fgMuted },
  rowValue: {
    fontFamily: "JetBrainsMono",
    fontSize: 12,
    color: theme.colors.fg,
    minWidth: 54,
    textAlign: "right",
  },
  rowTrack: {
    height: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.border,
    overflow: "hidden",
  },
  rowFill: { height: 4, borderRadius: 999 },
  rowSub: { fontSize: 11, color: theme.colors.fgFaint },
  child: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    paddingLeft: 15,
    paddingTop: 4,
  },
  childLabel: { flex: 1, fontSize: 12, color: theme.colors.fgMuted },
  childValue: { fontFamily: "JetBrainsMono", fontSize: 11.5, color: theme.colors.fgMuted },

  tip: { fontSize: 13, lineHeight: 18.5, color: theme.colors.fgMuted },

  // `marginLeft: auto` is what puts these at the RIGHT edge of the header row,
  // opposite the title, instead of under it.
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    marginLeft: "auto",
    justifyContent: "flex-end",
  },
  actionPrimary: {
    borderRadius: 8,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  actionPrimaryLabel: { fontSize: 12.5, fontWeight: "600", color: theme.colors.onAccent },
  action: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  actionLabel: { fontSize: 12.5, fontWeight: "600", color: theme.colors.fg },
  actionNote: { flexShrink: 1, fontSize: 11, color: theme.colors.fgFaint },
  caveat: { fontSize: 11.5, lineHeight: 16.5, color: theme.colors.fgFaint },

  empty: { gap: 4, paddingVertical: 24 },
  emptyTitle: { fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  emptyBody: { fontSize: 12.5, color: theme.colors.fgFaint },

  errorBox: {
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 14,
  },
  progressLabel: {
    fontSize: 12.5,
    lineHeight: 17,
    color: theme.colors.fgMuted,
    paddingBottom: 10,
  },
  errorTitle: { fontSize: 15, fontWeight: "600", color: theme.colors.fg },
  errorBody: { fontSize: 12.5, lineHeight: 17, color: theme.colors.fgMuted },
  retryBtn: {
    alignSelf: "flex-start",
    borderRadius: 8,
    backgroundColor: theme.colors.accent,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  retryLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.onAccent },
}));
