import { describe, expect, it } from "vitest";
import {
  FALLBACK_CHARS_PER_TOKEN,
  ITEMS,
  MIN_FIT_POINTS,
  attribute,
  fileKind,
  fitPreamble,
  foldSmall,
  scanEntries,
  shellSub,
  shellVerb,
} from "./attribution.mjs";

/* ---------------- transcript builders ---------------- */

let clock = Date.parse("2026-08-17T09:00:00Z");
const stamp = () => new Date((clock += 1000)).toISOString();

const user = (text, extra = {}) => ({
  type: "user",
  timestamp: stamp(),
  message: { content: text },
  ...extra,
});

const toolResult = (id, payload) => ({
  type: "user",
  timestamp: stamp(),
  message: { content: [{ type: "tool_result", tool_use_id: id, content: payload }] },
  toolUseResult: payload,
});

/** One assistant message. `billed` is the exact prefix bill the API charged. */
const assistant = ({
  billed = 1000,
  output = 100,
  thinking = 0,
  content = [],
  model = "claude-opus-5",
}) => ({
  type: "assistant",
  timestamp: stamp(),
  message: {
    model,
    content,
    usage: {
      input_tokens: 0,
      cache_read_input_tokens: billed,
      cache_creation_input_tokens: 0,
      output_tokens: output,
      output_tokens_details: { thinking_tokens: thinking },
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    },
  },
});

const useTool = (id, name, input) => ({ type: "tool_use", id, name, input });
const text = (t) => ({ type: "text", text: t });
const think = (t) => ({ type: "thinking", thinking: t, signature: "sig" });

const itemOf = (result, name) => result.items.find((i) => i.key === name);

/* ---------------- shellVerb ---------------- */

describe("shellVerb", () => {
  it("takes the command, not its path or its flags", () => {
    expect(shellVerb("git status --short")).toBe("git");
    expect(shellVerb("/usr/bin/rg -n foo")).toBe("rg");
  });

  it("skips env assignments, which bind to the command rather than being it", () => {
    expect(shellVerb("NODE_ENV=test bun run test")).toBe("bun");
  });

  it("survives an empty or non-string command", () => {
    expect(shellVerb("")).toBe("shell");
    expect(shellVerb(undefined)).toBe("shell");
  });

  it("walks past navigation to the command that does the work", () => {
    // `cd` was the biggest row in a real scan — a command that produces no
    // output at all.
    expect(shellVerb("cd /tmp && git log")).toBe("git");
    expect(shellVerb("cd /tmp")).toBe("cd");
  });

  it("reads only the first line, so a heredoc body isn't billed as commands", () => {
    // This is where `const`, `for` and `a-z-` came from in a real scan: the
    // script body lives in the same string and was being split into clauses.
    expect(shellVerb("cat > f.js <<'EOF'\nconst x = 1;\nfor (;;) {}\nEOF")).toBe("cat");
    expect(shellVerb('bun -e "const a = 1; console.log(a)"')).toBe("bun");
  });

  it("does not mistake a quoted argument for the command", () => {
    expect(shellVerb("rg -n 'git status' src")).toBe("rg");
    expect(shellVerb("echo $(git rev-parse HEAD)")).toBe("echo");
  });

  it("looks inside a subshell instead of giving up on it", () => {
    // `(cd apps/bridge && bun test)` produced an unhelpful "shell" row.
    expect(shellVerb("(cd apps/bridge && bun test)")).toBe("bun");
    expect(shellVerb("(git log)")).toBe("git");
  });

  it("ignores flags and punctuation fragments", () => {
    // `a-z-` — a character class out of a regex — was a billed row in a real
    // scan. A flag is skipped rather than ending the search, so a command that
    // opens with one still resolves to a name.
    expect(shellVerb("tr -d '[a-z-]'")).toBe("tr");
    expect(shellVerb("git -c core.pager=cat log")).toBe("git");
    expect(shellVerb("-- --")).toBe("shell");
  });
});

/* ---------------- third level ---------------- */

