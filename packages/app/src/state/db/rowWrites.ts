/**
 * Low-level row writes, shared by every collection (their key IS `row.id`).
 *
 * Kept free of RN / MMKV imports so the rules here — above all "don't write a
 * row that hasn't changed" — are unit-testable without a device runtime.
 */
import { deepEqual } from "../equality";

/** The subset of the collection API these ops need — keeps callers generic.
 *  Mutation params are `any` so any of our differently-typed row collections is
 *  assignable (their concrete `insert(T | T[])` signatures otherwise clash). */
interface RowCollection {
  has(id: string): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(id: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insert(rows: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  update(id: string, fn: (draft: any) => void): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete(ids: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  keys(): IterableIterator<any>;
}

type WithId = { id: string };

/** Would `Object.assign(draft, row)` actually change `draft`?
 *
 *  Every sync tick re-sends the full row set, and almost all of those rows come
 *  back byte-identical. `update()` marks the row dirty and emits regardless, so
 *  each tick woke every `useLiveQuery` in the app and re-rendered every mounted
 *  screen top-to-bottom for data that had not moved — measured at ~5,100 fiber
 *  renders per 30s while sitting completely idle.
 *
 *  Only keys PRESENT on `row` matter: assign merges, so extra keys already on
 *  the draft are untouched and must not count as a difference. */
function assignWouldChange(draft: unknown, row: object): boolean {
  if (draft === null || typeof draft !== "object") return true;
  for (const [k, v] of Object.entries(row)) {
    if (!deepEqual((draft as Record<string, unknown>)[k], v)) return true;
  }
  return false;
}

/** Insert new rows and overwrite existing ones (matched by `id`), in as few
 *  writes as possible (one batched insert for the new keys, one update each for
 *  changed keys — each persists the whole blob once). */
export function upsertRows<T extends WithId>(c: RowCollection, rows: T[]): void {
  const toInsert: T[] = [];
  const insertAt = new Map<string, number>(); // id → its index in toInsert
  for (const r of rows) {
    if (c.has(r.id)) {
      // Skip no-op writes: an identical row still emits a change and wakes every
      // live query subscribed to this collection (see `assignWouldChange`).
      if (assignWouldChange(c.get(r.id), r)) {
        c.update(r.id, (draft) => void Object.assign(draft, r));
      }
    } else if (insertAt.has(r.id)) {
      // Duplicate id WITHIN this batch (e.g. two source events that derived the
      // same id — seen with codex messages sharing a timestamp). Never push a
      // dup into a single insert(): the collection throws "already exists" and
      // takes the whole screen down. Last write wins, matching upsert semantics.
      toInsert[insertAt.get(r.id)!] = r;
    } else {
      insertAt.set(r.id, toInsert.length);
      toInsert.push(r);
    }
  }
  if (!toInsert.length) return;
  try {
    c.insert(toInsert);
  } catch {
    // `has()` can disagree with the underlying store (a pending delete from an
    // earlier transaction, hydration races) and the batched insert then throws
    // "already exists" — which aborted the whole sync and froze every thread's
    // activity at its last value. Recover row-by-row: insert, else update,
    // else drop the row and let the next sync retry it.
    for (const r of toInsert) {
      try {
        c.insert([r]);
      } catch {
        try {
          c.update(r.id, (draft) => void Object.assign(draft, r));
        } catch {
          // unrecoverable this tick — next sync retries
        }
      }
    }
  }
}

/** Make the collection exactly `rows`: upsert the present, delete the absent.
 *  Returns which ids were removed so callers can cascade. */
export function replaceAll<T extends WithId>(
  c: RowCollection,
  rows: T[],
): { removedIds: string[] } {
  const nextIds = new Set(rows.map((r) => r.id));
  const removedIds = [...c.keys()].filter((id) => !nextIds.has(id));
  if (removedIds.length) c.delete(removedIds);
  upsertRows(c, rows);
  return { removedIds };
}

/** A collection's keys as `string[]` (all our collections key on string ids). */
export function keyList(c: RowCollection): string[] {
  return [...c.keys()] as string[];
}

/** Delete rows whose id is in `ids` (no-op on empty). */
export function deleteIds(c: RowCollection, ids: string[]): void {
  const present = ids.filter((id) => c.has(id));
  if (present.length) c.delete(present);
}

/** Empty a collection entirely. */
export function clearCollection(c: RowCollection): void {
  const ids = [...c.keys()];
  if (ids.length) c.delete(ids);
}
