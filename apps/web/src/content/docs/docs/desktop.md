---
title: The desktop app
description: The full Pounce experience on macOS — the whole fleet in a window, with the Bridge built in.
---

The desktop app is the whole Pounce experience on your Mac: the same fleet,
live sessions, filters, and diff review as the phone — in a resizable window,
with keyboard and voice — plus the Bridge built in, so installing it also
makes the machine pairable.

## Install

[Download `Pounce.dmg`](https://github.com/pounce-ai/pounce/releases/latest) —
signed and notarized, macOS 14 or later on Apple Silicon. Open the DMG, drag
Pounce to Applications, launch.

Intel Macs are not supported. If you're on an Intel Mac, run `npx use-pounce`
instead — see [Install](/docs/install/) — and drive it from your phone.

On first launch the app starts hosting the agents on that Mac and shows the
pairing QR — scan it with your phone and the machine joins your fleet.

## Updates

The app checks for updates and installs them automatically — you'll always be
on the latest release without doing anything. New versions land in the
[changelog](/changelog).

## Windows & Linux

The full desktop app is macOS-only today. On Windows and Linux, run the
headless [Bridge](/docs/install#windows--linux--the-headless-bridge) (or
`npx use-pounce`) — your phone provides the UI.