describe("shellSub", () => {
  it("names the subcommand, which is the actionable half", () => {
    // "git cost 2M" is a fact; "git diff cost 2M" is something you can change.
    expect(shellSub("git status --short", "git")).toBe("status");
    expect(shellSub("git -c core.pager=cat log", "git")).toBe("log");
    expect(shellSub("bun run test", "bun")).toBe("run");
  });

  it("has nothing to say when the verb stands alone", () => {
    expect(shellSub("git", "git")).toBeNull();
    expect(shellSub("bun", "bun")).toBeNull();
  });

  it("stays silent for tools whose second word is an argument", () => {
    // `rg -n <pattern>` would otherwise mint a row per search, and `cat <file>`
    // a row per file — the noise `fileKind` exists to avoid.
    expect(shellSub("rg -n foo src", "rg")).toBeNull();
    expect(shellSub("cat package.json", "cat")).toBeNull();
    expect(shellSub("ls -la", "ls")).toBeNull();
  });

  it("does not mistake a path or a filename for a subcommand", () => {
    expect(shellSub("bun scripts/build", "bun")).toBeNull();
    expect(shellSub("bun run.js", "bun")).toBeNull();
  });
});

describe("fileKind", () => {
  it("groups by extension rather than by path", () => {
    // A per-path breakdown would be thousands of rows of mostly-noise.
    expect(fileKind({ file_path: "/a/b/c.ts" })).toBe("*.ts");
    expect(fileKind({ notebook_path: "/x/y.ipynb" })).toBe("*.ipynb");
  });

  it("keeps a dotfile's own name and labels the extensionless", () => {
    expect(fileKind({ file_path: "/repo/.gitignore" })).toBe(".gitignore");
    expect(fileKind({ file_path: "/usr/bin/env" })).toBe("no extension");
  });

  it("has nothing to say about a tool that touches no file", () => {
    expect(fileKind({ command: "ls" })).toBeNull();
    expect(fileKind(undefined)).toBeNull();
  });
});

/* ---------------- scanEntries ---------------- */

describe("scanEntries", () => {
  it("routes a tool result to the tool that asked for it", () => {
    // The name is only on the assistant's tool_use; the result carries an id.
    // Without the join, every result lands in one anonymous bucket.
    const { segments } = scanEntries([
      user("go"),
      assistant({ content: [useTool("t1", "Read", { file_path: "/a.ts" })] }),
      toolResult("t1", "x".repeat(400)),
      assistant({}),
    ]);
    const result = segments.find((s) => s.chars >= 400);
    expect(result.item).toBe(ITEMS.toolsIn);
    expect(result.key).toBe("Read");
  });

  it("bills a Bash result to its subcommand, not to 'Bash'", () => {
    const { segments } = scanEntries([
      user("go"),
      assistant({ content: [useTool("t1", "Bash", { command: "git log --oneline" })] }),
      toolResult("t1", "y".repeat(500)),
      assistant({}),
    ]);
    const result = segments.find((s) => s.chars >= 500);
    expect(result.item).toBe(ITEMS.shell);
    expect(result.key).toBe("git");
  });

  it("separates the harness from the human in the same slot", () => {
    const { segments } = scanEntries([
      user("what I typed"),
      user("a system reminder", { isMeta: true }),
      assistant({}),
    ]);
    expect(segments.find((s) => s.item === ITEMS.typing).key).toBe("prompts");
    expect(segments.find((s) => s.item === ITEMS.harness).key).toBe("reminders");
  });

  it("carries assistant output from the NEXT request, not the one that wrote it", () => {
    // Output is billed once as output, then re-billed as input from the
    // following request on. Born at the same index would double-charge it.
    const { segments, requests } = scanEntries([
      user("go"),
      assistant({ content: [text("hello")] }),
      user("more"),
      assistant({}),
    ]);
    expect(requests).toHaveLength(2);
    const prose = segments.find((s) => s.key === "assistant prose");
    expect(prose.bornAt).toBe(1);
  });

  it("keeps thinking tokens exact and splits only what is left", () => {
    const { requests } = scanEntries([
      user("go"),
      assistant({
        output: 100,
        thinking: 40,
        content: [think("t"), text("aaaa"), useTool("t1", "Edit", { a: "b" })],
      }),
    ]);
    const r = requests[0];
    expect(r.genThinking).toBe(40);
    // 60 left over, split by character share of prose vs tool arguments.
    expect(r.genProse + r.genArgs).toBe(60);
    expect(r.genProse).toBeGreaterThan(0);
    expect(r.genArgs).toBeGreaterThan(0);
  });

  it("reads the cache-write TTL split rather than repricing it", () => {
    const line = assistant({});
    line.message.usage.cache_creation_input_tokens = 900;
    line.message.usage.cache_creation = {
      ephemeral_1h_input_tokens: 800,
      ephemeral_5m_input_tokens: 100,
    };
    const { requests } = scanEntries([user("go"), line]);
    expect(requests[0].cacheWrite1h).toBe(800);
    expect(requests[0].cacheWrite5m).toBe(100);
  });

  it("ignores synthetic turns, which cost nothing", () => {
    const { requests } = scanEntries([user("go"), assistant({ model: "<synthetic>" })]);
    expect(requests).toHaveLength(0);
  });
});

