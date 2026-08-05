---
title: Search
description: Full-text search across every agent session on every machine you've paired.
---

You remember solving something. You don't remember where, or in which tool, or
on which machine.

Search covers all of it — every session from Claude Code, Codex, Cursor and
opencode, on every machine you've paired, including work from tools you've
since stopped using.

## Where you can search from

- **Everything** — the Search tab, across all machines and all agents.
- **One project** — scoped to a single [Space](/docs/spaces).
- **One thread** — a find bar inside a session, for long transcripts.

Results carry enough context to recognise the moment. Tap one and Pounce opens
that session and scrolls straight to the message, highlighted where it matched.

## What it reads

Your agents' own transcripts, on your own disk. Nothing is uploaded, and no
Pounce server is involved — search runs on the machine the history lives on and
returns results over the same connection your phone already uses.

That also means an unreachable machine simply isn't searched. Wake it and its
history comes back.

## From other agents

The same search is available to any tool that speaks MCP, so an agent can look
through your past work before starting something new:

```sh
claude mcp add pounce -- npx use-pounce mcp
```

See [MCP server](/docs/mcp) for the full set of tools.
