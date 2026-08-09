#!/usr/bin/env bash
# Build a .deb from Electrobun's Linux app bundle.
#
# Electrobun ships Linux as a self-extracting `installer` inside a .tar.gz that
# unpacks to ~/.local/share — per-user, which is exactly what lets its BSDIFF
# self-update rewrite the bundle in place. A .deb is the opposite: root-owned
# under /opt, managed by apt. Both are useful, so we ship both; this script only
# builds the deb, and the deb's app cannot self-update (see NOTE below).
#
# Usage: packaging/build-deb.sh <arch>     # arch: x64 | arm64
set -euo pipefail

ARCH="${1:?usage: build-deb.sh <x64|arm64>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR_ROOT="$HERE/../build/stable-linux-$ARCH"
OUT_DIR="$HERE/../artifacts"

case "$ARCH" in
  x64)   DEB_ARCH=amd64 ;;
  arm64) DEB_ARCH=arm64 ;;
  *) echo "unknown arch: $ARCH" >&2; exit 1 ;;
esac

VERSION="$(node -p "require('$HERE/../package.json').version")"

# Electrobun names the bundle folder from the app name; don't hardcode it —
# a rename upstream should fail loudly here rather than ship an empty package.
BUNDLE="$(find "$APP_DIR_ROOT" -maxdepth 1 -mindepth 1 -type d | head -1)"
if [ -z "$BUNDLE" ]; then
  echo "no app bundle under $APP_DIR_ROOT — did 'bun run build:stable' run?" >&2
  exit 1
fi

# The launcher is the one top-level executable that starts the app. Locate it
# rather than assuming a name, for the same reason.
LAUNCHER="$(find "$BUNDLE" -maxdepth 1 -type f -perm -u+x -printf '%f\n' | grep -E '^(launcher|Pounce)$' | head -1)"
if [ -z "$LAUNCHER" ]; then
  echo "no launcher executable at the top level of $BUNDLE; found:" >&2
  find "$BUNDLE" -maxdepth 1 -type f -perm -u+x -printf '  %f\n' >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/opt/pounce" "$STAGE/usr/bin" \
         "$STAGE/usr/share/applications" \
         "$STAGE/usr/share/icons/hicolor/512x512/apps"

cp -a "$BUNDLE/." "$STAGE/opt/pounce/"
# /usr/bin/pounce is declared as a symlink in nfpm.yaml below, not staged here.
cp "$HERE/../assets/icon.iconset/icon_512x512.png" \
   "$STAGE/usr/share/icons/hicolor/512x512/apps/pounce.png"

cat > "$STAGE/usr/share/applications/pounce.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pounce
Comment=Drive your coding agents from your phone
Exec=/opt/pounce/$LAUNCHER
Icon=pounce
Terminal=false
Categories=Development;
StartupNotify=true
EOF

mkdir -p "$OUT_DIR"

# libwebkit2gtk is the webview the pairing window renders in; libayatana-
# appindicator is what puts the tray icon in Ubuntu's top bar (GNOME dropped
# legacy tray icons, and Ubuntu ships the AppIndicator extension by default).
# Without the latter the app runs but is invisible — no tray, no way back to a
# closed window.
cat > "$STAGE/nfpm.yaml" <<EOF
name: pounce
arch: $DEB_ARCH
platform: linux
version: "$VERSION"
section: devel
priority: optional
maintainer: Pounce <hello@use-pounce.com>
description: |
  Drive your coding agents from your phone.
  Runs the Pounce bridge in the tray so the Pounce app on your phone can
  drive the coding agents installed on this machine. Pair by scanning the QR.
homepage: https://use-pounce.com
license: MIT
depends:
  - libwebkit2gtk-4.1-0
  - libayatana-appindicator3-1
contents:
  - src: $STAGE/opt/pounce
    dst: /opt/pounce
  - src: /opt/pounce/$LAUNCHER
    dst: /usr/bin/pounce
    type: symlink
  - src: $STAGE/usr/share/applications/pounce.desktop
    dst: /usr/share/applications/pounce.desktop
  - src: $STAGE/usr/share/icons/hicolor/512x512/apps/pounce.png
    dst: /usr/share/icons/hicolor/512x512/apps/pounce.png
EOF

nfpm package --config "$STAGE/nfpm.yaml" --packager deb --target "$OUT_DIR"

# nfpm names it pounce_<version>_<arch>.deb; keep a stable download name too so
# /releases/latest/download/ links don't move between versions.
DEB="$(ls -t "$OUT_DIR"/pounce_*_"$DEB_ARCH".deb | head -1)"
cp "$DEB" "$OUT_DIR/Pounce-Linux-$ARCH.deb"
echo "✓ $(basename "$DEB")  →  Pounce-Linux-$ARCH.deb"

# NOTE: the app installed from this .deb lives under root-owned /opt, so
# Electrobun's in-place self-update cannot write to it. Updating means
# installing a newer .deb. The self-extracting tar.gz remains the
# self-updating, per-user option.
