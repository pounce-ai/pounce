# Pounce for Windows and Linux

An [Electrobun](https://electrobun.dev) tray app that hosts the Pounce bridge and
shows its pairing UI. This is how Pounce ships to **Windows and Ubuntu**, where
there is no React Native app — `desktop/` (react-native-macos) covers macOS.

It renders no UI of its own. The window points at the bridge's own loopback page
(`http://127.0.0.1:8099/`, served from `apps/bridge/server.mjs`), so the pairing
QR, live status, and the peer access approve/deny surface are the same code the
Mac app and the `pounce` CLI already serve. The tray adds today's usage and the
plan quota, mirroring the Mac menu bar (`AppDelegate.mm`).

The bridge runs **in-process** via `startBridge()` — there is no sidecar binary
and no host Node requirement; Electrobun's bundled Bun runtime is the runtime.

## Develop

```sh
bun install
bun run dev            # sync-server + electrobun dev
BRIDGE_PORT=8098 bun run dev   # avoid colliding with a bridge you already run
```

`sync-server` bundles the canonical `apps/bridge/server.mjs` into `server/` — a
build artifact, gitignored. Never hand-edit it; fix `apps/bridge/server.mjs`.

## Build

```sh
bun run build          # dev channel  → build/dev-<platform>/
bun run build:stable   # stable + installers → artifacts/
packaging/build-deb.sh x64   # Linux only: .deb from the stable build
```

## Release

Bump the version in **both** `package.json` and `electrobun.config.ts`, merge,
then push a `bridge-v<version>` tag. CI builds all four targets and publishes a
release tagged `v<version>`; every platform must succeed or nothing ships (a
release missing one platform's `update.json` strands that platform's updaters).

Artifacts: `Pounce.dmg` (signed + notarized), `Pounce-Setup-Windows.exe`,
`Pounce-Linux-<arch>.deb`, `Pounce-Setup-Linux-<arch>.tar.gz`.

## Two things that fail silently

**zigpty's native binding.** `apps/bridge/agents/pty.mjs` hosts interactive
(answerable) agent sessions in a real TTY. zigpty resolves its `.node` as
`new URL("../prebuilds/…", import.meta.url)`, and that URL survives bundling —
so the prebuilds are copied to `app/prebuilds/` by `electrobun.config.ts`.
Without them `hasNative` is false, zigpty degrades to a pure-JS pipe with no
TTY, and prompts can't be answered from the phone while everything else looks
fine. The app logs `[pty] no native TTY` at startup if this regresses.

**The .deb can't self-update.** It installs to root-owned `/opt/pounce`, which
Electrobun's in-place updater cannot write to. Updating means installing a newer
`.deb`. The `.tar.gz` installer is per-user (`~/.local/share`) and does
self-update — that's why both ship.
