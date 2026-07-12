#!/usr/bin/env bash
# Install the Pounce bridge from THIS bundle as a login service:
#   • Linux  → systemd user service
#   • macOS  → launchd user agent
# Starts on login, restarts on crash. Self-contained: runs the launcher.mjs that
# sits next to this script (no repo, no `bun install` — only a Node.js runtime).
# Reversible with ./uninstall.sh.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$DIR/launcher.mjs"
TOKEN="${BRIDGE_TOKEN:-pounce-bridge-local}"
PORT="${BRIDGE_PORT:-8099}"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "error: Node.js not found on PATH." >&2
  echo "  Install it, then re-run: https://nodejs.org  (or 'brew install node' / your distro's package)" >&2
  exit 1
fi
[ -f "$LAUNCHER" ] || { echo "error: launcher.mjs not next to this script ($LAUNCHER)" >&2; exit 1; }

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
    <string>$LAUNCHER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRIDGE_TOKEN</key><string>$TOKEN</string>
    <key>BRIDGE_PORT</key><string>$PORT</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

  launchctl unload "$PLIST" 2>/dev/null || true
  pkill -f "$LAUNCHER" 2>/dev/null || true
  sleep 1
  launchctl load -w "$PLIST"
  echo "Installed $LABEL (launchd)"
  echo "  • logs: $LOG"
  ;;

Linux)
  UNIT="pounce-bridge.service"
  UNIT_DIR="$HOME/.config/systemd/user"
  command -v systemctl >/dev/null || {
    echo "error: systemctl not found (non-systemd distro?)." >&2
    echo "  Run it manually instead: BRIDGE_TOKEN=$TOKEN BRIDGE_PORT=$PORT node \"$LAUNCHER\"" >&2
    exit 1
  }
  mkdir -p "$UNIT_DIR"

  cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=Pounce bridge (LAN HTTP bridge for the Pounce app)
After=network-online.target

[Service]
ExecStart=$NODE $LAUNCHER
WorkingDirectory=$DIR
Environment=BRIDGE_TOKEN=$TOKEN
Environment=BRIDGE_PORT=$PORT
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

  pkill -f "$LAUNCHER" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"
  echo "Installed $UNIT (systemd user service)"
  echo "  • logs: journalctl --user -u $UNIT -f"
  echo "  • keep running while logged out: sudo loginctl enable-linger $USER"
  ;;

*)
  echo "error: unsupported OS '$(uname -s)'. On Windows use install.ps1." >&2
  exit 1
  ;;
esac

echo "  • starts on login, restarts on crash"
echo "  • port $PORT, token $TOKEN"
echo "  • pair your phone: open Pounce on the same Wi-Fi and scan/enter this host's address"
echo "  • uninstall: ./uninstall.sh"
