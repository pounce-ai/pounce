#!/usr/bin/env bash
# Remove the Pounce bridge login service installed by ./install.sh.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$DIR/launcher.mjs"

case "$(uname -s)" in
Darwin)
  LABEL="com.pounce.bridge"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL (launchd)"
  ;;
Linux)
  UNIT="pounce-bridge.service"
  if command -v systemctl >/dev/null; then
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/$UNIT"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
  echo "Removed $UNIT (systemd)"
  ;;
*)
  echo "error: unsupported OS '$(uname -s)'. On Windows use uninstall.ps1." >&2
  exit 1
  ;;
esac

pkill -f "$LAUNCHER" 2>/dev/null || true
echo "Done."
