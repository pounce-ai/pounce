/**
 * Minimal unified-patch splitter shared by the diff viewers: enough structure
 * to filter by file and render per-file sections, without a diff library.
 */

export interface PatchFile {
  /** New path (old path for deletions). */
  path: string;
  /** The file's complete patch text, including its `diff --git` header. */
  text: string;
  adds: number;
  dels: number;
}

/** Split a multi-file unified diff into per-file patches. */
export function splitPatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  if (!patch.trim()) return files;
  const lines = patch.split("\n");
  let cur: { header: string; body: string[]; adds: number; dels: number } | null = null;
  const flush = () => {
    if (!cur) return;
    // Path from `diff --git a/X b/Y` — take the b side (a side survives for
    // deletions since both sides name the same file there).
    const m = cur.header.match(/^diff --git a\/(.*) b\/(.*)$/);
    files.push({
      path: m?.[2] ?? m?.[1] ?? "unknown",
      text: [cur.header, ...cur.body].join("\n"),
      adds: cur.adds,
      dels: cur.dels,
    });
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      cur = { header: line, body: [], adds: 0, dels: 0 };
      continue;
    }
    if (!cur) continue; // preamble before the first file header
    // The bridge caps huge diffs and appends this marker on its own line — it
    // isn't valid unified-diff content and strict parsers (Pierre) reject it.
    // Exact match only: a diff of the bridge's own source contains the same
    // string as a +/-/context line. The preceding line may be cut mid-way, so
    // drop both.
    if (line === "… (diff truncated)") {
      cur.body.pop();
      break;
    }
    cur.body.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) cur.adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) cur.dels++;
  }
  flush();
  return files;
}

/** File extension for filtering/grouping — ".ts", ".json"; "other" when none. */
export function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "other";
}

/** Git metadata lines (not hunk content) in a unified diff. */
export const DIFF_META_RE =
  /^(diff --git|index |--- |\+\+\+ |new file|deleted file|rename |similarity |old mode|new mode|Binary files)/;

export type LineKind = "header" | "hunk" | "add" | "del" | "ctx";

/** Classify one raw diff line for rendering. */
export function classifyLine(line: string): LineKind {
  if (line.startsWith("@@")) return "hunk";
  if (DIFF_META_RE.test(line)) return "header";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** Tailwind classes per diff-line kind (shared by every native renderer). */
export const LINE_CLASS: Record<LineKind, string> = {
  header: "text-fg-faint",
  hunk: "text-info",
  add: "bg-diff-add-bg text-diff-add-fg",
  del: "bg-diff-del-bg text-diff-del-fg",
  ctx: "text-fg-muted",
};
