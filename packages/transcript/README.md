# @pounce/transcript

Normalize coding-agent **session-transcript message bodies** for display.

Coding-agent CLIs (Claude Code, Codex, opencode, …) each inline their own
agent-specific plumbing into message text — slash-command envelopes, captured
command output, injected project context, system reminders. Rendered raw it
looks like leaked internals. This package turns one raw message into a small,
presentable shape, keyed off which agent produced it.

Framework-agnostic, **zero runtime dependencies**, plain ESM — runs in a bundler
(React Native / Metro), Node, and Bun alike.

## API

```js
import { stripNoise, parseUserMessage, isEmptyUserMessage, cleanAssistantText } from "@pounce/transcript";

// Server-side / ingest: remove only zero-value junk, keep presentation tags.
stripNoise(rawText, "codex"); // → readable text for any client

// UI layer: full parse into { command?, output?, text }.
const p = parseUserMessage(rawText, "claude");
if (!isEmptyUserMessage(p)) render(p); // p.command → chip, p.output → note, p.text → bubble
```

Two entry points, by consumer:

- **`stripNoise(text, agent)`** removes only zero-value plumbing (system
  reminders, Codex's injected `AGENTS.md`, caveats, hooks) plus ANSI, while
  **preserving** presentation-bearing tags. Cheap and lossless enough to run at
  ingest so every client renders readable text without reimplementing the parser.
- **`parseUserMessage(text, agent)`** does the full presentation parse: a
  slash-command chip, a collapsed output note, and cleaned prose. Idempotent
  w.r.t. text `stripNoise` already cleaned.

## Safety

Real transcripts are full of legitimate `<…>` — code, HTML, TS generics like
`Array<string>`. So cleaning is a strict **allowlist of known envelope tag names
per agent**, never a blanket XML strip. Unknown agents pass through untouched.

## Per-agent tag taxonomy

Verified against real `~/.claude`, `~/.codex`, and `~/.local/share/opencode`
transcripts.

| Agent | Body plumbing | Treatment |
|---|---|---|
| **claude** | `<command-name\|message\|args>` | slash-command chip (message/args folded in) |
| | `<local-command-stdout\|stderr>`, `<bash-input\|stdout\|stderr>` | collapsed output note |
| | `<system-reminder>`, `<local-command-caveat>`, `<user-prompt-submit-hook>` | stripped (noise) |
| **codex** | `<INSTRUCTIONS>` (AGENTS.md), `<environment_context>`, `<user_instructions>`, `# AGENTS.md instructions for <path>` header | stripped (injected context, not turns) |
| **opencode** | none — plain markdown | passthrough |
| **others** (amp/pi/grok/hermes/…) | unknown | passthrough (safe) |

Add an agent by extending `AGENT_RULES` in `src/index.js` — `noise` tags are
stripped everywhere, `command`/`output` map tags to chips/notes, and `present`
lists the tags removed from prose once lifted.
