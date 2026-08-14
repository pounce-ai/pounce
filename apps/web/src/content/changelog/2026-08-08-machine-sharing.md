---
title: "Lend another machine your threads — read-only, scoped, and it expires"
date: 2026-08-08
component: bridge
---

Until now a machine's agent history was yours alone. That's the right default
and a bad ceiling: the person debugging beside you can't see what you already
tried, and neither can your own laptop when the work happened on the build box.

Machines running Pounce now find each other on the network, and one can **ask
another for access**. The owner decides what and for how long. The answer is
always read-only — browse threads, messages, diffs and search, but never send a
turn, run a command, or read the machine's setup.

**You can't tick a project you've never seen, so asking happens twice.** First a
short _preview_, good for nothing but a catalog: project names with counts and
dates, and a search over thread names. No messages, no paths, no branches, and
it lapses in five minutes. You pick from that, then ask for read access to what
you picked. Both steps stop at a person — nothing is ever granted automatically.
Each request shows the same six-digit code on both screens, so the one approving
can tell a colleague's laptop from a stranger on the café wifi.

**Scope is a real boundary, not a filter.** A grant reaches an allowlist of
read-only routes, so anything added to Pounce later is closed to it by default.
Ask for a thread outside your scope and you get "not found" rather than
"forbidden", because the difference would map what else is on the machine.
Threads started later in a project you shared _do_ appear — the project is what
was agreed to, not a snapshot of that moment.

**And it ends.** An hour, eight hours, a day, a week, or never. When it lapses
or you revoke it, the other machine is told exactly that, so the threads leave
its sidebar instead of lingering as "offline". Off-network access rides its own
peer-to-peer tunnel per grant, which is closed at the same moment.

**Your computer stays hidden until you make it visible.** Others would see its
name, and a computer's name is usually a person's, so Pounce keeps quiet on the
networks you join until you say otherwise — from the app, the page, or
`pounce peers --visible on`. Staying hidden doesn't shut you out: a computer
that knows your address can still ask, and you can still ask it.

All of it lives in the Bridge, which means it works everywhere the Bridge does.
The Mac app has it in the sidebar; on Windows, Linux, or a server you've SSH'd
into, open `http://127.0.0.1:8099/peers` in a browser, or stay in the terminal:

```sh
pounce peers                       # who's nearby, who's asking, who has access
pounce ask work-laptop --spaces api
pounce approve 418207 --hours 8
pounce revoke e1f71ab0
```

[How sharing works →](/docs/sharing)
