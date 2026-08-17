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
#
# Plain globs, not `find | grep | head`: under `set -euo pipefail` that pipeline
# aborts the script even on success, because `head` closing the pipe SIGPIPEs
# its upstream and pipefail propagates the 141. The guards below are only
# reachable without it.
BUNDLE=""
for d in "$APP_DIR_ROOT"/*/; do
  [ -d "$d" ] || continue
  BUNDLE="${d%/}"
  break
done
if [ -z "$BUNDLE" ]; then
  echo "no app bundle under $APP_DIR_ROOT — did 'bun run build:stable' run?" >&2
  exit 1
fi

# On Linux, Electrobun puts the launcher in <bundle>/bin, not at the top level
# ("Use bin instead of MacOS" — cli/index.ts), and the generated .desktop file
# runs it as `Exec=launcher`. Search bin/ first, then the root, and record the
# path RELATIVE to the bundle so the desktop entry and symlink stay correct
# wherever it lives.
LAUNCHER=""
CANDIDATES=()
for dir in bin .; do
  [ -d "$BUNDLE/$dir" ] || continue
  for f in "$BUNDLE/$dir"/*; do
    [ -f "$f" ] && [ -x "$f" ] || continue
    rel="$(basename "$f")"
    [ "$dir" = "." ] || rel="$dir/$rel"
    CANDIDATES+=("$rel")
    case "$(basename "$f")" in
      launcher | launcher.exe | Pounce)
        [ -n "$LAUNCHER" ] || LAUNCHER="$rel"
        ;;
    esac
  done
done
# An upstream rename should degrade to a warning when it is unambiguous, not a
# failure — but never guess between several executables.
if [ -z "$LAUNCHER" ] && [ "${#CANDIDATES[@]}" -eq 1 ]; then
  LAUNCHER="${CANDIDATES[0]}"
  echo "note: no launcher executable by name; using the only candidate '$LAUNCHER'" >&2
fi
if [ -z "$LAUNCHER" ]; then
  echo "cannot identify the launcher under $BUNDLE (looked in bin/ and the root)" >&2
  printf '  candidate: %s\n' "${CANDIDATES[@]:-(none)}" >&2
  exit 1
fi
echo "▸ bundle=$BUNDLE launcher=$LAUNCHER version=$VERSION arch=$DEB_ARCH"

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

# nfpm names it pounce_<version>_<arch>.deb. The published download gets a
# clearer name and lands in downloads/, which is the only directory the release
# job uploads — publishing OUT_DIR wholesale is how the same package ended up on
# the releases page twice under two names, byte for byte identical.
DEB="$(ls -t "$OUT_DIR"/pounce_*_"$DEB_ARCH".deb | head -1)"
VERSION="$(node -p "require('$HERE/../package.json').version")"
mkdir -p "$OUT_DIR/downloads"
cp "$DEB" "$OUT_DIR/downloads/Pounce-$VERSION-Linux-$ARCH.deb"
echo "✓ $(basename "$DEB")  →  downloads/Pounce-$VERSION-Linux-$ARCH.deb"

# NOTE: the app installed from this .deb lives under root-owned /opt, so
# Electrobun's in-place self-update cannot write to it. Updating means
# installing a newer .deb. The self-extracting tar.gz remains the
# self-updating, per-user option.
