export interface DiffViewProps {
  /** Raw multi-file unified diff. */
  patch: string;
  layout?: "unified" | "split";
  /** Show only files with this extension (".ts", "other"); null = all. */
  extFilter?: string | null;
  /** Files already marked "Seen" — rendered collapsed on mount. */
  seenPaths?: string[];
  onToggleSeen?: (path: string, seen: boolean) => Promise<void>;
}
