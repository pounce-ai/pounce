/**
 * Where a session's chrome lives — the seam between mobile and desktop.
 *
 * On a phone the thread's toolbar is part of the screen, so its controls are
 * ordinary local state. On desktop the screen has no header of its own: the
 * shell's tab strip owns the search and "…" buttons and the status bar shows
 * the usage readout, so those pieces have to be reachable from outside the
 * screen. The desktop variant backs them with an observable; this default keeps
 * mobile on plain `useState` and publishes nothing.
 */
import { useState } from "react";
import type { ThreadUsage } from "../services/bridge";
import type { TaskListState } from "../components/taskEvents";

export type { SessionChrome } from "./sessionChromeTypes";
import type { SessionChrome } from "./sessionChromeTypes";

export function useSessionChrome(): SessionChrome {
  const [searchOpen, setSearchOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  return { searchOpen, setSearchOpen, envOpen, setEnvOpen, tasksOpen, setTasksOpen };
}

/** No-op on mobile — the screen renders its own usage summary. */
export function usePublishUsage(_usage: ThreadUsage | null): void {}

/** No-op on mobile — the checklist appears above the composer there. */
export function usePublishTasks(_tasks: TaskListState | null): void {}
