/**
 * Skills available to the agents working in a project.
 *
 * A skill is a folder with a `SKILL.md` — front matter naming it and saying
 * when to use it, then the instructions themselves. They decide what an agent
 * will actually do in a repo, and until now they were invisible from Pounce:
 * you could read every transcript a skill produced and never see the skill.
 *
 * Read the way skills.sh lays them out, NOT the way any one agent does:
 *
 *   .agents/skills/<name>/SKILL.md      the canonical store (project)
 *   ~/.agents/skills/<name>/SKILL.md    the same, for every project
 *   .claude/skills/<name> -> ../../.agents/skills/<name>     per-agent farms,
 *   .opencode/skills/<name> -> …                             symlinks into it
 *   skills-lock.json                    where each one came from, and at which ref
 *
 * That layout is the whole reason this file is agent-agnostic: the store is
 * shared, and each agent gets a symlink farm pointing into it. So the store
 * answers "what skills exist", and the farms answer "who can see this one" —
 * which is a fact worth showing and impossible to get by reading one agent's
 * directory. Repos that don't use skills.sh have no store and only farms, so
 * those are read too and folded together by their real path; a skill found
 * both ways is one skill, not two.
 *
 * Read-only. Nothing here writes, moves or deletes a skill.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Enough of a SKILL.md to render; they are instructions, not documents. */
const MAX_DOC_BYTES = 256 * 1024;
/** A directory that isn't a skill collection shouldn't cost a deep walk. */
const MAX_SUPPORTING_DEPTH = 6;

/** The per-agent symlink farms, by the directory each agent reads. `skill` and
 *  `skills` both appear in the wild, so both are checked. */
const AGENT_DIRS = [
  ["claude", ".claude"],
  ["opencode", ".opencode"],
  ["codex", ".codex"],
  ["cursor", ".cursor"],
  ["copilot", ".github/copilot"],
];
const SKILL_SUBDIRS = ["skills", "skill"];

const norm = (p) => (p || "").replace(/\\/g, "/").replace(/\/+$/, "");

/** Resolve through symlinks, or null when the link dangles — which happens for
 *  real: a worktree carries `.claude/skills` while `.agents` lives only in the
 *  checkout it was cut from, leaving every link pointing at nothing. */
function real(p) {
  try {
    return norm(realpathSync(p));
  } catch {
    return null;
  }
}

/** The project root for a working directory: the nearest ancestor that holds a
 *  skills store, a lockfile or a `.git`. Walks up because a session's cwd is
 *  often a subdirectory (or a worktree) rather than the root itself. */
export function projectRoot(cwd, exists = existsSync) {
  let dir = norm(cwd);
  for (let i = 0; dir && i < 40; i++) {
    for (const marker of [".agents/skills", "skills-lock.json", ".git"]) {
      if (exists(path.join(dir, marker))) return dir;
    }
    const parent = norm(path.dirname(dir));
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** `name` and `description` out of YAML front matter. Deliberately not a YAML
 *  parser: these two keys are the contract every SKILL.md follows, and a real
 *  parser would be a dependency plus a new way to fail on someone's odd file. */
export function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "");
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    if (key !== "name" && key !== "description") continue;
    let v = kv[2].trim();
    // Quoted values are common; block scalars (`>`/`|`) are not worth the
    // machinery, so they simply yield nothing rather than the marker itself.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else if (v === ">" || v === "|" || v === ">-" || v === "|-") {
      v = "";
    }
    out[key] = v;
  }
  return out;
}

/** Files beside SKILL.md, and what the whole skill weighs. */
function supporting(dir, depth = 0) {
  let files = 0;
  let bytes = 0;
  if (depth > MAX_SUPPORTING_DEPTH) return { files, bytes };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files, bytes };
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = supporting(full, depth + 1);
      files += sub.files;
      bytes += sub.bytes;
      continue;
    }
    try {
      bytes += statSync(full).size;
    } catch {
      continue;
    }
    if (!(depth === 0 && e.name === "SKILL.md")) files++;
  }
  return { files, bytes };
}

/** Every `<root>/<agentdir>/<skills|skill>/*` link, as realpath → agent id. */
function farms(root, agents = new Map()) {
  for (const [agent, dir] of AGENT_DIRS) {
    for (const sub of SKILL_SUBDIRS) {
      const base = path.join(root, dir, sub);
      let entries;
      try {
        entries = readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const resolved = real(path.join(base, e.name));
        if (!resolved) continue; // dangling link — the skill isn't there to read
        // A BUNDLE: a directory of skills rather than one skill, which is how
        // a plugin ships several at once (`superset/skills/{standup,doctor,…}`).
        // Without descending, eight skills the agent can plainly use are
        // invisible here, while their unlinked copies in the store show as
        // "no agent linked" — the list would be wrong in both directions.
        const nested = existsSync(path.join(resolved, "SKILL.md"))
          ? [resolved]
          : SKILL_SUBDIRS.flatMap((sub) => storeDirs(path.join(resolved, sub)));
        for (const target of nested) {
          const seen = agents.get(target) ?? new Set();
          seen.add(agent);
          agents.set(target, seen);
        }
      }
    }
  }
  return agents;
}

/** Skill directories directly under a store. */
function storeDirs(base) {
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => real(path.join(base, e.name)))
    .filter(Boolean);
}

