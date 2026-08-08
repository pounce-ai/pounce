/**
 * Who is currently asking this machine for access — one poll, many readers.
 *
 * Three things in the chrome need this list: the titlebar bell, the badge on
 * the account row's Connect button, and the alert that interrupts you when a
 * request lands. Each used to run its own 5s interval against the bridge, which
 * is three times the traffic for one answer and — worse — three answers that
 * can disagree for a few seconds, so the bell could show a count while the
 * alert had not noticed yet.
 *
 * The poll runs only while something is mounted to read it, and stops when the
 * last reader unmounts.
 */
import { useEffect, useState } from "react";
import { listAccess, type AccessRequest } from "@pounce/app/services/peers";

const POLL_MS = 5_000;

let pending: AccessRequest[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(v: AccessRequest[]) => void>();

async function tick() {
  const { pending: next } = await listAccess();
  // Same ids in the same order means nothing changed; re-publishing a fresh
  // array anyway would re-render every reader on every tick forever.
  const same = next.length === pending.length && next.every((r, i) => r.id === pending[i]?.id);
  if (same) return;
  pending = next;
  for (const fn of listeners) fn(pending);
}

/** The requests waiting on a decision here. Live — it repolls while mounted. */
export function useAccessRequests(): AccessRequest[] {
  const [value, setValue] = useState(pending);
  useEffect(() => {
    listeners.add(setValue);
    if (!timer) {
      timer = setInterval(() => void tick(), POLL_MS);
      void tick(); // don't make the first reader wait out a whole interval
    } else {
      setValue(pending); // a later reader starts from what is already known
    }
    return () => {
      listeners.delete(setValue);
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return value;
}

/** Drop a request from the shared list the moment it is answered, rather than
 *  letting it linger until the next poll — an approved request that stays on
 *  screen for five seconds reads as a click that didn't work. */
export function forgetAccessRequest(id: string): void {
  const next = pending.filter((r) => r.id !== id);
  if (next.length === pending.length) return;
  pending = next;
  for (const fn of listeners) fn(pending);
}
