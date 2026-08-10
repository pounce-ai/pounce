/**
 * "Open in" — hand the open thread's project folder to a real editor.
 *
 * Desktop only, and deliberately: this launches an application on the machine
 * you're sitting at, which is a sentence that only makes sense here. The phone
 * shows nothing.
 *
 * Split across two exports because the control and its menu live in different
 * layers. The button belongs in the tab strip beside the thread's other
 * controls; the menu can't, because a popover clipped to a 28pt-tall strip has
 * nowhere to go and no way to be dismissed by clicking away from it. So the
 * button measures itself, parks its position in an observable, and the shell
 * draws the menu at those coordinates over the whole window — the same trick
 * the modal host uses.
 */
import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSelector } from "@legendapp/state/react";
import { Ionicons } from "@expo/vector-icons";
import { COLOR } from "@pounce/app/ui";
import { type EditorTarget, listEditors, openInEditor } from "@pounce/app/services/bridge";
import { useThreads } from "@pounce/app/state/db/hooks";
import { nav$ } from "../shims/router";
import { AnchoredMenu, anchorStore, useAnchorButton } from "./AnchoredMenu";

const openIn$ = anchorStore();

/** Menu width. Fixed rather than content-sized so it doesn't resize as the
 *  editor list arrives. */
const MENU_W = 190;

/** Icon per target. A glyph is faster to find than a word in a short list, and
 *  these are the shapes the apps themselves use. */
const ICON: Record<string, React.ComponentProps<typeof Ionicons>["name"]> = {
  files: "folder-outline",
};
const DEFAULT_ICON: React.ComponentProps<typeof Ionicons>["name"] = "code-slash-outline";

/** The folder a thread is actually working in. The worktree wins over the cwd:
 *  a thread on a branch worktree has its code there, and opening the main
 *  checkout instead would show the wrong files with no hint that it had. */
function folderOf(t: { worktree: string | null; cwd: string | null } | undefined) {
  return t?.worktree ?? t?.cwd ?? null;
}

/** The thread the tab strip is currently showing, if it's a thread at all. */
function useActiveThread() {
  const tabs = useSelector(() => nav$.tabs.get());
  const active = useSelector(() => nav$.active.get());
  const threads = useThreads();
  const id = tabs[active]?.params?.id;
  return id ? threads.find((t) => t.id === id) : undefined;
}

/** The tab strip's control. Renders nothing when there's no folder to open —
 *  a new thread with no cwd yet, or an archived one whose worktree is gone. */
export function OpenInButton() {
  const thread = useActiveThread();
  const { open, ref, onPress } = useAnchorButton(openIn$);

  if (!folderOf(thread)) return null;

  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        onPress={onPress}
        accessibilityLabel="Open in"
        style={({ pressed }) => [s.btn, (pressed || open) && s.hover]}
      >
        <Ionicons name="open-outline" size={13} color={open ? COLOR.accent : COLOR.fgMuted} />
        <Text style={[s.btnLabel, open && s.btnLabelOn]}>Open</Text>
        <Ionicons name="chevron-down" size={9} color={COLOR.fgFaint} />
      </Pressable>
    </View>
  );
}

/**
 * The popover, drawn by the shell over the whole window.
 *
 * The editor list is fetched when the menu opens rather than held: it's a
 * one-line read from the local bridge, and fetching on mount would ask on every
 * launch for a menu most sessions never open.
 */
export function OpenInMenu() {
  const anchor = useSelector(() => openIn$.anchor.get());
  const thread = useActiveThread();
  const [editors, setEditors] = useState<EditorTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const folder = folderOf(thread);
  const hostId = thread?.hostId;

  const close = useCallback(() => openIn$.anchor.set(null), []);

  useEffect(() => {
    if (!anchor || !hostId) return;
    let live = true;
    setEditors(null);
    setError(null);
    void listEditors(hostId).then((list) => {
      if (live) setEditors(list);
    });
    return () => {
      live = false;
    };
  }, [anchor, hostId]);

  // A tab switch while the menu is open would leave it describing a thread you
  // can no longer see. Close instead of silently retargeting.
  useEffect(() => {
    if (anchor && !folder) close();
  }, [anchor, folder, close]);

  if (!anchor || !hostId || !folder) return null;

  const pick = async (id: string) => {
    close();
    const r = await openInEditor(hostId, id, folder);
    if (!r.ok) setError(r.error ?? "couldn't open");
  };

  // Right-aligned: the control sits near the window's right edge, so a
  // left-aligned card would hang off it.
  return (
    <AnchoredMenu store={openIn$} width={MENU_W} align="right" style={s.menuBody}>
      {editors == null ? (
        <Text style={s.note}>Looking…</Text>
      ) : editors.length === 0 ? (
        <Text style={s.note}>No editor found on this machine.</Text>
      ) : (
        editors.map((e) => (
          <Pressable
            key={e.id}
            onPress={() => void pick(e.id)}
            style={({ pressed }) => [s.item, pressed && s.hover]}
          >
            <Ionicons name={ICON[e.id] ?? DEFAULT_ICON} size={13} color={COLOR.fgMuted} />
            <Text style={s.itemLabel}>{e.name}</Text>
          </Pressable>
        ))
      )}
      {/* The folder about to be opened. A thread's worktree is not always the
            path you'd guess, and this is the only place the choice is visible
            before something launches. */}
      <Text numberOfLines={1} style={s.path}>
        {folder}
      </Text>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </AnchoredMenu>
  );
}

const s = StyleSheet.create((theme) => ({
  btn: {
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 6,
    paddingHorizontal: 7,
  },
  hover: { backgroundColor: theme.colors.surface },
  btnLabel: { fontSize: 11.5, color: theme.colors.fgMuted },
  btnLabelOn: { color: theme.colors.accent },
  menuBody: { gap: 1 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  itemLabel: { fontSize: 12.5, color: theme.colors.fg },
  note: { paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, color: theme.colors.fgFaint },
  path: {
    marginTop: 3,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: 8,
    paddingTop: 5,
    fontSize: 10,
    color: theme.colors.fgFaint,
  },
  error: { paddingHorizontal: 8, paddingTop: 3, fontSize: 10.5, color: theme.colors.danger },
}));
