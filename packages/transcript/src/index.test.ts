import { describe, expect, it } from "vitest";
import { cleanAssistantText, isEmptyUserMessage, parseUserMessage, stripNoise } from "./index.js";

describe("parseUserMessage — claude", () => {
  const p = (raw: string) => parseUserMessage(raw, "claude");

  it("renders a slash command as a chip and drops the echo/args noise", () => {
    const raw =
      "<command-name>/login</command-name>\n<command-message>login</command-message>\n<command-args></command-args>";
    const r = p(raw);
    expect(r.command).toEqual({ name: "/login", args: undefined });
    expect(r.text).toBe("");
    expect(r.output).toBeUndefined();
    expect(isEmptyUserMessage(r)).toBe(false);
  });

  it("keeps non-empty command args", () => {
    expect(
      p("<command-name>/model</command-name>\n<command-args>opus</command-args>").command,
    ).toEqual({
      name: "/model",
      args: "opus",
    });
  });

  it("collapses local-command stdout into an output note", () => {
    const r = p("<local-command-stdout>Login successful</local-command-stdout>");
    expect(r.output).toEqual({ text: "Login successful", isError: false });
    expect(r.text).toBe("");
  });

  it("flags stderr output as an error", () => {
    expect(p("<local-command-stderr>boom</local-command-stderr>").output).toEqual({
      text: "boom",
      isError: true,
    });
  });

  it("strips ANSI escapes from captured output", () => {
    expect(
      p("<local-command-stdout>\x1b[1mBold\x1b[0m done</local-command-stdout>").output?.text,
    ).toBe("Bold done");
  });

  it("treats a lone caveat/system-reminder envelope as empty", () => {
    expect(isEmptyUserMessage(p("<local-command-caveat>Caveat: …</local-command-caveat>"))).toBe(
      true,
    );
    expect(isEmptyUserMessage(p("<system-reminder>Do not do X.</system-reminder>"))).toBe(true);
  });

  it("strips a task-notification envelope (task-id and all)", () => {
    const raw =
      "<task-notification>\n<task-id>aeaf6e6072ce89041</task-id>\nDone.\n</task-notification>";
    expect(isEmptyUserMessage(p(raw))).toBe(true);
    const r = p(`resume that\n${raw}`);
    expect(r.text).toBe("resume that");
    expect(isEmptyUserMessage(r)).toBe(false);
  });

  it("keeps real prose and strips a trailing system-reminder", () => {
    const r = p("where were we ?\n<system-reminder>internal</system-reminder>");
    expect(r.text).toBe("where were we ?");
    expect(isEmptyUserMessage(r)).toBe(false);
  });
});

describe("parseUserMessage — codex", () => {
  const p = (raw: string) => parseUserMessage(raw, "codex");

  it("strips a multi-paragraph INSTRUCTIONS block (blank lines and all)", () => {
    const raw =
      "# AGENTS.md instructions for /Users/x/proj\n\n<INSTRUCTIONS>\n\n# Project guidelines\n\nNever use any.\n\n</INSTRUCTIONS>";
    const r = p(raw);
    expect(r.text).toBe("");
    expect(isEmptyUserMessage(r)).toBe(true);
  });

  it("strips environment_context and keeps a following real prompt", () => {
    const raw =
      "<environment_context>\n  <cwd>/Users/x/proj</cwd>\n</environment_context>\n\nfix the login bug";
    expect(p(raw).text).toBe("fix the login bug");
  });

  it("does not invent Claude-style chips for codex", () => {
    expect(p("<command-name>/login</command-name>").command).toBeUndefined();
  });
});

describe("parseUserMessage — passthrough", () => {
  it("passes ordinary text through untouched", () => {
    expect(parseUserMessage("just a normal message", "claude")).toEqual({
      command: undefined,
      output: undefined,
      text: "just a normal message",
    });
  });

  it("leaves opencode / unknown-agent bodies (incl. legit <tags>) intact", () => {
    const code = "here is a type: Array<string> and <div>markup</div>";
    expect(parseUserMessage(code, "opencode").text).toBe(code);
    expect(parseUserMessage(code, "amp").text).toBe(code);
    expect(parseUserMessage(code, "claude").text).toBe(code);
  });

  it("an unclosed known tag does not swallow the following text", () => {
    const r = parseUserMessage("<system-reminder>oops no close\n\nActual user question?", "claude");
    expect(r.text).toContain("Actual user question?");
  });
});

describe("stripNoise (server-side ingest)", () => {
  it("removes zero-value junk but preserves presentation tags for the client", () => {
    const raw =
      "<system-reminder>x</system-reminder>\n<local-command-stdout>Login successful</local-command-stdout>";
    const cleaned = stripNoise(raw, "claude");
    expect(cleaned).not.toContain("system-reminder");
    // stdout is presentation-bearing → kept so the app can render an output note.
    expect(cleaned).toContain("<local-command-stdout>Login successful</local-command-stdout>");
  });

  it("kills Codex's injected AGENTS.md block at ingest", () => {
    const raw = "# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>\n\nrules\n\n</INSTRUCTIONS>";
    expect(stripNoise(raw, "codex")).toBe("");
  });

  it("is idempotent: parseUserMessage over already-stripped text is unchanged", () => {
    const raw = "<system-reminder>x</system-reminder>\nhello";
    const once = stripNoise(raw, "claude");
    expect(parseUserMessage(once, "claude").text).toBe("hello");
  });

  it("passes unknown-agent text through", () => {
    expect(stripNoise("plain <div>x</div>", "opencode")).toBe("plain <div>x</div>");
  });
});

describe("cleanAssistantText", () => {
  it("strips injected system-reminders for claude but leaves opencode alone", () => {
    expect(
      cleanAssistantText("answer\n<system-reminder>x</system-reminder>", "claude").trim(),
    ).toBe("answer");
    const withTag = "answer <system-reminder>x</system-reminder>";
    expect(cleanAssistantText(withTag, "opencode")).toBe(withTag);
  });
});
