#!/usr/bin/env bash
# Publish Pounce to TestFlight (iOS) and the Play internal track (Android).
#
#   bash scripts/publish-testflight.sh            # iOS
#   bash scripts/publish-testflight.sh android    # Android
#
# Credentials already live on EAS servers (App Store Connect API key for iOS,
# keystore + the local Play service-account JSON for Android), so this runs
# unattended — no prompts, nothing to paste.
#
# EAS_NO_VCS=1 is LOAD-BEARING, not a convenience. The tunnel's native cores are
# gitignored — the 412MB ios/PounceTunnelCore.xcframework and the per-ABI
# android/src/main/jniLibs/*/libpounce_tunnel.so — so a git-based pack drops them
# and produces an app whose tunnel is silently missing. Only the .easignore path
# (which EAS uses solely when EAS_NO_VCS=1) carries them up. Build them first
# with modules/pounce-tunnel/build-ios.sh / build-android.sh if they're absent.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/apps/mobile"

PLATFORM="${1:-ios}"
case "$PLATFORM" in
  ios | android) ;;
  *)
    echo "usage: $0 [ios|android]" >&2
    exit 2
    ;;
esac

# Fail loudly here rather than shipping a tunnel-less build that only misbehaves
# once it's on someone's phone.
if [ "$PLATFORM" = "ios" ]; then
  CORE="modules/pounce-tunnel/ios/PounceTunnelCore.xcframework"
else
  CORE="modules/pounce-tunnel/android/src/main/jniLibs/arm64-v8a/libpounce_tunnel.so"
fi
if [ ! -e "$CORE" ]; then
  echo "missing $CORE — build it before publishing, or the tunnel ships broken" >&2
  exit 1
fi

echo "  Pounce → $([ "$PLATFORM" = ios ] && echo TestFlight || echo 'Play internal')"
echo "  version $(node -p "require('./app.json').expo.version")"
echo

exec env EAS_NO_VCS=1 npx eas-cli build \
  --platform "$PLATFORM" \
  --profile production \
  --auto-submit \
  --non-interactive
