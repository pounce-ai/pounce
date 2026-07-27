/**
 * Agent task lists — pure helpers (no React/RN imports), so they unit-test in
 * isolation and can be reused without pulling in the Timeline component.
 *
 * Coding agents plan their work as a checklist and tick items off as they go.
 * They do it in two different shapes, and both arrive as ordinary `tool_call`
 * events — live on the turn stream AND on the transcript re-read — so the task
 * view is derived from the timeline the client already holds:
 *
 *  • WHOLE-LIST writes. Claude Code's `TodoWrite`, Codex's `update_plan`, and
 *    ACP's `plan` (normalized to `update_plan` by the bridge) each carry the
 *    complete list every time, so the newest write IS the state.
 *  • INCREMENTAL events. Newer Claude Code builds ship `TaskCreate` (one task,
 *    id assigned in the tool RESULT: "Task #1 created successfully: …") and
 *    `TaskUpdate` ({ taskId, status }). Neither call alone is the list — they
 *    have to be folded in order.
 *
 * A thread only ever uses one shape, but we fold both and let the newer one win
 * so an agent that switches mid-thread still renders correctly.
 */
import type { TimelineEvent, ToolCallEvent } from "@pounce/shared";

/** Whole-list writes: input carries every task. */
const LIST_TOOLS = new Set(["todowrite", "update_plan"]);
/** Incremental writes: one task per call, folded in order. */
const CREATE_TOOLS = new Set(["taskcreate"]);
const UPDATE_TOOLS = new Set(["taskupdate"]);

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskItem {
  readonly text: string;
  readonly status: TaskStatus;
  /** Present-tense form ("Fixing the parser") — shown while the item is active. */
  readonly activeForm?: string;
}

export interface TaskListState {
  readonly items: readonly TaskItem[];
  /** The event the list resolved at — the row that renders the full checklist. */
  readonly eventId: string;
  readonly seq: number;
  readonly ts: string;
}

function toolName(ev: TimelineEvent): string | null {
  return ev.type === "tool_call" ? ev.call.name.toLowerCase() : null;
}

/** True for any tool call that writes the task list (reads like TaskList aren't). */
export function isTaskCall(ev: TimelineEvent): ev is ToolCallEvent {
  const n = toolName(ev);
  return !!n && (LIST_TOOLS.has(n) || CREATE_TOOLS.has(n) || UPDATE_TOOLS.has(n));
}

/** Agents spell the terminal state several ways; everything unknown is pending
 *  so a new upstream status can never silently swallow an item. */
function normStatus(raw: unknown): TaskStatus | "deleted" {
  const v =
    typeof raw === "string"
      ? raw
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, "_")
      : "";
  if (v === "completed" || v === "complete" || v === "done" || v === "finished") return "completed";
  if (v === "in_progress" || v === "active" || v === "running" || v === "current")
    return "in_progress";
  if (v === "deleted" || v === "cancelled" || v === "canceled") return "deleted";
  return "pending";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Normalize one WHOLE-LIST task write into items.
 *
 * Returns `null` for anything that isn't such a write (or whose input is
 * unusable), and `[]` when the agent wrote an EMPTY list — a meaningful state
 * (the list was cleared), which callers distinguish from "not a task call".
 */
export function parseTaskCall(ev: TimelineEvent): TaskItem[] | null {
  const n = toolName(ev);
  if (!n || !LIST_TOOLS.has(n)) return null;
  const input = asObject((ev as ToolCallEvent).call.input);
  if (!input) return null;
  // Claude: { todos: [{ content, status, activeForm }] }
  // Codex/ACP: { plan: [{ step, status }] }
  const raw = input.todos ?? input.plan;
  if (!Array.isArray(raw)) return null;
  const items: TaskItem[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text) items.push({ text, status: "pending" });
      continue;
    }
    const o = asObject(entry);
    if (!o) continue;
    const text = str(o.content) || str(o.step) || str(o.text) || str(o.title) || str(o.task);
    if (!text) continue;
    const st = normStatus(o.status);
    const activeForm = str(o.activeForm) || undefined;
    items.push({
      text,
      status: st === "deleted" ? "completed" : st,
      ...(activeForm ? { activeForm } : {}),
    });
  }
  return items;
}

/** The id TaskCreate assigns lives in its RESULT text, not its input:
 *  "Task #3 created successfully: Run the tests". */
function idFromResultText(text: string): string | null {
  return /task\s*#(\d+)/i.exec(text)?.[1] ?? null;
}

/** tool_call id → its result's text, for the TaskCreate id lookup above. */
function resultTexts(events: readonly TimelineEvent[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "tool_result") continue;
    const c = e.result.content;
    if (c?.kind === "text") m.set(e.result.toolCallId || e.id.replace(/:o$/, ""), c.text ?? "");
  }
  return m;
}

const EMPTY_RESULTS: ReadonlyMap<string, string> = new Map();

export interface TaskTimeline {
  /** The thread's current checklist, or null when it has none. */
  readonly state: TaskListState | null;
  /** Newest task-writing event — the row that renders the full checklist. */
  readonly latestEventId: string | null;
  /** One-line label per superseded task event, so those rows stay a quiet trace
   *  instead of repeating the whole checklist ("＋ Run the tests", "✓ Read it"). */
  readonly labels: Map<string, string>;
}