/* ---------------- compaction ---------------- */

describe("compaction", () => {
  const boundary = (preTokens, postTokens) => ({
    type: "system",
    subtype: "compact_boundary",
    timestamp: stamp(),
    compactMetadata: {
      trigger: "manual",
      preTokens,
      postTokens,
      cumulativeDroppedTokens: preTokens - postTokens,
    },
  });

  it("kills the prefix at the boundary, so nothing is billed past it", () => {
    const { segments } = scanEntries([
      user("x".repeat(100)),
      assistant({}),
      boundary(50_000, 5_000),
      user("y".repeat(100)),
      assistant({}),
    ]);
    const before = segments.find((s) => s.epoch === 0);
    expect(before.diesAt).toBe(1);
    expect(segments.find((s) => s.epoch === 1).bornAt).toBe(1);
  });

  it("donates preTokens as an exact anchor for the epoch's fit", () => {
    const { anchors } = scanEntries([
      user("x".repeat(1000)),
      assistant({}),
      boundary(50_000, 5_000),
      assistant({}),
    ]);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ epoch: 0, tokens: 50_000 });
    expect(anchors[0].chars).toBeGreaterThan(0);
  });

  it("does not anchor when the boundary reports no prefix", () => {
    const { anchors } = scanEntries([user("x"), assistant({}), boundary(0, 0)]);
    expect(anchors).toHaveLength(0);
  });
});

/* ---------------- fitPreamble ---------------- */

describe("fitPreamble", () => {
  /** A synthetic session where the truth is known: 1200 tokens of preamble and
   *  exactly 4 chars per token. */
  const truthful = (n) =>
    Array.from({ length: n }, (_, i) => {
      const chars = 4000 + i * 2000;
      return { chars, tokens: 1200 + chars / 4 };
    });

  it("recovers the preamble and the ratio from a clean session", () => {
    const fit = fitPreamble(truthful(20));
    expect(fit.fitted).toBe(true);
    expect(fit.intercept).toBeCloseTo(1200, 3);
    expect(1 / fit.slope).toBeCloseTo(4, 5);
  });

  it("falls back rather than fitting noise on a short session", () => {
    const fit = fitPreamble(truthful(MIN_FIT_POINTS - 1));
    expect(fit.fitted).toBe(false);
    expect(fit.slope).toBeCloseTo(1 / FALLBACK_CHARS_PER_TOKEN, 10);
  });

  it("falls back when every request has the same prefix size", () => {
    // No spread means no line to fit — the intercept would be arbitrary.
    const flat = Array.from({ length: 30 }, () => ({ chars: 5000, tokens: 2450 }));
    expect(fitPreamble(flat).fitted).toBe(false);
  });

  it("refuses a negative preamble instead of reporting one", () => {
    // Prefix shrinking while the bill grows is not a preamble; it's a bad fit.
    const bogus = Array.from({ length: 30 }, (_, i) => ({
      chars: 10_000 - i * 300,
      tokens: 500 + i * 400,
    }));
    const fit = fitPreamble(bogus);
    expect(fit.fitted).toBe(false);
    expect(fit.intercept).toBeGreaterThanOrEqual(0);
  });

  it("never returns a negative preamble from the fallback either", () => {
    const tiny = [{ chars: 100_000, tokens: 10 }];
    expect(fitPreamble(tiny).intercept).toBeGreaterThanOrEqual(0);
  });
});

