# Pounce Desktop (`@pounce/desktop`)

The desktop client — the same product as `apps/mobile`, built with
[expo-desktop](https://github.com/shirakaba/expo-desktop) on react-native-macos
and react-native-windows, **with the Pounce bridge merged into the app**: the
bridge launcher (`apps/bridge/desktop-launcher.mjs` — daemon bootstrap +
`server.mjs`) is bundled into the app's Resources at build time and spawned as
a child process at launch, and the app pairs with it automatically. Launch the
app and you're connected — no separate bridge install, no QR scan.

## Architecture: one shared source, thin platform seams

**All screens, components, state, and services live once in
`packages/app` (`@pounce/app`)** and are consumed by both apps:

- `apps/mobile` — expo-router route files that re-export `@pounce/app/screens/*`,
  plus mobile chrome (motion-tabs layouts) and native config. Expo SDK 57 / RN 0.86.
- `desktop/` — the master-detail shell (`src/shell/`), an expo-router shim
  (`src/shims/router.tsx`, mapped by Metro), the local-bridge auto-pairing
  service, and native config. Expo SDK 54 / RN 0.81 (the common minor of
  react-native-macos + react-native-windows) — which is why this package sits
  **outside** the bun workspace and resolves `@pounce/*` via Metro instead.

Platform divergence uses React Native's platform-file mechanism inside the
shared package — `.macos.ts` / `.windows.ts` forks (re-exporting a single
`.desktop.ts` impl) exist only where a library has no desktop build:

| Seam | Mobile | Desktop |
|---|---|---|
| `services/persistence` | MMKV | AsyncStorage |
| `services/secureStore` | expo-secure-store | AsyncStorage (Keychain follow-up) |
| `services/streamTurn` | nitro-fetch streaming | XHR progressive events |
| `services/transport` | Iroh (nitro) or HTTP | HTTP only |
| `services/voice` | expo-speech-recognition | hidden |
| `services/imagePicker` | expo-image-picker | stub |
| `components/Skeleton` | Boneyard + Reanimated | core Animated |
| `components/Providers` | gesture/keyboard/HeroUI | safe-area + query |
| `components/QrScanner` | expo-camera | manual-entry notice |

Everything else — uniwind styling, Legend State/List, the Timeline (with the
shared pure-JS Markdown renderer), Composer, git flows, stores — is byte-for-byte
the same code on iOS, Android, macOS, and Windows.

Desktop's `metro.config.js` does three jobs: adds the `macos`/`windows`
platforms + `react-native` export conditions, maps `expo-router` → the shell
shim and `@pounce/*` → package sources, and re-anchors bare imports from
`../packages` into `desktop/node_modules` so the workspace root's RN 0.86
never leaks into the 0.81 bundle. Runtime tsconfig-paths are disabled
(`app.json` → `experiments.tsconfigPaths: false`); the tsconfig `paths` exist
for type-checking only (with `moduleSuffixes: [".macos", ""]`).

## Running (macOS)

```sh
bun install                # repo root — workspace + bridge deps
cd desktop && bun install  # desktop's own RN 0.81 tree

bun run macos              # builds + launches app and Metro
```

If port 8081 is taken, run Metro elsewhere and point the app at it once:
`bunx expo start --port 8082` +
`defaults write com.pounce.desktop RCT_jsLocation "localhost:8082"`
(`RCT_METRO_PORT` is compile-time in RN, not a runtime env var).

The app is **unsandboxed on purpose** (see `PounceDesktop.entitlements`): the
embedded bridge reads agent transcripts, drives agent CLIs, and runs git natively; off-LAN access rides the pounce-tunnel iroh p2p tunnel (apps/tunnel).
Distribute via Developer ID, not the Mac App Store.

## Windows

`windows/` scaffolding is committed (expo-desktop has no prebuild; native dirs
are source-controlled) and every `.windows.ts` seam is in place, but the
bridge-spawn build phase equivalent hasn't been wired into the `.vcxproj` yet.

## Known gaps / follow-ups

- **Direct Iroh transport**: `packages/nitro`'s Rust crate should cross-compile
  to `aarch64-apple-darwin`, but Nitro Modules has no macOS runtime — desktop
  would need a small hand-written native module over the same C FFI, behind
  the existing `services/transport` seam. The bridge covers all current
  functionality locally; Iroh matters for controlling *other* machines off-LAN.
- Secure storage is AsyncStorage-backed on desktop (plaintext at rest).
- Reanimated 4 needs the New Architecture, which this project doesn't enable
  on react-native-macos yet — motion-tabs and Boneyard skeletons stay mobile-only.
