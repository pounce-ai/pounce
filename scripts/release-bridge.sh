#!/usr/bin/env bash
# One-shot signed + notarized release of the macOS Bridge app.
#
# Prereq (one manual step): create a "Developer ID Application" certificate at
# developer.apple.com (Account Holder only) using ~/.pounce-signing/devid.csr,
# and download the .cer.
#
#   bash scripts/release-bridge.sh [path-to.cer]
#
# Does: import cert+key → sign build → notarize (via `asc`) → staple → GitHub Release.
set -euo pipefail

CER="${1:-$HOME/Downloads/developerID_application.cer}"
SIGN_DIR="$HOME/.pounce-signing"
KEY="$SIGN_DIR/devid.key"
P12="$SIGN_DIR/devid.p12"
P12_PASS="pounce-bridge"
TEAMID="${ELECTROBUN_TEAMID:-RH8HV49PWL}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/bridge-desktop"

# Reuse an already-imported Developer ID identity if the keychain has one — then
# no .cer is needed. Only import from cert+key when the keychain has none.
ID=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)"/\1/')
if [ -z "$ID" ]; then
  [ -f "$CER" ] || { echo "❌ no Developer ID identity in keychain and cert not found: $CER  (create it from $SIGN_DIR/devid.csr)"; exit 1; }
  [ -f "$KEY" ] || { echo "❌ private key not found: $KEY"; exit 1; }
  echo "▸ Importing Developer ID identity into the keychain…"
  openssl x509 -inform DER -in "$CER" -out "$SIGN_DIR/devid.pem" 2>/dev/null || cp "$CER" "$SIGN_DIR/devid.pem"
  openssl pkcs12 -export -legacy -inkey "$KEY" -in "$SIGN_DIR/devid.pem" \
    -out "$P12" -passout "pass:$P12_PASS" -name "Developer ID Application"
  security import "$P12" -k "$HOME/Library/Keychains/login.keychain-db" \
    -P "$P12_PASS" -T /usr/bin/codesign >/dev/null 2>&1 || \
  security import "$P12" -P "$P12_PASS" -T /usr/bin/codesign
  ID=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)"/\1/')
  [ -n "$ID" ] || { echo "❌ no Developer ID Application identity after import"; exit 1; }
else
  echo "▸ Using existing Developer ID identity from keychain."
fi
echo "  identity: $ID"

echo "▸ Building signed app…"
cd "$APP"
[ -d node_modules ] || bun install
# Bundle the canonical bridge server into a self-contained file so its workspace
# imports (@litter/transcript) and deps (qrcode/qrcode-terminal) are inlined —
# the copied server.mjs runs as its own process with no monorepo node_modules.
[ -d "$ROOT/node_modules/@litter/transcript" ] || (cd "$ROOT" && bun install)
mkdir -p server && bun build "$ROOT/apps/bridge/server.mjs" --target=node --outfile server/server.mjs
export ELECTROBUN_DEVELOPER_ID="$ID"
export ELECTROBUN_TEAMID="$TEAMID"
./node_modules/.bin/electrobun build --env=stable
DMG=$(ls -t artifacts/*.dmg | head -1)
echo "  built: $APP/$DMG"

echo "▸ Notarizing via asc (uses your stored App Store Connect key)…"
asc notarization submit --file "$DMG" --wait
echo "▸ Stapling…"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG" && echo "  ✓ stapled & valid"
cp "$DMG" artifacts/Pounce.dmg

VERSION="v$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)"
echo "▸ Creating GitHub Release ${VERSION}…"
cd "$ROOT"
# Upload the installer + the auto-update artifacts (update.json + bundle + any
# BSDIFF patch). The bridge's updater reads them from the rolling `bridge-latest`
# release (see bridge-desktop/electrobun.config.ts), which is refreshed below.
UPDATE_ASSETS=()
for f in "$APP/artifacts/"stable-macos-*; do
  case "$f" in *.dmg) continue ;; esac   # skip the duplicate stable-*.dmg
  UPDATE_ASSETS+=("$f")
done
[ ${#UPDATE_ASSETS[@]} -gt 0 ] || { echo "❌ no stable-macos-* update artifacts in $APP/artifacts — installs would never self-update"; exit 1; }
ASSETS=("$APP/artifacts/Pounce.dmg" "${UPDATE_ASSETS[@]}")
# --latest=false is load-bearing, and this script shipped without it: GitHub's
# "latest" belongs to the macOS desktop app, whose Sparkle feed resolves through
# releases/latest/download/appcast.xml. A bridge release that grabs "latest"
# 404s that feed — and the URL is baked into every shipped build, so desktop
# auto-update stays dead until the next desktop release takes the title back.
gh release create "$VERSION" "${ASSETS[@]}" \
  --title "Pounce ${VERSION}" \
  --latest=false \
  --notes "Signed + notarized macOS build (Apple Silicon). Download Pounce.dmg, open it, drag Pounce to Applications, launch, and scan the QR with the Pounce app. Installs from v1.0.2+ update automatically."

# Deliberately NOT refreshing `bridge-latest` here. That rolling channel is what
# every installed tray app polls, and it is shared by all platforms — but this
# script builds macOS only. Pushing this run's assets into it would leave the
# win/linux entries behind from whatever CI last published, against notes still
# naming CI's version, which is the partial-set state release-bridge.yml runs
# four platforms with `fail-fast: false` specifically to prevent. It also has no
# equivalent of the workflow's package.json/electrobun.config.ts version gate —
# and that value is the one the updater compares.
#
# So a build cut here installs but does not self-update. Run the Release Bridge
# workflow to publish the channel; it holds the same signing secrets and does
# the whole set.
echo "✅ Done — notarized build is live on the Releases page."
echo "   Note: bridge-latest was NOT refreshed. Run the Release Bridge workflow"
echo "   to publish an update the installed tray apps will actually pick up."
