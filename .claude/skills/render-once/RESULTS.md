# Render-once pass — measured results

First application of the [`render-once`](./SKILL.md) skill to the mobile app,
2026-08-14. Three changes; every screen in the tab bar stopped re-rendering
while idle.

## Method

| | |
| --- | --- |
| Device | iPhone 17 simulator, iOS 26.5 |
| Build | Metro dev bundle, Hermes, bridgeless |
| Data | Live bridge — 2 paired devices, ~19 threads, 1 agent actively running |
| Tool | argent `react-profiler-start` / `-stop` / `profiler-commit-query` |

Two caveats on reading the numbers:

- **Dev mode renders ~3× slower than production.** Absolute millisecond figures
  are inflated; the render *counts* and the before/after ratios are not.
- **The baseline was re-measured, not remembered.** After the changes were
  written, they were stashed and the original scenario re-run: 5,076 fiber
  renders vs the 5,106 first recorded — under 1% apart. The deltas below are
  well outside run-to-run noise.

The headline scenario is deliberately **30 seconds of doing nothing at all** —
app open on Home, no touches. Every render counted below is a render the app
did not need to do.

## Scenario A — 30s idle, Home focused

| Metric | Before | After | Δ |
| --- | ---: | ---: | ---: |
| Fiber renders | 5,076 | 2,620 | **−48%** |
| React commits | 192 | 207 | +8% |
| Commits ≥16ms | **4** | **0** | **−100%** |

The profiler's verdict went from four hot commits to
*"All commits below 16ms — app appears smooth (all-clear)"*.

Commit count rose slightly while work fell by half, which is the shape you want:
the remaining ~200 commits are the thinking-glyph animation on the one running
thread (a shared 6.25 Hz ticker driving a single `<Text>`). Many tiny commits at
the leaf beat four big ones at the root.

### Per screen — renders during those 30 idle seconds

| Component | Before | After |
| --- | ---: | ---: |
| `HomeScreen` | 4 | **0** |
| `DashboardScreen` (Activity) | 4 | **0** |
| `SearchScreen` | 4 | **0** |
| `SettingsScreen` | 4 | **0** |
| `QuotaCard` | 4 | **0** |
| `StatTile` | 20 | **0** |
| `SessionCard` | 152 | **0** |
| `CellRenderer` | 108 | **0** |

All four tab screens are mounted at once, so they were re-rendering *together* —
four full screens, top to bottom, roughly every seven seconds, while the user
did nothing. Three of those four were not even on screen.

## Scenario B — scrolling the Home list

| Metric | Before | After |
| --- | ---: | ---: |
| Commits / second | 6.2 | 6.1 |
| Commits ≥16ms | **2** (20.9ms, 20.2ms) | **0** |

The scroll itself was always handled natively — the two hot commits were
background sync ticks landing mid-scroll, which is exactly when a 21ms commit is
most likely to drop a frame.

## Scenario C — scrolling a Session transcript

Measured after the changes only; no pre-change baseline was captured for this
screen, so there is no delta to report.

41 commits over ~12s, one at 16.5ms. Worth recording *why*: `SessionScreen`
itself never appeared in the render set — the 16.5ms commit was `HomeScreen` and
`SearchScreen` re-rendering in the background while the user was reading a
transcript. Scenario A's fix removes that class of work.

---

## The three changes

### 1. Stop writing rows that haven't changed

`packages/app/src/state/db/rowWrites.ts` (extracted from `collections.ts` so it
is unit-testable without a device runtime).

`upsertRows` called `collection.update()` for **every row on every sync tick**,
unconditionally. react-db marks the row dirty and emits a change even when the
assigned values are byte-identical, so each tick woke every `useLiveQuery` in
the app and re-rendered every mounted screen — for data that had not moved.

It now skips the write when `Object.assign(draft, row)` would be a no-op. Only
keys present on the incoming row are compared, because assign merges rather than
clears — treating a locally-derived field's absence as a difference would
rewrite the row every tick and defeat the whole thing.

Covered by 11 new tests in `rowWrites.test.ts`. The skip is load-bearing in both
directions: too eager and sync silently stops applying real updates.

### 2. Subscribe to the count, not the collection

