/**
 * A real shell, docked under the transcript.
 *
 * The bridge runs the login shell and emulates it (apps/bridge/agents/term.mjs),
 * so this file paints a screen and forwards keys — it is not a terminal
 * emulator. That split is what lets the macOS app have a colour terminal at all:
 * there is no RN terminal view for this platform, and the emulator we already
 * had was sitting in the bridge.
 *
 * One shell per thread, outliving the dock: closing the panel stops watching,
 * it doesn't kill the session, so reopening lands back in the same directory
 * with the same history. The trash control is what actually ends one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { observable } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import { COLOR } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";
import {
  ATTR,
  COLOR_DEFAULT,
  type Run,
  type TermLine,
  applyFrame,
  closeTerm,
  encodeKey,
  openTerm,
  resizeTerm,
  sendTermInput,
  streamTerm,
} from "@pounce/app/services/terminal";

/**
 * Which threads have the dock open, and how tall it is.
 *
 * Per thread, because "I want a terminal here" is a property of the work, not
 * of the window — a thread you were building in should still have it when you
 * come back. Height is shared: it's a window-layout preference, and having the
 * panel change size as you switch tabs would read as a glitch.
 */
export const term$ = observable<{ open: Record<string, boolean>; height: number }>({
  open: {},
  height: 260,
});

export const isTermOpen = (id: string | null | undefined) => !!id && !!term$.open[id].get();

export function toggleTerm(id: string | null | undefined) {
  if (!id) return;
  term$.open[id].set(!term$.open[id].get());
}

const MIN_H = 120;
const MAX_H = 900;

/** Monospace metrics. The grid size we ask the shell for is derived from these
 *  and the measured panel, so a resize reflows the real shell rather than just
 *  clipping it. */
const FONT_SIZE = 12;
const LINE_H = 17;
/** Advance width of one character in JetBrainsMono at FONT_SIZE. Measured, not
 *  computed: the ratio differs per face and getting it wrong makes the shell's
 *  idea of the width disagree with what's drawn, which wraps lines early. */
const CHAR_W = FONT_SIZE * 0.6;

/**
 * The 16 base ANSI colours, in the app's own palette rather than the raw
 * xterm defaults — those were picked for a white CRT and read as neon here.
 * Indices 16–255 fall through to the xterm cube, which is computed.
 */
const BASE16 = [
  "#3b3b46", // black (lifted, or a "black" glyph is invisible on this ground)
  "#f85149",
  "#3fb950",
  "#d29922",
  "#58a6ff",
  "#bc8cff",
  "#39c5cf",
  "#b1bac4",
  "#6e7681",
  "#ff7b72",
  "#56d364",
  "#e3b341",
  "#79c0ff",
  "#d2a8ff",
  "#56d4dd",
  "#f0f6fc",
];

