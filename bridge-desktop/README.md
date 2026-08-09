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

To rehearse without publishing, run **Release Bridge** from the Actions tab —
`dry_run` defaults to on, so it builds every platform and uploads the artifacts
for inspection while skipping the release job entirely. Merging to `main` never
publishes anything; only the tag or a `dry_run: false` manual run does.

### Two updaters, one "latest"

This repo publishes two independently updating apps, and GitHub has only one
`releases/latest`:

| App | Updater | Reads |
| --- | --- | --- |
| `desktop/` (macOS) | Sparkle | `releases/latest/download/appcast.xml` |
| `bridge-desktop/` (Win/Linux) | Electrobun | `releases/download/bridge-latest/…` |

Sparkle owns `latest` and cannot be moved: `SUFeedURL` is compiled into every
desktop build already in the field. So bridge releases publish with
`make_latest: false`, and CI additionally re-uploads the `stable-*` auto-update
artifacts to a rolling **`bridge-latest`** release, which is what
`electrobun.config.ts`'s `baseUrl` points at. Electrobun builds its BSDIFF delta
by fetching the previous `.tar.zst` from that same URL, so those assets are
replaced in place (`gh release upload --clobber`) rather than accumulated under
per-version tags.

If a bridge release ever marks itself latest, the desktop app's appcast 404s and
macOS auto-update dies silently until the next desktop release — and the reverse
is equally true. Neither failure is visible without checking.

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
