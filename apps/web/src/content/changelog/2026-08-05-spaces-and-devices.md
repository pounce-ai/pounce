---
title: "One project, one row. One machine, one device."
date: 2026-08-05
component: desktop
version: "1.0.30"
link: https://github.com/pounce-ai/pounce/releases/latest
---

Two things that should have been one thing were showing up as several.

**Worktrees now live with their project.** If you cut worktrees off a
repository — by hand or through a tool that makes them for you — they group
under that project instead of scattering into rows of their own. Pounce works
this out by asking git rather than reading the path, so it holds for whatever
made the worktree, and keeps holding for branches you merged and deleted long
ago. On one machine here that turned 53 entries into 36.

**And a machine you've already paired stays one device.** Identity now comes
from the machine itself rather than the address your phone reached it at — so
pairing the same computer at home, on a café's wifi, and after your router
hands out a new lease no longer files it three times. Where duplicates already
existed, their sessions move onto the device you kept rather than being
dropped.

Both fixes live in the Bridge, so they arrive with the desktop app or with
`npx use-pounce` — nothing to configure.
