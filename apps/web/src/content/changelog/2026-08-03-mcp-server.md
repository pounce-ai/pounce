---
title: "Your agent history, in every other agent"
date: 2026-08-03
component: cli
link: https://www.npmjs.com/package/use-pounce
---

Every coding agent starts from scratch. It can't see what you tried in a
different tool yesterday, or which approach you already ruled out.

`pounce mcp` fixes that. One line and Claude Code — or Cursor, or anything else
that speaks MCP — can search your whole history across Claude Code, Codex,
opencode and Cursor:

```sh
claude mcp add pounce -- npx use-pounce mcp
```

Five tools: search everything, list sessions, read a session, read the messages
you flagged as important, and see what's been worked on lately. It's read-only
and entirely local — nothing leaves your machine, and no Pounce server is
involved.
