/** Shape of the session-chrome seam, in its own module so the platform
 *  implementations can both import it (a `.desktop` file importing from
 *  `./sessionChrome` resolves back to itself). */
export interface SessionChrome {
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  envOpen: boolean;
  setEnvOpen: (open: boolean) => void;
  /** Desktop only: the checklist is opened from the status line rather than
   *  appearing over the composer of its own accord. */
  tasksOpen: boolean;
  setTasksOpen: (open: boolean) => void;
}
