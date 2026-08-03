---
name: verify
description: Drive the Pounce iOS app on the simulator against a branch-local bridge to verify mobile changes end-to-end.
---

# Verify Pounce mobile on the iOS simulator

All app code is JS (`packages/app`), so the installed dev client (`com.pounce.app`, iPhone 17 sim) picks changes up from Metro — no rebuild needed unless native modules changed.

## Launch

```bash
# 1. Bridge from THIS worktree, isolated port (default token pounce-bridge-local)
BRIDGE_PORT=8123 node apps/bridge/server.mjs   # run_in_background

# 2. Metro
cd apps/mobile && bun run start                # pinned :8081 (desktop is :8083)

# 3. Sim (booted iPhone 17: AFFEC86E-2C7B-46CC-B147-EFDCE5CF2DF8)
xcrun simctl launch <SIM> com.pounce.app       # dev client auto-connects to :8081

# 4. Fresh state (optional): terminate app, rm -rf <DataContainer>/Documents/mmkv,
#    xcrun simctl keychain <SIM> reset
# 5. Pair
xcrun simctl openurl <SIM> 'pounce://connect?url=http%3A%2F%2F127.0.0.1%3A8123&token=pounce-bridge-local'
```

## Drive

- `axe tap/swipe/type --udid <SIM>`; coordinates are points = screenshot px / 3.
- `axe describe-ui` for exact frames — blind taps drift after list re-sorts; always re-locate before tapping a thread card.
- Pull-to-refresh: `axe swipe --start-y 300 --end-y 650 --duration 0.6` from the list top; it silently no-ops if the gesture is too short.
- Software keyboard: `defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false` + restart Simulator; after `axe type` the keyboard drops — re-show with Cmd+K via osascript.
- Sending a message runs a REAL claude turn on this Mac — use a cheap prompt ("Reply with exactly the word OK").

## Observe

- Screenshots: `xcrun simctl io <SIM> screenshot out.png`.
- App-side logs: add temporary `console.log` (Metro hot-reloads in ~2s) and grep the metro log; REVERT after.
- Persisted state: `strings <DataContainer>/Documents/mmkv/pounce | grep db:<collection>` (threads/recents/syncLog…).
- Bridge turns log to its stdout: `[turn] claude resume/exit`.

## Gotchas

- Stale `pounce-tunnel` processes from other sessions linger; isolate on a fresh BRIDGE_PORT.
- Tab bar AX x-ranges: Home ≈88–138, Search ≈138–188, Settings ≈188–238 (y≈800).
- Right after a turn completes, the just-sent message can show twice in the open Timeline (streamed vs re-parsed event ids); reopening the thread shows the clean transcript.
