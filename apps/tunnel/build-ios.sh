#!/usr/bin/env bash
# Cross-compile pounce-tunnel's staticlib and package it as a static-framework
# xcframework (CocoaPods links framework xcframeworks reliably; bare static-lib
# ones it silently skips — same lesson as packages/nitro/rust/build-ios.sh).
# Output: ../mobile/modules/pounce-tunnel/ios/PounceTunnel.xcframework
set -euo pipefail
cd "$(dirname "$0")"

# The iOS target stdlibs are installed via rustup — Homebrew's cargo can't see
# them, so force the rustup toolchain regardless of PATH order.
export PATH="$HOME/.cargo/bin:$PATH"

LIBNAME=libpounce_tunnel.a
OUT=../mobile/modules/pounce-tunnel/ios/PounceTunnel.xcframework
TMP=$(mktemp -d)

for t in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  echo "▸ building $t"
  cargo build --release --lib --target "$t"
done

mkdir -p target/sim-universal
lipo -create \
  target/aarch64-apple-ios-sim/release/$LIBNAME \
  target/x86_64-apple-ios/release/$LIBNAME \
  -output target/sim-universal/$LIBNAME

wrap_framework() { # $1 = static lib, $2 = dest dir
  local lib="$1" dir="$2"
  local fw="$dir/PounceTunnel.framework"
  mkdir -p "$fw/Headers" "$fw/Modules"
  cp "$lib" "$fw/PounceTunnel"
  cp include/pounce_tunnel.h "$fw/Headers/"
  printf 'framework module PounceTunnel {\n  umbrella header "pounce_tunnel.h"\n  export *\n}\n' > "$fw/Modules/module.modulemap"
  cat > "$fw/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.pounce.PounceTunnel</string>
<key>CFBundleName</key><string>PounceTunnel</string>
<key>CFBundleExecutable</key><string>PounceTunnel</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>MinimumOSVersion</key><string>16.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
</dict></plist>
EOF
}

wrap_framework target/aarch64-apple-ios/release/$LIBNAME "$TMP/device"
wrap_framework target/sim-universal/$LIBNAME "$TMP/sim"

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
xcodebuild -create-xcframework \
  -framework "$TMP/device/PounceTunnel.framework" \
  -framework "$TMP/sim/PounceTunnel.framework" \
  -output "$OUT"
rm -rf "$TMP"

echo "✓ $OUT"
