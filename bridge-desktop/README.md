# Pounce Bridge (desktop) — DEPRECATED

**This app is deprecated.** The standalone desktop Bridge has been superseded by
the **Pounce desktop app** (`desktop/` at the repo root), which is the full
Pounce UI for macOS/Windows with the bridge server embedded — it spawns
`apps/bridge` internally on launch, self-pairs, and shows the phone-pairing QR
from its own Pair screen. There is nothing this wrapper does that the desktop
app doesn't.

The code stays for reference and for existing installs' auto-update channel,
but no new releases are planned: the `bridge-v*` tag trigger has been removed
from CI (`.github/workflows/release-bridge.yml` can still be run manually via
workflow_dispatch if an emergency patch for old installs is ever needed).

Last released version: **1.0.20**.
