---
title: CLI reference
description: Everything npx use-pounce can do — commands, flags, and what it puts on your machine.
---

`use-pounce` is the one-command way to make any machine pairable:

```sh
npx use-pounce
```

It starts the [Pounce](https://use-pounce.com) Bridge in the background,
prints a QR code in your terminal, and waits for your scan. The Bridge keeps
running after you close the terminal.

Installed globally (`npm i -g use-pounce`), the command is just `pounce`.

## Commands

| Command                     | What it does                                                   |
| --------------------------- | -------------------------------------------------------------- |
| `pounce`                    | Start the Bridge (background) + show the pairing QR + wait     |
| `pounce qr`                 | Same, but don't wait for the phone                             |
| `pounce configure`          | Set this machine up for good — the app, or a login-time Bridge |
| `pounce status`             | Bridge / tunnel / phone status                                 |
| `pounce stop`               | Stop the background Bridge and its tunnel                      |
| `pounce logs [-f]`          | Show (or follow) the Bridge log                                |
| `pounce peers`              | Machines nearby, who's asking, who has access                  |
| `pounce peers --visible on` | Let other computers here find this one                         |
| `pounce ask <machine>`      | Ask another computer to share its threads with you             |
| `pounce approve <code>`     | Let a machine in                                               |
| `pounce deny <code>`        | Turn a request down                                            |
| `pounce revoke <id>`        | Take access away again                                         |

## Flags

| Flag           | Meaning                                              |
| -------------- | ---------------------------------------------------- |
| `--port <n>`   | Bridge port (default `8099`)                         |
| `--token <t>`  | Pairing token (default: random, kept in `~/.pounce`) |
| `--lan`        | Skip the tunnel — the QR pairs on this Wi-Fi only    |
| `--foreground` | Run the Bridge attached to this terminal             |

Setup flags (see [Setting a machine up for good](#setting-a-machine-up-for-good)):

| Flag        | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `--desktop` | Install the desktop app                              |
| `--bridge`  | Install the background Bridge as a login service     |
| `--remove`  | Take that login service back off                     |
| `-y`        | Don't ask — take the recommendation for this machine |

Sharing flags (see [Sharing with another machine](/docs/sharing)):

| Flag                | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `--spaces a,b`      | Limit to these projects — on `ask` and on `approve`            |
| `--all`             | Ask for everything the other machine is willing to give        |
| `--hours <n>`       | How long the access lasts (default `24`)                       |
| `--forever`         | No expiry                                                      |
| `--note "text"`     | A line for the person approving                                |
| `--visible on\|off` | Let other computers here find this one — **hidden by default** |

## Setting a machine up for good

`npx use-pounce` is perfect for a one-off, but the Bridge only lives as long as
you leave it running. One command makes it permanent:

```sh
npx use-pounce configure
```

It looks at the machine you're on — OS, chip, whether there's a screen, whether
you're at the far end of an SSH connection — and offers only what can actually
run there:

- **The desktop app** — the whole Pounce UI with the Bridge built in and the
  pairing QR in the window. It downloads and installs the right build for you:
  `Pounce.dmg` on an Apple Silicon Mac, the installer on Windows, a `.deb` (or
  the tarball) on Linux. Not offered on an Intel Mac, on macOS 13 or older, or
  on a machine with no desktop session — and it tells you why rather than
  quietly leaving the option out.
- **The background Bridge** — no window at all. A launchd agent on macOS, a
  systemd user service on Linux, a scheduled task on Windows: it starts at
  login and restarts on crash. This is the recommendation on a headless box or
  when you're connected over SSH.

Skip the question with a flag — handy in a provisioning script:

```sh
npx use-pounce configure --bridge      # a Bridge that starts at login
npx use-pounce configure --desktop     # the app, where it can run
npx use-pounce configure --remove      # take the login service back off
```

The login service reuses whatever pairing token this machine already has, so
phones that paired before keep working. Run through `npx`, it installs its own
copy of `use-pounce` under `~/.pounce/app` and points the service at that —
npm prunes its `npx` cache, and a service pointed there would stop working the
day it did.

## Sharing with another machine

Machines running Pounce find each other on the network. One can ask another for
**read-only** access to the projects its owner picks, with an expiry:

```sh
pounce peers --visible on          # hidden by default — others would see this computer's name
pounce peers                       # who's nearby, who's asking, who has access
pounce ask work-laptop             # prints their catalog, then tells you what to run
pounce ask work-laptop --spaces api --note "debugging the timeout"
pounce approve 418207 --hours 8    # requests are addressed by their six-digit code
pounce revoke e1f71ab0
```

Prefer buttons? The Bridge serves the same thing at
`http://127.0.0.1:8099/peers`. Full details in
[Sharing with another machine](/docs/sharing).

## Giving other agents your history

`pounce mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio, so Claude Code, Cursor and any other MCP client can search
everything you've done across every agent on this machine:

```sh
claude mcp add pounce -- npx use-pounce mcp
```

It's read-only — see [MCP server](/docs/mcp) for the tools and setup.

## What it puts on your machine

- **Bridge** — an HTTP server on port `8099` that reads your coding-agent
  sessions from disk and drives the agent CLIs. State lives in `~/.pounce/`.
- **Tunnel** — a `pounce-tunnel` binary (downloaded to `~/.pounce/bin/` on
  first run) that accepts secure peer-to-peer connections from your phone and
  hands them to the Bridge. Optional: without it, pairing still works on the
  same Wi-Fi.
- **Auth** — requests need the pairing token from the QR. The token is minted
  randomly per machine.

Everything lives under `~/.pounce/` — run `pounce stop` and delete that
directory to remove all of it.

`pounce configure --bridge` adds one thing outside it: the login service —
`~/Library/LaunchAgents/com.pounce.bridge.plist` on macOS,
`~/.config/systemd/user/pounce-bridge.service` on Linux, a `PounceBridge`
scheduled task on Windows. `pounce configure --remove` takes it away again.
