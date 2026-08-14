---
name: render-once
description: Find and fix the render-cascade performance problems in this React Native app — screens that re-render wholesale because state is owned and subscribed at the top. Use when optimizing a slow screen or interaction, when scrolling/typing/streaming feels janky, when auditing a screen for wasted renders, or when the user mentions performance, re-renders, render cascades, jank, dropped frames, or CPU usage in the app. Encodes Jay Meistrich's "Render once" architecture (App.js Conf 2026) applied to this codebase's Legend State setup.
---

# Render once

The single biggest hidden bottleneck in this app is **state architecture**, not
rendering primitives. Everything below follows from one measured fact.

## The number that justifies all of this

Jay Meistrich benchmarked the same state update applied at three depths of the
same tree (App.js Conf 2026, "How to Build the Fastest Apps: Break the Rules"):

| Update target | CPU |
| --- | --- |
| App root | 10% |
| Mid-tree (`PlaybackArea`) | 8% |
| Leaf (`ElapsedText`) | **1%** |

Same visible result. **10× less CPU** purely from moving *where* the subscription
lives. Note the shape of the curve: moving from the root to the middle of the
tree bought almost nothing (10% → 8%). Nearly all the win came from reaching the
leaf. **Half-measures do not pay.** Pushing a subscription from a screen down
into a big sub-component is not the optimization; pushing it to the smallest
component that displays the value is.

## The thesis

React ties two separate things together: **owning** state and **subscribing** to
it. `useState` does both. That forces the owner to re-render and then push the
value down through everything in between.

Break them apart:

- **Lift state _ownership_ up** (where it needs to be shared).
- **Push state _subscription_ down** to the leaf that actually displays it.

> Render the app and large coordinating screens **once**. Let leaf nodes
> re-render themselves. Let effects re-run themselves. Don't orchestrate through
> render.

"Render once" does not mean "never update". It means high-level orchestrating
components own state but never subscribe to it.

## What this repo already has

`@legendapp/state@3.0.0-beta.47` is installed and in use in both `apps/mobile`
and `desktop`. Everything needed is exported from `@legendapp/state/react`:

| Purpose | API |
| --- | --- |
| Create state without subscribing | `useObservable(initial)` |
| Global state without subscribing | `observable(initial)` (already used across `state/`) |
| Subscribe (at the leaf) | `use$(obs$)` / `useValue(obs$)` / `useSelector(obs$)` — all the same function |
| Subscribe to a *derived* value | `use$(() => a$.x.get() === id)` |
| One thread row, at the leaf | `useThreadRow(id)` (`state/db/hooks`) |
| Hold a derived value's identity still | `useStable(value)` (`state/equality`) |
| A relative timestamp that keeps itself current | `<TimeAgo iso={…} />` (`ui`) |
| Effect that re-runs on state change, no render | `useObserveEffect(() => …)` |
| Read a value without subscribing | `obs$.get()` |
| Subscribe a whole component | `observer(Component)` |
| Render a subscribed subtree inline | `<Memo>{() => …}</Memo>` |

The codebase convention is `useSelector` imported from `@legendapp/state/react`.
Keep using that name for consistency; it is the same function as `use$`.

**The gap in this repo is not the library — it is *where* it is called.**
`useSelector` is currently called at the top of large screen components, which
subscribes the entire screen. That is the thing to fix.

---

## Procedure

### 1. Find what is actually slow

Do not guess. In order of cost:

