# @pounce/meter

What a coding agent cost, read off the machine it ran on.

Four independent answers to "what did this cost", because no single source covers
the question and they disagree in ways that matter:

| Source        | What it is                                                  | Trust                                      |
| ------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `cost-ledger` | The agent's own reported dollars, captured as a turn closes | Authoritative — but only for driven turns  |
| `admin-cost`  | The org's billing report (Anthropic Admin API, opt-in key)  | Official, org-wide, daily buckets          |
| `ccusage`     | Tokens priced at public list rates from local transcripts   | Estimate — fills nulls, never overwrites   |
| `quota`       | How much of a subscription plan's rolling window is spent   | The agent's own figure; not dollars at all |

That last row is the one nothing else can answer. A seat on Claude Max or Codex
Plus bills a flat fee and meters against rolling windows, so there is no API
traffic to intercept and no dollar figure to bill — the only place the number
exists is on the machine, in what the agent wrote there.

Plus the shapes that make the numbers legible: `blocks` (spend folded into the
agent's own rate-limit windows), `attribution` (which tool, file and shell
command filled a context window), and `atif` (a whole thread as an ATIF v1.7
trajectory document, for audit export and eval harnesses).

## Everything here reads

No agent is driven, no socket is opened, no UI is assumed. The one
host-specific concern — finding an agent's CLI — is injected:

```js
import { configureMeterHost, readQuota } from "@pounce/meter";

// Optional. Without it the package uses process.env and bare binary names,
// which is right for a service and wrong for a GUI app with a stunted PATH.
configureMeterHost({ agentEnv, binPath, binOverride });

const quota = await readQuota();
```

Two functions, five call sites — that is the entire coupling between metering
and its host, and keeping it that small is what lets the same code run inside
the bridge on a developer's laptop and inside a collector that never sees one.

**Inside the bridge, import from `apps/bridge/agents/meter.mjs`, not from here.**
That module configures the adapter against the bridge's own PATH resolution and
re-exports the package; importing directly gets you the standalone defaults, and
`ccusage` goes missing on any machine where PATH isn't already right.

## Tests

```bash
bun run --filter @pounce/meter test
```
