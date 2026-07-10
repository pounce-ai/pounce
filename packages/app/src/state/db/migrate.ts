/**
 * One-time import of the old Legend State MMKV data into react-db collections.
 *
 * Before this migration, state lived in ~16 independent observables persisted by
 * `@legendapp/state`'s MMKV plugin — each stored as plain JSON at its key
 * (`devices`, `sessions`, `recentOpens`, …). This reads those legacy keys once
 * and reshapes them into collection rows, so existing users keep their pairings,
 * threads, favourites and history after the upgrade. Runs before the first sync,
 * gated on a flag so it never re-imports. `filters`/`user` stay in Legend State.
 */
import type { AgentCapabilities, Device, Host, Repository, Session } from "@litter/shared";
import type { ModelInfo } from "../../services/bridge";
import { storage as mmkv } from "../../services/persistence";
import {
  agentCaps,
  agentModels,
  deviceOverrides,
  devices,
  favorites,
  hosts,
  ignoredRepos,
  markers,
  projects,
  recents,
  syncLog,
  threadModels,
  threads,
} from "./collections";

const MIGRATED_FLAG = "db:__migrated";

function readJson<T>(key: string): T | null {
  const raw = mmkv.getString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Insert rows into a collection unless it's empty-input or already populated. */
function seed<T extends object>(
  collection: { size: number; insert: (rows: T[]) => unknown },
  rows: T[],
): void {
  if (rows.length === 0 || collection.size > 0) return;
  collection.insert(rows);
}

/**
 * Import legacy data into collections. Idempotent: gated on `db:__migrated`, and
 * each `seed` also no-ops if its collection already has rows. Call AFTER
 * `preloadDb()` so collection sizes are accurate.
 */
export function migrateLegendToDb(): void {
  if (mmkv.getString(MIGRATED_FLAG)) return;

  const legacyDevices = readJson<Record<string, Device>>("devices");
  if (legacyDevices) seed(devices, Object.values(legacyDevices));

  const legacyHosts = readJson<Record<string, Host>>("hosts");
  if (legacyHosts) seed(hosts, Object.values(legacyHosts));

  const legacyRepos = readJson<Record<string, Repository>>("repositories");
  if (legacyRepos) seed(projects, Object.values(legacyRepos));

  const legacySessions = readJson<Record<string, Session>>("sessions");
  if (legacySessions) seed(threads, Object.values(legacySessions));

  const legacyRecents = readJson<Record<string, string>>("recentOpens");
  if (legacyRecents) {
    seed(
      recents,
      Object.entries(legacyRecents).map(([id, openedAt]) => ({ id, openedAt })),
    );
  }

  const legacySyncLog = readJson<{ at: string; repos: { repoId: string; name: string; count: number }[] }[]>("syncLog");
  if (legacySyncLog) {
    seed(
      syncLog,
      legacySyncLog.map((e, i) => ({ id: `${e.at}:${i}`, at: e.at, repos: e.repos })),
    );
  }

  const favThreads = readJson<Record<string, true>>("favThreads");
  const favReposMap = readJson<Record<string, true>>("favRepos");
  const favRows = [
    ...Object.keys(favThreads ?? {}).map((ref) => ({ id: `thread:${ref}`, kind: "thread" as const, ref })),
    ...Object.keys(favReposMap ?? {}).map((ref) => ({ id: `repo:${ref}`, kind: "repo" as const, ref })),
  ];
  seed(favorites, favRows);

  const legacyIgnored = readJson<Record<string, true>>("ignoredRepos");
  if (legacyIgnored) seed(ignoredRepos, Object.keys(legacyIgnored).map((id) => ({ id })));

  const legacyThreadModels = readJson<Record<string, string>>("threadModels");
  if (legacyThreadModels) {
    seed(threadModels, Object.entries(legacyThreadModels).map(([id, model]) => ({ id, model })));
  }

  const legacyAgentModels = readJson<Record<string, ModelInfo[]>>("agentModels");
  if (legacyAgentModels) {
    seed(agentModels, Object.entries(legacyAgentModels).map(([id, models]) => ({ id, models })));
  }

  const legacyCaps = readJson<Record<string, AgentCapabilities>>("agentCaps");
  if (legacyCaps) seed(agentCaps, Object.entries(legacyCaps).map(([id, caps]) => ({ ...caps, id })));

  const legacyOverrides = readJson<Record<string, { name?: string; emoji?: string }>>("deviceOverrides");
  if (legacyOverrides) {
    seed(deviceOverrides, Object.entries(legacyOverrides).map(([id, patch]) => ({ id, ...patch })));
  }

  const legacyMarkers = readJson<Record<string, Record<string, boolean>>>("markers");
  if (legacyMarkers) {
    const rows = Object.entries(legacyMarkers).flatMap(([sessionId, byMsg]) =>
      Object.entries(byMsg).map(([messageId, marked]) => ({ id: `${sessionId}|${messageId}`, marked })),
    );
    seed(markers, rows);
  }

  mmkv.set(MIGRATED_FLAG, "1");
}
