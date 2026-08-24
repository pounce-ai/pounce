# @pounce/redact

Strip credentials from a payload **before it leaves the machine**.

Zero runtime dependencies, synchronous, and it throws rather than degrading —
a scrubber that silently returns its input on failure is worse than none,
because the caller cannot tell the difference.

## Four layers, in decreasing precision

| Layer               | What it matches                                                       | False positives               |
| ------------------- | --------------------------------------------------------------------- | ----------------------------- |
| `machine denylist`  | The exact credentials live on **this** box                            | None — exact match            |
| `known formats`     | `sk-ant-…`, `ghp_…`, PEM blocks, JWTs, `Bearer …`, connection strings | Negligible — published shapes |
| `named assignments` | Values whose key says secret/token/password                           | Some — see below              |
| `entropy runs`      | Bare random-looking strings (**off by default**)                      | Many — base64 content         |

The first layer is the one a server-side scrubber cannot have. It reads the
agent credential stores (`~/.claude/.credentials.json`, `~/.codex/auth.json`,
opencode, `~/.pounce/config.json`), the project's `.env` family, and
secret-named environment variables, and redacts **exact matches**. By the time
a payload reaches a collector, the environment that would identify those values
is gone. That is the whole difference between scrubbing at the source and
scrubbing after the fact.

## Usage

```js
import { createRedactor, harvestMachineSecrets } from "@pounce/redact";

const redactor = createRedactor({
  denylist: harvestMachineSecrets({ cwd: "/path/to/project" }),
  home: os.homedir(), // fold /Users/alice/… → ~/…
});

const { value, findings, count } = redactor.redact(doc);
// findings → { "anthropic-key": 1, "bearer-token": 4 }   counts only, never values
```

Inside the bridge, import from `apps/bridge/agents/redact.mjs` instead — it
primes the denylist with the bridge's own token and admin key, which the
package could never guess, and memoizes the harvest.

## The named-assignment layer, and why it is fussy

`password = hunter2` has the entropy of a dictionary word and is still a
password, so this layer keys off the **name**, not randomness. But a coding
transcript is full of assignments whose key says "token" and whose value is
ordinary source:

```
token: dev.token                              ← property access
const token = str(key, 128) || randomBytes(16) ← call expression
tunnelToken: TUNNEL_SECRET                     ← a constant's name
{ tunnelToken: freshTunnelSecret }             ← a local's name
```

Redacting those shreds the document and teaches the reader to distrust the
placeholder. So an unquoted value must look like a literal and **not** like an
identifier or an expression. On one real 494-step trajectory this took the
count from 97 redactions to 9 — the 9 being two `LEGACY_TOKEN = "…"` literals,
four `Authorization: "Bearer …"` headers, and three quoted fixture secrets.

Real `.env` secrets that fall through this test are not lost: they are on the
machine, so the denylist catches them by exact value.

## This is a control, not a guarantee

A low-entropy secret with no name and no known format survives all four layers,
as does one the model paraphrased into prose or buried in a base64 blob. Once
content has left, deletion is not undo.

The stronger posture is to **not collect content at all** — which is why
`@pounce/meter`'s numbers (plan-window burn, token counts, folded blocks) carry
no free text and need none of this. Use redaction where content genuinely has
to travel, and say plainly that it is best-effort.

## Tests

```bash
bun run --filter @pounce/redact test
```

The suite plants a fabricated credential of every supported format and asserts
the value never survives, and carries a regression corpus of real source lines
an earlier ruleset wrongly redacted.
