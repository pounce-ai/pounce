/**
 * GENERIC interactive-prompt detection from a rendered terminal screen.
 *
 * Replaces the AskUserQuestion-specific, transcript-based detector. Every
 * blocking CLI prompt we care about — trust-folder, tool permission, plan-mode
 * approval, AskUserQuestion — renders the same way: a numbered list with one row
 * highlighted (a `❯` marker and/or reverse video) and a "↑/↓ · Enter · Esc"
 * hint. We read that off the screen, so it works for ANY prompt and ANY agent
 * with zero per-case code. Answering is equally generic: move the highlight to
 * the chosen option and press Enter (see answerKeys).
 */

/** A numbered option row: optional highlight marker, a number, then the label.
 *  The leading marker is how the TUI shows which row is selected. */
const OPTION_RE = /^\s*(❯|›|»|▶|❭|◆|●|>)?\s*(\d{1,2})[.)]\s+(\S.*?)\s*$/u;

/** Footer hints a selection prompt shows — the gate that says "this really is an
 *  awaiting-input menu", not just numbered text scrolling by in tool output. */
const HINT_RE = /(esc\s+to\s+(cancel|exit|go\s*back))|((enter|↵|⏎|return)\s+to\s+(select|confirm|submit|continue))|(↑\s*\/?\s*↓)|(to\s+navigate)/iu;

/** Separators / chrome we never treat as a title. */
const CHROME_RE = /^[\s─—–—=_·•]*$/u;

/**
 * Detect a pending selection prompt on `lines` (each `{ text, inverse }`, top to
 * bottom). Returns `{ title, kind, options:[{label}], highlighted, multiSelect }`
 * or null when no menu is on screen.
 */
export function detectPrompt(lines) {
  const opts = [];
  for (let y = 0; y < lines.length; y++) {
    const m = lines[y].text.match(OPTION_RE);
    if (!m) continue;
    opts.push({ y, num: parseInt(m[2], 10), label: m[3].trim(), marked: !!m[1] || lines[y].inverse });
  }
  // Need a real menu (≥2 options) AND a nav/confirm hint on screen.
  if (opts.length < 2) return null;
  if (!lines.some((l) => HINT_RE.test(l.text))) return null;

  // Order by the displayed number; the option's position in this list is the
  // index the app sends back and the number of Downs from the top.
  opts.sort((a, b) => a.num - b.num || a.y - b.y);
  const hi = opts.findIndex((o) => o.marked);

  // Title: the prose block just above the first option (skip chrome/hints/links).
  const firstY = Math.min(...opts.map((o) => o.y));
  const titleLines = [];
  for (let y = firstY - 1; y >= 0 && titleLines.length < 4; y--) {
    const t = lines[y].text.trim();
    if (!t) { if (titleLines.length) break; else continue; } // stop at the blank above the block
    if (CHROME_RE.test(t) || HINT_RE.test(t) || OPTION_RE.test(lines[y].text)) continue;
    if (/^(security guide|learn more|read more|docs?|documentation)\b/i.test(t)) continue; // doc links
    if (t.length < 3) continue;
    titleLines.unshift(t);
  }
  const title = titleLines.join(" ").slice(0, 240);

  return {
    title,
    kind: promptKind(title, opts),
    options: opts.map((o) => ({ label: o.label })),
    highlighted: hi >= 0 ? hi : 0,
    multiSelect: false,
  };
}

/** Best-effort label for nicer UI copy — purely cosmetic, never branches logic. */
function promptKind(title, opts) {
  const hay = (title + " " + opts.map((o) => o.label).join(" ")).toLowerCase();
  if (/trust (this )?folder|trust this project/.test(hay)) return "trust";
  if (/don't ask again|allow|permission|proceed\??$|yes, and/.test(hay)) return "permission";
  if (/keep planning|proceed with|plan/.test(hay)) return "plan";
  return "prompt";
}

/**
 * Keystrokes that move the highlight from `highlighted` to option `target`
 * (0-based index into the detected options) and select it. Universal to any list
 * menu — arrows navigate, Enter selects. Returned as discrete tokens to be
 * written one at a time with a gap (a burst write picks the default).
 */
export function answerKeys(highlighted, target) {
  const DOWN = "\x1b[B", UP = "\x1b[A", ENTER = "\r";
  const seq = [];
  let delta = target - highlighted;
  while (delta > 0) { seq.push(DOWN); delta--; }
  while (delta < 0) { seq.push(UP); delta++; }
  seq.push(ENTER);
  return seq;
}

/**
 * Write keystrokes to a PTY one at a time with a gap, so each arrow registers
 * before the next key (Enter especially) — a burst write lands on the default.
 * `write` is any `(bytes: string) => void`.
 */
export async function writeKeys(write, keys, gapMs = 140) {
  for (const k of keys) {
    write(k);
    await new Promise((r) => setTimeout(r, gapMs));
  }
}
