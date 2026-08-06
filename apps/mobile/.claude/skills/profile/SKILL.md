---
name: profile
description: Profile the Pounce iOS app with Argent and prove a performance fix with a controlled before/after, instead of a single hopeful run.
---

# Profile Pounce mobile with Argent

Argent is a devDependency (`@swmansion/argent`) and its MCP server is wired up in
`.mcp.json`, so the `argent-*` skills and tools are already available. This file is
only the Pounce-specific parts: what to point it at, and the traps we already fell
into.

Everything below assumes the dev client is installed on the sim and Metro is up
(see the sibling `verify` skill for launching the bridge and Metro).

## The targets

| what | value |
|---|---|
| bundle id | `com.pounce.app` |
| sim | iPhone 17 — get the UDID from `list-devices`, never hardcode |
| Metro port | 8081 (mobile; desktop is 8083 — see the metro-port-collision memory) |
| project root for `react-profiler-analyze` | `apps/mobile` |

`native-profiler-start` needs `app_process: "Pounce"` whenever the agent-device
runner is also on the sim, otherwise it refuses to guess between them.

## Measure a store tick, not just a scroll

The mistake that cost a whole round here: a short profiling window catches only
scroll-driven mounts and completely misses the commits caused by a **store
update** — which is where the expensive re-render cascades live, because every
mounted-but-off-screen tab screen re-renders too.

Drive a deterministic store update instead of hoping a background sync lands
inside the window. Pull-to-refresh is the cheapest one:

```
react-profiler-start
  → 4 × (swipe down from y=0.42 to y=0.88 over 400ms, then wait 6s)
react-profiler-stop → react-profiler-analyze
```

That yields a ~28s window containing four real store ticks, and it repeats
closely enough that trials are comparable.

## Prove the fix, don't assert it

Single-run ms deltas are worthless here — dev-mode timings swing with GC, Metro,
SVG warm-up, and scroll depth. Two runs of *different lengths* cannot be compared
at all.

Run **3 trials per side over identical windows**, toggling the code with
`git checkout --` / copy-back, and report ranges. Trust in this order:

1. **Render counts** (`CellRenderer` renders, `×98`-style markers in the report) —
   structural, near-deterministic, and directly caused by the change.
2. **Sum of commits ≥16ms** over a fixed-length window.
3. Individual commit ms — noisiest; only believe non-overlapping ranges.

## Traps

- **Attaching the CDP debugger can kill the app.** Two crashes seen on this app,
  both inside RN's inspector, not app code: a `ConsoleTaskOrchestrator::finishTask`
  assert (SIGABRT) and `hermes::vm::Debugger::runUntilValidPauseLocation`
  (SIGSEGV). Expect to relaunch and re-attach mid-session; check
  `~/Library/Logs/DiagnosticReports/Pounce-*.ips` when the app vanishes.
- **A black screen after relaunch** is usually a stale bundle, not your diff —
  `debugger-reload-metro` fixes it. Check before blaming the change.
- **`native-profiler-stop` can return `fetch failed`** while the xctrace export is
  still running. The export may still have finished: re-run `native-profiler-analyze`
  and look at the trace dir before concluding the run was lost. If the trace has no
  `time-profile` / `potential-hangs` tables, that one really is dead — re-record.
- **`fiber_renders_captured: 0`** means the DevTools backend was not hooked when
  profiling started (typical right after a relaunch). CPU samples are still valid,
  React commits are not — re-run.

## Layout gotchas this app already hit

Both of these look like performance wins and are not:

- `itemLayoutAnimation` on the Home list must be **rebuilt per render**. Hoisting
  one shared `LinearTransition` instance leaves a just-reordered card riding up
  into its group header.
- A list `style` passed to a reanimated component must be a **plain object**.
  A unistyles `StyleSheet.create` entry resolves to `{}` there and throws
  "empty object is not a valid style value".
