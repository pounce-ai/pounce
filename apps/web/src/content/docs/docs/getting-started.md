---
title: Getting started
description: Pair your phone with your computer in about two minutes — one command, one QR scan.
---

Two minutes, three steps.

## 1. Get the app on your phone

- **iPhone** — [download Pounce on the App Store](https://apps.apple.com/app/id6779601425).
- **Android** — in testing on Google Play; public release soon.

## 2. Start Pounce on your computer

Pick whichever feels most like you — they all do the same thing: start the
Bridge on that machine and show a pairing QR.

```sh
npx use-pounce
```

That's the fastest path, and it works in any terminal — even over SSH to a
server on the other side of the world.

Prefer an app? On a **Mac**, [download the desktop app](https://github.com/pounce-ai/pounce/releases/latest)
(`Pounce.dmg`) — the Bridge is built in and the QR appears in the window. On
**Windows or Linux**, grab the headless Bridge bundle from the same page. See
[Install](/docs/install) for details on each.

## 3. Scan the QR

Open Pounce on your phone, tap **Sync a device**, and point the camera at the
code. (The built-in camera app works too — it opens Pounce straight to
pairing.)

That's it. Your machine's agent sessions sync instantly, and the phone keeps a
private, per-machine token so only you can connect. Pairing once is enough —
when you're away from home, Pounce reaches the same machine over its own
secure tunnel automatically. No VPN, no port-forwarding, nothing else to set
up.

## What you'll see

- **Home** — every agent, on every machine you've paired, with the threads
  that **need your input** floated to the top.
- **A live session** — reasoning, tool calls, and diffs streaming in real
  time. Reply, redirect, or answer prompts right there; hold to talk if your
  hands are full.
- **Changes** — the diff for any session. Commit, push, or open a PR from your
  phone.

## Next steps

- Pair more machines the same way — they all show up in one fleet.
- [Supported agents](/docs/agents) — what works with Claude Code, Codex,
  Cursor, and opencode.
- [Away from home](/docs/remote-access) — how remote access works, and how to
  pair a machine you only reach over SSH.
- [CLI reference](/docs/cli) — everything `npx use-pounce` can do.
