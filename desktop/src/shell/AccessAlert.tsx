/**
 * "Someone is asking for access" — said loudly enough to notice, quietly enough
 * to ignore.
 *
 * The bell in the titlebar is 14 points of icon in a row of other icons. If you
 * are heads-down in a transcript you will not see it, and the bridge's system
 * notification only helps when the window is buried — the case it does NOT
 * cover is the one that matters most: the app is right in front of you, you are
 * busy in it, and a machine on the network is waiting on a human. So the
 * request comes to you.
 *
 * WHAT THIS DELIBERATELY IS NOT: a modal. Auto-opening /access would drop a
 * scrim over the window, cover the composer, and swallow the next click — an
 * interruption that answers a stranger's request by taking the keyboard away
 * from the person who owns the machine. That is a worse failure than a missed
 * notification, because it happens every single time.
 *
 * THE FOCUS RULE, which is the whole reason this file is shaped the way it is:
 * an alert may never move the first responder. Concretely —
 *
 *   - It is an ABSOLUTE overlay, so appearing does not reflow the pane under
 *     it. A layout that pushes the composer down mid-sentence is its own kind
 *     of focus theft, even when the caret technically stays put.
 *   - `pointerEvents="box-none"` on the wrapper: everything except the card
 *     itself passes clicks straight through to the app behind.
 *   - Nothing here calls focus(), renders a TextInput, or sets autoFocus. The
 *     only way this can take the keyboard is if the user aims at it and clicks.
 *
 * It stays until it is dealt with — an access request is not a toast and must
 * not time out — but "Not now" hides it and leaves the bell counting.
 */
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { denyAccess } from "@pounce/app/services/peers";
import { useRouter } from "expo-router";
import { COLOR } from "@pounce/app/ui";
import { T } from "@pounce/app/ui/theme";
import { forgetAccessRequest, useAccessRequests } from "./accessRequests";

