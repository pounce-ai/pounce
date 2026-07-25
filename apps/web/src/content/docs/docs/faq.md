---
title: FAQ
description: Token counts, costs, session export, and what the numbers mean.
---

## Are the costs Pounce shows my actual bill?

**No. Treat every cost in Pounce as representative, not actual.** Use your
provider's billing page as the source of truth.

Pounce only ever shows a dollar figure that the coding agent itself reported —
it never prices tokens on its own. That still leaves gaps that make the number
approximate:

- It covers a **single thread**, not your account. Other threads, other tools,
  and other machines aren't in it.
- It can cover **part of a thread**. A leading `~` means the figure includes
  only the turns Pounce drove (see below).
- Agents report cost at **different moments and granularities**, and some
  don't report it at all.
- Subscription plans, credits, discounts, and taxes are applied by your
  provider after the fact and are invisible here.

## Why does my Claude thread show tokens but no cost?

Because Claude Code doesn't write cost to disk.

It records token counts on every assistant message in its transcript, but the
dollar figure exists only on the envelope that closes a live turn — and that
envelope is never saved. Read the transcript afterwards and the dollars are
simply gone.

So Pounce captures it as turns happen: when the Bridge runs a turn, it banks
the agent-reported cost in a local ledger at `~/.pounce/usage.jsonl`. That
means:

- Turns you ran **from Pounce** have a real, agent-reported cost.
- Turns you ran **in a terminal** contribute tokens but no cost — Pounce never
  saw the envelope.
- A thread that's a mix of both shows `~` to mark the total as partial.
- A thread with no Pounce-driven turns shows tokens and no cost at all.

Nothing is estimated to fill those gaps. Earlier versions of Pounce multiplied
tokens by a built-in price table; that table silently drifted from real pricing
and presented a guess as a fact, so it was removed.

## What does each agent actually report?

| Agent           | Tokens             | Cost                        | Also reports                |
| --------------- | ------------------ | --------------------------- | --------------------------- |
| **OpenCode**    | Yes                | Yes — full history, in USD  | —                           |
| **Claude Code** | Yes — full history | Only for turns Pounce drove | Context window              |
| **Codex**       | Yes — full history | Never                       | Plan type, rate-limit usage |
| **Cursor**      | No                 | No                          | —                           |

Codex bills against a ChatGPT plan rather than per request, so there is no
dollar amount for it to report. Instead of inventing one, Pounce shows what
Codex does state — how much of your rate-limit window you've consumed, e.g.
`120.7M · 26% of 5h`.

## What are cache tokens, and why is my total so large?

Coding agents re-send your conversation on every turn and rely on prompt
caching, so cached reads dominate long threads — tens of millions of tokens is
normal and does **not** mean you were billed at the full input rate. Cached
reads are typically far cheaper than fresh input. Pounce includes them in the
total because they're real tokens the agent processed.

## Can I export a session?

Yes. The Bridge serves any thread as
[ATIF](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md)
(Agent Trajectory Interchange Format), a cross-framework JSON format for agent
trajectories:

```sh
curl -H "Authorization: Bearer $BRIDGE_TOKEN" \
  "http://localhost:8099/v1/trajectory?agent=claude&thread=<thread-id>&download=1" \
  -o session.atif.json
```

The export contains the same messages, reasoning, tool calls, and tool results
you see in the app, grouped into trajectory steps, plus a `final_metrics` block.
`cost_usd` appears there only when it's a real agent-reported figure, so a
consumer summing many trajectories won't accumulate guesses.

This is useful for attaching a session to a bug report, feeding it to an
evaluation harness, or handing it to tooling that already understands ATIF.