/** `software-mansion/argent @ v0.20.0` for a skill the lockfile records. */
function provenance(lock, name) {
  const row = lock?.skills?.[name];
  if (!row?.source) return null;
  return { source: row.source, ref: row.ref ?? null, kind: row.sourceType ?? null };
}

function readLock(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "skills-lock.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Every skill an agent working in `cwd` can reach.
 *
 * @param {object} deps
 * @param {string} deps.cwd     a session's working directory (or the repo root)
 * @param {string} [deps.home]  overridden in tests
 */
export function readSkills({ cwd, home = os.homedir(), exists = existsSync } = {}) {
  const root = projectRoot(cwd, exists);
  const userRoot = norm(home);

  // Who can see what, from both farms. Project first so a project link and a
  // user link to the SAME skill both land on one entry.
  const agentsByPath = new Map();
  if (root) farms(root, agentsByPath);
  farms(userRoot, agentsByPath);

  const found = new Map(); // realpath → row
  const add = (dir, scope) => {
    if (!dir || found.has(dir)) return;
    const doc = path.join(dir, "SKILL.md");
    let text;
    try {
      text = readFileSync(doc, "utf8").slice(0, MAX_DOC_BYTES);
    } catch {
      return; // a directory without a SKILL.md is not a skill
    }
    const fm = frontMatter(text);
    const { files, bytes } = supporting(dir);
    let updatedAt = null;
    try {
      updatedAt = new Date(statSync(doc).mtimeMs).toISOString();
    } catch {}
    found.set(dir, {
      installed: true,
      name: fm.name || path.basename(dir),
      description: fm.description || null,
      path: dir,
      scope,
      // Sorted for a stable row; an empty list means the store has it but no
      // agent links it — installed, and currently invisible to every agent.
      agents: [...(agentsByPath.get(dir) ?? [])].sort(),
      files,
      bytes,
      updatedAt,
      source: null,
    });
  };

  if (root) for (const d of storeDirs(path.join(root, ".agents", "skills"))) add(d, "project");
  for (const d of storeDirs(path.join(userRoot, ".agents", "skills"))) add(d, "user");
  // Farms last: anything they point at that the stores didn't already cover is
  // a skill kept outside skills.sh, and it counts just the same.
  for (const dir of agentsByPath.keys()) {
    add(dir, root && dir.startsWith(`${root}/`) ? "project" : "user");
  }

  // One row per NAME. A skill can genuinely exist twice on disk — a copy in
  // the shared store and another inside an agent's own directory (not a link
  // to it, an actual second copy) — and listing both shows the same skill
  // twice, once claiming no agent can see it. Merge them: the union of the
  // agents, and the copy an agent actually reads is the one to open.
  // Grouped by hand, not with `Map.groupBy`: that lands in Node 21 and this
  // repo's floor is 20 (see agents/store.mjs for the same constraint biting).
  const byName = new Map();
  for (const row of found.values()) {
    const group = byName.get(row.name);
    if (group) group.push(row);
    else byName.set(row.name, [row]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const best = group.find((r) => r.agents.length) ?? group[0];
    best.agents = [...new Set(group.flatMap((r) => r.agents))].sort();
    for (const dup of group) if (dup !== best) found.delete(dup.path);
  }

  const lock = root ? readLock(root) : null;
  const userLock = readLock(userRoot);
  const rows = [...found.values()].map((r) => ({
    ...r,
    source: provenance(r.scope === "project" ? lock : userLock, r.name) ?? provenance(lock, r.name),
  }));

  // Declared but NOT installed — the state a fresh worktree is in, and the one
  // worth saying out loud. `skills-lock.json` is checked in while the store it
  // points at is ignored, so `.claude/skills` arrives as a farm of symlinks
  // dangling over nothing: the agent silently has no skills, and the only
  // evidence is that they don't fire. A row saying so is the answer to "why is
  // it ignoring my skill".
  const have = new Set(rows.map((r) => r.name));
  for (const name of Object.keys(lock?.skills ?? {})) {
    if (have.has(name)) continue;
    rows.push({
      installed: false,
      name,
      description: null,
      path: null,
      scope: "project",
      agents: [],
      files: 0,
      bytes: 0,
      updatedAt: null,
      source: provenance(lock, name),
    });
  }
  // Project before user, then by name: a project's own skills are the ones
  // that make it different from every other project.
  rows.sort(
    (a, b) =>
      (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1) || a.name.localeCompare(b.name),
  );
  return { root, skills: rows };
}

/**
 * One skill's SKILL.md.
 *
 * `dir` must be a directory `readSkills` just returned for this cwd — the same
 * rule the disk report uses for deletion, and for the same reason: a path
 * parameter that reads any file on the machine is a file-exfiltration endpoint
 * with extra steps.
 */
export function readSkillDoc({ cwd, dir, home = os.homedir(), exists = existsSync } = {}) {
  // Resolved before comparing: the list holds realpaths, and a caller's path
  // may travel through a symlink — on macOS every `/tmp` and `/var` path does,
  // so a raw comparison refuses skills that are plainly there.
  const target = real(dir || "") ?? norm(dir || "");
  const { skills } = readSkills({ cwd, home, exists });
  const hit = skills.find((s) => s.path === target);
  if (!hit) return null;
  try {
    return {
      ...hit,
      doc: readFileSync(path.join(target, "SKILL.md"), "utf8").slice(0, MAX_DOC_BYTES),
    };
  } catch {
    return null;
  }
}
