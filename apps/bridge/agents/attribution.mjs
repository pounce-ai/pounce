/**
 * Token attribution — what filled a window, line item by line item.
 *
 * `blocks.mjs` answers "how much went into the current 5-hour window". This
 * answers the next question: WHICH tool, which shell command, and how much
 * fixed preamble. Same transcripts, same tail-read machinery, a much heavier
 * parse — blocks keeps `{ts, tokens}` per assistant message and throws the
 * content away, while this keeps every content block as a billable segment.
 *
 * THE ONE DERIVED NUMBER
 *
 * Claude publishes no per-segment token counts anywhere. Assistant content
 * blocks carry `{type,id,name,input,caller}` / `{type,text}` /
 * `{type,thinking,signature}`, and `toolUseResult` carries the payload only;
 * every token figure in the file lives in one aggregate `message.usage` per
 * assistant message. So splitting a request's billed input across the things in
 * its prefix is an apportionment, and there is no version of this feature where
 * it isn't. Everything else here is exact: output, thinking, cache-write TTL,
 * which tool produced which result, and where compaction cut the prefix.
 *
 * THE METHOD
 *
 * Every request re-bills its whole prefix, so a segment costs what it cost the
 * first time plus every re-bill until it falls out. Within a compaction epoch:
 *
 *     billedInput(r)  ≈  intercept + slope × prefixChars(r)
 *
 * `intercept` is the system prompt and tool schemas — never written to the
 * transcript, and not obtainable from the `system/init` envelope either (that
 * enumerates tool NAMES, not schemas), so it is solved for rather than counted.
 * `1/slope` is chars-per-token measured from this session's own mix of prose
 * and machine text, rather than a constant we assumed.
 *
 * The fit is anchored, not free-floating: `compact_boundary` records
 * `preTokens` — an exact token count for a prefix whose characters we just
 * measured — so each compaction donates a known point to the regression.
 *
 * Shares from the model, totals from the transcript: each request's ACTUAL
 * billed input is split in the model's proportions, so line items sum to the
 * real total by construction rather than approximately.
 */
import { BLOCK_HOURS } from "./blocks.mjs";
import {
  HOUR_MS,
  SYNTHETIC_MODEL,
  readTailLines,
  recentTranscripts,
  tailFor,
} from "./claude-transcripts.mjs";

/** Files read at once. Enough to keep the disk busy, few enough that peak
 *  memory is a handful of transcripts rather than every one of them. */
const SCAN_CONCURRENCY = 6;

/** Below this many requests in an epoch, least squares is fitting noise — fall
 *  back to a fixed ratio and tell the UI the preamble is estimated. */
export const MIN_FIT_POINTS = 15;

/** Only used when a fit fails. Between the 3.60 (machine text) and 4.40 (prose)
 *  that token-billing.vercel.app assumes for everything, because a transcript
 *  is a mix of both and we are no longer pretending to know the ratio. */
export const FALLBACK_CHARS_PER_TOKEN = 3.9;

/** A child under this share of its parent is folded into a labelled "other".
 *  Nothing is dropped — a breakdown that silently fails to sum is worse than no
 *  breakdown. */
export const FOLD_THRESHOLD = 0.008;

/* ------------------------------------------------------------------ *
 * Line items
 * ------------------------------------------------------------------ */

/** The top-level rows, in the order the report shows them. `carried` items are
 *  paid on the input side (re-billed every request until they fall out);
 *  `generated` is the output side, billed once. */
export const ITEMS = {
  toolsIn: "Tools · content read in",
  output: "Model output",
  /** A RESIDUAL, not a reading: everything billed in the prefix that the
   *  transcript does not record. That is mostly the system prompt and tool
   *  schemas, but it also absorbs injected context (CLAUDE.md, memory, the
   *  skills listing) and any framing the file leaves out — which is why a fat
   *  MCP surface shows up here and why the UI must not call it "the system
   *  prompt" flatly. */
  preamble: "System prompt & tool schemas",
  shell: "Shell commands",
  toolsOut: "Tools · content written out",
  media: "Images & attachments",
  harness: "Harness & reminders",
  typing: "My typing",
};

