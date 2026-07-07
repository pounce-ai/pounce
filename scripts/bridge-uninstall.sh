#!/usr/bin/env bash
# Remove the Pounce Bridge login service (launchd on macOS, systemd on Linux).
set -euo pipefail

case "$(uname -s)" in
Darwin)
  LABEL="com.pounce.bridge"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  ;;
Linux)
  UNIT="pounce-bridge.service"
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/$UNIT"
  systemctl --user daemon-reload 2>/dev/null || true
  ;;
*)
  echo "error: unsupported OS '$(uname -s)'" >&2
  exit 1
  ;;
esac

pkill -f "apps/bridge/server.mjs" 2>/dev/null || true

echo "Uninstalled the Pounce Bridge service. Run 'bun run bridge' to start it manually again."
