/**
 * AskUserQuestion bridge helpers — the isolated, fragile bits kept in one place
 * so they're easy to unit-test and adjust against the real `claude` picker.
 *
 *   parseAskUserQuestion(toolInput)  → normalized questions for the app event
 *   answerKeystrokes(questions, answers) → the byte stream that drives the picker
 *
 * Claude Code renders AskUserQuestion as an interactive list: ↑/↓ navigate the
 * current question's options, Enter selects/advances, Tab switches questions,
 * Space toggles an option in a multi-select, Esc cancels. We translate the app's
 * per-question chosen option indices into that keystroke stream.
 *
 * KEY MODEL — verify against real claude; every assumption is localized here so
 * a mismatch is a one-line change:
 *   - The cursor starts on option 0 of the current question.
 *   - Down moves the highlight down one option (we only ever move downward,
 *     0 → target, so wrap behaviour doesn't matter).
 *   - Single-select: Enter confirms the highlighted option AND advances to the
 *     next question (submits on the last). No Tab needed.
 *   - Multi-select: Space toggles the highlighted option; Enter confirms the
 *     question and advances.
 * If real claude turns out to need Tab between questions, flip ADVANCE below.
 */

export const KEYS = {
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  ENTER: "\r",
  SPACE: " ",
  TAB: "\t",
  ESC: "\x1b",
};

/** How we move from one question to the next. Enter is assumed to confirm AND
 *  advance; swap to KEYS.TAB if testing shows Enter submits the whole form. */
const ADVANCE = KEYS.ENTER;

/**
 * Normalize AskUserQuestion tool input into the app's Question[] shape. Tolerant
 * of missing fields so a malformed call still renders something answerable.
 * Returns null when there are no usable questions.
 */
export function parseAskUserQuestion(toolInput) {
  const raw = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  const questions = [];
  for (const q of raw) {
    const options = Array.isArray(q?.options)
      ? q.options
          .map((o) => ({
            label: String(o?.label ?? "").trim(),
            ...(o?.description ? { description: String(o.description) } : {}),
            ...(o?.preview ? { preview: String(o.preview) } : {}),
          }))
          .filter((o) => o.label)
      : [];
    if (!options.length) continue;
    questions.push({
      question: String(q?.question ?? "").trim(),
      header: String(q?.header ?? "").trim(),
      multiSelect: !!q?.multiSelect,
      options,
    });
  }
  return questions.length ? questions : null;
}

/**
 * Build the keystroke stream that answers the picker. `answers[q]` is the array
 * of chosen option indices for question q (one entry for single-select). Out-of-
 * range / empty picks are clamped so we never send an unbounded run of Downs.
 * @returns {string} raw bytes to write to the PTY.
 */
export function answerKeystrokes(questions, answers) {
  const seq = [];
  for (let q = 0; q < questions.length; q++) {
    const optCount = questions[q].options.length;
    const picks = [...new Set(answers?.[q] ?? [])]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < optCount)
      .sort((a, b) => a - b);

    let cursor = 0; // fresh question → highlight on option 0
    if (questions[q].multiSelect) {
      for (const target of picks) {
        while (cursor < target) { seq.push(KEYS.DOWN); cursor++; }
        seq.push(KEYS.SPACE); // toggle this option on
      }
      seq.push(ADVANCE); // confirm question → next
    } else {
      const target = picks[0] ?? 0; // default to the first option if none picked
      while (cursor < target) { seq.push(KEYS.DOWN); cursor++; }
      seq.push(ADVANCE); // select → next
    }
  }
  return seq.join("");
}

/** Human-readable form of a keystroke stream, for logging what we sent.
 *  Tokenizes longest-first so the CSI arrows (ESC [ A/B) match before a bare
 *  ESC, and the space key isn't confused with token separators. */
export function describeKeys(bytes) {
  const table = [
    [KEYS.UP, "↑"], [KEYS.DOWN, "↓"], // 3-byte CSI — must precede bare ESC
    [KEYS.ENTER, "⏎"], [KEYS.TAB, "⇥"], [KEYS.SPACE, "␣"], [KEYS.ESC, "⎋"],
  ];
  const out = [];
  let i = 0;
  outer: while (i < bytes.length) {
    for (const [seq, name] of table) {
      if (bytes.startsWith(seq, i)) { out.push(name); i += seq.length; continue outer; }
    }
    out.push(JSON.stringify(bytes[i]));
    i++;
  }
  return out.join(" ");
}