/** Items whose single bucket restates the row itself, so a breakdown would just
 *  repeat the label. Everything else keeps its children even when there is only
 *  one — "Shell commands → git" says something the parent row does not. */
const SINGLE = new Set([ITEMS.preamble, ITEMS.media, ITEMS.harness, ITEMS.typing]);

/** Navigation and shell bookkeeping, never the work. A run of `cd foo && git
 *  log` is a git call — attributing it to `cd` made the busiest row in a real
 *  scan a command that produces no output at all. */
const NOT_THE_WORK = new Set(["cd", "export", "set", "source", "."]);

/** The command a shell call should be billed to — `git`, `bun`, `rg`. Strips a
 *  leading path so `/usr/bin/git` and `git` are one row, skips `VAR=value`
 *  prefixes (they bind to the command, they aren't it), and walks past
 *  navigation to the first clause that actually does something. */
export function shellVerb(command) {
  if (typeof command !== "string") return "shell";
  // FIRST LINE ONLY. A heredoc or a multi-line script keeps its body in the
  // same string, and splitting the whole thing on `;`/`|`/`&&` turned those
  // body lines into clauses — which is how `const`, `for` and `a-z-` (out of a
  // regex) ended up billed as shell commands in a real scan.
  const line = command.split("\n")[0];
  let fallback = null;
  for (const clause of line.split(/&&|\|\||[;|]/)) {
    for (const raw of clause.trim().split(/\s+/)) {
      if (!raw) continue;
      // `VAR=value` prefixes bind to the command, they aren't the command.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue;
      // A quoted or substituted word is an ARGUMENT, and the command it might
      // contain is not the one being run here.
      if (/^["'`$]/.test(raw)) break;
      // `(` and `{` open a SUBSHELL or group — the command follows immediately
      // after, so strip them rather than giving up (bailing on `(cd x && bun
      // test)` produced an unhelpful "shell" row in a real scan).
      const word = raw
        .replace(/^[({]+/, "")
        .replace(/^.*\//, "")
        .replace(/[^\w.-]/g, "");
      // A command is a name, not a flag or a fragment of punctuation.
      if (!word || !/^[A-Za-z_][\w.-]*$/.test(word)) continue;
      if (NOT_THE_WORK.has(word)) {
        // Remember it in case the whole command is navigation and nothing else.
        fallback ??= word;
        break;
      }
      return word;
    }
  }
  return fallback || "shell";
}

/** Commands whose second word is a VERB rather than an argument. Everything
 *  else takes a pattern or a path there, which is not a category worth a row. */
const SUBCOMMAND_TOOLS = new Set([
  "git",
  "gh",
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "bunx",
  "cargo",
  "docker",
  "kubectl",
  "brew",
  "go",
  "uv",
  "pip",
  "expo",
  "eas",
  "asc",
  "rtk",
  "xcrun",
  "simctl",
  "adb",
  "aws",
  "gcloud",
  "systemctl",
  "defaults",
]);

/**
 * The THIRD level under a shell verb: `git status` → `status`.
 *
 * This is where the actionable detail lives — "git cost 2M" is a fact, "git
 * diff cost 2M" is something you can change. Flags are skipped so
 * `git -c x log` still reports `log`; a verb with no subcommand returns null
 * and simply has no level below it.
 */
export function shellSub(command, verb) {
  if (typeof command !== "string" || !verb) return null;
  // ONLY tools that actually have subcommands. A generic "first word after the
  // verb" turns `rg -n <pattern>` into a row per search and `cat <file>` into a
  // row per file — the same high-cardinality noise `fileKind` exists to avoid.
  if (!SUBCOMMAND_TOOLS.has(verb)) return null;
  const line = command.split("\n")[0];
  const idx = line.indexOf(verb);
  if (idx < 0) return null;
  for (const raw of line
    .slice(idx + verb.length)
    .split(/&&|\|\||[;|]/)[0]
    .trim()
    .split(/\s+/)) {
    if (!raw) continue;
    // Flags and their values sit between the verb and its subcommand:
    // `git -c core.pager=cat log` is still a `log`.
    if (raw.startsWith("-") || raw.includes("=")) continue;
    if (/^["'`$]/.test(raw)) return null;
    // Checked BEFORE sanitizing, or `scripts/build` survives as `scriptsbuild`.
    if (raw.includes("/") || raw.includes(".")) return null;
    const word = raw.replace(/[^\w-]/g, "");
    return word || null;
  }
  return null;
}

/**
 * The third level under a file tool: `*.ts`, `*.md`.
 *
 * Which FILES a Read costs you is the question behind the row, and the
 * extension is the honest grouping — a per-path breakdown would be thousands of
 * rows of mostly-noise.
 */
export function fileKind(input) {
  const p = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (typeof p !== "string" || !p) return null;
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base.startsWith(".") ? base : "no extension";
  return `*${base.slice(dot)}`;
}

/** Size of a value as it lands in the prefix. Everything is serialized before
 *  it is billed, so a JSON payload is measured as JSON. */
function charsOf(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Pass 1 — transcript to segments and requests
 * ------------------------------------------------------------------ */

/**
 * Walk parsed transcript lines IN ORDER and produce the two lists the
 * attribution needs.
 *
 * `segments` — every billable piece of content, tagged with the line item it
 * belongs to and the half-open request range `[bornAt, diesAt)` it is carried
 * across. `requests` — one per assistant message, with its exact usage.
 *
 * Pure and fs-free so it can be tested against hand-written transcripts.
 */
export function scanEntries(entries, { sinceMs = -Infinity } = {}) {
  const segments = [];
  const requests = [];
  /** Exact `(chars, tokens)` pairs donated by compaction boundaries. */
  const anchors = [];
  /** tool_use_id → the line item its RESULT should be billed to. Claude puts
   *  the tool name on the assistant's `tool_use` block and only the id on the
   *  user's `tool_result`, so the two have to be joined. */
  const resultRoute = new Map();
  /** Content born since the last request, waiting for a request to carry it. */
  let pending = [];
  let reqIndex = 0;
  let epoch = 0;

  /** Segments still in the prefix. Compaction kills them all at once. */
  let live = [];
  /** Their total size, kept as a running sum. `live` only grows within an
   *  epoch, so re-reducing it per request was O(requests x segments) — 1.3M
   *  iterations on one measured transcript. */
  let liveChars = 0;

  /** `sub` is the optional THIRD level — a shell subcommand, a file kind. Null
   *  where the row genuinely has nothing under it. */
  const born = (item, key, chars, sub = null) => {
    if (chars <= 0) return;
    pending.push({ item, key, sub, chars, epoch, bornAt: -1, diesAt: Infinity });
  };

  for (const o of entries) {
    if (!o || typeof o !== "object") continue;

    // Compaction is marked explicitly — no need to infer it from a drop in
    // cache reads. Everything live is dropped from the prefix here, and the
    // epoch's fit closes with an exact anchor point.
    if (o.type === "system" && o.subtype === "compact_boundary") {
      const m = o.compactMetadata || {};
      if (Number.isFinite(m.preTokens) && m.preTokens > 0 && liveChars > 0) {
        // Donated to this epoch's regression: an exact token count for a prefix
        // whose characters we just measured.
        anchors.push({ epoch, chars: liveChars, tokens: m.preTokens });
      }
      for (const s of live) s.diesAt = reqIndex;
      live = [];
      liveChars = 0;
      pending = [];
      epoch += 1;
      continue;
    }

    if (o.type === "attachment") {
      born(ITEMS.media, "attachments", charsOf(o.attachment ?? o.content));
      continue;
    }

    if (o.type === "user") {
      const content = o.message?.content;
      if (typeof content === "string") {
        // A plain string is the human typing. `isMeta` marks the harness
        // injecting reminders in the same slot, which is not the same spend.
        born(
          o.isMeta ? ITEMS.harness : ITEMS.typing,
          o.isMeta ? "reminders" : "prompts",
          content.length,
        );
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type !== "tool_result") {
          born(
            o.isMeta ? ITEMS.harness : ITEMS.typing,
            o.isMeta ? "reminders" : "prompts",
            charsOf(b?.text ?? b),
          );
          continue;
        }
        // Prefer the structured result the transcript keeps alongside the
        // message — it is what the tool actually returned.
        const chars = charsOf(o.toolUseResult ?? b.content);
        const route = resultRoute.get(b.tool_use_id);
        if (route) born(route.item, route.key, chars, route.sub);
        else born(ITEMS.toolsIn, "unattributed tool", chars);
      }
      continue;
    }

    if (o.type !== "assistant") continue;
    const msg = o.message;
    const usage = msg?.usage;
    if (!usage || msg.model === SYNTHETIC_MODEL) continue;

    // This request carries everything born before it.
    for (const s of pending) {
      s.bornAt = reqIndex;
      live.push(s);
      segments.push(s);
      liveChars += s.chars;
    }
    pending = [];

    const cacheCreation = usage.cache_creation || {};
    const ms = Date.parse(o.timestamp ?? "");
    requests.push({
      index: reqIndex,
      epoch,
      ms,
      /** A request BEFORE the window still has to be scanned — it shapes the
       *  prefix the window's requests inherit — but its spend belongs to an
       *  earlier window and must not be billed to this one. */
      counted: !Number.isFinite(ms) ? false : ms >= sinceMs,
      billedInput:
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0),
      output: usage.output_tokens || 0,
      thinking: usage.output_tokens_details?.thinking_tokens || 0,
      // Exact, not inferred: Claude records which TTL each write took, so the
      // 1h-vs-5m repricing lens the reference tool needs does not apply here.
      cacheWrite1h: cacheCreation.ephemeral_1h_input_tokens || 0,
      cacheWrite5m: cacheCreation.ephemeral_5m_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      prefixChars: liveChars,
      model: msg.model || null,
    });

    // The assistant's own output. Billed once as output now, then carried as
    // input from the NEXT request on — which is why these are born after the
    // request that produced them.
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const nonThinking = blocks.filter((b) => b?.type !== "thinking");
    const argChars = nonThinking
      .filter((b) => b?.type === "tool_use")
      .reduce((n, b) => n + charsOf(b.input), 0);
    const proseChars = nonThinking
      .filter((b) => b?.type === "text")
      .reduce((n, b) => n + charsOf(b.text), 0);

    // Thinking tokens are exact. What's left of output is split between prose
    // and tool arguments by character share — the only place on the output side
    // where an estimate is involved at all.
    const rest = Math.max(
      0,
      (usage.output_tokens || 0) - (usage.output_tokens_details?.thinking_tokens || 0),
    );
    const denom = argChars + proseChars;
    const argTokens = denom > 0 ? Math.round((rest * argChars) / denom) : 0;
    const proseTokens = Math.max(0, rest - argTokens);

    for (const b of blocks) {
      if (b?.type === "thinking") {
        born(ITEMS.output, "thinking", charsOf(b.thinking));
      } else if (b?.type === "text") {
        born(ITEMS.output, "assistant prose", charsOf(b.text));
      } else if (b?.type === "tool_use") {
        // Where the ARGUMENTS get billed as they are carried. Bash arguments
        // are the command itself, so they belong with the shell row.
        const isShell = b.name === "Bash";
        const verb = isShell ? shellVerb(b.input?.command) : null;
        // A shell call's third level is its subcommand; a file tool's is the
        // kind of file it touched.
        const sub = isShell ? shellSub(b.input?.command, verb) : fileKind(b.input);
        born(
          isShell ? ITEMS.shell : ITEMS.toolsOut,
          isShell ? verb : b.name || "tool",
          charsOf(b.input),
          sub,
        );
        // Remember where this tool's RESULT should land when it comes back —
        // including its third level, which only the CALL knows.
        resultRoute.set(
          b.id,
          isShell
            ? { item: ITEMS.shell, key: verb, sub }
            : { item: ITEMS.toolsIn, key: b.name || "tool", sub },
        );
      }
    }
    // Generated-side totals ride on the request, not on the segments, because
    // they are exact and need no apportionment.
    const r = requests[requests.length - 1];
    r.genThinking = usage.output_tokens_details?.thinking_tokens || 0;
    r.genProse = proseTokens;
    r.genArgs = argTokens;

    reqIndex += 1;
  }

  // Anything still pending was never carried by a request — it arrived after
  // the last assistant message, so nobody has been billed for it yet.
  for (const s of segments) if (s.diesAt === Infinity) s.diesAt = reqIndex;

  return { segments, requests, anchors, epochs: epoch + 1 };
}

/* ------------------------------------------------------------------ *
 * Pass 2 — solve for the preamble
 * ------------------------------------------------------------------ */

/**
 * Least squares over `{chars, tokens}` points: `tokens ≈ intercept + slope×chars`.
 *
 * Returns `fitted: false` when the fit is unusable rather than returning a
 * confident wrong number — too few points, no spread in prefix size, or a
 * result that isn't physical (a negative preamble, or a slope implying fewer
 * than one token per 20 characters). Callers fall back and the UI says so.
 */
export function fitPreamble(points) {
  const fallback = () => {
    const slope = 1 / FALLBACK_CHARS_PER_TOKEN;
    // Median residual, so one enormous request can't drag the preamble with it.
    const residuals = points.map((p) => p.tokens - slope * p.chars).sort((a, b) => a - b);
    const mid = residuals.length ? residuals[Math.floor(residuals.length / 2)] : 0;
    return { intercept: Math.max(0, mid), slope, fitted: false };
  };

  if (points.length < MIN_FIT_POINTS) return fallback();

  const n = points.length;
  let sx = 0,
    sy = 0,
    sxy = 0,
    sxx = 0;
  for (const p of points) {
    sx += p.chars;
    sy += p.tokens;
    sxy += p.chars * p.tokens;
    sxx += p.chars * p.chars;
  }
  const denom = n * sxx - sx * sx;
  if (denom <= 0) return fallback();
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  // A slope outside this range means the fit found something that isn't a
  // chars-to-tokens ratio (1 token per 1–20 chars covers every real mix).
  if (!(slope > 0.05 && slope < 1) || intercept < 0) return fallback();
  return { intercept, slope, fitted: true };
}

/* ------------------------------------------------------------------ *
 * Pass 3 — apportion, fold, reconcile
 * ------------------------------------------------------------------ */

/** Fold children under `FOLD_THRESHOLD` of the parent into one labelled row.
 *  Never drops: the folded row carries its members' full value and count. */
export function foldSmall(children, total) {
  const kept = [];
  let otherTokens = 0;
  let otherCount = 0;
  for (const c of children) {
    if (total > 0 && c.tokens / total < FOLD_THRESHOLD) {
      otherTokens += c.tokens;
      otherCount += 1;
    } else kept.push(c);
  }
  kept.sort((a, b) => b.tokens - a.tokens);
  // A folded row is a LEAF: its members came from different parents, so there
  // is no honest breakdown to offer underneath the merge.
  if (otherCount) {
    kept.push({
      key: `other (${otherCount} items)`,
      tokens: otherTokens,
      folded: otherCount,
      children: [],
    });
  }
  return kept;
}

/** Sum a forest of `{key, tokens, children}` into `map` by key, recursively —
 *  how several sessions' trees become one. */
function mergeInto(map, nodes) {
  for (const n of nodes || []) {
    let e = map.get(n.key);
    if (!e) map.set(n.key, (e = { key: n.key, tokens: 0, kids: new Map() }));
    e.tokens += n.tokens;
    mergeInto(e.kids, n.children);
  }
}

/** Turn a merged map back into a sorted, folded forest. */
function toForest(map, requests, parentTotal) {
  const nodes = [...map.values()].map((e) => ({
    key: e.key,
    tokens: e.tokens,
    perRequest: requests ? e.tokens / requests : 0,
    children: toForest(e.kids, requests, e.tokens),
  }));
  const total = parentTotal ?? nodes.reduce((n, c) => n + c.tokens, 0);
  return foldSmall(nodes, total);
}

/**
 * Turn a scan into the reconciled tree.
 *
 * Per request, the model's components are: the preamble (`intercept`) and each
 * live segment (`slope × chars`). Their predicted sum is scaled to the request's
 * ACTUAL billed input, so every line item sums to the real total — the report
 * never shows a breakdown that fails to add up.
 */
export function attribute({ segments, requests, anchors = [] }) {
  // item -> key -> { tokens, subs: sub -> tokens }. Three levels, because the
  // chart drills: line item, then row, then the row's own detail.
  const byItem = new Map();
  const add = (item, key, tokens, sub = null) => {
    if (!(tokens > 0)) return;
    if (!byItem.has(item)) byItem.set(item, new Map());
    const m = byItem.get(item);
    let e = m.get(key);
    if (!e) m.set(key, (e = { tokens: 0, subs: new Map() }));
    e.tokens += tokens;
    if (sub) e.subs.set(sub, (e.subs.get(sub) || 0) + tokens);
  };

  // Only requests inside the window are billed. Requests before it are still
  // scanned — they built the prefix — but contribute nothing to this report.
  const counted = requests.filter((r) => r.counted !== false);
  const billedInput = counted.reduce((n, r) => n + r.billedInput, 0);
  const billedOutput = counted.reduce((n, r) => n + r.output, 0);

  // Output side first: exact, no apportionment.
  for (const r of counted) {
    add(ITEMS.output, "thinking (generated)", r.genThinking || 0);
    add(ITEMS.output, "assistant prose (generated)", r.genProse || 0);
    add(ITEMS.output, "tool-call arguments (generated)", r.genArgs || 0);
  }

  // Input side, per epoch — the fit is only valid within one.
  const epochs = new Map();
  for (const r of requests) {
    if (!epochs.has(r.epoch)) epochs.set(r.epoch, []);
    epochs.get(r.epoch).push(r);
  }

  let preambleTokens = 0;
  /** Preamble tokens that came from an epoch whose fit actually solved. Tracked
   *  as a SHARE rather than a boolean because one two-request epoch alongside a
   *  400-request one should not make the whole report read as estimated. */
  let preambleFittedTokens = 0;

  for (const [epoch, reqs] of epochs) {
    const points = reqs.map((r) => ({ chars: r.prefixChars, tokens: r.billedInput }));
    for (const a of anchors)
      if (a.epoch === epoch) points.push({ chars: a.chars, tokens: a.tokens });
    const fit = fitPreamble(points);

    // `v(r)` scales the model back onto the request's real billed input, so the
    // parts sum exactly. Prefix-summed so each segment costs O(1) rather than
    // walking every request it survived.
    const v = [];
    for (const r of reqs) {
      const predicted = fit.intercept + fit.slope * r.prefixChars;
      // An uncounted request contributes 0, which zeroes it out of every
      // segment's cumulative sum as well as out of the preamble.
      const scale = predicted > 0 && r.counted !== false ? r.billedInput / predicted : 0;
      v.push(scale);
      const mine = fit.intercept * scale;
      preambleTokens += mine;
      if (fit.fitted) preambleFittedTokens += mine;
    }
    // Cumulative sums indexed by position within the epoch.
    const cum = [0];
    for (let i = 0; i < v.length; i++) cum.push(cum[i] + v[i]);
    const first = reqs[0].index;
    const clamp = (i) => Math.max(0, Math.min(v.length, i));

    for (const s of segments) {
      if (s.epoch !== epoch) continue;
      const from = clamp(s.bornAt - first);
      const to = clamp(s.diesAt - first);
      if (to <= from) continue;
      add(s.item, s.key, fit.slope * s.chars * (cum[to] - cum[from]), s.sub);
    }
  }

  add(ITEMS.preamble, "system prompt & tool schemas", preambleTokens);

  // Build the tree in the declared order, dropping items nothing landed in.
  const items = [];
  for (const item of Object.values(ITEMS)) {
    const m = byItem.get(item);
    if (!m) continue;
    const children = [...m].map(([key, e]) => ({
      key,
      tokens: Math.round(e.tokens),
      children: [...e.subs].map(([k, t]) => ({ key: k, tokens: Math.round(t), children: [] })),
    }));
    const tokens = children.reduce((n, c) => n + c.tokens, 0);
    if (tokens <= 0) continue;
    items.push({
      key: item,
      tokens,
      // Unfolded, and SINGLE items childless. Folding happens once in
      // `toForest`, after every session is merged — folding per session first
      // produced one "other (N items)" row PER session, side by side, because
      // the differing counts made them different keys. `perRequest` is left to
      // `toForest` too, so there is only ever one rate and it is the report's.
      children: SINGLE.has(item) ? [] : children,
    });
  }
  items.sort((a, b) => b.tokens - a.tokens);

  const attributed = items.reduce((n, i) => n + i.tokens, 0);
  return {
    items,
    total: billedInput + billedOutput,
    billedInput,
    billedOutput,
    /** Rounding only — the apportionment sums exactly by construction. Shown so
     *  the report can state its own error instead of hiding it. */
    unattributed: billedInput + billedOutput - attributed,
    requests: counted.length,
    /** The oldest request actually billed to this report. Asking for a year of
     *  history does not create a year of history — Claude prunes transcripts —
     *  so the page must state what it FOUND, not what it asked for. */
    earliestMs: counted.reduce(
      (m, r) => (Number.isFinite(r.ms) && (m === null || r.ms < m) ? r.ms : m),
      null,
    ),
    /** How much of the preamble figure was solved for rather than assumed. The
     *  UI marks it estimated below 1. */
    preambleFittedShare: preambleTokens > 0 ? preambleFittedTokens / preambleTokens : 0,
    preambleTokens,
    preamblePerRequest: counted.length ? preambleTokens / counted.length : 0,
    cacheWrite1h: counted.reduce((n, r) => n + r.cacheWrite1h, 0),
    cacheWrite5m: counted.reduce((n, r) => n + r.cacheWrite5m, 0),
    cacheRead: counted.reduce((n, r) => n + r.cacheRead, 0),
    /** How many times the model's own output was re-billed as input. The
     *  actionable number: carry cost is linear in how long a result survives. */
    carryMultiplier: carryOf(items, billedOutput),
  };
}

/** Output written once, against output carried as input afterwards. */
function carryOf(items, billedOutput) {
  const out = items.find((i) => i.key === ITEMS.output);
  if (!out || billedOutput <= 0) return null;
  const generated = out.children
    .filter((c) => c.key.includes("(generated)"))
    .reduce((n, c) => n + c.tokens, 0);
  const carried = out.tokens - generated;
  return generated > 0 ? 1 + carried / generated : null;
}

/* ------------------------------------------------------------------ *
 * IO
 * ------------------------------------------------------------------ */

/**
 * Read one transcript and reduce it to its attribution, keeping nothing else.
 *
 * The scan happens INSIDE the per-file task on purpose. Collecting every
 * parsed line first and attributing afterwards retained the whole corpus at
 * once: 111 files / 1.4GB on a real machine, roughly 1.7GB of heap, because
 * `Promise.all` fans out over all of them. Reducing here means only the small
 * result survives the task, so peak memory is a few files rather than all of
 * them.
 */
async function scanFile({ file, size }, sinceMs, tailBytes, coverage) {
  coverage.files += 1;
  if (size > tailBytes) {
    // A truncated file still parses, so this has to be COUNTED or the report
    // quietly under-reports whatever fell off the front.
    coverage.truncated += 1;
    coverage.unreadBytes += size - tailBytes;
  }
  const lines = [];
  let seen = false;
  await readTailLines(file, size, tailBytes, (o) => {
    // Keep the whole session once it enters the window: a segment born before
    // `sinceMs` is still being carried (and re-billed) inside it.
    const ms = Date.parse(o.timestamp ?? "");
    if (Number.isFinite(ms) && ms >= sinceMs) seen = true;
    lines.push(o);
  });
  if (!seen) return null;
  const scan = scanEntries(lines, { sinceMs });
  const counted = scan.requests.filter((r) => r.counted).length;
  if (!counted) return null;
  // Unfolded: sessions are merged before folding, so keys line up at every
  // depth and the tree is folded once against the real combined totals.
  return { part: attribute(scan), requests: counted };
}

/**
 * Attribution for one agent's recent transcripts.
 *
 * Claude only — nothing else carries per-message usage in its transcripts, and
 * a fabricated shape for the others is worse than `null` (same contract as
 * `readBlocks`).
 */
export async function readAttribution({
  agent = "claude",
  windowHours = BLOCK_HOURS,
  /**
   * Start of the window, when the caller knows it exactly.
   *
   * The rolling block the quota card reports opens at your FIRST MESSAGE and
   * runs five hours from there — it is not the last five hours. Passing
   * `blocks.mjs`'s `current.startedAt` here is what makes this page's total
   * equal the number on the card that opened it; without it the two disagreed
   * by 140M on a block that had been open seventeen minutes.
   */
  since = null,
  now = Date.now(),
} = {}) {
  if (agent !== "claude") return null;
  const sinceMs = since ?? now - windowHours * HOUR_MS;
  const tailBytes = tailFor(windowHours);
  /** What the scan actually managed to read — reported so the page can state
   *  its own incompleteness rather than implying full coverage. */
  const coverage = { files: 0, truncated: 0, unreadBytes: 0 };
  const files = recentTranscripts(sinceMs);

  // Sessions are scanned SEPARATELY and their results summed: each has its own
  // prefix, its own preamble and its own compaction history, so concatenating
  // them would fit one regression across unrelated contexts.
  //
  // Bounded rather than a flat `Promise.all`: unbounded fan-out opened every
  // transcript at once, which with a 192MB tail is the whole corpus in flight.
  const parts = [];
  let requests = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, files.length) }, async () => {
      for (let i = next++; i < files.length; i = next++) {
        const done = await scanFile(files[i], sinceMs, tailBytes, coverage).catch(() => null);
        if (!done) continue;
        parts.push(done.part);
        requests += done.requests;
      }
    }),
  );
  if (!parts.length) return null;

  const merged = new Map();
  for (const p of parts) mergeInto(merged, p.items);

  // SINGLE items arrived childless from `attribute`, so the merge has no kids
  // to give them back and `toForest` returns them childless too.
  const items = toForest(merged, requests).filter((i) => i.tokens > 0);

  const sum = (k) => parts.reduce((n, p) => n + (p[k] || 0), 0);
  const attributed = items.reduce((n, i) => n + i.tokens, 0);
  const total = sum("total");

  return {
    agent,
    windowHours,
    /** What this report actually covers, so the UI can name its own range
     *  rather than implying one. */
    windowStartedAt: new Date(sinceMs).toISOString(),
    /** Oldest turn actually found in range — the report's REAL start. */
    earliestAt: (() => {
      const ms = parts.reduce(
        (m, p) => (p.earliestMs != null && (m === null || p.earliestMs < m) ? p.earliestMs : m),
        null,
      );
      return ms == null ? null : new Date(ms).toISOString();
    })(),
    /** True when the range came from the agent's own rolling block rather than
     *  from "the last N hours". */
    windowIsBlock: since != null,
    scannedSessions: parts.length,
    requests,
    items,
    total,
    billedInput: sum("billedInput"),
    billedOutput: sum("billedOutput"),
    unattributed: total - attributed,
    cacheRead: sum("cacheRead"),
    cacheWrite1h: sum("cacheWrite1h"),
    cacheWrite5m: sum("cacheWrite5m"),
    preambleFittedShare: (() => {
      const all = parts.reduce((n, p) => n + p.preambleTokens, 0);
      return all > 0
        ? parts.reduce((n, p) => n + p.preambleTokens * p.preambleFittedShare, 0) / all
        : 0;
    })(),
    preamblePerRequest: requests
      ? parts.reduce((n, p) => n + p.preamblePerRequest * p.requests, 0) / requests
      : 0,
    carryMultiplier: weightedCarry(parts),
    /** Same horizon caveat blocks.mjs carries — but measured rather than
     *  assumed, so the UI can say how much of the range it actually read. */
    tailBytes,
    coverage,
  };
}

function weightedCarry(parts) {
  const withCarry = parts.filter((p) => p.carryMultiplier != null);
  if (!withCarry.length) return null;
  const w = withCarry.reduce((n, p) => n + p.billedOutput, 0);
  if (w <= 0) return null;
  return withCarry.reduce((n, p) => n + p.carryMultiplier * p.billedOutput, 0) / w;
}
