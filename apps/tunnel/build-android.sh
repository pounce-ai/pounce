#!/usr/bin/env bash
# Cross-compile pounce-tunnel's cdylib for Android and drop one .so per ABI into
# the Expo module's jniLibs, where gradle picks them up with no native build of
# its own. The Android counterpart of build-ios.sh; same shape, less ceremony —
# a .so needs no framework wrapper.
#
# Output: ../mobile/modules/pounce-tunnel/android/src/main/jniLibs/<abi>/libpounce_tunnel.so
#
# Needs: rustup Android targets and cargo-ndk
#   rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
#   cargo install cargo-ndk
# and an NDK — ANDROID_NDK_HOME, or the newest one under $ANDROID_HOME/ndk.
set -euo pipefail
cd "$(dirname "$0")"

# The Android target stdlibs are installed via rustup — Homebrew's cargo can't
# see them, so force the rustup toolchain regardless of PATH order.
export PATH="$HOME/.cargo/bin:$PATH"

# Matches Expo SDK 57 / React Native 0.86's minSdk. Building against a lower API
# would link fine and then fail at load on nothing in particular.
API=24
OUT=../mobile/modules/pounce-tunnel/android/src/main/jniLibs

if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
  SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  # Newest installed NDK. Sorted with -V so 27.1 beats 27.0 rather than losing
  # to it the way a plain lexical sort would have it.
  ANDROID_NDK_HOME=$(find "$SDK/ndk" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort -V | tail -1)
  export ANDROID_NDK_HOME
fi
if [[ -z "$ANDROID_NDK_HOME" || ! -d "$ANDROID_NDK_HOME" ]]; then
  echo "no Android NDK found — set ANDROID_NDK_HOME, or install one via Android Studio" >&2
  exit 1
fi
echo "▸ NDK $ANDROID_NDK_HOME"

# x86 (32-bit) is deliberately absent: no such device has shipped in years, and
# every ABI is a full LTO build of iroh. arm64 is real phones, armeabi-v7a the
# long tail, x86_64 the emulator everyone develops against.
rm -rf "$OUT"
mkdir -p "$OUT"
cargo ndk \
  --platform "$API" \
  -t arm64-v8a \
  -t armeabi-v7a \
  -t x86_64 \
  -o "$OUT" \
  build --release --lib

# cargo-ndk copies EVERY cdylib it finds in the target dir, not just ours —
# iroh and iroh-relay build their own, and they were riding along into the AAR
# as ~3.5MB of libraries nothing loads (the armeabi-v7a ones being 2.8KB stubs).
# Ours is the only one Kotlin ever calls System.loadLibrary on.
find "$OUT" -name '*.so' ! -name 'libpounce_tunnel.so' -delete

# cargo-ndk is happy to report success having produced nothing if the crate has
# no cdylib — check rather than hand gradle an empty directory.
for abi in arm64-v8a armeabi-v7a x86_64; do
  so="$OUT/$abi/libpounce_tunnel.so"
  [[ -f "$so" ]] || { echo "missing $so" >&2; exit 1; }
  printf '  %-12s %s\n' "$abi" "$(du -h "$so" | cut -f1)"
done

echo "✓ $OUT"
