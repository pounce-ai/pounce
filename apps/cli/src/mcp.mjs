/**
 * `pounce mcp` — expose this machine's coding-agent history to OTHER agents.
 *
 * An MCP server over stdio, proxying the local bridge's read APIs. The point is
 * the thing only Pounce has: ONE searchable history across Claude Code, Codex,
 * opencode and Cursor. No other agent on this machine can answer "what did
 * Codex try on this bug yesterday?" — after
 *
 *     claude mcp add pounce -- npx use-pounce mcp
 *
 * every agent can.
 *
 * DELIBERATELY READ-ONLY. The same bridge also exposes /v1/exec, /v1/turn and
 * /v1/git/commit on the same port and token. Handing an arbitrary agent shell
 * execution and commit rights through a tool call is a foot-gun, and any
 * incident lands on Pounce's name. Read-only keeps the security story one
 * sentence long. If write tools are ever added they need their own opt-in flag.
 *
 * STDOUT IS THE PROTOCOL. Every diagnostic goes to stderr — a stray
 * console.log corrupts the JSON-RPC stream and the client drops the connection.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** Diagnostics must never touch stdout — see the header. */
const note = (s) => process.stderr.write(`${s}\n`);

/**
 * Talk to the bridge. `/ui` is loopback-only and reports the RUNNING bridge's
 * own token, which is what makes this work regardless of who started it (the
 * desktop app, launchd, or `pounce` earlier) — we never need to guess or
 * persist a token of our own.
 */
function makeClient(port) {
  let token = null;
  const base = `http://127.0.0.1:${port}`;

  async function ensureToken() {
    if (token) return token;
    const res = await fetch(`${base}/ui`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`bridge /ui -> ${res.status}`);
    token = (await res.json()).token;
    if (!token) throw new Error("bridge did not report a token");
    return token;
  }

  return async function get(path, params = {}) {
    const t = await ensureToken();
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401) {
      token = null; // bridge restarted with a new token — one retry
      return get(path, params);
    }
    if (!res.ok) throw new Error(`bridge ${path} -> ${res.status}`);
    return res.json();
  };
}

/** MCP wants content blocks; everything here is structured, so JSON it is. */
const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

/** Trim a thread to the fields another agent can actually use — the raw wire
 *  shape carries app-specific bookkeeping that only wastes the caller's tokens. */
const slimThread = (t) => ({
  id: t.id,
  agent: t.agent,
  title: t.name || t.preview || null,
  repo: t.repo,
  branch: t.gitBranch || null,
  cwd: t.cwd,
  createdAt: t.createdAt,
  activity: t.activity,
});

export async function runMcpServer({ port, version = "0.0.0" }) {
  const get = makeClient(port);

  // Fail fast with a fixable message rather than surfacing every tool call as
  // a timeout later.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    note(`pounce mcp: no bridge on port ${port}. Start one with \`npx use-pounce\` first.`);
    process.exit(1);
  }

  // Report the real package version — MCP clients surface this, and a
  // hardcoded one makes every release look identical.
  const server = new McpServer({ name: "pounce", version });

  server.tool(
    "search_history",
    "Search this machine's coding-agent history across Claude Code, Codex, opencode and Cursor. " +
      "Use it to find what was already tried, decided, or debugged before — including work done " +
      "in a DIFFERENT agent than the one asking.",
    {
      query: z.string().describe("Free-text search over past agent conversations"),
      agent: z
        .string()
        .optional()
        .describe("Restrict to one agent: claude, codex, opencode, cursor"),
      project: z.string().optional().describe("Restrict to a repo/project name"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ query, agent, project, limit }) => {
      const r = await get("/v1/search", { q: query, agent, workspace: project, limit });
      return json(r.results ?? []);
    },
  );

  server.tool(
    "list_threads",
    "List coding-agent sessions on this machine, newest first, across every agent.",
    {
      agent: z.string().optional().describe("Restrict to one agent"),
      project: z.string().optional().describe("Restrict to a repo/project name"),
      limit: z.number().optional().describe("Max threads to return (default 50)"),
    },
    async ({ agent, project, limit = 50 }) => {
      const r = await get("/v1/threads");
      let threads = (r.threads ?? []).map(slimThread);
      if (agent) threads = threads.filter((t) => t.agent === agent);
      if (project) threads = threads.filter((t) => t.repo === project);
      return json(threads.slice(0, limit));
    },
  );

  server.tool(
    "get_thread",
    "Read the full message history of one session. Get its id from search_history or list_threads.",
    {
      agent: z.string().describe("Which agent owns the thread"),
      thread: z.string().describe("Thread id"),
    },
    async ({ agent, thread }) => {
      const r = await get("/v1/messages", { agent, thread });
      return json(r.events ?? r);
    },
  );

  server.tool(
    "list_markers",
    "The messages the user explicitly flagged as important in a thread. These are human " +
      "judgements about what mattered — usually the fastest way into a long session.",
    { thread: z.string().optional().describe("Thread id; omit for every thread") },
    async ({ thread }) => {
      const r = await get("/v1/markers", { thread });
      return json(r.markers ?? []);
    },
  );

  server.tool(
    "recent_activity",
    "Recent agent activity on this machine — what has been worked on lately, and where.",
    { days: z.number().optional().describe("Look back this many days (default 7)") },
    async ({ days = 7 }) => {
      const r = await get("/v1/activity", { days });
      return json(r);
    },
  );

  await server.connect(new StdioServerTransport());
  note(`pounce mcp: serving on stdio (bridge :${port})`);
}