`useDeviceCount()` in `state/db/hooks.ts`; `Dashboard`, `Search` and `Settings`
switched over.

Those three screens called `useDevices()` — subscribing to the entire
collection — and then used nothing but `devices.length`. The sync rewrites each
device's `lastSyncAt` on every tick, so a bookkeeping timestamp that no screen
displays was re-rendering three screens in full.

This is [A5 in the skill](./SKILL.md) — Jay's `useWindowDimensions().fontScale`
trap, reproduced in our own data layer. `useDeviceCount` projects the query to
`{ id }`, so the derived collection stays stable across those writes and the
screens re-render only when a device is genuinely added or removed.

### 3. Put the clock at the leaf

`<TimeAgo>` in `ui/index.tsx`; used by `SessionCard`, `Space`, `SyncHistory`,
`MarkerSheet`.

**This one was a regression the first two changes caused, caught before
shipping.** `timeAgo()` reads `Date.now()` at render, so its answer goes stale
with no state change behind it. That had been papered over by accident: the
wasted re-renders were also what kept every relative timestamp current. With
them gone, the labels visibly froze — a thread reading "43m" still said 43m two
minutes later.

Verified on device: idle threads sat unchanged across 100 seconds. After the
fix, the same rows advanced correctly (17m→19m, 48m→50m, 51m→53m over 130s).

The replacement is strictly better than the accident it removed. One shared 1s
interval, existing only while at least one label is mounted, and the
`useSyncExternalStore` snapshot is the **formatted label** rather than the tick —
so a row reading "43m" re-renders once a minute rather than once a second, and
only that one `<Text>` re-renders instead of the screen containing it.

## Verification

- `tsc --noEmit` clean (apps/mobile).
- 931 tests pass across the workspace (459 app / 446 bridge / 23 / 3), including
  11 new ones.
- Lint: no new errors.
- Home, Activity, Search, Settings and a Session transcript all confirmed
  rendering correctly on device, with live data still flowing.

---

# Second pass — pushing the lists to the leaf

The first pass left one structural problem: a *genuine* thread change still
re-rendered all of Home rather than the one card that changed. This pass fixed
it, for Home and Search.

## Method

Idle profiling can't see this — it needs a thread to actually change. So the
trigger was made deterministic: a temporary `__DEV__` handle on the collections,
and five single-field writes to one known thread, injected from the debugger.
Everything else about the app is held constant, and every render in the window
is attributable to those five writes.

The handle was removed before committing.

Both sides were measured back-to-back by stashing the changes, because the app
is running a live agent whose own thread churns the list — an earlier attempt to
compare against a number taken twenty minutes prior was polluted by exactly that
(190 commits against 108 for identical code), and was thrown away.

## Result — five changes to one thread

| Metric | Before | After | Δ |
| --- | ---: | ---: | ---: |
| Fiber renders | 3,127 | 1,472 | **−53%** |
| React commits | 103 | 99 | — |
| Card bodies rendered | 190 | 12 | **−94%** |

The card figure is from the paired run taken mid-way, where both sides still
produced data the per-component query could read. See the caveat below.

Before, changing one thread's title re-rendered **38 session cards, 27 cells and
two full screens** — including Search, a tab that wasn't even visible. After, the
work is proportional to what's actually on screen.

Liveness was verified explicitly, not assumed: with the probe thread visible on
Home, the injected title change still appears on screen.

> **A measurement caveat worth recording.** `react-profiler-analyze` stores
> nothing when no commit crosses its 16ms floor, and `profiler-commit-query` then
> reports zero renders for every component — including components that
> demonstrably rendered, since the screen visibly updated. Those zeros are an
> artifact of the tooling, not a result. The fiber-render totals above come
> straight from `react-profiler-stop` and are the trustworthy figure.

## The changes

### 4. A card that reads its own row

`useThreadRow(id)` watches a single key via the collection's `subscribeChanges`,
rather than building a filtered live query per caller — cheap enough to run once
per visible row. `collection.get` returns a stable reference until the row is
actually rewritten, which is what makes it safe as a `useSyncExternalStore`
snapshot; that was verified against the running app before the hook was written.

