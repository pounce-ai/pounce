/**
 * ATIF export — a thread as an Agent Trajectory Interchange Format document.
 *
 * ATIF (Harbor RFC 0001, v1.7) is a cross-framework JSON format for agent
 * trajectories, aimed at debugging, visualization, and SFT/RL pipelines. We
 * emit it so a Pounce thread can leave Pounce — into a bug report, an eval
 * harness, a teammate's tooling — as something other than a bespoke JSON dump.
 *
 * This is an EXPORT format only. Our own TimelineEvent stream (packages/shared)
 * stays the internal wire format: it is incremental, carries streaming flags,
 * permission and interactive-prompt events, and per-turn ordering that ATIF has
 * no concept of. ATIF is whole-session and post-hoc. Converting in this
 * direction is lossless enough to be useful; the reverse would not be.
 *
 * Shape mismatch worth knowing about: our timeline is a FLAT event list, while
 * an ATIF `step` is a turn — a message plus the reasoning and tool calls that
 * produced it, with tool output attached as that step's `observation`. So we
 * group rather than emit one step per event, which is what makes the output a
 * real trajectory instead of a transcript with different key names.
 */

const SCHEMA_VERSION = "1.7";

/** Flatten a ToolResultContent union into text ATIF can carry. */
function resultText(content) {
  if (!content || typeof content !== "object") return "";
  switch (content.kind) {
    case "text":
      return content.text || "";
    case "diff":
      return content.patch || "";
    case "files":
      return (content.paths || []).join("\n");
    case "json":
      return JSON.stringify(content.value ?? null);
    // Image bytes are deliberately not inlined — ATIF's own convention is to
    // reference images by path rather than embed them in the trajectory.
    case "image":
      return `[image ${content.mediaType || "application/octet-stream"}]`;
    default:
      return "";
  }
}

/**
 * Build an ATIF document from a thread's timeline events.
 *
 * `usage` is the official-only usage record (agents/usage.mjs) — its cost is
 * omitted rather than estimated when the agent never reported one, so a
 * consumer can trust `final_metrics.cost_usd` to be real or absent.
 */
