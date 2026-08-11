/**
 * Settings primitives — one card per section, rows inside it with no chrome of
 * their own, and anything bigger than a row living behind a chevron on its own
 * screen.
 *
 * Metrics (24pt corners, 16pt row padding, 18pt labels, 22pt icons) are the
 * whole look; change them here and every settings screen moves together. A card
 * whose body isn't rows wraps itself in `SettingsCard` for the same reason.
 */
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { PounceIcon } from "../../ui/native/Icon";
import type { IoniconName } from "../../ui/native/icon-map";
import { IS_DESKTOP } from "../../ui";

/** The page body every settings screen scrolls in. Must be the screen's ROOT on
 *  mobile: the native large title only collapses against the first child scroll
 *  view. Desktop wraps it in its own chrome instead. */
export function SettingsScroll({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      style={s.scroll}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={s.scrollPad}
    >
      {children}
    </ScrollView>
  );
}

/** Title + card. Rows go inside; a `caption` sits under the card. */
export function SettingsSection({
  title,
  caption,
  action,
  children,
}: {
  title?: string;
  caption?: string;
  /** A control on the title line — Refresh, Edit, See all. Belongs to the
   *  section rather than to any one row, which is why it sits up here. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={s.section}>
      {title || action ? (
        <View style={s.sectionHeader}>
          {title ? <Text style={s.sectionTitle}>{title}</Text> : null}
          {action ? <View style={s.sectionAction}>{action}</View> : null}
        </View>
      ) : null}
      <View style={s.card}>{children}</View>
      {caption ? <Text style={s.caption}>{caption}</Text> : null}
    </View>
  );
}

/** A card with no rows of its own — for a section whose body is custom. */
export function SettingsCard({ children }: { children: ReactNode }) {
  return <View style={s.card}>{children}</View>;
}

/** Free-standing explanatory line, aligned with section titles. */
export function SettingsCaption({ children }: { children: ReactNode }) {
  return <Text style={s.caption}>{children}</Text>;
}

/**
 * One row: icon, label, optional right-hand value, chevron.
 *
 * `href` navigates; `onPress` runs an action. A row with neither is inert
 * (a fact, not a control) and drops its chevron.
 */
export function SettingsRow({
  icon,
  leading,
  label,
  value,
  href,
  onPress,
  disabled,
  divided,
  accessory,
  destructive,
}: {
  icon?: IoniconName;
  /** Replaces the icon — swatches, an avatar, anything that isn't a glyph. */
  leading?: ReactNode;
  label: string;
  value?: string;
  href?: string;
  onPress?: () => void;
  disabled?: boolean;
  /** Hairline above — for rows in a list where each entry is its own thing. */
  divided?: boolean;
  /** Replaces the chevron: a checkmark, a spinner, a switch. */
  accessory?: ReactNode;
  destructive?: boolean;
}) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const tappable = !!href || !!onPress;

  const body = (
    <View style={[s.row, divided && s.rowDivided, disabled && s.rowDisabled]}>
      {leading ??
        (icon ? (
          <PounceIcon
            name={icon}
            size={22}
            color={destructive ? theme.colors.danger : theme.colors.fg}
          />
        ) : null)}
      <Text style={destructive ? s.labelDanger : s.label} numberOfLines={1}>
        {label}
      </Text>
      <View style={s.valueSlot}>
        {value ? (
          <Text style={s.value} numberOfLines={1} ellipsizeMode="middle">
            {value}
          </Text>
        ) : null}
      </View>
      {/* A chevron promises a screen behind it, so only a row that navigates
          gets one — an action row (Sync now) does its work in place. */}
      {accessory ??
        (href ? (
          <PounceIcon name="chevron-forward" size={16} color={theme.colors.fgFaint} />
        ) : null)}
    </View>
  );

  if (!tappable) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      // `as never`: expo-router types hrefs against the app's generated route
      // table, which this shared package can't see (and the desktop shim
      // doesn't have at all) — same cast the mobile root layout makes.
      onPress={() => (href ? router.push(href as never) : onPress?.())}
      // box-only — see RunSummary in Timeline.tsx (RCTText swallows mouse-down
      // on macOS).
      pointerEvents="box-only"
      style={({ pressed }) => pressed && s.pressed}
    >
      {body}
    </Pressable>
  );
}

/**
 * A settings screen.
 *
 * Mobile takes its title from the native navigation bar. On desktop the
 * sub-screens are modal cards, and the shell draws a modal's title and dismiss
 * control (see ModalEntry in desktop/src/shell/Shell.tsx) — so only the ROOT
 * screen, which is a pane you sit in rather than a card you dismiss, titles
 * itself here.
 */
export function SettingsPage({
  title,
  chrome = "modal",
  children,
}: {
  title: string;
  chrome?: "modal" | "pane";
  children: ReactNode;
}) {
  if (!IS_DESKTOP || chrome === "modal") return <SettingsScroll>{children}</SettingsScroll>;
  return (
    <View style={[s.desktopRoot, s.desktopRootPad]}>
      <View style={s.headerRow}>
        <Text style={s.headerTitle}>{title}</Text>
      </View>
      <SettingsScroll>{children}</SettingsScroll>
    </View>
  );
}

const s = StyleSheet.create((theme, rt) => ({
  /** Safe-area padding in the sheet — applied natively, no re-render. */
  scrollPad: {
    gap: 24,
    // contentInsetAdjustmentBehavior is iOS-only: Android's toolbar is in-flow
    // with no automatic inset, and desktop has no bar at all, so both need the
    // top padding spelled out.
    paddingTop: IS_DESKTOP ? 4 : 16,
    paddingBottom: Math.max(rt.insets.bottom, 18) + 18,
  },
  desktopRootPad: { paddingTop: rt.insets.top + 8 },
  scroll: { flex: 1, paddingHorizontal: 20, backgroundColor: theme.colors.bg },
  desktopRoot: { flex: 1, backgroundColor: theme.colors.bg },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerTitle: { fontSize: 22, fontWeight: "700", color: theme.colors.fg },
  section: { gap: 8 },
  // Baseline-ish alignment: the title sets the line, the action sits to its
  // right without stretching the row taller than the text.
  sectionHeader: { flexDirection: "row", alignItems: "flex-end", gap: 12 },
  sectionAction: { paddingHorizontal: 8 },
  sectionTitle: {
    flex: 1,
    paddingHorizontal: 8,
    fontSize: 14,
    fontWeight: "500",
    color: theme.colors.fgMuted,
  },
  caption: { paddingHorizontal: 8, fontSize: 14, lineHeight: 19, color: theme.colors.fgMuted },
  card: {
    overflow: "hidden",
    borderRadius: 24,
    // The squircle, not a circular arc — at 24pt that is the whole difference
    // between "iOS card" and "rounded rectangle".
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 16, padding: 16 },
  rowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border },
  rowDisabled: { opacity: 0.45 },
  label: { flexShrink: 0, fontSize: 18, color: theme.colors.fg },
  labelDanger: { flexShrink: 0, fontSize: 18, color: theme.colors.danger },
  /* Takes the slack so the value hugs the chevron and the label never wraps
     early — the value is the thing allowed to truncate, in the middle. */
  valueSlot: { minWidth: 0, flex: 1, alignItems: "flex-end" },
  value: { maxWidth: 180, textAlign: "right", fontSize: 16, color: theme.colors.fgMuted },
  pressed: { opacity: 0.6 },
}));
