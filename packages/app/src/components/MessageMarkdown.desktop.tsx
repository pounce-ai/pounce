/**
 * MessageMarkdown — desktop implementation.
 *
 * Renders with the SAME native md4c engine as the phones. This file used to
 * carry a hand-rolled pure-JS markdown renderer, on the belief that
 * react-native-enriched-markdown had no macOS build — it does: the package
 * declares `:osx` in its podspec and ships `ios/utils/ENRMUIKit.h`, which
 * aliases UIKit onto react-native-macos's RCTUIView for precisely this. It was
 * simply never added to desktop/package.json. The fork also silently lacked
 * tables, which is how it was found.
 *
 * What stays desktop-specific: code blocks are lifted into cards with a Run
 * affordance that asks for a second click rather than a long-press (there is no
 * long-press with a mouse), and links open in the system browser rather than an
 * in-app one.
 */
import { useMemo, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import { useGround, useThemeHex } from "../ui/useThemeHex";
import { StyleSheet } from "react-native-unistyles";
import { MD4C_FLAGS, buildAssistantStyle, buildUserStyle, scaleStyle } from "./markdownStyle";

/** Executes a command on the thread's host and resolves with its result. Mirrors
 *  the mobile fork's export so Timeline can import it from either. */
export type RunCommand = (command: string) => Promise<{ code: number; output: string } | null>;
import { Ionicons } from "@expo/vector-icons";
import { isDestructive, splitCodeBlocks } from "./runnableBlocks";
import { highlightLines, themeFor } from "./highlight";
import { usePacedText } from "./pacedText";
import { SECONDARY_SCALE, useColors } from "../ui/tokens";

/** One extra action on the native text-selection menu. Taken off the
 *  component's own props rather than imported by name — the package exports two
 *  different `ContextMenuItem`s (text vs. text-input) and the bare name
 *  resolves to the wrong one. */
export type MarkdownContextMenuItem = NonNullable<
  React.ComponentProps<typeof EnrichedMarkdownText>["contextMenuItems"]
>[number];

/** Desktop opens links in the user's browser: there is no in-app browser on a
 *  Mac, and a new window for a link is what every other desktop app does. */
function openLink(url: string): void {
  if (/^https?:\/\//i.test(url)) void Linking.openURL(url).catch(() => {});
}

export function MessageMarkdown({
  text,
  role,
  streaming,
  onRun,
  singleBlock,
  contextMenuItems,
  secondary,
}: {
  text: string;
  role: "user" | "assistant";
  streaming?: boolean;
  /** Present only for live assistant turns — enables shell "Run" cards. */
  onRun?: RunCommand;
  /** Render as one document rather than lifting code blocks into cards. */
  singleBlock?: boolean;
  /** Extra actions on the native text-selection menu, e.g. "Comment". Really
   *  wired now — the old JS renderer had no selection-menu hook and silently
   *  ignored these. */
  contextMenuItems?: MarkdownContextMenuItem[];
  /** Render as secondary material rather than a conversation turn — see
   *  SECONDARY_SCALE. */
  secondary?: boolean;
}) {
  const scale = secondary ? SECONDARY_SCALE : 1;
  // Settled assistant turns get code blocks lifted out (Run cards); streaming
  // turns render on the single path (incomplete fences would mis-split).
  const highlight = role === "assistant" && !streaming && !singleBlock;
  const segments = useMemo(() => (highlight ? splitCodeBlocks(text) : null), [highlight, text]);

  if (!highlight || !segments || (segments.length === 1 && segments[0].type === "md")) {
    return (
      <View style={s.gap2}>
        <MarkdownBody
          text={text}
          role={role}
          streaming={streaming}
          scale={scale}
          contextMenuItems={contextMenuItems}
        />
        {streaming ? <Text style={s.cursor}>▋</Text> : null}
      </View>
    );
  }
  return (
    <View style={s.blocks}>
      {segments.map((seg, i) =>
        seg.type === "code" ? (
          <CodeCard
            key={`c${i}`}
            lang={seg.lang}
            code={seg.code}
            onRun={seg.runnable ? onRun : undefined}
          />
        ) : (
          <MarkdownBody
            key={`m${i}`}
            text={seg.text}
            role="assistant"
            scale={scale}
            contextMenuItems={contextMenuItems}
          />
        ),
      )}
    </View>
  );
}

/** A lifted fenced block: mono body, language tag, optional Run affordance. */
function CodeCard({ lang, code, onRun }: { lang: string; code: string; onRun?: RunCommand }) {
  const COLOR = useColors();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ code: number; output: string } | null>(null);
  // Same bar as the phone: a command that is hard to take back needs a
  // deliberate gesture. There is no long-press with a mouse, so desktop asks
  // for a second click instead — one gesture either way, no dialog.
  const risky = useMemo(() => isDestructive(code), [code]);
  const [armed, setArmed] = useState(false);

  const run = () => {
    if (busy) return;
    setArmed(false);
    setBusy(true);
    setResult(null);
    void onRun?.(code)
      .then(setResult)
      .finally(() => setBusy(false));
  };

  return (
    <View style={s.codeCard}>
      <View style={s.codeCardHeader}>
        <Text style={s.codeLang}>{lang || "code"}</Text>
        {onRun ? (
          <Pressable
            onPress={() => {
              if (!risky || armed) return run();
              setArmed(true);
              setTimeout(() => setArmed(false), 2500);
            }}
            disabled={busy}
            style={({ pressed }) => [s.runBtn, pressed && s.pressed70]}
          >
            <Ionicons
              name={risky ? "alert-circle" : "play"}
              size={10}
              color={risky ? COLOR.warning : COLOR.success}
            />
            <Text style={[s.runLabel, risky ? { color: COLOR.warning } : null]}>
              {busy ? "Running…" : armed ? "Click to confirm" : "Run"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <HighlightedCode code={code} lang={lang} />
      {result ? (
        <View style={s.runResult}>
          <Text
            style={{
              fontSize: 10,
              fontWeight: "600",
              color: result.code === 0 ? COLOR.success : COLOR.danger,
            }}
          >
            {result.code === 0 ? "Ran · exit 0" : `Failed · exit ${result.code}`}
          </Text>
          {result.output.trim() ? <Text style={s.runOutput}>{result.output.trim()}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

/** Fenced-block body, syntax-highlighted. Rangi is pure JS, so desktop gets the
 *  same highlighting as mobile from the same module — this body used to render
 *  as flat unhighlighted text. */
function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  const light = useGround() === "light";
  const hlTheme = themeFor(light);
  const lines = useMemo(() => highlightLines(code, lang, light), [code, lang, light]);
  return (
    // The padding lives on a View, not on the Text. rn-macos doesn't apply
    // horizontal padding reliably to a multi-line Text with nested Texts inside
    // it — the declared 12pt showed up as about 4, so code sat almost flush
    // against the card's left border while the header above it (a View) indented
    // correctly. Wrapping is the fix that holds for wrapped and scrolled lines
    // alike.
    <View style={s.codeCardPad}>
      <Text selectable style={s.codeCardBody}>
        {lines.map((spans, i) => (
          <Text key={i}>
            {i > 0 ? "\n" : ""}
            {spans.map((span, j) => (
              <Text key={j} style={{ color: span.color ?? hlTheme.fg }}>
                {span.text}
              </Text>
            ))}
          </Text>
        ))}
      </Text>
    </View>
  );
}

/**
 * One message body, rendered by the same native md4c engine the phones use.
 *
 * This used to be a hand-rolled parser — a second markdown implementation that
 * only desktop ran, and which quietly lacked tables. The native package builds
 * for macOS as shipped (its `ENRMUIKit.h` aliases UIKit onto RCTUIView for
 * exactly this), so there was never a reason for the fork; it just was not
 * installed here. Styling comes from the shared builders, so a heading or an
 * inline code chip cannot drift between platforms again.
 */
function MarkdownBody({
  text,
  role,
  streaming,
  scale,
  contextMenuItems,
}: {
  text: string;
  role: "user" | "assistant";
  streaming?: boolean;
  scale: number;
  contextMenuItems?: MarkdownContextMenuItem[];
}) {
  // The APP's ground, not the platform trait — the app can be forced Dark on a
  // light Mac, and these styles pair explicit colours with the engine's own
  // light/dark defaults.
  const scheme = useGround();
  const hex = useThemeHex();
  const markdownStyle = useMemo(
    () =>
      scaleStyle(
        role === "user" ? buildUserStyle(scheme, hex) : buildAssistantStyle(scheme, hex),
        scale,
      ),
    [role, scheme, hex, scale],
  );
  // Meter the reveal a couple of words at a time rather than letting whole
  // bridge chunks land at once. `paced` returns `text` verbatim once settled.
  const paced = usePacedText(text, !!streaming);
  return (
    <EnrichedMarkdownText
      markdown={paced}
      markdownStyle={markdownStyle}
      md4cFlags={MD4C_FLAGS}
      flavor="github"
      selectable
      contextMenuItems={contextMenuItems}
      onLinkPress={({ url }) => openLink(url)}
    />
  );
}

const s = StyleSheet.create((theme) => ({
  gap2: { gap: 8 },
  // Between blocks (paragraph → paragraph, paragraph → list). Tighter than the
  // line height and the paragraphs stop being separate things.
  blocks: { gap: 12 },
  cursor: { color: theme.colors.accent },
  runResult: {
    gap: 3,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  runOutput: {
    fontFamily: "JetBrainsMono",
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.fgMuted,
  },
  codeCard: {
    overflow: "hidden",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bg,
  },
  codeCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  codeLang: {
    fontSize: 10.5,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: theme.colors.fgFaint,
  },
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 6,
    backgroundColor: theme.colors.surfaceAlt,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  runLabel: { fontSize: 11, fontWeight: "500", color: theme.colors.fg },
  codeCardPad: { paddingHorizontal: 14, paddingBottom: 10 },
  codeCardBody: {
    fontFamily: "JetBrainsMono",
    fontSize: 12.5,
    lineHeight: 18,
    color: theme.colors.fgMuted,
  },
  pressed70: { opacity: 0.7 },
  /* Same shell as a code block — a table is the other thing in a message that
     is a block of structure rather than prose, and giving it its own chrome
     would make the transcript read as three different documents. */
}));
