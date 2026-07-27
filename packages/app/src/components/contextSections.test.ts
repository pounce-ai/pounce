import { describe, expect, it } from "vitest";
import {
  bodyOf,
  buildContextChangeRequest,
  countMatches,
  findMatches,
  quoteFor,
  sectionForText,
  splitHighlight,
  splitSections,
  type ContextComment,
} from "./contextSections";

describe("splitSections", () => {
  it("splits at ATX headings and keeps the heading line with its body", () => {
    const md = "# Project\n\nIntro line.\n\n## Testing\n\nRun the tests.\n";
    const out = splitSections(md, "CLAUDE.md");
    expect(out.map((s) => s.heading)).toEqual(["Project", "Testing"]);
    expect(out.map((s) => s.level)).toEqual([1, 2]);
    expect(out[0].body).toBe("# Project\n\nIntro line.");
    expect(out[1].body).toBe("## Testing\n\nRun the tests.");
  });

  it("keeps text above the first heading as a preamble", () => {
    const out = splitSections("Some notes.\n\n# Later\n\nbody\n", "AGENTS.md");
    expect(out[0].heading).toBeNull();
    expect(out[0].level).toBe(0);
    expect(out[0].body).toBe("Some notes.");
  });

  it("does not split on a # inside a fenced code block", () => {
    // The reason fence tracking exists: `# build` is a shell comment. Splitting
    // here would cut the code block in half.
    const md = ["## Setup", "", "```bash", "# build the thing", "make all", "```", ""].join("\n");
    const out = splitSections(md, "CLAUDE.md");
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain("# build the thing");
  });

  it("treats a ~~~ fence as separate from a ``` fence", () => {
    const md = ["# A", "~~~", "```", "# not a heading", "~~~", "", "# B", "tail"].join("\n");
    const out = splitSections(md, "CLAUDE.md");
    expect(out.map((s) => s.heading)).toEqual(["A", "B"]);
  });

  it("gives every section a stable per-file id", () => {
    const out = splitSections("# A\nx\n# B\ny\n", "CLAUDE.md");
    expect(out.map((s) => s.id)).toEqual(["CLAUDE.md#0", "CLAUDE.md#1"]);
  });

  it("returns nothing for empty or blank content", () => {
    expect(splitSections("", "CLAUDE.md")).toEqual([]);
    expect(splitSections("\n\n  \n", "CLAUDE.md")).toEqual([]);
  });
});

