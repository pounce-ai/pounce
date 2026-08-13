/**
 * Add a machine over SSH.
 *
 * The manual version of this has always worked and is in the docs: ssh to the
 * box, run `npx use-pounce`, scan the QR it prints. Every step of that is
 * something the computer can do, so here it does — you give it a host, it does
 * the rest, and the machine is in your list.
 *
 * What the screen is really showing is a wait, so it shows the wait honestly:
 * the phase in words, and underneath it the session's own output, because when
 * a first run takes two minutes the difference between "stuck" and "npm is
 * downloading" is the only thing you want to know. The QR the CLI prints is
 * filtered out — scanning it is precisely the chore we came here to remove.
 *
 * SSH gets used once, to get the far side running and learn its tunnel
 * identity. After that the machine is an ordinary device dialled over iroh,
 * which is why it also turns up on your phone, where there is no SSH.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { PounceIcon } from "@pounce/app/ui/native/Icon";
import {
  SettingsCaption,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@pounce/app/components/settings/primitives";
import {
  answerSsh,
  cancelSsh,
  listSshHosts,
  saveSshDevice,
  sshStatus,
  startSsh,
  streamSsh,
  type SshFrame,
  type SshHost,
  type SshState,
} from "@pounce/app/services/ssh";
import { syncLiveDataStreaming } from "@pounce/app/services/bridge";
import { COLOR, INPUT_TWEAKS } from "@pounce/app/ui";

/** Terminal control sequences, and the block characters the CLI's QR is drawn
 *  from. Both are noise in a log rendered as text. */
// eslint-disable-next-line no-control-regex -- escape sequences are exactly what we're stripping
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;
const QR_CHARS = /[█▀▄ ]{12,}/;
const MARKER = /@@POUNCE[^@]*@@|@@END@@/g;

/** The session's output, made readable: no escape codes, no QR, no markers of
 *  our own, no runs of blank lines. */
function cleanLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(ANSI, "").replace(MARKER, "").split("\n")) {
    const line = raw.trimEnd();
    if (QR_CHARS.test(line)) continue;
    if (!line && !out.at(-1)) continue;
    out.push(line);
  }
  return out;
}

/** What we're waiting on, in words. Phases come from the remote script itself,
 *  so these stay true even if the CLI rewrites its own output. */
function phaseLabel(state: SshState): string {
  switch (state.phase) {
    case "connecting":
      return `Connecting to ${state.host}…`;
    case "starting":
      return "Starting Pounce over there…";
    case "pairing":
      return "Reading its pairing details…";
    case "prompt":
      return "Waiting for you";
    case "done":
      return "Connected";
    case "failed":
      return "Couldn't add it";
  }
}

/** known_hosts can run to hundreds of lines; a wall of them is not a
 *  suggestion. Typing narrows, so the cap only ever hides the tail. */
const MAX_SUGGESTIONS = 12;

/**
 * The detail beside a suggestion — what picking it would actually do.
 *
 * The row's value column is ~20 characters (maxWidth 180 at 16pt) and truncates
 * in the MIDDLE, so a prose list of every setting came out as "127.0.0.1 ·
 * a…port 32222" — the half that mattered elided. So: the ssh target, written
 * the way ssh writes it, and no prefix, because the bookmark glyph already says
 * this came from your config. The port is the one thing left out — the alias
 * carries it either way, and it is what you'd drop to keep the rest legible.
 */
function describeHost(h: SshHost): string {
  if (h.source !== "config") return "Previously connected";
  if (!h.hostName) return h.user ? `as ${h.user}` : "From your SSH config";
  return h.user ? `${h.user}@${h.hostName}` : h.hostName;
}

const PROMPT_TITLE: Record<string, string> = {
  "host-key": "Is this the right machine?",
  passphrase: "Unlock your SSH key",
  password: "Password",
  verification: "Verification code",
};

