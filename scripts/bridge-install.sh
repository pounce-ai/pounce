#!/usr/bin/env bash
# Install the Pounce Bridge as a login service: launchd user agent on macOS,
# systemd user service on Linux. Starts on login, restarts on crash.
# Reversible with scripts/bridge-uninstall.sh.
# (On Windows, use the Pounce desktop app from Releases instead — the agent
# host it bootstraps registers its own Startup-folder autostart.)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
SERVER="$REPO/apps/bridge/server.mjs"
TOKEN="${BRIDGE_TOKEN:-pounce-bridge-local}"
PORT="${BRIDGE_PORT:-8099}"

[ -n "$NODE" ] || { echo "error: node not found on PATH" >&2; exit 1; }
[ -f "$SERVER" ] || { echo "error: $SERVER not found" >&2; exit 1; }

case "$(uname -s)" in
Darwin)
  LABEL="com.pounce.bridge"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  LOG="$HOME/Library/Logs/pounce-bridge.log"

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$SERVER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRIDGE_TOKEN</key><string>$TOKEN</string>
    <key>BRIDGE_PORT</key><string>$PORT</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

  # Stop any launchd-managed or manual instance, then (re)load.
  launchctl unload "$PLIST" 2>/dev/null || true
  pkill -f "apps/bridge/server.mjs" 2>/dev/null || true
  sleep 1
  launchctl load -w "$PLIST"

  echo "Installed $LABEL (launchd)"
  echo "  • logs: $LOG"
  ;;

Linux)
  UNIT="pounce-bridge.service"
  UNIT_DIR="$HOME/.config/systemd/user"

  command -v systemctl >/dev/null || { echo "error: systemctl not found (non-systemd distro?) — run 'bun run bridge' manually" >&2; exit 1; }
  mkdir -p "$UNIT_DIR"

  cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=Pounce Bridge (LAN HTTP bridge for the Pounce app)
After=network-online.target

[Service]
ExecStart=$NODE $SERVER
WorkingDirectory=$REPO
Environment=BRIDGE_TOKEN=$TOKEN
Environment=BRIDGE_PORT=$PORT
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

  pkill -f "apps/bridge/server.mjs" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"

  echo "Installed $UNIT (systemd user service)"
  echo "  • logs: journalctl --user -u $UNIT -f"
  echo "  • to keep it running while logged out: sudo loginctl enable-linger $USER"
  ;;

*)
  echo "error: unsupported OS '$(uname -s)' — on Windows, use the Pounce desktop app (github.com/peppyhop/pounce/releases)" >&2
  exit 1
  ;;
esac

echo "  • starts on login, restarts on crash"
echo "  • port $PORT, token $TOKEN"
echo "  • uninstall: bun run bridge:uninstall"
