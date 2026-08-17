<div align="center">
  <img src="https://use-pounce.com/assets/icon.png" width="104" alt="Pounce" />
  <h1>Pounce</h1>
  <p><b>Control your coding agents from your pocket.</b></p>
  <p>
    <a href="https://use-pounce.com/">Website</a> ·
    <a href="https://github.com/pounce-ai/pounce/releases/latest">Download the Bridge</a> (macOS · Windows · Linux) ·
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

| Path                           | What                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile`                  | The Pounce **Expo / React Native** app (iOS & Android)                                                                                                                             |
| `apps/bridge`                  | The **bridge server** (`server.mjs`) — the native agent host + LAN HTTP surface the apps talk to                                                                                   |
| `desktop`                      | The **Pounce desktop app** (expo‑desktop → react‑native‑macos / windows) — the full app UI with the bridge embedded                                                                |
| `packages/{shared,runtime,ui}` | Shared types, runtime/transport, and UI primitives                                                                                                                                 |
| `apps/web`                     | The website — landing pages, docs & changelog at [use-pounce.com](https://use-pounce.com/) (Astro + Starlight, deployed to Cloudflare via Alchemy — see `apps/web/alchemy.run.ts`) |
| `scripts/`                     | Release + host install helpers                                                                                                                                                     |

## How it works

Your agents run behind an Iroh‑based daemon (the _agent host_) that a phone can't reach
directly. The **Bridge** runs on your computer: it starts the host, exposes a small
token‑protected HTTP surface on your LAN, and shows a QR. The **app** scans it once and
syncs — then keeps a direct identity to reach your machine afterward.

## Get the app

Every platform ships from one release, under one version. Grab yours from
[**Releases**](https://github.com/pounce-ai/pounce/releases/latest) — or from
[use-pounce.com](https://use-pounce.com/#get), which links each file directly — run it, and scan
the QR:

- **macOS (Apple Silicon, 14+):** `Pounce.dmg` (signed + notarized) — open, drag to Applications,
  launch.
- **Windows (x64):** `Pounce-<version>-Windows-x64.zip` — extract, then run `Pounce-Setup.exe`
  from the extracted folder; it needs the `.installer` folder beside it. Unsigned for now: if
  SmartScreen appears, choose _More info → Run anyway_.
- **Ubuntu / Debian (x64 / arm64):** `Pounce-<version>-Linux-<arch>.deb` —
  `sudo apt install ./Pounce-<version>-Linux-<arch>.deb`.
- **Other Linux (x64 / arm64):** `Pounce-<version>-Linux-<arch>.tar.gz` — extract, run
  `./installer` (installs to `~/.local/share` and adds a desktop entry).
- **iPhone / Android:** on the [App Store](https://apps.apple.com/app/id6779601425) and
  [Google Play](https://play.google.com/store/apps/details?id=com.pounce.app).

Or skip the download entirely — `npx use-pounce configure` sets up any machine, including one you
only reach over SSH.

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

### Driving and profiling the app

[Argent](https://argent.swmansion.com/) ships as a devDependency, so `bun install`
is all a teammate needs — its MCP server (`.mcp.json`) lets a coding agent launch
the app, tap through it, read the React tree, and record React + Instruments
profiles on the simulator. `apps/mobile/.claude/skills/profile` has the
Pounce-specific recipe, including how to run a before/after that actually holds up.

### Releasing the Bridge

Set the version once with `bun run version:set <version>` — it stamps
[`version.json`](version.json) into the phone app, the macOS app and the Windows/Linux app, and
CI fails if any of them drift. Merge that, then run the **Release Pounce** workflow
([`.github/workflows/release.yml`](.github/workflows/release.yml)) from the Actions tab.

It builds every platform — macOS (signed + notarized), Windows, Linux x64/arm64 — and publishes
one GitHub Release tagged `v<version>` holding every installer. Auto-update artifacts go to the
separate rolling `bridge-latest` release, so the download page stays readable.

The tunnel and the npm CLI version independently and release on their own tags.

For a macOS-only release from your machine:

```bash
bash scripts/release-bridge.sh ~/Downloads/<your-DeveloperID>.cer
```

Builds, signs, notarizes (via the `asc` CLI), staples, and cuts a GitHub Release.
(Note: a release cut this way carries no Windows/Linux update artifacts, so prefer CI
once those platforms have shipped.)

## License

MIT
