---
title: MCP server
description: Give Claude Code, Cursor, Codex and any other MCP client your whole cross-agent history — searchable, read-only, local.
---

Every coding agent starts each session with amnesia. It can't see what you
tried in a different tool yesterday, which approach you already rejected, or
what you flagged as important.

Pounce can. It already reads sessions from Claude Code, Codex, opencode and
Cursor on your machine, so it's the one thing that can answer _"what did Codex
try on this bug yesterday?"_ — and `pounce mcp` hands that to any agent.

```sh
claude mcp add pounce -- npx use-pounce mcp
```

That's it. The next time Claude Code needs context it can search everything
you've done, in every agent, on this machine.

## Setup

The MCP server talks to a running Bridge, so start one first:

```sh
npx use-pounce
```

Then register the server with your client. Installed globally
(`npm i -g use-pounce`), use `pounce` in place of `npx use-pounce` everywhere
below.

### Claude Code

```sh
claude mcp add pounce -- npx use-pounce mcp
```

Or by hand — `.mcp.json` in your project root (shared with the repo), or
`~/.claude.json` for every project:

```json
{
  "mcpServers": {
    "pounce": {
      "command": "npx",
      "args": ["use-pounce", "mcp"]
    }
  }
}
```

### Claude Desktop

Settings → Developer → Edit Config, or edit directly:

- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "pounce": {
      "command": "npx",
      "args": ["use-pounce", "mcp"]
    }
  }
}
```

Restart Claude Desktop completely afterwards — it only reads the config on
launch.

### Cursor

`~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "pounce": {
      "command": "npx",
      "args": ["use-pounce", "mcp"]
    }
  }
}
```

### VS Code (GitHub Copilot)

`.vscode/mcp.json`. **Note the different shape** — VS Code uses `servers`, not
`mcpServers`, and wants an explicit `type`:

```json
{
  "servers": {
    "pounce": {
      "type": "stdio",
      "command": "npx",
      "args": ["use-pounce", "mcp"]
    }
  }
}
```

### Anything else

Most clients take the `mcpServers` shape above. If yours wants the command as
one string, it's `npx use-pounce mcp`.

### Non-default port

If your Bridge isn't on `8099`, pass the port through:

```json
{
  "mcpServers": {
    "pounce": {
      "command": "npx",
      "args": ["use-pounce", "mcp", "--port", "9000"]
    }
  }
}
```

The server finds the Bridge's token itself over loopback, so there is nothing
else to configure and no secret to paste into a config file.

## Tools

| Tool              | What it answers                                                       |
| ----------------- | --------------------------------------------------------------------- |
| `search_history`  | "Has anyone tried this before?" — full-text search across every agent |
| `list_threads`    | "What sessions exist?" — newest first, filterable by agent or project |
| `get_thread`      | "What actually happened in that session?" — the full message history  |
| `list_markers`    | "What did I flag as important?" — your own jump-to points in a thread |
| `recent_activity` | "What's been worked on lately?" — activity across machines and repos  |

`list_markers` is the underrated one: markers are _your_ judgement about what
mattered in a long session, so they're usually the fastest way for an agent to
get oriented without reading thousands of messages.

## Read-only, on purpose

The Bridge also exposes endpoints that run shell commands, start agent turns
and make git commits. **None of those are exposed over MCP.**

Handing an arbitrary agent shell execution and commit rights through a tool
call is a foot-gun, and it makes the security story impossible to explain in
one sentence. Read-only keeps it simple: an MCP client connected to Pounce can
_read_ your history and nothing else.

## Privacy

Everything stays on your machine. The MCP server runs locally over stdio and
talks to the Bridge over loopback — no Pounce server sees your history, and
nothing is uploaded. It's the same data the Pounce app reads, exposed to a
program already running on your computer.

## Troubleshooting

**`no bridge on port 8099`** — the Bridge isn't running. Start it with
`npx use-pounce`, then reconnect the MCP client.

**Tools return nothing** — check the Bridge sees your sessions first with
`pounce status`, and that the agent whose history you expect has actually run
on this machine. Pounce reads each agent's own session files; it can't see
history that isn't there.

**Search returns no results** — search is powered by
[`ctx`](https://ctx.rs), installed to `~/.pounce/bin` on first use. If it
never installed, `search_history` reports that rather than returning empty.
