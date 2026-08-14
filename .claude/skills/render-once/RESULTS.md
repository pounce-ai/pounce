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

## What is left

The largest remaining structural issue is the one Scenario C exposes: the tab
screens subscribe to whole collections at their top level, so a *genuine* thread
change still re-renders all of Home rather than the one card that changed. The
skill's A1/A2 fix — the list subscribes to ordered ids, each `SessionCard`
subscribes to its own row — would push that to the leaf too.

It was not attempted here because `Home.tsx` is 953 lines with non-trivial
grouping and filtering, and the measured cost after these three changes no
longer justifies the risk in the same pass.
