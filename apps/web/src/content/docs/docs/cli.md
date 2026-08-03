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

| Command            | What it does                                               |
| ------------------ | ---------------------------------------------------------- |
| `pounce`           | Start the Bridge (background) + show the pairing QR + wait |
| `pounce qr`        | Same, but don't wait for the phone                         |
| `pounce status`    | Bridge / tunnel / phone status                             |
| `pounce stop`      | Stop the background Bridge and its tunnel                  |
| `pounce logs [-f]` | Show (or follow) the Bridge log                            |

## Flags

| Flag           | Meaning                                              |
| -------------- | ---------------------------------------------------- |
| `--port <n>`   | Bridge port (default `8099`)                         |
| `--token <t>`  | Pairing token (default: random, kept in `~/.pounce`) |
| `--lan`        | Skip the tunnel — the QR pairs on this Wi-Fi only    |
| `--foreground` | Run the Bridge attached to this terminal             |

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