`LiveSessionCard` wraps the presentational `SessionCard` with it. The plain card
is unchanged, so callers that already hold a `Session` keep working.

### 5. Ids in the rows, and a list identity that holds still

Two halves of one change, neither of which works alone.

Home's rows now carry a `sessionId` instead of a whole `Session`, so a thread's
contents no longer appear in the row list. Most rebuilds therefore come out
identical, and `sameRows` hands LegendList back the *previous* array rather than
an equal one — so it doesn't churn a single realised cell.

Carrying ids is what makes reusing the array safe. Reusing it while the rows
still held whole sessions would have shown stale cards.

The memo still reads every thread — ordering, grouping and attention counts all
depend on their contents — so it still recomputes on any change. What changed is
that recomputing is now nearly free of downstream cost.

### 6. Search's inline list slots

Search got the same id-based treatment, but the bigger find was beside it.

`Search.tsx` already carried a note to keep every `FlatList` prop referentially
stable — and yet `ListHeaderComponent`, `ListFooterComponent` and
`ListEmptyComponent` were all inline JSX. Each got a fresh identity on every
render, re-rendering every realised cell of a list that usually sits offscreen
behind Home. Memoized on what they actually read.

A note that says "keep these stable" is worth re-reading against the props that
arrived after it was written.

## Verification

`tsc` clean, 931 tests pass, no new lint errors. Home and Search confirmed on
device — including a live search (`antigravity` → "1 MATCH", correct card, and
the in-messages footer), which exercises the memoized slots and the id-based
list together.

---

# Third pass — Space and Sessions

The two screens flagged as "unmeasured, so unclaimed" at the end of the second
pass. Measuring first was the right call: one of them was the worst offender
found so far, and the other turned out to be fine.

Same deterministic probe as the second pass — five single-field writes to one
thread, injected from a temporary dev handle, with the screen under test open.

## Space — the worst commit found so far

| Metric (5 writes, Space open) | Before | After | Δ |
| --- | ---: | ---: | ---: |
| Fiber renders | 3,053 | 1,885 | **−38%** |
| Commits ≥16ms | **5** | **1** | −80% |

Paired runs with near-identical commit totals (103 and 101), so this is a fair
comparison rather than two different background conditions.

Every one of the five writes produced a commit over 16ms. `SpaceDetail` was
re-rendering at ~5ms each, cascading into 28 Pressables, 72 Texts, the cadence
rows and both charts — for a title change on one thread in a list this screen
doesn't even show.

**Root cause: both of `SpaceDetail`'s props were new objects every time.**
`space` comes from `deriveSpaces`, which runs over every thread; `sessions` was
an inline `.filter()` in the JSX, which is fresh on every render regardless of
data. Memoization can't help with either — the React Compiler included, because
the props genuinely changed identity. Holding both still with `useStable` lets
`SpaceDetail` bail out.

**And the timestamp trap again.** Space had two plain `timeAgo()` calls that
were being kept current by exactly the re-renders this change removes — the
third time this pattern has appeared. They became live `<TimeAgo/>` elements in
the same commit, and `CadenceLine`'s `figure` widened to a node to carry one.
Verified on device: "active 48s" still advances to "active 2m" on its own.

> Worth stating as a rule: **in this app, cutting renders and auditing
> wall-clock reads are the same task.** Anything derived from `Date.now()` at
> render time is silently riding on renders it didn't ask for.

## Sessions — measured, and left almost alone

No problem found. Five writes produced about **nine** card renders, against 190
on Home before its fix. `LegendList` absorbs an unstable `renderItem` far better
than `FlatList` does, and this screen is a modal that only exists while open.

Its `keyExtractor` and `renderItem` were still inline arrows, so they were
hoisted — three lines, for consistency with the two lists either side of it that
already do this and carry comments explaining why. **That is hygiene, not a
measured win**, and the commit says so.

The leaf-subscription refactor was *not* applied here. The measurement didn't
justify the complexity, and applying it anyway would have been cargo-culting the
previous pass.

## Shared groundwork

