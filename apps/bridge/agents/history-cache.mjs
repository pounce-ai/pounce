/**
 * HistoryCache — bounded LRU for parsed thread histories (event arrays).
 *
 * The old bridge kept histories in an unbounded TTL map, which is exactly how a
 * few multi-million-token threads turn into hundreds of retained MB. This cache
 * enforces hard caps — entry count AND total bytes — and evicts oldest-first.
 * Entries never expire by time: transcripts are append-only, so the session
 * index's fs.watch invalidates a thread the moment its file changes, which is
 * strictly more precise than a TTL.
 */
export class HistoryCache {
  constructor({ maxEntries = 8, maxTotalBytes = 32 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries;
    this.maxTotalBytes = maxTotalBytes;
    this.map = new Map(); // key -> { events, bytes } (Map order = LRU order)
    this.totalBytes = 0;
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    this.map.delete(key); // re-insert = mark most-recently-used
    this.map.set(key, hit);
    return hit.events;
  }

  set(key, events, bytes) {
    this.delete(key);
    this.map.set(key, { events, bytes });
    this.totalBytes += bytes;
    while (this.map.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined || oldest === key) break; // never evict what we just set
      this.delete(oldest);
    }
  }

  delete(key) {
    const hit = this.map.get(key);
    if (!hit) return;
    this.totalBytes -= hit.bytes;
    this.map.delete(key);
  }

  /** Drop every entry for a thread (all :lastN variants share the prefix). */
  invalidatePrefix(prefix) {
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) this.delete(key);
    }
  }

  clear() {
    this.map.clear();
    this.totalBytes = 0;
  }
}

/** Rough retained-size estimate for an event array (text dominates). */
export function eventBytes(events) {
  let n = 0;
  for (const ev of events) {
    n += 200; // object/key overhead
    if (ev.text) n += ev.text.length * 2;
    const r = ev.result?.content;
    if (r?.text) n += r.text.length * 2;
    if (r?.patch) n += r.patch.length * 2;
    if (ev.call?.input) n += JSON.stringify(ev.call.input).length * 2;
  }
  return n;
}
