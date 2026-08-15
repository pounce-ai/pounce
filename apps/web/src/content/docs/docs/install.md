---
title: Install
description: Every way to get Pounce — iPhone, Android, the macOS desktop app, the Windows/Linux Bridge, and the npx CLI.
---

Pounce is two halves: the **phone app** (the remote) and the **Bridge** (the
part on your computer that hosts your agents). Install one of each.

## Phone

### iPhone

[**Download Pounce on the App Store**](https://apps.apple.com/app/id6779601425).
Requires iOS 16 or later.

### Android

In testing on Google Play now — public release soon. The
[changelog](/changelog) will announce it the day it's out.

## Computer

### Not sure which? Let it decide

```sh
npx use-pounce configure
```

One command on any machine with Node.js. It works out what the machine is — OS,
chip, whether there's a screen, whether you're on the other end of an SSH
connection — then offers you the desktop app or a Bridge that starts at login,
and installs the one you pick. Everything below is the same thing done by hand.

### macOS — the desktop app

[Download `Pounce.dmg`](https://github.com/pounce-ai/pounce/releases/latest)
— signed and notarized, macOS 14+ on Apple Silicon. Open it, drag Pounce to
Applications, launch. The full Pounce UI runs on your Mac with the Bridge built
in, and the pairing QR is right in the window.

Intel Macs are not supported by the desktop app — use `npx use-pounce` below
instead.

The app keeps itself up to date automatically.

### Windows · Linux — the headless Bridge

Download `pounce-bridge.zip` from the
[latest release](https://github.com/pounce-ai/pounce/releases/latest), unzip,
and run `install.ps1` (Windows) or `install.sh` (Linux). Needs Node.js on the
machine. It starts the Bridge and prints the pairing QR.

### Any terminal — `npx use-pounce`

```sh
npx use-pounce
```

One command on any machine with Node.js — macOS, Windows, or Linux. It starts
the Bridge in the background, prints a QR in the terminal, and waits for your
scan. The Bridge keeps running after you close the terminal.

Works over SSH too, so it's the easiest way to pair a remote server — see
[Away from home](/docs/remote-access).

Installing globally makes the command just `pounce`:

```sh
npm i -g use-pounce
pounce
```

The [CLI reference](/docs/cli) covers every subcommand and flag.
