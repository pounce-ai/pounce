---
title: Sharing with another machine
description: Let someone else's computer read your agent threads — scoped to the projects you choose, read-only, and with an expiry. Works from the app, a browser, or the terminal.
---

Your threads live on your machine, and normally nobody else can see them. But
sometimes you want them to: a colleague debugging the thing you were debugging,
your own laptop reading what the build box did overnight, a pairing session
where the other person needs the context and not a screen share.

Pounce lets one machine ask another for access. The owner decides **what** and
**for how long**, and the answer is always read-only.

## What "access" means here

A grant is deliberately narrow:

- **Read-only.** The other machine can browse threads, messages, diffs, activity
  and search. It cannot send a turn, run a command, read your config, or pair
  anything.
- **Scoped.** Everything, or particular projects, or individual threads. New
  threads in a project you shared do appear — the project is what you agreed to,
  not a frozen snapshot of what was in it.
- **Timed.** One hour, eight hours, a day, a week, or no expiry. When it lapses
  the access stops working and the threads disappear from the other machine.
- **Revocable.** Take it back at any moment and it ends immediately.

## The two steps, and why there are two

You can't pick a project you've never seen. But listing every repository name to
anyone who asks would leak plenty on its own — project names say a lot.

So asking happens twice:

1. **"Can I see what's there?"** The owner approves a short **preview**, good for
   nothing but a catalog: project names with thread counts and dates, plus a
   search over thread *names*. No messages, no file paths, no branches. It
   expires in five minutes.
2. **"Can I read these?"** Built from what the preview turned up. The owner
   approves the scope and sets the clock.

Both steps stop at a person. Nothing is granted automatically, ever.

### The verification code

Every request shows a six-digit code on **both** machines. Before approving,
check it matches the one on the computer that's asking. On a shared network
that's what tells your colleague's laptop apart from a stranger's.

## Doing it from the app

On the Mac app, the sidebar has a **network icon** next to the pairing button.

1. Click it to see **Nearby machines**, and choose **Ask for access**.
2. Check the code, and have the other machine approve the preview.
3. Tick the projects you want, or search for individual threads by name.
4. **Request read access.**

When it's approved, the other machine appears as a device and its threads sync
into your sidebar like any other.

Requests coming *to* you show up as a **bell in the sidebar's top row**, with a
count. It only appears when something is waiting.

## Doing it from a browser

The app is macOS-only, so on Windows and Linux the Bridge carries this itself.
With the Bridge running, open:

```
http://127.0.0.1:8099/peers
```

That page does everything the app does: nearby machines, the ask flow with the
catalog picker, incoming requests with the scope and duration controls, the
machines that currently hold access, and revoke. The pairing window links to it,
and tells you when a machine is waiting on an answer.

The page is localhost-only. Nothing on your network can open it.

## Doing it from the terminal

For a server you've SSH'd into, or any box without a browser:

```sh
pounce peers                  # who's nearby, who's asking, who has access
pounce ask work-laptop        # ask a machine to share (prints its catalog)
pounce ask work-laptop --spaces api,web
pounce approve 418207         # let a machine in
pounce deny 418207
pounce revoke e1f71ab0        # take access away
```

Useful flags:

| Flag | What it does |
| --- | --- |
| `--spaces a,b` | Limit to these projects — on `ask` and on `approve` |
| `--all` | Ask for everything they're willing to give |
| `--hours <n>` | How long it lasts (default 24) |
| `--forever` | No expiry |
| `--note "text"` | A line for the person approving |

Requests are addressed by their six-digit code, so you can read it off the other
screen and type it.

## Finding each other

Machines announce themselves on the local network, so a computer running Pounce
shows up under "Nearby machines" within a few seconds. The announcement carries
a name, an address and nothing else — no token, no project names, nothing about
what's on the machine.

Once a grant exists it also works **off the network**: each grant gets its own
peer-to-peer tunnel, so access survives the other machine leaving the Wi-Fi.
Revoking closes that tunnel along with everything else.

To keep a machine from announcing itself at all, start the Bridge with
`POUNCE_DISCOVERY=0`.

## Reading what you've been granted

On macOS, granted machines become devices in the app and you browse them
normally. On iOS and Android the same is true once you've paired to your own
Bridge.

On a Windows or Linux box the Bridge records the grant and lists it under
"Access you hold", but there's no thread viewer on that machine yet — the
sharing works everywhere, the reading currently needs the mobile or Mac app.

## Security notes

- The request itself needs no credential — that's what lets a machine ask before
  it has one. It's inert: nothing exists until a human approves, requests are
  rate-limited and expire after fifteen minutes, and the code has to match.
- Granted tokens are stored hashed, never in the clear, and handed over exactly
  once.
- A grant reaches an allowlist of read-only routes. Anything not on that list —
  including anything added to Pounce later — is refused by default.
- Asking for a thread outside your scope answers "not found", so a grant can't
  be used to map what else is on the machine.
- Revoking or expiring is reported specifically, so the other machine drops the
  threads rather than showing them as merely offline.