/* ---------------- foldSmall ---------------- */

describe("foldSmall", () => {
  it("folds the tail into one labelled row without losing its value", () => {
    const kept = foldSmall(
      [
        { key: "git", tokens: 900 },
        { key: "rg", tokens: 90 },
        { key: "sed", tokens: 5 },
        { key: "awk", tokens: 5 },
      ],
      1000,
    );
    expect(kept.map((c) => c.key)).toEqual(["git", "rg", "other (2 items)"]);
    expect(kept.reduce((n, c) => n + c.tokens, 0)).toBe(1000);
  });

  it("sorts by size so the biggest line item reads first", () => {
    const kept = foldSmall(
      [
        { key: "small", tokens: 100 },
        { key: "big", tokens: 900 },
      ],
      1000,
    );
    expect(kept[0].key).toBe("big");
  });

  it("produces exactly one 'other', however many rows it stands in for", () => {
    // Folding per session and THEN merging gave one "other (N items)" row per
    // session — the counts made them different keys, so three sat side by side.
    const kept = foldSmall(
      Array.from({ length: 40 }, (_, i) => ({ key: `c${i}`, tokens: i === 0 ? 9000 : 25 })),
      9975,
    );
    expect(kept.filter((c) => c.key.startsWith("other"))).toHaveLength(1);
    expect(kept.reduce((n, c) => n + c.tokens, 0)).toBe(9975);
  });

  it("folds nothing when everything clears the threshold", () => {
    const kept = foldSmall(
      [
        { key: "a", tokens: 500 },
        { key: "b", tokens: 500 },
      ],
      1000,
    );
    expect(kept.some((c) => c.key.startsWith("other"))).toBe(false);
  });
});

/* ---------------- attribute ---------------- */

