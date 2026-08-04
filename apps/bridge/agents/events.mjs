/**
 * Shared helpers for adapters: timeline-event constructors matching the shapes
 * the app already consumes (see itemToEvents in server.mjs — user_message /
 * thinking_finished / assistant_message / tool_call / tool_result /
 * system_event), plus bounded file-reading utilities.
 */
import { openSync, readSync, closeSync, fstatSync } from "node:fs";

// --- event constructors ------------------------------------------------------
// `base` = { id, conversationId, seq, ts }

export const userMessage = (base, text, images) => ({
  ...base,
  type: "user_message",
  text,
  ...(images && images.length ? { images } : {}),
});

export const thinking = (base, text) => ({
  ...base,
  type: "thinking_finished",
  text,
  durationMs: 0,
});

export const assistantMessage = (base, text, streaming = false) => ({
  ...base,
  type: "assistant_message",
  text,
  streaming,
});

export const toolCall = (base, { name, input, status = "success" }) => ({
  ...base,
  type: "tool_call",
  call: { id: base.id, name, input, status, startedAt: base.ts },
});

export const toolResult = (base, { toolCallId, content, isError = false }) => ({
  ...base,
  type: "tool_result",
  result: { toolCallId, content, isError, durationMs: null },
});

export const systemEvent = (base, message, level = "warning", detail) => ({
  ...base,
  type: "system_event",
  message,
  level,
  ...(detail ? { detail } : {}),
});

export const permissionRequest = (base, { requestId, toolName, toolTitle, options }) => ({
  ...base,
  type: "permission_request",
  requestId,
  toolName,
  toolTitle,
  options,
});

// --- bounded reads -----------------------------------------------------------

/**
 * Read up to `bytes` from the END of a file and return its complete lines
 * (the possibly-truncated first line is dropped). Used for activity checks so
 * a multi-hundred-MB transcript costs one 64KB positioned read, never a full scan.
 */
export function readTailLines(filePath, bytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter(Boolean);
    if (len < size && lines.length) lines.shift(); // first line is mid-record
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** Build a unified-diff body from Claude Code's structuredPatch hunks. */
export function patchFromStructured(structuredPatch, filePath = "") {
  try {
    const parts = [];
    if (filePath) parts.push(`--- a/${filePath}`, `+++ b/${filePath}`);
    for (const h of structuredPatch || []) {
      parts.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const l of h.lines || []) parts.push(l);
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

/** Flatten a message-content field (string | block array) to its text. */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text || "" : ""))
      .join("");
  }
  return "";
}