`deepEqual` moved out of `db/rowWrites.ts` into `state/equality.ts`, since the
write path and the screens now ask the same question. `rowWrites` imports it;
its 11 tests still cover the write path, and 7 new ones cover the function
directly — including the cases a looser implementation gets wrong: a missing key
versus an undefined one, `0` versus `false`, and Date/Map/Set bailing out rather
than guessing.

`useStable(value)` sits beside it. It deliberately hands back a stale-but-equal
reference, so it is only safe for values fully described by the comparison —
noted in its own doc comment.

## Verification

`tsc` clean, 938 tests pass, no new lint errors, zero console errors or warnings
on device. Space confirmed rendering and staying live.

---

# Fourth pass — the Session screen

Session is the app's biggest component (1,835 lines, 20 `useState`, 18
`useEffect`) and the obvious suspect. Measuring it first was again the right
call: two of its three interactions were already fine, and the one that wasn't
is not the one anyone would have guessed.

## Measure the interaction, not the screen

| Session interaction | Result |
| --- | --- |
| Idle, 20s | **0 renders** |
| Transcript scroll | see the caveat below |
| Composer typing, 30 chars | 0 commits over 16ms — `Composer` owns its own draft behind a ref, so the screen is never involved |
| **In-thread search typing** | **2 renders of the whole screen per keystroke** |

The composer being already isolated is Jay's A6 applied by whoever built it: an
imperative handle instead of lifted state. Only the search box had its state
sitting in the screen.

## The fix, and the thing that isn't the fix

The first attempt moved the search cluster into a `useThreadSearch` hook and
measured flat. That was **not** a null result to shrug at — it was the wrong
change. A custom hook's state still belongs to the calling component, so moving
code between files cannot move a render. Extraction buys readability; it is not
render-once.

The second attempt actually applied the pattern:

- `useObservable` creates the query, hits, index and searching flag **without
  subscribing**, so the screen doesn't re-render when they change;
- a new `ThreadSearchBar` leaf reads them with `useSelector` and re-renders
  itself;
- `useObserveEffect` drives the debounced search by reading `threadQuery$`
  directly, so the search runs with no render behind it at all;
- the screen subscribes to exactly one thing — the highlight — which changes per
  jump, not per keystroke.

| 10 keystrokes in the search field | `SessionScreen` renders |
| --- | ---: |
| Before | **21** |
| After | **0** |

Verified on device: "antigravity" gives 1/3, two taps of next gives 3/3, and the
matched event is scrolled to and highlighted.

## Measure the setters, not the renders

The aggregate fiber counts were unreadable for this work — 874/299/328 against
485/295/473, ranges fully overlapping, because a live agent session churns the
app in the background. Counting renders of the one component under test cut
straight through that.

Better still, for deciding **whether** to convert a cluster: count the setter
calls. The scroll cluster looked like the obvious next target — `atBottom`,
`scrollDir`, `newWhileAway`, `visibleIndex` all sound like they fire constantly
while scrolling. They don't:

| During 8 scroll swipes | Calls |
| --- | ---: |
| `setAtBottom` | 1 |
| `setScrollDir` | 0 |
| `setVisibleIndex` | 0 (mobile-gated) |

Edge-triggered, not continuous. Converting it would save about one render per
scroll session, so it was left alone — the same call made for the Sessions list
in pass three.

> **A retraction, recorded on purpose.** An earlier draft of this section
> reported "~6 renders per scroll, the rest is history pagination". Both halves
> were wrong. The list never actually moved under the synthetic swipes — five
> gesture profiles, identical pixels every time — so the renders were the screen
> settling after open, not scrolling. And there is no scroll-triggered
> pagination on this screen at all: `fullQ` fetches the whole history in one
> query. A render count taken from a gesture that silently did nothing looks
> exactly like a real measurement. **Verify the interaction happened before
> trusting the counter.**

## What is left

Nothing measured and unfixed. Not profiled at all: the less-travelled screens
(Metric, Disk, Diagnostics, Context, Changes), and Session's remaining clusters
— send/queue, timeline, usage, model/permission, markers, diff. Each should get
the setter-count check before anyone converts it; the clusters tested so far
came out opposite ways and neither was predictable from reading the code.

There is also no reliable way to drive a transcript scroll from automation on
this build, so no scroll number here should be trusted until that harness
exists.
