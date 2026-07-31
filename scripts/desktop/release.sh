#!/usr/bin/env bash
# Package a built Pounce.app into a signed, notarized, stapled DMG and generate
# the Sparkle appcast for it. Encapsulates the exact recipe used by the desktop
# release (see memory: sign inside-out incl. Sparkle helpers → DMG → notarize →
# staple → generate_appcast) so CI and local runs share one tested path.
#
# Runs on macOS. Requires: codesign, hdiutil, xcrun notarytool, and the Sparkle
# generate_appcast tool from the CocoaPods checkout.
#
# Env inputs:
#   APP                 path to the built .app                     (required)
#   SIGN_IDENTITY       "Developer ID Application: … (TEAMID)" or the cert SHA-1 (required)
#   ENTITLEMENTS        path to the app's .entitlements            (required)
#   OUT_DMG             output DMG path                            (default: <dir of APP>/Pounce.dmg)
#   SIGN_KEYCHAIN       keychain holding the identity              (optional; else default search list)
#   NOTARY_KEY_P8       App Store Connect API key (.p8) path       (required unless SKIP_NOTARIZE=1)
#   NOTARY_KEY_ID       …its Key ID                                (required unless SKIP_NOTARIZE=1)
#   NOTARY_ISSUER       …its Issuer ID                             (required unless SKIP_NOTARIZE=1)
#   SKIP_NOTARIZE       "1" to build+sign the DMG but skip notarize/staple (dry run)
#   GENERATE_APPCAST    path to Pods/Sparkle/bin/generate_appcast  (required unless SKIP_APPCAST=1)
#   SPARKLE_KEY_FILE    exported Sparkle EdDSA private key file     (required unless SKIP_APPCAST=1)
#   DOWNLOAD_URL_PREFIX release download URL prefix for enclosures (required unless SKIP_APPCAST=1)
#   APPCAST_OUT         where to write the generated appcast.xml   (default: <dir of APP>/appcast.xml)
#   SKIP_APPCAST        "1" to skip appcast generation
set -euo pipefail

: "${APP:?set APP to the built .app}"
: "${SIGN_IDENTITY:?set SIGN_IDENTITY}"
: "${ENTITLEMENTS:?set ENTITLEMENTS}"
[ -d "$APP" ] || { echo "error: APP not found: $APP" >&2; exit 1; }

DIR="$(cd "$(dirname "$APP")" && pwd)"
OUT_DMG="${OUT_DMG:-$DIR/Pounce.dmg}"
APPCAST_OUT="${APPCAST_OUT:-$DIR/appcast.xml}"
# Entitlements for the embedded bun-compiled bridge (JIT + library-validation);
# defaults to the file beside the app's entitlements.
BRIDGE_ENTITLEMENTS="${BRIDGE_ENTITLEMENTS:-$(dirname "$ENTITLEMENTS")/PounceBridge.entitlements}"
# --keychain only when SIGN_KEYCHAIN is set. Unquoted ${VAR:+…} is safe here —
# a keychain name has no spaces — and avoids empty-array expansion, which trips
# `set -u` on macOS's bash 3.2.
sign() { codesign --force --options runtime --timestamp ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} -s "$SIGN_IDENTITY" "$@"; }
# Like sign(), but with the bridge's JIT/library-validation entitlements.
sign_bridge() { codesign --force --options runtime --timestamp ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} --entitlements "$BRIDGE_ENTITLEMENTS" -s "$SIGN_IDENTITY" "$@"; }

echo "▸ Signing inside-out with: $SIGN_IDENTITY"
SP="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
if [ -d "$SP" ]; then
  # Sparkle's nested helpers must be hardened-runtime signed inside-out or
  # notarization rejects them.
  [ -d "$SP/XPCServices/Downloader.xpc" ] && sign "$SP/XPCServices/Downloader.xpc"
  [ -d "$SP/XPCServices/Installer.xpc" ] && sign "$SP/XPCServices/Installer.xpc"
  [ -d "$SP/Updater.app" ] && sign "$SP/Updater.app"
  [ -f "$SP/Autoupdate" ] && sign "$SP/Autoupdate"
  sign "$APP/Contents/Frameworks/Sparkle.framework"