describe("countMatches / findMatches", () => {
  const sections = splitSections("# One\nalpha beta\n\n# Two\nbeta beta gamma\n", "CLAUDE.md");

  it("counts case-insensitively without overlapping", () => {
    expect(countMatches("aaaa", "aa")).toBe(2);
    expect(countMatches("Beta beta BETA", "beta")).toBe(3);
    expect(countMatches("anything", "  ")).toBe(0);
  });

  it("returns only matching sections, in document order, with hit counts", () => {
    const hits = findMatches(sections, "beta");
    expect(hits.map((h) => [h.section.heading, h.count])).toEqual([
      ["One", 1],
      ["Two", 2],
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(findMatches(sections, "   ")).toEqual([]);
  });
});

describe("splitHighlight", () => {
  it("alternates plain and matched runs", () => {
    expect(splitHighlight("run the Tests now", "tests")).toEqual([
      { text: "run the ", match: false },
      { text: "Tests", match: true },
      { text: " now", match: false },
    ]);
  });

  it("handles a match at both ends", () => {
    expect(splitHighlight("abcab", "ab")).toEqual([
      { text: "ab", match: true },
      { text: "c", match: false },
      { text: "ab", match: true },
    ]);
  });

  it("passes text through untouched with no query", () => {
    expect(splitHighlight("hello", "")).toEqual([{ text: "hello", match: false }]);
  });
});

describe("sectionForText", () => {
  const sections = splitSections(
    "# Top\n\nIntro text.\n\n## Testing\n\nRun `bun test` before every commit.\n\n## Style\n\nTwo-space indent.\n",
    "CLAUDE.md",
  );

  it("finds the section a selection came from", () => {
    expect(sectionForText(sections, "before every commit")?.heading).toBe("Testing");
    expect(sectionForText(sections, "Two-space indent.")?.heading).toBe("Style");
  });

  it("matches despite the renderer re-wrapping whitespace", () => {
    // The selection comes back from what was DRAWN, so line breaks and runs of
    // spaces won't match the source byte-for-byte.
    expect(sectionForText(sections, "Run  `bun test`\n   before")?.heading).toBe("Testing");
  });

  it("is case-insensitive", () => {
    expect(sectionForText(sections, "TWO-SPACE INDENT")?.heading).toBe("Style");
  });

  it("matches on the opening of a long selection", () => {
    // A selection spanning a heading boundary won't appear verbatim in any one
    // section; where it started is the honest answer.
    const long = "Two-space indent.\n\n## Something the renderer showed differently";
    expect(sectionForText(sections, long)?.heading).toBe("Style");
  });

  it("returns null rather than guessing when the text appears in several sections", () => {
    // Regression: selecting a common word used to resolve to whichever section
    // came first, naming a passage the user never looked at. A wrong heading is
    // worse than none — the agent would go edit the wrong place.
    const dup = splitSections(
      "# One\n\nthe shared phrase here\n\n# Two\n\nthe shared phrase here too\n",
      "CLAUDE.md",
    );
    expect(sectionForText(dup, "the shared phrase")).toBeNull();
  });

  it("still resolves a repeated phrase when the selection is long enough to be unique", () => {
    const dup = splitSections(
      "# One\n\nthe shared phrase here\n\n# Two\n\nthe shared phrase here too, and then more\n",
      "CLAUDE.md",
    );
    expect(sectionForText(dup, "the shared phrase here too, and then more")?.heading).toBe("Two");
  });

  it("matches a selection whose markdown syntax the renderer stripped", () => {
    // Regression: the user selects what they SEE ("Package manager is Bun"),
    // but the source says "**Bun**". Comparing raw markdown missed every
    // selection that crossed emphasis, a code span, or a link.
    const md = splitSections(
      "## Commands\n\nPackage manager is **Bun** (`bun@1.3.14`). See [the docs](https://bun.sh).\n",
      "CLAUDE.md",
    );
    expect(sectionForText(md, "Package manager is Bun (bun@1.3.14)")?.heading).toBe("Commands");
    expect(sectionForText(md, "bun@1.3.14). See the docs")?.heading).toBe("Commands");
  });

  it("matches a list item selected without its bullet", () => {
    const md = splitSections("## Rules\n\n- never use `as` casts\n- prefer Remeda\n", "CLAUDE.md");
    expect(sectionForText(md, "never use as casts")?.heading).toBe("Rules");
  });

  it("declines selections too short to place", () => {
    expect(sectionForText(sections, "Run")).toBeNull();
    expect(sectionForText(sections, "   ")).toBeNull();
  });

  it("returns null for text that isn't in the document", () => {
    expect(sectionForText(sections, "nothing like this appears anywhere")).toBeNull();
  });
});

describe("bodyOf", () => {
  it("drops the heading line", () => {
    const [section] = splitSections("## Testing\n\nRun the tests.\n", "CLAUDE.md");
    expect(bodyOf(section)).toBe("Run the tests.");
  });

  it("keeps a preamble whole", () => {
    const [section] = splitSections("No heading here.\n", "CLAUDE.md");
    expect(bodyOf(section)).toBe("No heading here.");
  });
});

describe("quoteFor", () => {
  it("quotes the body under the heading, not the heading itself", () => {
    const [section] = splitSections("## Testing\n\nRun bun test.\n", "CLAUDE.md");
    expect(quoteFor(section)).toBe("Run bun test.");
  });

  it("falls back to the heading when the section has no body", () => {
    const [section] = splitSections("## Testing\n", "CLAUDE.md");
    expect(quoteFor(section)).toBe("Testing");
  });

  it("caps a long section", () => {
    const [section] = splitSections(`## Long\n\n${"x".repeat(900)}\n`, "CLAUDE.md");
    const q = quoteFor(section);
    expect(q.endsWith("…")).toBe(true);
    expect(q).toHaveLength(501);
  });
});

describe("buildContextChangeRequest", () => {
  const comment = (over: Partial<ContextComment>): ContextComment => ({
    id: "c1",
    file: "CLAUDE.md",
    heading: "Testing",
    quote: "Run bun test.",
    note: "We use vitest now.",
    createdAt: "2026-07-27T00:00:00.000Z",
    ...over,
  });

  it("names the file and section on the note itself, and quotes the passage", () => {
    const out = buildContextChangeRequest({ cwd: "/repo", comments: [comment({})] });
    expect(out).toContain("/repo");
    expect(out).toContain("Files to edit: CLAUDE.md.");
    expect(out).toContain('### CLAUDE.md — section "Testing"');
    expect(out).toContain("> Run bun test.");
    expect(out).toContain("Requested change: We use vitest now.");
  });

  it("repeats the filename on EVERY note, not just once per group", () => {
    // The filename has to sit next to the request it applies to — a single
    // group header ends up an arbitrary number of lines above the later notes.
    const out = buildContextChangeRequest({
      cwd: "/repo",
      comments: [comment({ id: "a", heading: "Testing" }), comment({ id: "b", heading: "Style" })],
    });
    expect(out.match(/### CLAUDE\.md/g)).toHaveLength(2);
  });

  it("lists every file up front and keeps a file's notes together", () => {
    const out = buildContextChangeRequest({
      cwd: "/repo",
      comments: [
        comment({ id: "a", file: "CLAUDE.md" }),
        comment({ id: "b", file: "AGENTS.md", heading: "Build" }),
        comment({ id: "c", file: "CLAUDE.md", heading: "Style" }),
      ],
    });
    expect(out).toContain("Files to edit: CLAUDE.md, AGENTS.md.");
    expect(out.indexOf('### CLAUDE.md — section "Style"')).toBeLessThan(
      out.indexOf('### AGENTS.md — section "Build"'),
    );
  });

  it("asks for creation when the file doesn't exist yet", () => {
    const out = buildContextChangeRequest({
      cwd: "/repo",
      comments: [comment({ heading: null, quote: "", missing: true, note: "Cover the build." })],
    });
    expect(out).toContain("### CLAUDE.md — does not exist yet");
    expect(out).toContain("Requested change: Cover the build.");
    expect(out).not.toContain("section");
  });

  it("names the file even for a whole-file note with no section", () => {
    const out = buildContextChangeRequest({
      cwd: "/repo",
      comments: [comment({ heading: null, quote: "" })],
    });
    expect(out).toContain("### CLAUDE.md");
  });

  it("tells the agent to leave the rest alone", () => {
    const out = buildContextChangeRequest({ cwd: null, comments: [comment({})] });
    expect(out).toContain("leave everything the notes don't mention unchanged");
  });

  it("is empty with no comments", () => {
    expect(buildContextChangeRequest({ cwd: "/repo", comments: [] })).toBe("");
  });
});
