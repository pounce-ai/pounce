/**
 * Session chrome — desktop implementation (see ./sessionChrome.ts).
 *
 * The shell's tab strip and status bar render controls that belong to the open
 * session, so the state has to outlive the screen's own tree. One observable
 * does it: the screen reads and writes it exactly as it would local state, and
 * the shell reads the same values.
 */
import { useEffect } from "react";
import { observable } from "@legendapp/state";
import { useSelector } from "@legendapp/state/react";
import type { ThreadUsage } from "../services/bridge";
import type { TaskListState } from "../components/taskEvents";
import type { SessionChrome } from "./sessionChromeTypes";

export type { SessionChrome } from "./sessionChromeTypes";

export const sessionChrome$ = observable<{
  searchOpen: boolean;
  envOpen: boolean;
  tasksOpen: boolean;
  usage: ThreadUsage | null;
  tasks: TaskListState | null;
}>({ searchOpen: false, envOpen: false, tasksOpen: false, usage: null, tasks: null });

// Module scope, so these keep one identity forever: the screen puts them in
// hook dependency arrays, and a fresh closure per render would re-run those
// effects on every single render.
const setSearchOpen = (open: boolean) => sessionChrome$.searchOpen.set(open);
const setEnvOpen = (open: boolean) => sessionChrome$.envOpen.set(open);
const setTasksOpen = (open: boolean) => sessionChrome$.tasksOpen.set(open);

export function useSessionChrome(): SessionChrome {
  const searchOpen = useSelector(() => sessionChrome$.searchOpen.get());
  const envOpen = useSelector(() => sessionChrome$.envOpen.get());
  const tasksOpen = useSelector(() => sessionChrome$.tasksOpen.get());
  return { searchOpen, setSearchOpen, envOpen, setEnvOpen, tasksOpen, setTasksOpen };
}

/** Hand the thread's token/cost figures to the shell's status bar. Cleared on
 *  unmount so a closed tab's numbers never linger under a different thread. */
export function usePublishUsage(usage: ThreadUsage | null): void {
  useEffect(() => {
    sessionChrome$.usage.set(usage);
    return () => sessionChrome$.usage.set(null);
  }, [usage]);
}

/** Hand the turn's checklist to the status line, which shows the count and owns
 *  whether the list is expanded. Cleared on unmount for the same reason. */
export function usePublishTasks(tasks: TaskListState | null): void {
  useEffect(() => {
    sessionChrome$.tasks.set(tasks);
    return () => sessionChrome$.tasks.set(null);
  }, [tasks]);
}