export function AccessAlert() {
  const router = useRouter();
  const pending = useAccessRequests();
  // Dismissed by id, not by a single boolean: hiding one request must not hide
  // the next machine that asks thirty seconds later.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const request = pending.find((r) => !hidden.has(r.id)) ?? null;
  const [busy, setBusy] = useState(false);

  // Entrance only — it slides down and stays. No auto-dismiss timer: the thing
  // it describes does not go away on its own.
  // The entrance animates POSITION ONLY, and the card is fully opaque from the
  // first frame. Animating opacity from 0 makes visibility depend on the
  // animation actually running, and the first version of this did exactly that
  // and shipped a card that was mounted, laid out, and invisible: under
  // react-native-macos Fabric the native driver never drove the value, so it
  // sat at 0 forever. For a thing whose entire job is to be noticed, "fails to
  // animate" must degrade to "appears instantly", never to "does not appear".
  const slide = useRef(new Animated.Value(0)).current;
  // Keyed on the id alone, not the request object: a poll that returns an
  // equal-but-new object would otherwise replay the entrance every few seconds.
  const shownId = request?.id ?? null;
  useEffect(() => {
    if (!shownId) return;
    slide.setValue(0);
    Animated.timing(slide, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [shownId, slide]);

  if (!request) return null;

  const isPreview = request.kind === "preview";
  const existing = request.existing ?? null;
  return (
    // box-none, not "none": the card below must stay clickable while every
    // other pixel of this layer belongs to the app underneath. In `style`
    // rather than as a prop — the prop form is deprecated and warns.
    <View style={s.host}>
      <Animated.View
        style={[
          s.card,
          existing && s.cardMore,
          {
            transform: [
              { translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) },
            ],
          },
        ]}
      >
        {/* A returning machine gets its own icon and word. "wants access" from
            a name you granted yesterday reads like a duplicate, and the safe
            response to a duplicate is to ignore it — which is exactly the wrong
            response to someone widening what they can read. */}
        <View style={existing ? s.badgeMore : s.badge}>
          <Ionicons
            name={existing ? "add-circle" : "hand-left"}
            size={16}
            color={existing ? T.warning : COLOR.accent}
          />
        </View>
        <View style={s.grow}>
          <Text style={s.title} numberOfLines={1}>
            {existing
              ? `${request.requester.hostName} wants more access`
              : `${request.requester.hostName} wants ${isPreview ? "a look at what's here" : "access"}`}
          </Text>
          <Text style={s.meta} numberOfLines={1}>
            {/* Short enough to survive the card's width — the earlier "— this
                would widen it" was true and got ellipsed away, which is worse
                than not saying it: the title already implies it. */}
            {existing
              ? `Already reads ${existing.summary}`
              : "Nothing is shared until you approve it"}
          </Text>
        </View>
        {/* The verification code rides along so a glance is often the whole
            check — if it doesn't match what the other person is reading out,
            you already know the answer without opening anything. */}
        <Text selectable style={s.code}>
          {request.code.slice(0, 3)}-{request.code.slice(3)}
        </Text>
        <Pressable
          disabled={busy}
          onPress={() => {
            setBusy(true);
            void denyAccess(request.id)
              .then(() => forgetAccessRequest(request.id))
              .finally(() => setBusy(false));
          }}
          style={({ pressed }) => [s.ghostBtn, pressed && s.pressed]}
        >
          <Text style={s.ghostLabel}>Deny</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push("/access")}
          style={({ pressed }) => [s.primaryBtn, pressed && s.pressed]}
        >
          <Text style={s.primaryLabel}>Review</Text>
        </Pressable>
        <Pressable
          onPress={() => setHidden((prev) => new Set(prev).add(request.id))}
          accessibilityLabel="Not now"
          hitSlop={6}
          style={({ pressed }) => [s.close, pressed && s.pressed]}
        >
          <Ionicons name="close" size={13} color={COLOR.fgFaint} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  host: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingTop: 12,
    pointerEvents: "box-none",
    // Over the transcript and the diff dock beside it. The modal host is a
    // level up and paints later regardless, so opening /access still covers
    // this rather than fighting it.
    zIndex: 9,
  },
  grow: { flex: 1 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    // Wide enough that the sentence and the code both fit without ellipsis —
    // "MacBook-Air wants a…" is a worse alert than no alert, because the one
    // fact it has to carry is WHO. Still capped so it never spans a wide
    // window edge to edge.
    maxWidth: 760,
    minWidth: 560,
    borderRadius: 12,
    borderWidth: 1,
    // Accent-bordered rather than accent-filled: loud enough to pull the eye
    // across a busy window, not so loud it reads as an error.
    borderColor: COLOR.accent,
    // (A widening request overrides this to warning — see cardMore.)
    backgroundColor: T.bgElevated,
    paddingLeft: 12,
    paddingRight: 10,
    paddingVertical: 10,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  // Amber, not red: widening access is a normal thing to be asked and often
  // the right thing to say yes to. It needs a second look, not an alarm.
  cardMore: { borderColor: T.warning },
  badge: {
    height: 30,
    width: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: T.accentSoft,
  },
  badgeMore: {
    height: 30,
    width: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: T.warningSoft,
  },
  title: { fontSize: 13, fontWeight: "600", color: T.fg },
  meta: { marginTop: 1, fontSize: 11.5, color: T.fgMuted },
  code: { fontFamily: "JetBrainsMono", fontSize: 13, letterSpacing: 1, color: T.fgMuted },
  primaryBtn: {
    borderRadius: 999,
    backgroundColor: COLOR.accent,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  primaryLabel: { fontSize: 12.5, fontWeight: "600", color: T.onAccent },
  ghostBtn: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: T.borderStrong,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  ghostLabel: { fontSize: 12.5, color: T.fgMuted },
  close: { height: 20, width: 20, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.8 },
});
