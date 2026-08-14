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

## What is left

Home and Search are done. The same pattern would apply to `Space.tsx` and the
Sessions list, which still pass whole `Session` objects — neither was measured
here, so neither is claimed as a problem.
