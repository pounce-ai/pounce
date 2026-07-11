/**
 * Voice command interpreter — turns a spoken transcript into an app action
 * (filter, open a thread, new task). Rule-based for the common phrasings;
 * on-device Gemma will later augment this for free-form natural language.
 *
 * The STT itself (Whisper/Moonshine via react-native-executorch) feeds
 * transcripts here. Pure + dependency-free so it's unit-testable.
 */
import type { Device, Repository, Session } from "@litter/shared";

export interface VoiceContext {
  sessions: Session[];
  devices: Device[];
  agents: string[];
  repos: Record<string, Repository>;
  navigate: (path: string) => void;
  setFilter: (f: { device?: string | null; agent?: string | null; needsOnly?: boolean }) => void;
}

export interface VoiceResult {
  ok: boolean;
  /** Short spoken/visual confirmation, e.g. "Showing Codex tasks". */
  say: string;
}

const AGENT_LABEL: Record<string, string> = {
  claude: "Claude", codex: "Codex", opencode: "opencode", grok: "Grok",
  pi: "Pi", amp: "Amp", droid: "Droid", devin: "Devin", hermes: "Hermes",
};

/** Interpret `transcript` against `ctx` and perform the action. */
export function runVoiceCommand(transcript: string, ctx: VoiceContext): VoiceResult {
  const t = transcript.toLowerCase().trim().replace(/[.?!]+$/, "");
  if (!t) return { ok: false, say: "I didn't catch that." };

  // New task
  if (/\b(new task|start a (new )?task|create a task)\b/.test(t)) {
    ctx.navigate("/new");
    return { ok: true, say: "New task" };
  }

  // Open a specific thread: "open the auth thread", "open prod cart"
  const open = t.match(/^(?:open|show|go to)\s+(?:the\s+)?(.+?)(?:\s+(?:thread|task|card|session))?$/);
  if (open && /^(open|go to)/.test(t)) {
    const q = open[1].trim();
    // Don't hijack filter phrases like "open codex tasks".
    if (!isFilterPhrase(q, ctx)) {
      const hit = ctx.sessions.find((s) => matchesSession(s, q, ctx.repos));
      if (hit) {
        ctx.navigate(`/session/${hit.id}`);
        return { ok: true, say: `Opening ${hit.title}` };
      }
      return { ok: false, say: `Couldn't find "${q}"` };
    }
  }

  // Status filters
  if (/\b(needs? (you|me)|need attention|waiting on me|attention)\b/.test(t)) {
    ctx.setFilter({ needsOnly: true });
    return { ok: true, say: "Showing what needs you" };
  }
  if (/\b(everything|all (tasks|threads|sessions)|show all|clear filter)/.test(t)) {
    ctx.setFilter({ device: null, agent: null, needsOnly: false });
    return { ok: true, say: "Showing everything" };
  }

  // Agent filter: "show me codex tasks", "claude"
  for (const a of ctx.agents) {
    if (new RegExp(`\\b${a}\\b`).test(t)) {
      ctx.setFilter({ agent: a, needsOnly: false });
      return { ok: true, say: `Showing ${AGENT_LABEL[a] ?? a} tasks` };
    }
  }

  // Device filter: by device name
  for (const d of ctx.devices) {
    const name = d.name.toLowerCase();
    if (t.includes(name) || t.includes(name.replace(/[-\s]/g, ""))) {
      ctx.setFilter({ device: d.id, needsOnly: false });
      return { ok: true, say: `Showing ${d.name}` };
    }
  }

  return { ok: false, say: "Sorry, I didn't understand that." };
}

function isFilterPhrase(q: string, ctx: VoiceContext): boolean {
  return (
    ctx.agents.some((a) => q.includes(a)) ||
    ctx.devices.some((d) => q.includes(d.name.toLowerCase())) ||
    /\b(everything|all|needs)\b/.test(q)
  );
}

function matchesSession(s: Session, q: string, repos: Record<string, Repository>): boolean {
  const repo = repos[s.repoId]?.name ?? "";
  return (
    s.title.toLowerCase().includes(q) ||
    (s.branch ?? "").toLowerCase().includes(q) ||
    repo.toLowerCase().includes(q)
  );
}
