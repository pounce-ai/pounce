# Pounce Bridge (headless)

Run Pounce's agent host on a **Windows, Linux, or macOS** machine so your phone
can drive the agent CLIs (Claude, Codex, opencode, …) installed there. The
desktop app bundles this same bridge; this is the standalone, UI-less version
for hosts where you don't want the full app.

## Requirements

- **Node.js** on the host (that's it — this bundle is self-contained; no repo, no
  `npm`/`bun install`). Install from <https://nodejs.org>.
- The agent CLIs you want to use (e.g. `claude`, `codex`) on the host's PATH.
- Phone on the **same Wi-Fi/LAN** as the host (off-LAN is optional — see below).

## Install

**Linux / macOS**

```sh
./install.sh
```

Registers a systemd user service (Linux) or launchd agent (macOS): starts at
login, restarts on crash.

**Windows** (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Registers a `PounceBridge` scheduled task: starts at logon, restarts on crash.

Override the port or pairing token before installing:

```sh
BRIDGE_TOKEN=my-secret BRIDGE_PORT=8099 ./install.sh          # Linux/macOS
$env:BRIDGE_TOKEN="my-secret"; .\install.ps1                  # Windows
```

## Pair your phone

Open Pounce on the same network and connect to the host's LAN address on the
bridge port (default `8099`) with the token above (default `pounce-bridge-local`).
The bridge logs a pairing QR at startup:

- Linux: `journalctl --user -u pounce-bridge.service -f`
- macOS: `~/Library/Logs/pounce-bridge.log`
- Windows: `%LOCALAPPDATA%\Pounce\pounce-bridge.log`

## Off-LAN access (optional)

By default the bridge is **LAN-only**. To reach it from anywhere, drop a
`pounce-tunnel` binary for the host's OS at:

- Linux/macOS: `~/.pounce/bin/pounce-tunnel`
- Windows: `%USERPROFILE%\.pounce\bin\pounce-tunnel.exe`

The bridge auto-detects it on restart and advertises an off-LAN identity via
its `/v1/pair` endpoint.

## Uninstall

```sh
./uninstall.sh                                                # Linux/macOS
powershell -ExecutionPolicy Bypass -File uninstall.ps1        # Windows
```

## Run manually (no service)

```sh
BRIDGE_TOKEN=pounce-bridge-local BRIDGE_PORT=8099 node launcher.mjs
```
