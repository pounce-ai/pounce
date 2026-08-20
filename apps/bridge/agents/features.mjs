/**
 * What this bridge can do, declared — so a client never has to guess.
 *
 * THE PROBLEM THIS EXISTS FOR
 *
 * Pounce is four independently-versioned things that meet at runtime: the phone
 * app from the App Store, the desktop app from its own updater, the bridge, and
 * the tunnel. Any pair can be weeks apart. The tunnel is the only boundary that
 * ever handled this honestly — its ALPN (`pounce/tunnel/1`) is a declared
 * contract that iroh REFUSES to cross, so two mismatched tunnels cannot
 * silently half-work.
 *
 * The app↔bridge boundary had nothing. A client discovered what a bridge could
 * do by calling it and seeing what came back, which produced three classes of
 * bug in one afternoon:
 *
 *   - A desktop app on 1.6.2 attached to a bridge from a checkout five weeks
 *     behind (startBridge attaches to whatever already holds the port), then
 *     served a page whose route that bridge had never heard of. The 404 came
 *     back in 11ms and the screen said "the machine didn't answer in time",
 *     under a Try again that could never work.
 *   - Roughly twenty separate `// an older bridge has no such route` fallbacks,
 *     each invented independently by whoever happened to touch that call. Some
 *     degrade well. Some didn't. Which one you got depended on whether the
 *     author remembered.
 *   - Nothing at release time checked any of it.
 *
 * WHY A LIST OF NAMES AND NOT A VERSION NUMBER
 *
 * Version comparison is the wrong tool: it requires every client to hold a
 * table of which version introduced what, and that table is a second place to
 * forget. Presence is self-describing. An old bridge simply advertises fewer
 * names; a client asks "is `attribution` in the list" and gets a true answer
 * without knowing anything about release history. Same reason the ALPN works.
 *
 * HOW IT STAYS HONEST
 *
 * `scripts/check-compat.mjs` (wired into CI) fails the build when the route
 * table and this manifest disagree in either direction, and when the app calls
 * a route no bridge declares. Adding a route without declaring it is a broken
 * build, not a bug discovered by a user a month later.
 */

/**
 * Feature name → the routes it covers.
 *
 * A feature is a thing a CLIENT decides to offer or hide, so the grouping is by
 * user-visible capability rather than one name per route. Routes that have been
 * there since before any client we support are grouped under `core`: a bridge
 * too old for those is too old to pair at all, so there is nothing to gate.
 */
export const FEATURES = {
  /**
   * Present on every bridge worth talking to — pairing, sync, running a turn.
   * A bridge too old for these is too old to pair at all, so there is nothing
   * for a client to gate and no point advertising them individually.
   */
  core: [
    "/health",
    "/v1/hello",
    "/v1/pair",
    "/v1/status",
    "/v1/agents",
    "/v1/threads",
    "/v1/messages",
    "/v1/models",
    "/v1/warm",
    "/v1/config",
    "/v1/daemon",
    "/v1/daemon/restart",
    "/v1/turn",
    "/v1/turn/stream",
    "/v1/turn/interrupt",
    "/v1/turn/permission",
    "/v1/context",
    "/v1/commands",
    "/v1/doctor",
    "/v1/open",
    "/v1/exec",
    "/v1/image",
    "/v1/file",
    "/v1/files",
    "/v1/dirs",
    "/v1/markers",
    "/v1/markers/thread",
    "/v1/settled",
    "/v1/catalog/spaces",
    "/v1/catalog/threads",
  ],
  /** Token attribution — "what filled the window". */
  attribution: ["/v1/attribution", "/v1/attribution/export"],
  /** The same report streamed with progress, instead of one silent request. */
  "attribution-stream": ["/v1/attribution/stream"],
  /** Reporting agent CLI versions, and running their own updaters. */
  "agent-updates": ["/v1/agents/versions", "/v1/agents/update"],
  /** Cost, quota and spend reporting. */
  quota: ["/v1/quota", "/v1/activity", "/v1/usage", "/v1/trajectory"],
  /** Scoped, expiring peer access grants. */
  "peer-access": [
    "/v1/access",
    "/v1/access/request",
    "/v1/access/approve",
    "/v1/access/deny",
    "/v1/access/revoke",
    "/v1/peers",
    "/v1/peers/ask",
    "/v1/peers/catalog",
    "/v1/peers/dial",
    "/v1/peers/discovery",
    "/v1/peers/granted",
  ],
  /** Per-device credentials and one-time pairing codes. */
  "device-auth": ["/v1/device/adopt", "/v1/devices/revoke", "/v1/pair/code", "/v1/token"],
  /** Off-LAN reachability over the Iroh tunnel, and updating its binary. */
  tunnel: ["/v1/tunnel/ensure", "/v1/tunnel/version", "/v1/tunnel/update"],
  /** PTY-hosted interactive sessions — answering CLI prompts from the app. */
  interactive: ["/v1/session/interactive", "/v1/session/input", "/v1/session/prompt/answer"],
  /** Progressive thread sync, so the list fills as pages land. */
  "threads-stream": ["/v1/threads/stream"],
  /** Terminal panes. */
  terminal: [
    "/v1/term/open",
    "/v1/term/close",
    "/v1/term/input",
    "/v1/term/resize",
    "/v1/term/stream",
  ],
  /** Adding a machine over SSH. */
  ssh: [
    "/v1/ssh/start",
    "/v1/ssh/cancel",
    "/v1/ssh/hosts",
    "/v1/ssh/input",
    "/v1/ssh/status",
    "/v1/ssh/stream",
  ],
  /** Repo operations — diffs, commits, PRs. */
  git: [
    "/v1/git/branch",
    "/v1/git/changes",
    "/v1/git/checks",
    "/v1/git/commit",
    "/v1/git/pr",
    "/v1/git/push",
    "/v1/git/suggest",
  ],
  /** Disk reporting and worktree cleanup. */
  disk: ["/v1/disk", "/v1/disk/worktree/remove"],
  /** Local history search. */
  search: ["/v1/search"],
  /** Push notifications to paired devices. */
  push: ["/v1/push/register", "/v1/push/unregister"],
  /** Agent skills. */
  skills: ["/v1/skill", "/v1/skills"],
  /** Opening a thread in a desktop editor. */
  editors: ["/v1/editors"],
};

/** The names a client can gate on, as advertised by /v1/hello. */
export function featureNames() {
  return Object.keys(FEATURES);
}

/** Every route this manifest accounts for. */
export function declaredRoutes() {
  return new Set(Object.values(FEATURES).flat());
}