fi
[ -d "$APP/Contents/Frameworks/hermes.framework" ] && sign "$APP/Contents/Frameworks/hermes.framework"
# The embedded bridge is a bun-compiled Mach-O executable (Resources/bridge/
# pounce-bridge). Notarization rejects the app unless every Mach-O is
# hardened-runtime signed, and the bridge additionally needs JIT /
# library-validation entitlements — so sign it with sign_bridge().
BRIDGE_DIR="$APP/Contents/Resources/bridge"
if [ -d "$BRIDGE_DIR" ]; then
  if [ -f "$BRIDGE_DIR/pounce-bridge" ]; then
    [ -f "$BRIDGE_ENTITLEMENTS" ] || { echo "error: bridge entitlements not found: $BRIDGE_ENTITLEMENTS" >&2; exit 1; }
    sign_bridge "$BRIDGE_DIR/pounce-bridge"
  fi
  # Every other nested Mach-O, whatever it's called — this walks ALL files
  # rather than *.node/*.dylib because the bundled ccusage (a Rust executable,
  # no extension) would otherwise slip through, and notarization rejects the
  # whole app over one unsigned Mach-O. It needs no entitlements: unlike the
  # bridge it embeds no JS runtime, JITs nothing, and links only libSystem.
  # Non-macOS prebuilds (linux/win .node = ELF/PE) fail the file(1) test and are
  # skipped; pounce-bridge is already signed above, with its entitlements.
  while IFS= read -r -d '' bin; do
    if [ "$bin" != "$BRIDGE_DIR/pounce-bridge" ] && file "$bin" | grep -q "Mach-O"; then
      sign "$bin"
    fi
  done < <(find "$BRIDGE_DIR" -type f -print0)
fi
# The app last, with entitlements.
codesign --force --options runtime --timestamp ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} --entitlements "$ENTITLEMENTS" -s "$SIGN_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "▸ Building DMG → $OUT_DMG"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT_DMG"
hdiutil create -volname Pounce -srcfolder "$STAGE" -ov -format UDZO "$OUT_DMG" >/dev/null
rm -rf "$STAGE"
codesign --force --timestamp ${SIGN_KEYCHAIN:+--keychain "$SIGN_KEYCHAIN"} -s "$SIGN_IDENTITY" "$OUT_DMG"

if [ "${SKIP_NOTARIZE:-}" = "1" ]; then
  echo "▸ SKIP_NOTARIZE=1 — leaving DMG un-notarized"
else
  : "${NOTARY_KEY_P8:?set NOTARY_KEY_P8}"; : "${NOTARY_KEY_ID:?set NOTARY_KEY_ID}"; : "${NOTARY_ISSUER:?set NOTARY_ISSUER}"
  echo "▸ Notarizing (this can take a few minutes)…"
  xcrun notarytool submit "$OUT_DMG" \
    --key "$NOTARY_KEY_P8" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait
  xcrun stapler staple "$OUT_DMG"
  # Verify the app inside is Gatekeeper-accepted as a notarized Developer ID app.
  MP="$(mktemp -d)"
  hdiutil attach "$OUT_DMG" -nobrowse -mountpoint "$MP" >/dev/null
  spctl -a -t exec -vv "$MP/Pounce.app" 2>&1 | sed 's/^/    /'
  hdiutil detach "$MP" >/dev/null
fi

if [ "${SKIP_APPCAST:-}" = "1" ]; then
  echo "▸ SKIP_APPCAST=1 — not generating appcast"
else
  : "${GENERATE_APPCAST:?set GENERATE_APPCAST}"; : "${SPARKLE_KEY_FILE:?set SPARKLE_KEY_FILE}"; : "${DOWNLOAD_URL_PREFIX:?set DOWNLOAD_URL_PREFIX}"
  echo "▸ Generating signed appcast → $APPCAST_OUT"
  AC="$(mktemp -d)"
  cp "$OUT_DMG" "$AC/"   # single-item appcast: only the new DMG in the folder
  "$GENERATE_APPCAST" --ed-key-file "$SPARKLE_KEY_FILE" \
    --download-url-prefix "$DOWNLOAD_URL_PREFIX" "$AC/"
  cp "$AC/appcast.xml" "$APPCAST_OUT"
  rm -rf "$AC"
  echo "    enclosure: $(grep -oE 'url="[^"]+"' "$APPCAST_OUT" | head -1)"
  echo "    length:    $(grep -oE 'length="[0-9]+"' "$APPCAST_OUT" | head -1)"
fi

echo "▸ Done: $OUT_DMG"
