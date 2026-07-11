> **SUPERSEDED (2026-07-11):** off-LAN access shipped via **pounce-tunnel**
> (apps/tunnel — iroh p2p byte tunnel + the PounceTunnel Expo module in
> apps/mobile/modules/pounce-tunnel). This package's direct-dial design below
> is historical reference only and targets a daemon Pounce no longer uses.

# NitroLitter — native Iroh client (full remote reach)

Goal: let the app talk **directly** to the alleycat daemon over Iroh (P2P, NAT
traversal) instead of through the LAN HTTP bridge — so you control your fleet
**from anywhere**, not just same-wifi.

## Architecture

```
JS (app)
  └─ IrohTransport  (packages/nitro/src/irohTransport.ts)   ✅ exists
      └─ NitroLitter HybridObject  (NitroLitter.nitro.ts)    ✅ spec exists
          └─ Swift HybridNitroLitter                          ❌ to build
              └─ litter-iroh  (Rust staticlib, this crate)    🟡 dial layer done
                  └─ iroh 0.98.2 QUIC + alleycat framing
```

The native side dials by `node_id` (+ `relay`) from the `PairPayload`, then
speaks the **same JSON-RPC protocol** as the bridge — JS sees one surface.

## What's verified / done (whole Rust layer, `cargo check` green)

- **iroh pinned to 0.98.2** (matches the daemon), **ALPN `alleycat/1`**.
- **Dial**: `Endpoint::builder(presets::N0).bind()` →
  `EndpointAddr::new(EndpointId).with_relay_url(relay)` → `connect(addr, ALPN)`.
- **Protocol** (`Connection::{list_agents, request}`): length-prefixed `connect`
  handshake → JSONL `initialize`/`initialized`/method + streamed notifications.
- **JSONL codec** imported from upstream `alleycat-bridge-core` (git dep).
- **C ABI FFI** (`src/ffi.rs` + `include/litter_iroh.h`): `litter_connect`,
  `litter_list_agents`, `litter_request` (with event callback), `litter_disconnect`,
  `litter_string_free` — process-wide tokio runtime + handle registry.
- **iOS build** scripted: `rust/build-ios.sh` (xcframework via lipo).
- **Swift skeleton**: `ios/HybridNitroLitter.swift` (bridges the spec to the FFI).

## Remaining

1. ✅ **DONE** — `ios/LitterIroh.xcframework` (device + sim). Upstream alleycat
   crates cross-compile to iOS cleanly. Module map (`LitterIroh`) embedded so
   Swift can `import LitterIroh`.
2. ✅ **DONE** — codegen. The package is **`nitrogen`** (not `nitro-codegen`);
   `nitrogen@0.35.9` matches the runtime. `bunx nitrogen` generated 28 files in
   `nitrogen/generated/` (Swift spec + C++ bridges + autolinking).
3. ✅ **DONE** — `ios/HybridNitroLitter.swift` conforms to the full generated
   spec (connect/disconnect/listAgents/sendMessage/createTask wired to the FFI;
   git/terminal/project throw "not over Iroh yet" — those use the HTTP bridge
   today). `NitroLitter.podspec` vendors the xcframework + loads the nitrogen
   autolinking.
4. ✅ **DONE** — the app **builds with the native module** (simulator `** BUILD
   SUCCEEDED **`). Integration gotchas that were solved:
   - `react-native.config.js` + `react-native` field on `@litter/nitro` so RN
     autolinking discovers it.
   - CocoaPods silently ignores **static-library** xcframeworks → repackage as a
     **static-framework** xcframework (`build-ios.sh` does this).
   - `vendored_frameworks` path is relative to the podspec — `ios/LitterIroh.xcframework`.
   - Link `SystemConfiguration`, `Security`, `CoreFoundation` (iroh deps).
5. ✅ **DONE** — `IrohTransport` is wired in `runtime.ts buildTransport()`,
   gated by `isNitroLitterAvailable()` (HTTP fallback when the native module
   isn't in the build).

## To actually use Iroh remote-reach
- Install a fresh dev client on device: `cd apps/mobile && npx expo run:ios
  --device` (re-apply `DEVELOPMENT_TEAM = RH8HV49PWL` if prebuild ran).
- Pair via a daemon **PairPayload** (`kittylitter pair --qr`) saved through
  `savePairing()` → `connectSaved()` uses `IrohTransport` (direct Iroh, works
  off-LAN). A "pair via Iroh" UI is the remaining product step.

## Wire protocol (verified, sourced from upstream)

`Connection::{list_agents, request}` are implemented and `cargo check`-green:
- Per-agent stream: **length-prefixed** `connect` handshake
  (`{op,v,token,agent}`) → check `ok` → switch to **JSONL** → `initialize` →
  `initialized` → method (id=2); frames without `id` are notifications.
- ALPN `alleycat/1`, PROTOCOL_VERSION 1.

Source of truth = the **third-party open-source `dnakov/alleycat`** (depend on
its published crates; no vendoring/forking):
- JSONL codec imported from **`alleycat-bridge-core::framing`** (git dep). ✅
- Length-prefixed handshake + `protocol` types (`Request`/`Response`/
  `ALLEYCAT_ALPN`) are **private** in the `alleycat` daemon crate, so they can't
  be imported. `lib.rs` has a minimal **wire-conformance shim** (the stable
  protocol contract — not their Rust source). Optional: upstream a PR exposing
  those modules `pub`; not required for correctness.

## Remaining work (once unblocked)

1. Fill `Connection::request()` + a `subscribe()` notification loop using
   alleycat framing.
2. Expose a C ABI / uniffi surface matching `NitroLitter.nitro.ts` (connect,
   listAgents, sendMessage, subscribe, git, terminal) — JSON in/out.
3. `rustup` + iOS targets, run `build-ios.sh` → `LitterIroh.xcframework`.
4. Swift `HybridNitroLitter` implementing the spec, calling the FFI.
5. Restore `nitro.json` (from `nitro.json.deferred`) and run nitro-codegen.
   ⚠️ Do NOT restore it before the Swift impl exists — it breaks the app build.
6. Wire `IrohTransport` into `runtime.ts` pairing path; QR already carries the
   `PairPayload` (node_id/relay/token).

## Toolchain note

Homebrew rust has no `rustup`; install rustup + `aarch64-apple-ios*` targets for
the cross-compile.
