/**
 * Reading skills the way skills.sh lays them out.
 *
 * Built on a real directory tree rather than mocks, because everything
 * interesting here is a filesystem fact: a symlink farm pointing into a shared
 * store, the same skill reachable two ways, and a link that dangles because the
 * store it points at was never installed in this checkout.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { frontMatter, projectRoot, readSkillDoc, readSkills } from "./skills.mjs";

let home;
let repo;

/** `<root>/.agents/skills/<name>/SKILL.md`, plus any supporting files. */
function store(root, name, { description = `does ${name}`, files = {} } = {}) {
  const dir = path.join(root, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n`,
  );
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

/** `<root>/<agentDir>/skills/<name>` → target, the way skills.sh links them. */
function link(root, agentDir, name, target) {
  const base = path.join(root, agentDir, "skills");
  mkdirSync(base, { recursive: true });
  symlinkSync(target, path.join(base, name));
}

beforeAll(() => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pounce-skills-"));
  home = path.join(tmp, "home");
  repo = path.join(tmp, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });

  // A user skill two agents can see, and a project skill only Claude links.
  const shared = store(home, "shared-skill");
  link(home, ".claude", "shared-skill", shared);
  link(home, ".opencode", "shared-skill", shared);

  const local = store(repo, "repo-skill", { files: { "references/rules.md": "x".repeat(100) } });
  link(repo, ".claude", "repo-skill", local);

  // A skill kept outside the skills.sh store — a plain directory some agent
  // links directly. It still counts.
  const loose = path.join(repo, "handmade", "loose-skill");
  mkdirSync(loose, { recursive: true });
  writeFileSync(path.join(loose, "SKILL.md"), "---\nname: loose-skill\n---\n\nbody\n");
  link(repo, ".cursor", "loose-skill", loose);

  // A plugin bundle: one farm entry holding a nest of skills.
  const bundle = path.join(home, ".claude", "skills", "pack", "skills");
  for (const n of ["bundled-one", "bundled-two"]) {
    mkdirSync(path.join(bundle, n), { recursive: true });
    writeFileSync(path.join(bundle, n, "SKILL.md"), `---\nname: ${n}\ndescription: d\n---\nb\n`);
  }

  // The same skill twice: in the shared store, and as a real directory inside
  // the agent's own skills dir (a copy, not a link to the store).
  store(home, "twin-skill");
  const twin = path.join(home, ".claude", "skills", "twin-skill");
  mkdirSync(twin, { recursive: true });
  writeFileSync(path.join(twin, "SKILL.md"), "---\nname: twin-skill\ndescription: d\n---\nb\n");

  // The state a fresh worktree is in: the lockfile is checked in, the store it
  // points at is not, so the farm link dangles over nothing.
  link(repo, ".claude", "ghost-skill", path.join(repo, ".agents", "skills", "ghost-skill"));
  writeFileSync(
    path.join(repo, "skills-lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        "repo-skill": { source: "acme/pack", ref: "v1.2.0", sourceType: "github" },
        "ghost-skill": { source: "acme/pack", ref: "v1.2.0", sourceType: "github" },
      },
    }),
  );
});

afterAll(() => {
  try {
    rmSync(path.dirname(home), { recursive: true, force: true });
  } catch {}
});

const byName = (r) => Object.fromEntries(r.skills.map((s) => [s.name, s]));

describe("readSkills", () => {
  it("finds project and user skills, and says which agents can see each", () => {
    const r = readSkills({ cwd: repo, home });
    const s = byName(r);
    expect(s["repo-skill"]).toMatchObject({
      scope: "project",
      installed: true,
      agents: ["claude"],
    });
    expect(s["shared-skill"]).toMatchObject({ scope: "user", agents: ["claude", "opencode"] });
  });

  it("counts one skill once, however many agents link it", () => {
    const r = readSkills({ cwd: repo, home });
    expect(r.skills.filter((x) => x.name === "shared-skill")).toHaveLength(1);
  });

  it("includes a skill kept outside the skills.sh store", () => {
    const s = byName(readSkills({ cwd: repo, home }));
    expect(s["loose-skill"]).toMatchObject({ installed: true, agents: ["cursor"] });
  });

  it("reports a declared-but-uninstalled skill instead of silently omitting it", () => {
    // The whole point: `.claude/skills/ghost-skill` exists and points at
    // nothing, so the agent has no such skill and nothing says why.
    const s = byName(readSkills({ cwd: repo, home }));
    expect(s["ghost-skill"]).toMatchObject({
      installed: false,
      path: null,
      agents: [],
      source: { source: "acme/pack", ref: "v1.2.0" },
    });
  });

  it("carries provenance and supporting-file counts", () => {
    const s = byName(readSkills({ cwd: repo, home }));
    expect(s["repo-skill"].source).toMatchObject({ source: "acme/pack", ref: "v1.2.0" });
    expect(s["repo-skill"].files).toBe(1);
    expect(s["repo-skill"].bytes).toBeGreaterThan(100);
    // A hand-written skill has no lockfile row, and that is not a failure.
    expect(s["loose-skill"].source).toBe(null);
  });

  it("descends into a plugin BUNDLE — a directory of skills, not one skill", () => {
    // How a plugin ships several at once: `.claude/skills/pack/skills/{a,b}`.
    // Without descending, every skill it provides is invisible.
    const s = byName(readSkills({ cwd: repo, home }));
    expect(s["bundled-one"]).toMatchObject({ installed: true, agents: ["claude"] });
    expect(s["bundled-two"]).toMatchObject({ installed: true, agents: ["claude"] });
  });

  it("merges a skill that exists twice on disk into one row", () => {
    // A store copy and a real (non-symlink) copy inside an agent's directory.
    // Listed separately, the same skill appears twice and one of the two
    // claims no agent can see it.
    const r = readSkills({ cwd: repo, home });
    const twins = r.skills.filter((x) => x.name === "twin-skill");
    expect(twins).toHaveLength(1);
    expect(twins[0].agents).toEqual(["claude"]);
  });

  it("resolves the project from a subdirectory of it", () => {
    const deep = path.join(repo, "packages", "app", "src");
    mkdirSync(deep, { recursive: true });
    expect(projectRoot(deep)).toBe(repo);
    expect(byName(readSkills({ cwd: deep, home }))["repo-skill"]).toBeTruthy();
  });

  it("still lists the user's skills outside any project", () => {
    const r = readSkills({ cwd: os.tmpdir(), home });
    expect(byName(r)["shared-skill"]).toBeTruthy();
  });
});

describe("readSkillDoc", () => {
  it("returns the SKILL.md of a skill this project can reach", () => {
    const doc = readSkillDoc({
      cwd: repo,
      dir: path.join(repo, ".agents/skills/repo-skill"),
      home,
    });
    expect(doc?.doc).toContain("# repo-skill");
    expect(doc?.name).toBe("repo-skill");
  });

  it("refuses a path that isn't one of this project's skills", () => {
    // The guard that stops a `dir` parameter reading anything on the machine.
    for (const dir of [os.homedir(), path.join(repo, ".git"), "/etc", ""]) {
      expect(readSkillDoc({ cwd: repo, dir, home })).toBe(null);
    }
  });
});

describe("frontMatter", () => {
  it("reads name and description, quoted or bare", () => {
    expect(frontMatter('---\nname: a\ndescription: "b: with colon"\n---\nbody')).toEqual({
      name: "a",
      description: "b: with colon",
    });
  });

  it("yields nothing rather than a marker for a block scalar", () => {
    expect(frontMatter("---\nname: a\ndescription: >\n  wrapped\n---\n")).toEqual({
      name: "a",
      description: "",
    });
  });

  it("survives a file with no front matter at all", () => {
    expect(frontMatter("# just a heading")).toEqual({});
    expect(frontMatter("")).toEqual({});
  });
});