/** xterm's 6x6x6 colour cube and greyscale ramp, for indices 16–255. */
function cubeColor(i: number): string {
  if (i < 16) return BASE16[i];
  if (i < 232) {
    const n = i - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(n / 36) % 6];
    const g = steps[Math.floor(n / 6) % 6];
    const b = steps[n % 6];
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (i - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

const PALETTE = Array.from({ length: 256 }, (_, i) => cubeColor(i));

/** One styled span. `inverse` swaps fg/bg, which is how a TUI draws its
 *  selection bar and how the shell shows a highlighted completion. */
function Span({ run }: { run: Run }) {
  const [text, fg, bg, flags] = run;
  const inverse = (flags & ATTR.inverse) !== 0;
  let color = fg === COLOR_DEFAULT ? T.fg : PALETTE[fg];
  let background = bg === COLOR_DEFAULT ? undefined : PALETTE[bg];
  if (inverse) {
    const f = color;
    color = (background ?? String(T.bg)) as string;
    background = f as string;
  }
  return (
    <Text
      style={[
        s.cell,
        { color },
        background ? { backgroundColor: background } : null,
        flags & ATTR.bold ? s.bold : null,
        flags & ATTR.dim ? s.dim : null,
        flags & ATTR.italic ? s.italic : null,
        flags & ATTR.underline ? s.underline : null,
        flags & ATTR.strike ? s.strike : null,
      ]}
    >
      {text}
    </Text>
  );
}

export function TerminalDock({
  threadId,
  hostId,
  cwd,
}: {
  threadId: string;
  hostId: string;
  cwd: string | null;
}) {
  const height = useSelector(() => term$.height.get());
  const [lines, setLines] = useState<TermLine[]>([]);
  const [dead, setDead] = useState(false);
  const [size, setSize] = useState({ cols: 0, rows: 0 });
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const dragStart = useRef(0);
  // The grid the shell has actually been told about. A ref, not state: the
  // resize effect reads it to decide whether anything changed, and putting it
  // in state would make that effect depend on its own output.
  const sent = useRef({ cols: 0, rows: 0 });

  // Open once per (thread, host), then watch. The open call is idempotent on
  // the bridge, so remounting the dock re-attaches rather than restarting.
  useEffect(() => {
    let stop: (() => void) | null = null;
    let live = true;
    setLines([]);
    setDead(false);
    void openTerm(hostId, threadId, {
      cwd,
      cols: sent.current.cols || 100,
      rows: sent.current.rows || 24,
    }).then((ok) => {
      if (!live || !ok) return;
      stop = streamTerm(hostId, threadId, (frame) => {
        if (frame.exited) return setDead(true);
        setLines((prev) => applyFrame(prev, frame));
      });
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [hostId, threadId, cwd]);

  // Tell the shell the real grid whenever the panel's size changes. Without
  // this it keeps the 100x24 it was born with and every full-screen program
  // draws into the wrong box.
  useEffect(() => {
    if (!size.cols || !size.rows) return;
    if (size.cols === sent.current.cols && size.rows === sent.current.rows) return;
    sent.current = size;
    void resizeTerm(hostId, threadId, size.cols, size.rows);
  }, [size, hostId, threadId]);

  const send = useCallback(
    (data: string) => void sendTermInput(hostId, threadId, data),
    [hostId, threadId],
  );

  const onLayout = useCallback((e: { nativeEvent: { layout: { width: number; height: number } } }) => {
    const { width, height: h } = e.nativeEvent.layout;
    setSize({
      cols: Math.max(20, Math.floor((width - 16) / CHAR_W)),
      rows: Math.max(5, Math.floor((h - 8) / LINE_H)),
    });
  }, []);

  const body = useMemo(
    () =>
      lines.map((line) => (
        <Text key={line.y} numberOfLines={1} style={s.line}>
          {line.runs.length ? (
            line.runs.map((run, i) => <Span key={i} run={run} />)
          ) : (
            // A hair space, not "": an empty <Text> collapses to zero height
            // and the blank line vanishes, shifting everything below it up.
            <Text style={s.cell}> </Text>
          )}
        </Text>
      )),
    [lines],
  );

  return (
    <View style={[s.root, { height }]}>
      {/* Drag the top edge to resize. Same gesture as the sidebar splitter. */}
      <View
        style={s.grip}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={() => {
          dragStart.current = term$.height.get();
        }}
        onResponderMove={(e) => {
          // Dragging UP grows the panel, so the delta is inverted.
          const next = dragStart.current - e.nativeEvent.pageY + (e.nativeEvent.locationY ?? 0);
          term$.height.set(Math.min(MAX_H, Math.max(MIN_H, next)));
        }}
      />
      <View style={s.head}>
        <Ionicons name="terminal-outline" size={12} color={COLOR.fgMuted} />
        <Text numberOfLines={1} style={s.headLabel}>
          {cwd ? cwd.replace(/^.*\//, "") : "shell"}
          {dead ? " · exited" : ""}
        </Text>
        <Text style={s.headSize}>
          {size.cols}×{size.rows}
        </Text>
        {/* Ends the shell for real, unlike closing the panel. */}
        <Pressable
          onPress={() => {
            void closeTerm(hostId, threadId).then(() => {
              setLines([]);
              setDead(true);
            });
          }}
          accessibilityLabel="Kill terminal"
          style={({ pressed }) => [s.headBtn, pressed && s.hover]}
        >
          <Ionicons name="trash-outline" size={12} color={COLOR.fgFaint} />
        </Pressable>
        <Pressable
          onPress={() => toggleTerm(threadId)}
          accessibilityLabel="Hide terminal"
          style={({ pressed }) => [s.headBtn, pressed && s.hover]}
        >
          <Ionicons name="chevron-down" size={12} color={COLOR.fgFaint} />
        </Pressable>
      </View>

      {/* Clicking anywhere in the screen focuses the (invisible) key sink, so
          the panel behaves like a terminal rather than like a text view that
          happens to be on screen. */}
      <Pressable style={s.flex1} onPress={() => inputRef.current?.focus()}>
        <ScrollView
          ref={scrollRef}
          style={s.flex1}
          contentContainerStyle={s.screen}
          onLayout={onLayout}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        >
          {body}
        </ScrollView>
      </Pressable>

      {/* The key sink. Printable text, IME and paste all arrive through
          onChangeText, which is why the value is cleared on every change —
          the field is a funnel, not a buffer. Everything else is a key event. */}
      <TextInput
        ref={inputRef}
        value=""
        multiline
        onChangeText={(t) => {
          if (t) send(t);
        }}
        editable={!dead}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={s.sink}
        {...({
          enableFocusRing: false,
          keyDownEvents: KEY_DOWN_EVENTS,
          onKeyDown: (e: {
            nativeEvent?: {
              key?: string;
              ctrlKey?: boolean;
              altKey?: boolean;
              shiftKey?: boolean;
              metaKey?: boolean;
            };
          }) => {
            const n = e?.nativeEvent;
            if (!n?.key || n.metaKey) return; // ⌘ stays with the app (copy, quit)
            const bytes = encodeKey(
              n.key,
              { ctrl: n.ctrlKey, alt: n.altKey, shift: n.shiftKey },
              false,
            );
            if (bytes) send(bytes);
          },
        } as Record<string, unknown>)}
      />
    </View>
  );
}

const NO_MODS = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

/**
 * Every key the text view must NOT handle itself.
 *
 * A terminal needs the raw press, not the text view's interpretation of it:
 * left-arrow should move the SHELL's cursor, not the field's, and Ctrl-C must
 * reach the program rather than being swallowed. Listing a key here suppresses
 * the native handling and routes it to onKeyDown.
 *
 * Modifiers are spelled out on every entry for the reason documented in
 * enrichedInput.desktop.tsx: under Fabric an omitted modifier means "don't
 * care", so a bare `{key: "Tab"}` would also capture Shift-Tab and Alt-Tab.
 */
const NAV_KEYS = [
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

const KEY_DOWN_EVENTS = [
  ...NAV_KEYS.map((key) => ({ key, ...NO_MODS })),
  // Shift-Tab is a distinct sequence (back-tab), so it needs its own entry
  // rather than riding on the bare Tab above.
  { key: "Tab", ...NO_MODS, shiftKey: true },
  // Ctrl-<letter>: the C0 controls. ^C, ^D, ^Z, ^R, ^L are the difference
  // between a terminal and a command box.
  ...LETTERS.map((key) => ({ key, ...NO_MODS, ctrlKey: true })),
];

const s = StyleSheet.create({
  root: {
    borderTopWidth: 1,
    borderTopColor: T.border,
    backgroundColor: T.bg,
  },
  // Sits above the header and overhangs the border, so the hit area is a
  // comfortable few pixels rather than the 1pt rule itself.
  grip: {
    position: "absolute",
    top: -3,
    left: 0,
    right: 0,
    height: 7,
    zIndex: 2,
  },
  flex1: { flex: 1 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: T.border,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  headLabel: { flex: 1, fontSize: 11, color: T.fgMuted },
  headSize: { fontFamily: "JetBrainsMono", fontSize: 10, color: T.fgFaint },
  headBtn: {
    height: 18,
    width: 18,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 4,
  },
  hover: { backgroundColor: T.surface },
  screen: { paddingHorizontal: 8, paddingVertical: 4 },
  line: { height: LINE_H },
  cell: {
    fontFamily: "JetBrainsMono",
    fontSize: FONT_SIZE,
    lineHeight: LINE_H,
    color: T.fg,
  },
  bold: { fontWeight: "700" },
  dim: { opacity: 0.6 },
  italic: { fontStyle: "italic" },
  underline: { textDecorationLine: "underline" },
  strike: { textDecorationLine: "line-through" },
  // Present and focusable but invisible: it exists only to receive keys. Not
  // `display: none` or zero-size, either of which makes it unfocusable.
  sink: {
    position: "absolute",
    bottom: 0,
    left: 0,
    height: 1,
    width: 1,
    opacity: 0,
    color: "transparent",
  },
});
