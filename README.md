<div align="center">
  <img src="docs/assets/icon.png" width="104" alt="Pounce" />
  <h1>Pounce</h1>
  <p><b>Control your coding agents from your pocket.</b></p>
  <p>
    <a href="https://peppyhop.github.io/pounce/">Website</a> ·
    <a href="https://github.com/peppyhop/pounce/releases/latest">Download the Bridge</a> (macOS · Windows · Linux) ·
    <a href="#getting-started-dev">Dev setup</a>
  </p>
</div>

---

Pounce lets you steer **Claude, Codex & opencode** across every machine you own — from
your phone. Watch agents work in real time, jump in by voice, review diffs, and ship,
all one‑handed.

This is the full open‑source monorepo: the mobile app, the desktop Bridge, the bridge
server, the shared packages, and the landing page.

## Repo layout

| Path | What |
|---|---|
| `apps/mobile` | The Pounce **Expo / React Native** app (iOS & Android) |
| `apps/bridge` | The **bridge server** (`server.mjs`) — the native agent host + LAN HTTP surface the apps talk to |
| `desktop` | The **Pounce desktop app** (expo‑desktop → react‑native‑macos / windows) — the full app UI with the bridge embedded |
| `bridge-desktop` | **Deprecated** — the old standalone desktop Bridge ([Electrobun](https://electrobun.dev)). Superseded by `desktop/`, which embeds the bridge |
| `packages/nitro` | Native **Iroh** client (Rust + Nitro) for direct device‑to‑device sync |
| `packages/{shared,runtime,ui}` | Shared types, runtime/transport, and UI primitives |
| `docs/` | The landing page (served via GitHub Pages) |
| `scripts/` | Release + host install helpers |

## How it works

Your agents run behind an Iroh‑based daemon (the *agent host*) that a phone can't reach
directly. The **Bridge** runs on your computer: it starts the host, exposes a small
token‑protected HTTP surface on your LAN, and shows a QR. The **app** scans it once and
syncs — then keeps a direct identity to reach your machine afterward.

## Get the app

Grab the Bridge for your computer from [**Releases**](https://github.com/peppyhop/pounce/releases/latest),
run it, and scan the QR:

- **macOS (Apple Silicon):** `Pounce.dmg` (signed + notarized) — open, drag to Applications, launch.
- **Windows (x64):** `Pounce-Setup-Windows.zip` — extract, run `Pounce-Setup.exe`. Unsigned for
  now: if SmartScreen appears, choose *More info → Run anyway*.
- **Linux (x64 / arm64):** `Pounce-Setup-Linux-<arch>.tar.gz` — extract, run `./installer`
  (installs to `~/.local/share` and adds a desktop entry).
- **iOS / Android:** in private beta — see the [website](https://peppyhop.github.io/pounce/).

## Getting started (dev)

Prereqs: [Bun](https://bun.sh), Xcode (iOS) / Android Studio, and the `kittylitter`
agent host running.

```bash
bun install                       # install the workspace (apps/* + packages/*)

# Mobile app
cd apps/mobile && bun run ios     # or: bun run android

# Bridge server (standalone CLI)
node apps/bridge/server.mjs

# Desktop app (isolated — not part of the bun workspace; embeds the bridge)
cd desktop && bun install && bunx expo start --port 8082
```

### Releasing the Bridge

Tag `bridge-v*` (e.g. `git tag bridge-v1.0.8 && git push --tags`) and CI builds all
platforms — macOS (signed + notarized), Windows, Linux x64/arm64 — and attaches every
installer + auto-update artifact to one GitHub Release — see
[`.github/workflows/release-bridge.yml`](.github/workflows/release-bridge.yml).

For a macOS-only release from your machine:

```bash
bash scripts/release-bridge.sh ~/Downloads/<your-DeveloperID>.cer
```

Builds, signs, notarizes (via the `asc` CLI), staples, and cuts a GitHub Release.
(Note: a release cut this way carries no Windows/Linux update artifacts, so prefer CI
once those platforms have shipped.)

## License

MIT