export default function AddMachineScreen() {
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [state, setState] = useState<SshState | null>(null);
  const [log, setLog] = useState("");
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  /** Named the moment it lands, shown on the form we return to. */
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [hosts, setHosts] = useState<SshHost[] | null>(null);
  const scroller = useRef<ScrollView>(null);
  const stopStream = useRef<(() => void) | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopWatching = useCallback(() => {
    stopStream.current?.();
    stopStream.current = null;
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
  }, []);

  // Closing the window mid-run must not leave a poll ticking against a bridge
  // nobody is listening to.
  useEffect(() => stopWatching, [stopWatching]);

  const refreshHosts = useCallback(async () => {
    // null means "haven't looked yet" and drives the spinner; an empty array is
    // a real answer and says so on screen.
    setHosts(null);
    try {
      setHosts((await listSshHosts()).hosts);
    } catch {
      setHosts([]);
    }
  }, []);

  useEffect(() => {
    void refreshHosts();
  }, [refreshHosts]);

  /** `pick` is a suggestion being used directly; otherwise the typed form. */
  const begin = useCallback(
    async (pick?: SshHost) => {
      setStartError(null);
      setLog("");
      setJustAdded(null);
      // "user@host" is how everybody writes it, so accept it in the host field
      // rather than insisting the parts go in separate boxes.
      const typed = pick ? pick.name : host;
      const [typedUser, typedHost] = typed.includes("@") ? typed.split("@") : [null, typed];
      // A config alias already carries its own user and port; what's in the
      // form wins only when the person put it there themselves.
      const chosenUser = pick ? pick.user || user : user || typedUser;
      const chosenPort = pick ? pick.port || Number(sshPort) || null : Number(sshPort) || null;
      try {
        const started = await startSsh({
          host: typedHost,
          user: chosenUser,
          sshPort: chosenPort,
        });
        setState(started);
        stopStream.current = streamSsh(started.id, (frame: SshFrame) => {
          setState(frame);
          if (frame.output) setLog((prev) => prev + frame.output);
        });
        // The stream is the fast path, not the only one: if it never connects,
        // this still lands on the outcome.
        poll.current = setInterval(async () => {
          try {
            const s = await sshStatus(started.id);
            setState(s);
            if (s.phase === "done" || s.phase === "failed") stopWatching();
          } catch {
            stopWatching();
          }
        }, 3_000);
      } catch (e) {
        setStartError(String((e as Error)?.message || e));
      }
    },
    [host, user, sshPort, stopWatching],
  );

  const send = useCallback(
    async (value: string) => {
      if (!state) return;
      setAnswer("");
      await answerSsh(state.id, value).catch(() => {});
    },
    [state],
  );

  const reset = useCallback(() => {
    stopWatching();
    if (state && state.phase !== "done") void cancelSsh(state.id).catch(() => {});
    setState(null);
    setLog("");
    setAnswer("");
    setJustAdded(null);
    setStartError(null);
  }, [state, stopWatching]);

  // Saving is a separate, explicit step. The bridge finds out how to reach the
  // machine; putting it in the list is this side's job, and doing it silently
  // would mean a machine appearing in the sidebar with no moment that said so.
  const save = useCallback(async () => {
    if (!state?.device) return;
    setSaving(true);
    try {
      const dev = await saveSshDevice(state.device);
      // Pull its threads in now, so the machine isn't an empty row until the
      // next sync tick.
      void syncLiveDataStreaming().catch(() => {});
      // Back to the list this run started from. The job is done, and a
      // finished transcript with nothing left to do on it reads as unfinished —
      // the confirmation belongs where you'd add the next machine.
      reset();
      setJustAdded(dev.name);
    } catch (e) {
      setStartError(String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  }, [state, reset]);

  const lines = cleanLines(log);
  // The transcript should use the sheet it is in. Roughly half the window,
  // floored so a short window still shows a useful amount and capped so a very
  // tall one doesn't push the prompt and the buttons below the fold.
  const { height: windowHeight } = useWindowDimensions();
  const logHeight = Math.max(190, Math.min(520, Math.round(windowHeight * 0.42)));
  const running = state !== null && state.phase !== "done" && state.phase !== "failed";
  // The host field doubles as the filter — one control, and typing narrows the
  // list rather than sitting beside it doing nothing.
  const query = host.trim().toLowerCase();
  const suggestions = (hosts ?? [])
    .filter((h) => !query || h.name.toLowerCase().includes(query))
    .slice(0, MAX_SUGGESTIONS);

  return (
    <View style={s.root}>
      <SettingsPage title="Add a machine">
        {!state ? (
          <>
            {/* The run that just finished, reported where you land rather than
                on a transcript you had to dismiss yourself. */}
            {justAdded ? (
              <View style={s.addedBanner}>
                <PounceIcon name="checkmark-circle" size={16} color={COLOR.success} />
                <Text style={s.addedText}>
                  {`${justAdded} added. Its threads are syncing, and it's on your phone too.`}
                </Text>
              </View>
            ) : null}
            <SettingsCaption>
              Any machine you can reach over SSH. Pounce connects, sets itself up there, and adds it
              — no need to go and run anything yourself.
            </SettingsCaption>
            <SettingsCard>
              <Field
                label="Host"
                value={host}
                onChange={setHost}
                placeholder="Search hosts, or type one"
                autoFocus
                onSubmit={() => begin()}
              />
              {/* Username and port share a row: they're both small, both
                  optional, and both qualify the host above them. */}
              <View style={[s.pairRow, s.rowDivided]}>
                <Field
                  label="Username"
                  value={user}
                  onChange={setUser}
                  placeholder="optional"
                  grow
                />
                <View style={s.pairDivider} />
                <Field label="Port" value={sshPort} onChange={setSshPort} placeholder="22" narrow />
              </View>
            </SettingsCard>
            {startError ? <Text style={s.error}>{startError}</Text> : null}
            <Pressable
              style={[s.primary, !host.trim() && s.primaryOff]}
              disabled={!host.trim()}
              onPress={() => begin()}
            >
              <Text style={s.primaryLabel}>Add machine</Text>
            </Pressable>

            {/* The machines this Mac already knows how to reach. Telling
                someone their ssh_config aliases work is a fact they have to act
                on; showing them the list is that fact with the work done. */}
            <SettingsSection
              title="Suggested hosts"
              action={
                <Pressable onPress={refreshHosts} style={s.refresh}>
                  <PounceIcon name="refresh" size={13} color={COLOR.accent} />
                  <Text style={s.link}>Refresh</Text>
                </Pressable>
              }
            >
              {hosts === null ? (
                <View style={s.suggestEmpty}>
                  <ActivityIndicator size="small" />
                </View>
              ) : suggestions.length ? (
                suggestions.map((h, i) => (
                  <SettingsRow
                    key={`${h.source}:${h.name}`}
                    // A config alias is a machine you named; a known_hosts entry
                    // is only somewhere you've been. Same row, different glyph —
                    // the list stays one list.
                    icon={h.source === "config" ? "bookmark-outline" : "time-outline"}
                    label={h.name}
                    value={describeHost(h)}
                    divided={i > 0}
                    onPress={() => begin(h)}
                    accessory={<Text style={s.ghostLabel}>Add</Text>}
                  />
                ))
              ) : (
                <View style={s.suggestEmpty}>
                  <Text style={s.hint}>
                    {hosts.length
                      ? `Nothing matching “${host.trim()}”.`
                      : "No hosts found in ~/.ssh. Type one above."}
                  </Text>
                </View>
              )}
            </SettingsSection>
          </>
        ) : (
          <>
            <View style={s.statusRow}>
              {running ? (
                <ActivityIndicator size="small" />
              ) : (
                <Ionicons
                  name={state.phase === "done" ? "checkmark-circle" : "alert-circle"}
                  size={20}
                  color={state.phase === "done" ? COLOR.success : COLOR.danger}
                />
              )}
              <Text style={s.statusText}>{phaseLabel(state)}</Text>
            </View>

            {state.prompt ? (
              <View style={s.promptCard}>
                <Text style={s.promptTitle}>
                  {PROMPT_TITLE[state.prompt.kind] ?? "The server is asking"}
                </Text>
                <Text style={s.promptText}>{state.prompt.text}</Text>
                {state.prompt.kind === "host-key" ? (
                  // A fingerprint is a decision, not a form field. Two buttons,
                  // and the text above them is what you're agreeing to.
                  <View style={s.promptButtons}>
                    <Pressable style={s.primary} onPress={() => send("yes")}>
                      <Text style={s.primaryLabel}>Yes, continue</Text>
                    </Pressable>
                    <Pressable style={s.ghost} onPress={() => send("no")}>
                      <Text style={s.ghostLabel}>No</Text>
                    </Pressable>
                  </View>
                ) : (
                  <TextInput
                    style={s.promptInput}
                    value={answer}
                    onChangeText={setAnswer}
                    secureTextEntry={state.prompt.secret}
                    autoFocus
                    onSubmitEditing={() => send(answer)}
                    placeholder="…and press return"
                    placeholderTextColor={COLOR.fgFaint}
                  />
                )}
              </View>
            ) : null}

            {state.phase === "done" && state.device ? (
              <View style={s.doneCard}>
                <Text style={s.doneName}>{state.device.hostName}</Text>
                <Text style={s.doneBody}>
                  Ready to add. It&apos;ll be reachable from anywhere, including your phone.
                </Text>
                <Pressable style={s.primary} disabled={saving} onPress={save}>
                  <Text style={s.primaryLabel}>{saving ? "Adding…" : "Add this machine"}</Text>
                </Pressable>
              </View>
            ) : null}

            {state.error ? <Text style={s.error}>{state.error}</Text> : null}
            {startError ? <Text style={s.error}>{startError}</Text> : null}

            {lines.length ? (
              <View style={[s.logCard, { height: logHeight }]}>
                <ScrollView
                  ref={scroller}
                  style={s.logScroll}
                  onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
                >
                  <Text style={s.logText}>{lines.join("\n")}</Text>
                </ScrollView>
              </View>
            ) : null}

            {/* The way back to the form. It used to live beside the title, but
                the shell draws that now — and a run you've finished reading is
                the only time you want it anyway. */}
            {running ? null : (
              <View style={s.startOver}>
                <Pressable onPress={reset} style={s.ghost}>
                  <Text style={s.ghostLabel}>Start over</Text>
                </Pressable>
              </View>
            )}
          </>
        )}
      </SettingsPage>
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  divided,
  narrow,
  grow,
  autoFocus,
  onSubmit,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  divided?: boolean;
  /** For the port, which is four characters and shouldn't claim half a row. */
  narrow?: boolean;
  /** Take the rest of a ROW. A field is content-sized by default because in the
   *  card's column that is what you want — `flex: 1` there stretches it
   *  vertically instead. Side by side, one of them has to claim the slack, and
   *  without this the username input collapsed to zero width: label, then
   *  nothing to type into. */
  grow?: boolean;
  autoFocus?: boolean;
  onSubmit?: () => void;
}) {
  return (
    <View style={[s.field, divided && s.rowDivided, narrow && s.fieldNarrow, grow && s.fieldGrow]}>
      <Text style={[s.fieldLabel, narrow && s.fieldLabelNarrow]}>{label}</Text>
      <TextInput
        {...INPUT_TWEAKS}
        style={s.fieldInput}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={COLOR.fgFaint}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmit}
      />
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.bg },
  link: { fontSize: 13, color: theme.colors.accent },
  startOver: { alignItems: "center", paddingTop: 4 },
  addedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.successSoft,
  },
  addedText: { flex: 1, fontSize: 12.5, lineHeight: 18, color: theme.colors.fg },

  hint: { fontSize: 11.5, color: theme.colors.fgFaint },
  error: { fontSize: 12.5, lineHeight: 18, color: theme.colors.danger },

  rowDivided: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  field: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, height: 44 },
  fieldLabel: { width: 78, fontSize: 12.5, color: theme.colors.fgMuted },
  fieldLabelNarrow: { width: "auto" },
  fieldInput: { flex: 1, fontSize: 13.5, color: theme.colors.fg },
  // Username takes the room it needs; the port is four characters and sits at
  // the end rather than claiming an equal half.
  pairRow: { flexDirection: "row", alignItems: "center" },
  pairDivider: { width: 1, height: 22, backgroundColor: theme.colors.border },
  fieldNarrow: { flex: 0, width: 118 },
  fieldGrow: { flex: 1 },

  refresh: { flexDirection: "row", alignItems: "center", gap: 4 },
  suggestEmpty: { alignItems: "center", justifyContent: "center", paddingVertical: 20 },

  statusRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  statusText: { fontSize: 13.5, fontWeight: "500", color: theme.colors.fg },

  promptCard: {
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accentSoft,
  },
  promptTitle: { fontSize: 13.5, fontWeight: "600", color: theme.colors.fg },
  promptText: { fontSize: 12, lineHeight: 17, color: theme.colors.fgMuted },
  promptButtons: { flexDirection: "row", gap: 8 },
  promptInput: {
    height: 34,
    paddingHorizontal: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    fontSize: 13.5,
    color: theme.colors.fg,
  },

  doneCard: {
    gap: 8,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.successSoft,
  },
  doneName: { fontSize: 14.5, fontWeight: "600", color: theme.colors.fg },
  doneBody: { fontSize: 12.5, lineHeight: 18, color: theme.colors.fgMuted },

  // Height is set per-render from the window (see logHeight): SettingsPage
  // scrolls, so `flex: 1` would collapse rather than fill. Bounded at both
  // ends — a transcript that grows without limit pushes the prompt off screen,
  // and one pinned to 190pt letterboxes itself in a tall window.
  logCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    overflow: "hidden",
  },
  logScroll: { flex: 1, padding: 10 },
  logText: {
    fontFamily: "Menlo",
    fontSize: 10.5,
    lineHeight: 15,
    color: theme.colors.fgMuted,
  },

  primary: {
    height: 34,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    backgroundColor: theme.colors.accent,
  },
  primaryOff: { opacity: 0.4 },
  primaryLabel: { fontSize: 13, fontWeight: "600", color: theme.colors.onAccent },
  ghost: {
    height: 34,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  ghostLabel: { fontSize: 13, fontWeight: "500", color: theme.colors.fg },
}));