describe("attribute", () => {
  /** A session with a growing prefix, one Read and one git call. */
  const session = () => {
    const entries = [user("start the work")];
    for (let i = 0; i < 20; i++) {
      entries.push(
        assistant({
          billed: 2000 + i * 400,
          output: 200,
          thinking: 50,
          content: [
            think("reasoning here"),
            text("some prose for the user"),
            useTool(
              `r${i}`,
              i % 2 ? "Read" : "Bash",
              i % 2 ? { file_path: "/a.ts" } : { command: "git status" },
            ),
          ],
        }),
      );
      entries.push(toolResult(`r${i}`, "z".repeat(600)));
    }
    entries.push(assistant({ billed: 12_000 }));
    return scanEntries(entries);
  };

  it("sums every line item to the exact billed total", () => {
    // The whole point of scaling the model onto real usage: the breakdown adds
    // up, so the report never shows a split that fails to reconcile.
    const r = attribute(session());
    const attributed = r.items.reduce((n, i) => n + i.tokens, 0);
    expect(Math.abs(r.total - attributed)).toBeLessThanOrEqual(r.items.length);
    expect(Math.abs(r.unattributed)).toBeLessThanOrEqual(r.items.length);
  });

  it("produces the line items the report shows", () => {
    const r = attribute(session());
    const names = r.items.map((i) => i.key);
    expect(names).toContain(ITEMS.preamble);
    expect(names).toContain(ITEMS.output);
    expect(names).toContain(ITEMS.toolsIn);
    expect(names).toContain(ITEMS.shell);
  });

  it("carries a third level, so the chart can drill past the tool name", () => {
    // Clicking `Shell commands` should reach `git`, and clicking `git` should
    // reach `status` — two levels below the top, as the reference tool does.
    const entries = [user("go")];
    for (let i = 0; i < 20; i++) {
      entries.push(
        assistant({
          billed: 2000 + i * 400,
          content: [useTool(`g${i}`, "Bash", { command: `git ${i % 2 ? "status" : "diff"} .` })],
        }),
      );
      entries.push(toolResult(`g${i}`, "z".repeat(800)));
    }
    entries.push(assistant({ billed: 12_000 }));
    const git = itemOf(attribute(scanEntries(entries)), ITEMS.shell).children.find(
      (c) => c.key === "git",
    );
    expect(git.children.map((c) => c.key).sort()).toEqual(["diff", "status"]);
    // Every level still reconciles to its own parent.
    expect(git.children.reduce((n, c) => n + c.tokens, 0)).toBeCloseTo(git.tokens, -2);
  });

  it("bills shell work to its subcommand", () => {
    const shell = itemOf(attribute(session()), ITEMS.shell);
    expect(shell.children.map((c) => c.key)).toContain("git");
  });

  it("reports a carry multiplier above 1 when output survives in the prefix", () => {
    // Prose written once and re-billed thereafter is the headline finding;
    // 1.0 would mean nothing was ever carried.
    const r = attribute(session());
    expect(r.carryMultiplier).toBeGreaterThan(1);
  });

  it("charges the preamble once per request, not once per session", () => {
    const r = attribute(session());
    const preamble = itemOf(r, ITEMS.preamble);
    expect(preamble.tokens).toBeCloseTo(r.preamblePerRequest * r.requests, 0);
  });

  it("marks the preamble unfitted when the session is too short to solve", () => {
    const short = scanEntries([user("hi"), assistant({ billed: 500 }), assistant({ billed: 600 })]);
    expect(attribute(short).preambleFittedShare).toBe(0);
  });

  it("reports the preamble as fitted when the session is long enough", () => {
    expect(attribute(session()).preambleFittedShare).toBe(1);
  });

  it("bills nothing for requests before the window, but still carries their prefix", () => {
    // A request outside the window shaped the prefix the window inherits; its
    // own spend belongs to an earlier window and must not be billed twice.
    const entries = [user("x".repeat(400)), assistant({ billed: 9_000, output: 500 })];
    const cutoff = clock + 1;
    entries.push(user("y".repeat(400)), assistant({ billed: 3_000, output: 100 }));
    const r = attribute(scanEntries(entries, { sinceMs: cutoff }));
    expect(r.requests).toBe(1);
    expect(r.billedInput).toBe(3_000);
    expect(r.billedOutput).toBe(100);
  });

  it("bills exactly the requests inside an explicitly given window start", () => {
    // The rolling block the quota card reports opens at your FIRST MESSAGE, not
    // N hours ago. When the caller passes that instant, only requests at or
    // after it count — this is what makes the page's total equal the card's.
    const entries = [user("a"), assistant({ billed: 5_000, output: 300 })];
    const blockOpened = clock + 1;
    entries.push(user("b"), assistant({ billed: 2_000, output: 100 }));
    const r = attribute(scanEntries(entries, { sinceMs: blockOpened }));
    expect(r.requests).toBe(1);
    expect(r.total).toBe(2_100);
  });

  it("reports the oldest turn it FOUND, not the range it was asked for", () => {
    // Asking for a year does not manufacture a year — Claude prunes its own
    // transcripts. The page can only honestly claim the span that exists.
    const first = clock + 1000;
    const entries = [user("a"), assistant({ billed: 1_000 }), assistant({ billed: 1_200 })];
    const r = attribute(scanEntries(entries, { sinceMs: first - 365 * 86_400_000 }));
    expect(r.requests).toBe(2);
    expect(r.earliestMs).toBeGreaterThanOrEqual(first);
    // Far newer than the requested start, which is the whole point.
    expect(r.earliestMs - (first - 365 * 86_400_000)).toBeGreaterThan(86_400_000);
  });

  it("has no earliest turn when nothing was billed", () => {
    expect(attribute(scanEntries([])).earliestMs).toBeNull();
  });

  it("has nothing to say about an empty transcript", () => {
    const r = attribute(scanEntries([]));
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.carryMultiplier).toBeNull();
  });
});