1. Name the slow **interaction**, not just the screen ("scrolling the Session
   transcript", "typing in the composer"). Renders are only expensive when they
   happen often, so an interaction that fires per-frame or per-keystroke is
   worth 100× a mount-time render.
2. Log renders. Drop a counter at the top of each suspect component:
   ```ts
   if (__DEV__) console.log("render Session", ++renderCount);
   ```
3. React DevTools → **Highlight updates**, then perform the interaction and
   watch what flashes. Anything flashing that did not visibly change is waste.
4. For a real profile, use the argent React Native profiler
   (`argent-react-native-profiler` skill) and record a flow.

### 2. Classify every offender

Walk the component and tag each hook against the table below. The anti-patterns
are ranked by how much they cost in practice.

### 3. Fix, then re-measure the same interaction

One screen at a time. Re-run the exact same interaction and compare.

---

## The anti-patterns, and what to do instead

### A1 — Lifted state that cascades (the biggest one)

The React docs tell you to lift state up. That is correct for *ownership* and
wrong for *subscription*.

```tsx
// SLOW — every keystroke re-renders ChatMessages and every message in it
function ChatScreen() {
  const [replyId, setReplyId] = useState("");
  return (
    <View>
      <ChatMessages replyId={replyId} />
      <ChatComposer replyId={replyId} />
    </View>
  );
}
```

```tsx
// FAST — replyId$ is a stable object, so ChatScreen never re-renders
function ChatScreen() {
  const replyId$ = useObservable("");
  return (
    <View>
      <ChatMessages replyId$={replyId$} />
      <ChatComposer replyId$={replyId$} />
    </View>
  );
}

function ReplyRow({ replyId$ }) {
  const replyId = useSelector(replyId$); // subscribe HERE, at the leaf
  return replyId ? <Text>Replying to {replyId}</Text> : null;
}
```

Naming convention: suffix observables with `$` so a reader can see at a glance
that a prop is a stable subscription handle rather than a value.

**React Compiler does not fix this.** Use it — but when a prop genuinely
changes, the compiler must still pass it down. Memoization cannot help when the
value is actually different.

### A2 — Subscribing to a broad value where a narrow one will do

The most valuable single fix in a list. Subscribing to the *identity* re-renders
every row; subscribing to a *derived boolean* re-renders exactly one.

```tsx
// SLOW — every message re-renders when the reply target changes
const replyId = useSelector(replyState$.replyId);
const isReplying = replyId === messageId;

// FAST — only the one matching message re-renders
const isReplying = useSelector(() => replyState$.replyId.get() === messageId);
```

Apply this anywhere a list row compares a global selection/focus/expansion value
against its own id.

### A3 — `useEffect` used to coordinate, not to render

If setting state does not change what is rendered, it should not cause a render.

```tsx
// SLOW — set state → render → effect → imperative call
const [isOpen, setIsOpen] = useState(false);
useEffect(() => {
  if (isOpen) dialogRef.current?.showModal();
}, [isOpen]);
```

```tsx
// FAST — no render at all; re-runs itself when isOpen$ changes
useObserveEffect(() => {
  if (isOpen$.get()) dialogRef.current?.showModal();
  else dialogRef.current?.close();
});
```

`useObserveEffect` automatically subscribes to every observable it reads — no
dependency array, and it never triggers a render.

The same shape covers the other two cases from the talk:

- **Pausing a query/poll**: don't `setState` to re-invoke a hook with new args;
  drive the pause flag from an observable and read it imperatively.
- **`useIsFocused` / focus-gated work**: `useIsFocused()` re-renders the whole
  screen on every focus change just so an effect can run. Read focus
  imperatively or via an observable instead.

### A4 — `useCallback` dependency arrays

This is the invisible one. It cannot be spotted by reading the component.

```tsx
// BROKEN — stale closure, logs the old value
const onPress = useCallback(() => {
  console.log(value);
  setValue((v) => v + 1);
}, []);

// "CORRECT" BUT SLOW — onPress identity churns, so BigComponent re-renders
// every time value changes
const onPress = useCallback(() => {
  console.log(value);
  setValue((v) => v + 1);
}, [value]);
```

```tsx
// FAST — read through .get() inside the body; deps stay empty forever
const onPressReply = useCallback(() => {
  sendReply(replyToId$.get());
}, []);
```

A callback that reads observables via `.get()` needs **no** dependencies and is
stable for the component's lifetime, so it never cascades a render into
children.

If a value genuinely is not an observable, use a stable-callback helper instead
of a deps array (see A7).

### A5 — `useContext` subscribes to the whole value

`useContext` subscribes to the entire context value, not the field you read.

```tsx
// SLOW — subscribes to fontScale AND width AND height.
// Every window resize re-renders every Text in the app.
function MyText({ text }) {
  const { fontScale } = useWindowDimensions();
  const numberOfLines = fontScale >= 1.3 ? 2 : 1;
  return <Text numberOfLines={numberOfLines}>{text}</Text>;
}
```

This one is worth searching for specifically: a component that reads only
`fontScale` still re-renders on every resize, and on desktop (`macos`/`windows`
platforms in this repo) users resize windows constantly.

Fix by putting an **observable** in the context so the provider never
re-renders and consumers select what they need:

```tsx
function ReplyIdProvider({ children }) {
  const replyState$ = useObservable({ replyId: "", chars: 0 });
  return (
    <ReplyIdContext.Provider value={replyState$}>
      {children}
    </ReplyIdContext.Provider>
  );
}

function useIsReplyMessage(messageId) {
  const replyState$ = useContext(ReplyIdContext);
  return useSelector(() => replyState$.replyId.get() === messageId);
}
```

The provider's `value` is a stable observable, so it never changes identity and
never re-renders its consumers. Each consumer subscribes to precisely one
derived value.

### A6 — Prefer imperative APIs over subscribing hooks

When you need a value at call time rather than at render time, read it at call
time.

```tsx
// SLOW — re-renders on every window size change
const { width } = useWindowDimensions();
const onClick = useCallback(() => doSomething(width), [width]);

// FAST — no subscription, no render
const onClick = useCallback(() => doSomething(Dimensions.get("window").width), []);

// And subscribe explicitly only if you actually need to react:
Dimensions.addEventListener("change", ({ window }) => { /* … */ });
```

**If you are writing a hook in `packages/app/src/hooks/` or a shared package,
ship an imperative API alongside it** — a `get()` plus a subscribe/listener,
the way `Dimensions` does. A hook-only API forces every consumer to re-render.
A useful variant: have the hook take a callback and return a ref, so callers get
a stable object they can pass around and read on demand.

### A7 — Escape hatches when you can't restructure

These are explicitly **symptom fixes**, not architecture fixes. Reach for them
when a full restructure isn't proportionate, and note that they leave the
underlying cascade in place.

| Problem | Escape hatch |
| --- | --- |
| Callback deps churn | `useLatestCallback` (`use-latest-callback`) or `useEventCallback` (`usehooks-ts`) — stable identity, no deps array |
| Context re-renders too broadly | `useContextSelector` (`use-context-selector`) — still re-renders on change, but only for the slice you select |

None of these are currently dependencies of this repo. Prefer the Legend State
route above, which is already installed; only add one of these if a specific
component genuinely cannot use an observable.

---

## Adjacent rules from the same talk

These are already largely satisfied here — verify rather than assume, and fix
regressions if you find them:

- **React Compiler** — use it. It just cannot fix real prop changes (A1).
- **Reanimated** over `Animated`. A `SharedValue` *is* a stable state object; it
  is the same pattern as an observable, which is why Reanimated is fast.
- **Legend List** over `FlatList`. Already used here (`@legendapp/list`). If a
  `FlatList` appears in this codebase, treat it as a bug.
- **Unistyles / NativeWind** over raw `StyleSheet`. This repo uses
  `react-native-unistyles@3`.
- **Do not use `TouchableOpacity`.** Prefer `Pressable`.
- **Skip a render entirely for pure style changes.** Legend List updates an
  animated style instead of re-rendering when the list size changes — "it's not
  actually animating, but it's more performant than doing a render." If a
  frequent update only moves or resizes something, drive it through an animated
  style rather than state.

### Why Legend List is fast (the pattern to copy)

Worth internalizing, because it is this architecture taken to its conclusion:

- It mounts a pool of absolutely-positioned containers up front and **never
  re-renders that array again**.
- On scroll it **signals one container** to re-render at a new position with a
  new item.
- On item resize a **tiny wrapper** re-renders with just a style change.
- On list resize it **skips rendering entirely** and updates an animated style.

It is fast because it is extremely careful to do less work — not because of any
single trick.

---

## Checklist for a screen

Run through this for the screen being optimized:

- [ ] Does the top-level screen component subscribe to anything that changes
      during an interaction? (scroll position, composer text, selection,
      streaming events) → move the subscription to the leaf.
- [ ] Any `useState` whose value is passed as a prop to more than one child? →
      `useObservable` + pass the `$` handle.
- [ ] Any `useEffect` whose only job is to call an imperative API? →
      `useObserveEffect`.
- [ ] Any `useCallback` with a non-empty deps array? → read via `.get()` and
      empty the array.
- [ ] Any list row subscribing to a global value and comparing it to its own
      id? → subscribe to the derived boolean instead (A2).
- [ ] Any `useWindowDimensions` / `useSafeAreaInsets` / `useIsFocused` used for
      a value the component only needs at call time? → imperative read.
- [ ] Any context whose `value` is an object literal? → make it an observable.

## Two rules the measurements kept teaching

**Extraction is not optimization.** Moving state into a custom hook cannot move
a render — the state still belongs to the calling component. If a change didn't
alter *where the subscription lives*, expect it to measure flat, and don't
report it as a win.

**Verify the interaction happened before trusting the counter.** A render count
taken from a gesture that silently did nothing is indistinguishable from a real
measurement. Check the scroll actually moved, the field actually received the
text, the row actually changed — then read the number.

Two corollaries for picking targets:

- To decide **whether** a cluster is worth converting, count the SETTER calls,
  not renders. Names lie: `scrollDir`/`atBottom` sound continuous and fire once
  per scroll session.
- To measure **whether a conversion worked**, count renders of the one component
  under test (`if (__DEV__) globalThis.__X__++` at the top of it). Aggregate
  fiber counts are unusable here — a live agent session churns the app enough to
  swamp the signal.

## The one that bites back: wall-clock reads

**Before removing renders from a screen, find every value it derives from
`Date.now()` at render time.** In this codebase that has bitten three times, on
three separate screens.

`timeAgo(iso)` reads the clock during render, so its answer goes stale with no
state change behind it. Wasted re-renders were the only thing keeping those
labels current — remove them and a row reading "43m" still says 43m two minutes
later. The bug looks nothing like the change that caused it.

Cutting renders and auditing wall-clock reads are the same task here.

```bash
# run this over any screen before/after cutting its renders
grep -nE "Date\.now\(\)|timeAgo\(|new Date\(\)" <file>
```

The fix is never "put the renders back". Put the clock at the leaf: a shared
ticker whose `useSyncExternalStore` snapshot is the **formatted label**, so the
component re-renders when its displayed value changes and not once per tick. Use
the existing `<TimeAgo iso={…} />` from `ui/index.tsx`. If a prop is typed
`string` and needs to carry one, widen it to `ReactNode`.

Verify on device by waiting, not by reasoning: screenshot, wait ~100s,
screenshot again, and check the labels actually moved.

## Guardrails

- **Measure the same interaction before and after.** A render-count log on the
  screen component is the cheapest honest metric; CPU during the interaction is
  the best one.
- **Do not change behaviour.** These are all identity-preserving refactors. If a
  fix requires changing what the user sees, it is out of scope.
- **Legend State object-selector gotcha**: `useSelector` on a parent object
  returns the same mutated reference and will not re-render. Always derive
  *inside* the selector: `useSelector(() => obj$.field.get())`, not
  `useSelector(obj$).field`.
- Prefer the smallest diff that moves the subscription. Splitting a 1500-line
  screen into a leaf component is a legitimate and expected part of the fix, but
  extract only what is needed to isolate the subscription.
