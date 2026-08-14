---
title: Troubleshooting
description: Pairing, connection, and Bridge issues — and how to fix them.
---

## First things to try

```sh
pounce status    # is the Bridge up? is the tunnel up? has a phone paired?
pounce logs -f   # watch the Bridge log live
```

(If you haven't installed globally, prefix with `npx use-pounce` → `npx
use-pounce status`, etc.)

## Diagnostics, from the phone

**Settings → Diagnostics** runs the same checks without going near a terminal —
useful when the machine in question is in another room, or another country.

It reports whether the Bridge is reachable, which agents it can see and which
it can only read history for, and where each one's sessions live on disk. An
agent showing as _history only_ means Pounce can read its past work but can't
start new turns — usually its command isn't on the Bridge's `PATH`. See [An
agent doesn't show up](#an-agent-doesnt-show-up).

## The phone can't find my machine after scanning

- **Same Wi-Fi?** If you started with `--lan`, the phone must be on the same
  network as the computer. Re-run without `--lan` to enable remote access.
- **iPhone Local Network permission.** The first connection on Wi-Fi triggers
  an iOS prompt for Local Network access. If it was dismissed, enable it in
  **Settings → Privacy & Security → Local Network → Pounce**.
- **Firewall.** The Bridge listens on port `8099`. If your firewall prompts,
  allow it — or start with `--port` to use a different one.

## "Works at home, not on cellular"

Remote access needs the tunnel, which starts automatically with the Bridge.
Check `pounce status` — if the tunnel isn't running, the usual cause is that
the `pounce-tunnel` binary couldn't be downloaded on first run (offline
install, blocked network). Run `pounce stop`, then start again with a normal
internet connection; the binary lands in `~/.pounce/bin/`.

Machines paired while the tunnel was down are LAN-only — run `pounce qr` and
scan again to upgrade the pairing.

## The QR expired or pairing failed halfway

Just run `pounce qr` (or restart the desktop app) and scan the fresh code.
Re-pairing a machine you already added is harmless — the phone updates what it
knows rather than creating a duplicate.

## Port already in use

Something else is on `8099`:

```sh
npx use-pounce --port 8123
```

## An agent doesn't show up

Pounce lists sessions for the agent CLIs installed on that machine — Claude
Code, Codex, Cursor, and opencode. Make sure the agent's CLI runs in a plain
terminal on the computer first; if it works there and still doesn't appear,
check `pounce logs` and [open an issue](https://github.com/pounce-ai/pounce/issues).

## Start over completely

```sh
pounce stop
rm -rf ~/.pounce
```

Then run `npx use-pounce` again for a fresh Bridge, token, and QR. On the
phone, remove the machine from the device list and re-scan.

## Still stuck?

[Open an issue](https://github.com/pounce-ai/pounce/issues) with the output of
`pounce status` and the tail of `pounce logs` — that's usually enough to
diagnose it.
