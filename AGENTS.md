# AGENTS.md

Pounce monorepo: Expo/RN mobile app + desktop app + headless bridge for driving
coding agents (Claude, Codex, opencode) from a phone. Bun workspace, TypeScript, oxlint/oxfmt.

## Layout — boundaries that aren't obvious from filenames

| Path | What | Notes |
|---|---|---|
| `apps/mobile` | Expo SDK 57 / RN 0.86 app | expo-router routes are thin re-exports of `@pounce/app/screens/*` |
| `apps/bridge` | Bridge server (`server.mjs`) | Plain Node ESM, **no build step**. Port 8099; env: `BRIDGE_PORT`, `BRIDGE_TOKEN`, `POUNCE_TUNNEL_BIN` |
| `apps/tunnel` | iroh p2p tunnel | **Rust crate** (cargo), not a bun package |
| `packages/app` | `@pounce/app` — ALL shared screens/state/services for mobile **and** desktop | Ships raw TS; each consumer's Metro compiles it. Its `typecheck` script is a deliberate no-op echo — it's typechecked via `apps/mobile` and `desktop` tsc runs |
| `packages/transcript` | Transcript normalizer | Authored in **JS + hand-maintained `.d.ts`**, zero deps — don't convert to TS |
| `packages/{shared,runtime,ui}` | Types / transport / UI primitives | Plain TS, `tsc` buildable |
| `packages/nitro` | Prebuilt iOS xcframework + nitrogen output | Not a workspace package; lint-ignored |
| `desktop/` | Desktop app (expo-desktop → RN-macos/windows), RN 0.81 | **Separate project, own lockfile — NOT in the bun workspace.** Needs its own `bun install`. See `desktop/README.md` (authoritative for the platform-seam table) |
| `bridge-desktop/` | Deprecated Electrobun app | Dead; lint/format-ignored. Don't touch |
| `docs/` | Landing page (GitHub Pages, CNAME `use-pounce.com`) | Static HTML |

Platform divergence lives in `.macos.ts` / `.windows.ts` files (usually re-exporting one
`.desktop.ts`) **inside `packages/app`** — never fork code per app.

## Commands (verified)

```bash
bun install                     # workspace only (apps/* + packages/*)
bun run lint                    # oxlint — errors fail CI, ~28 pre-existing warnings are tolerated
bun run typecheck               # tsc across workspace
bun run test                    # vitest (packages, bridge) + jest-expo (mobile)
bun run build                   # tsc build of packages/* only
bun run mobile                  # expo start (mobile)
bun run bridge                  # node apps/bridge/server.mjs  (bridge:restart to bounce it)

# Single package:
bun run --filter @pounce/shared test
bun run --filter @pounce/mobile typecheck

# Desktop (separate install — both are required for its typecheck, because
# packages/app's bare imports resolve up to the ROOT node_modules):
cd desktop && bun install && bun run macos      # or: bun run typecheck

# Headless bridge bundle (self-contained, runs with only Node on the host):
bun run bridge:pack             # → dist/pounce-bridge
```

## CI gate (`ci.yml`) — match it before considering work done

lint → format → typecheck → test, plus a desktop typecheck job.

**Format is incremental**: oxfmt is enforced only on files *added* in the PR
(`git diff --diff-filter=A`). Repo-wide `bun run format:check` fails on legacy files by
design. Run `bunx oxfmt` on files you create; **do not reformat pre-existing files** —
it buries real changes in churn.

## Gotchas

- **`bunfig.toml` `linker = "hoisted"` is load-bearing** — Metro can't resolve bun's
  isolated symlink store. Never change it; EAS reads it too.
- **Stale expo-router typed routes**: if `@pounce/mobile` typecheck fails with
  `"/sessions" is not assignable to ...`-style href errors, the generated
  `apps/mobile/.expo/types/router.d.ts` is stale. Run `bunx expo start` once in
  `apps/mobile` and kill it — regenerates the types, typecheck goes green. Not a code bug.
- React versions are pinned by `overrides`: root pins react 19.2.3 + expo-font 57.0.0;
  `desktop/` pins react 19.1.4 / RN 0.81.6 and carries a `patchedDependencies` patch on
  react-native-macos. Don't bump one side casually.
- Desktop is intentionally **unsandboxed** (entitlements) — the embedded bridge spawns
  agent CLIs and runs git natively. Distribute via Developer ID, never Mac App Store.
- Rust changes in `apps/tunnel` build with cargo (`build-ios.sh` produces the iOS
  staticlib consumed via `packages/nitro/ios/LitterIroh.xcframework`).
- **opencode ≥1.18 stores sessions in new sqlite tables** in
  `~/.local/share/opencode/opencode.db`: `session_v2` + `session_message` (parts inline
  as `data.content[]`, tool output in `state.content`), NOT the legacy
  `session`/`message`/`part` tables. Both schemas can coexist; the bridge's opencode
  adapter (`apps/bridge/agents/opencode.mjs`) probes `sqlite_master` and prefers v2.
  Symptom of reading only legacy: opencode sessions silently vanish from the bridge/MCP.

## Release (README's `bridge-v*` section is STALE — that workflow was deleted in #55)

Real flow is `.github/workflows/desktop-release.yml`, **manual `workflow_dispatch` only**:

1. Bump `CFBundleShortVersionString` + `CFBundleVersion` in
   `desktop/macos/PounceDesktop-macOS/Info.plist` in a PR, merge.
2. Run the workflow from main (`dry_run` to skip publishing).
3. It tags `desktop-v*`, builds/signs/notarizes the DMG, packs the cross-platform bridge
   bundle, and publishes one GitHub Release with the Sparkle `appcast.xml`. The release
   **must remain "latest"** — Sparkle polls `releases/latest/download/appcast.xml`.

iOS: `bun run testflight` (TestFlight) / `bun run publish:ios` (EAS production +
auto-submit); App Store metadata lives in `apps/mobile/metadata/`.
