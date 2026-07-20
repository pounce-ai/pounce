/**
 * Local-notification alerts for threads blocked on an interactive prompt.
 * The 20s live sync hands each fresh session snapshot here; a thread that
 * ENTERED awaiting_input fires one notification whose tap deep-links into the
 * thread (where the prompt form sheet auto-presents). Edge-triggered: a thread
 * alerts once per blockage, re-arming only after the prompt clears, so the
 * polling loop can call this every tick without spamming.
 */
import { clearNotify, notifyOnce } from "./notify";

const awaiting = new Set<string>();

export function alertAwaitingSessions(
  sessions: Record<string, { id: string; title: string; activity: string }>,
): void {
  for (const s of Object.values(sessions)) {
    const key = `prompt:${s.id}`;
    if (s.activity === "awaiting_input") {
      if (!awaiting.has(s.id)) {
        awaiting.add(s.id);
        void notifyOnce(key, "🔔 Waiting on you", s.title, 60_000, {
          url: `/session/${s.id}`,
        });
      }
    } else if (awaiting.delete(s.id)) {
      clearNotify(key); // re-arm for the next time this thread blocks
    }
  }
}