/**
 * Fold a thread's task events into its current checklist plus the per-row labels
 * the timeline needs. `events` must be chronological (seq-sorted) — Session and
 * Timeline both keep it that way.
 */
export function deriveTaskTimeline(events: readonly TimelineEvent[]): TaskTimeline {
  const labels = new Map<string, string>();
  // Only TaskCreate reads this, and only Claude's task tools emit one. Codex's
  // update_plan and Claude's TodoWrite — the common case — would otherwise pay
  // a full extra scan of the transcript, per streamed token, to build a map
  // nothing reads.
  const results = events.some((e) => {
    const n = toolName(e);
    return n !== null && CREATE_TOOLS.has(n);
  })
    ? resultTexts(events)
    : EMPTY_RESULTS;
  // Incremental fold. Insertion-ordered: a Map preserves creation order, which
  // is the order the agent listed the work in.
  const folded = new Map<string, TaskItem>();
  let creates = 0;
  let foldEvent: TimelineEvent | null = null;
  // Whole-list writes. `cleared` distinguishes "no writes seen" from "the agent
  // wrote an empty list", which must hide the checklist rather than keep a stale one.
  let listItems: TaskItem[] | null = null;
  let listEvent: TimelineEvent | null = null;
  let latest: TimelineEvent | null = null;

  for (const ev of events) {
    const n = toolName(ev);
    if (!n) continue;
    if (LIST_TOOLS.has(n)) {
      const items = parseTaskCall(ev);
      if (!items) continue;
      listItems = items;
      listEvent = ev;
      latest = ev;
      continue;
    }
    if (CREATE_TOOLS.has(n)) {
      const input = asObject((ev as ToolCallEvent).call.input);
      if (!input) continue;
      const text = str(input.subject) || str(input.description) || str(input.content);
      if (!text) continue;
      creates++;
      const call = (ev as ToolCallEvent).call;
      // Prefer the id the tool actually assigned; fall back to creation order
      // (which is what it numbers by) when the result hasn't arrived yet.
      const id = idFromResultText(results.get(call.id || ev.id) ?? "") ?? String(creates);
      const activeForm = str(input.activeForm) || undefined;
      folded.set(id, { text, status: "pending", ...(activeForm ? { activeForm } : {}) });
      labels.set(ev.id, `＋ ${text}`);
      foldEvent = ev;
      latest = ev;
      continue;
    }
    if (UPDATE_TOOLS.has(n)) {
      const input = asObject((ev as ToolCallEvent).call.input);
      if (!input) continue;
      const id = str(input.taskId) || String(input.taskId ?? "");
      const prev = folded.get(id);
      const st = input.status === undefined ? null : normStatus(input.status);
      if (st === "deleted") {
        folded.delete(id);
        labels.set(ev.id, `✕ ${prev?.text ?? `Task ${id}`}`);
      } else if (prev) {
        const text = str(input.subject) || prev.text;
        const activeForm = str(input.activeForm) || prev.activeForm;
        const status = st ?? prev.status;
        folded.set(id, { text, status, ...(activeForm ? { activeForm } : {}) });
        const glyph = status === "completed" ? "✓" : status === "in_progress" ? "▸" : "•";
        labels.set(ev.id, `${glyph} ${status === "in_progress" ? activeForm || text : text}`);
      } else {
        // An update for a task we never saw created (history truncated before it).
        labels.set(ev.id, `• Task ${id || "?"} ${st ?? "updated"}`);
      }
      foldEvent = ev;
      latest = ev;
    }
  }

  // Both shapes present (an agent that switched mid-thread): the newer wins.
  const useFold =
    folded.size > 0 && (!listEvent || (foldEvent ? foldEvent.seq > listEvent.seq : false));
  const source = useFold ? foldEvent : listEvent;
  const items = useFold ? [...folded.values()] : (listItems ?? []);
  const state =
    source && items.length ? { items, eventId: source.id, seq: source.seq, ts: source.ts } : null;
  // The row that owns the checklist renders it in full, so it carries no label.
  if (latest) labels.delete(latest.id);
  return { state, latestEventId: latest?.id ?? null, labels };
}

export interface TaskProgress {
  readonly done: number;
  readonly total: number;
  /** The item being worked on — the first in_progress, else the first pending. */
  readonly active: TaskItem | null;
  /** What to show as the one-line summary: the active item's present tense. */
  readonly activeLabel: string | null;
}

export function taskProgress(items: readonly TaskItem[]): TaskProgress {
  let done = 0;
  let active: TaskItem | null = null;
  let firstPending: TaskItem | null = null;
  for (const it of items) {
    if (it.status === "completed") done++;
    else if (it.status === "in_progress" && !active) active = it;
    else if (it.status === "pending" && !firstPending) firstPending = it;
  }
  const shown = active ?? firstPending;
  return {
    done,
    total: items.length,
    active: shown,
    activeLabel: shown ? shown.activeForm || shown.text : null,
  };
}