export function toAtif({
  agent,
  threadId,
  events = [],
  usage = null,
  agentVersion = null,
  cwd = null,
}) {
  const steps = [];
  // Tool calls are indexed by id so a tool_result arriving later — sometimes
  // several events later, sometimes after an interleaved assistant message —
  // still lands on the step whose tool_call produced it.
  const stepByToolCall = new Map();
  let cur = null;

  const flush = () => {
    if (
      cur &&
      (cur.message || cur.reasoning_content || cur.tool_calls?.length || cur.observation)
    ) {
      steps.push(cur);
    }
    cur = null;
  };
  /**
   * Open (or continue) the agent step new content belongs to.
   *
   * An ATIF step models ONE model call, but our timeline is flat and doesn't
   * mark call boundaries. Tool results supply them: the agent emits tool calls,
   * the environment answers, and anything the agent says *after* that answer
   * necessarily came from a fresh call. So a step that already has observations
   * is closed rather than extended — without this, a long tool-chaining turn
   * collapses into one enormous step holding dozens of unrelated calls.
   */
  const openAgentStep = (ev) => {
    if (cur?.source === "agent" && cur.observation) flush();
    if (cur?.source !== "agent") {
      flush();
      cur = { step_id: steps.length + 1, timestamp: ev.ts, source: "agent" };
    }
    return cur;
  };
  const emitStep = (ev, source, fields) => {
    flush();
    steps.push({ step_id: steps.length + 1, timestamp: ev.ts, source, ...fields });
  };

  for (const ev of [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
    switch (ev.type) {
      case "user_message":
        emitStep(ev, "user", { message: ev.text || "" });
        break;

      case "thinking_finished": {
        const s = openAgentStep(ev);
        // Multiple thinking blocks before one reply are one reasoning trace.
        s.reasoning_content = s.reasoning_content
          ? `${s.reasoning_content}\n\n${ev.text || ""}`
          : ev.text || "";
        break;
      }

      case "assistant_message": {
        // Streaming deltas are partial renders of a message whose final form
        // arrives as its own event — exporting them would duplicate the text.
        if (ev.streaming) break;
        const s = openAgentStep(ev);
        // A second finalized message means a new turn, not an appended one.
        if (s.message) {
          flush();
          openAgentStep(ev).message = ev.text || "";
        } else s.message = ev.text || "";
        break;
      }

      case "tool_call": {
        const s = openAgentStep(ev);
        const call = ev.call || {};
        (s.tool_calls ||= []).push({
          tool_call_id: call.id || ev.id,
          function_name: call.name || "tool",
          arguments: call.input ?? {},
        });
        stepByToolCall.set(call.id || ev.id, s);
        break;
      }

      case "tool_result": {
        const r = ev.result || {};
        const owner = stepByToolCall.get(r.toolCallId);
        const entry = {
          tool_call_id: r.toolCallId,
          content: resultText(r.content),
          is_error: !!r.isError,
        };
        if (owner) {
          ((owner.observation ||= { results: [] }).results ||= []).push(entry);
        } else {
          // Orphan result (its call fell outside a truncated history window) —
          // keep it as a system observation rather than dropping evidence.
          emitStep(ev, "system", { observation: { results: [entry] } });
        }
        break;
      }

      case "system_event":
        emitStep(ev, "system", {
          message: ev.message || "",
          extra: { level: ev.level || "info", ...(ev.source ? { source: ev.source } : {}) },
        });
        break;

      // Pounce-specific events with no ATIF counterpart. They are real parts of
      // what happened, so they become system steps carrying their payload in
      // `extra` (which ATIF leaves open) rather than being silently dropped.
      case "permission_request":
        emitStep(ev, "system", {
          message: `permission requested: ${ev.toolName || ""}`.trim(),
          extra: {
            pounce_type: ev.type,
            request_id: ev.requestId,
            tool_name: ev.toolName,
            options: ev.options,
          },
        });
        break;
      case "prompt_request":
        emitStep(ev, "system", {
          message: `interactive prompt: ${ev.title || ""}`.trim(),
          extra: {
            pounce_type: ev.type,
            prompt_id: ev.promptId,
            kind: ev.kind,
            options: ev.options,
          },
        });
        break;
      case "task_created":
      case "task_started":
      case "task_progress":
      case "task_completed":
      case "task_failed":
        emitStep(ev, "system", {
          message: `task ${ev.type.slice(5)}`,
          extra: {
            pounce_type: ev.type,
            task_id: ev.taskId,
            state: ev.state,
            ...(ev.error ? { error: ev.error } : {}),
          },
        });
        break;
      case "git_event":
        emitStep(ev, "system", {
          message: ev.summary || `git ${ev.action || ""}`.trim(),
          extra: { pounce_type: ev.type, action: ev.action, files: ev.files },
        });
        break;
      case "terminal_event":
        emitStep(ev, "system", {
          message: ev.data || "",
          extra: {
            pounce_type: ev.type,
            stream: ev.stream,
            terminal_id: ev.terminalId,
            exit_code: ev.exitCode,
          },
        });
        break;

      // thinking_started carries no content — its finished twin has the text.
      default:
        break;
    }
  }
  flush();
  // step_id is assigned optimistically as steps are opened; a flushed-then-
  // reopened step can leave gaps, so renumber once at the end.
  steps.forEach((s, i) => {
    s.step_id = i + 1;
  });

  return {
    schema_version: SCHEMA_VERSION,
    trajectory_id: `${agent}:${threadId}`,
    session_id: threadId,
    agent: {
      name: agent,
      ...(agentVersion ? { version: agentVersion } : {}),
      ...(usage?.model ? { model: usage.model } : {}),
    },
    steps,
    final_metrics: finalMetrics(usage),
    extra: {
      exported_by: "pounce-bridge",
      ...(cwd ? { cwd } : {}),
    },
  };
}

/**
 * ATIF `final_metrics` from our usage record.
 *
 * `cost_usd` appears only when the agent itself reported dollars. Codex threads
 * therefore export token counts with no cost key at all, which is the honest
 * answer — see agents/usage.mjs.
 */
function finalMetrics(usage) {
  if (!usage?.available) return {};
  const t = usage.tokens || {};
  const m = {
    prompt_tokens: t.input || 0,
    completion_tokens: t.output || 0,
    cached_tokens: t.cacheRead || 0,
    total_tokens: t.total || 0,
  };
  if (t.reasoning) m.reasoning_tokens = t.reasoning;
  if (usage.cost != null) {
    m.cost_usd = usage.cost;
    // Flag a total that covers only part of the thread so a consumer summing
    // trajectories doesn't treat a partial figure as the whole spend.
    m.cost_is_partial = usage.costComplete === false;
  }
  if (usage.contextWindow) m.model_context_window = usage.contextWindow;
  if (usage.rateLimit) m.rate_limit = usage.rateLimit;
  return m;
}
