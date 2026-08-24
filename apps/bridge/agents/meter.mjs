/**
 * The bridge's seam onto @pounce/meter.
 *
 * Metering used to live in this directory; it now lives in packages/meter so a
 * collector that is not the bridge can read the same numbers. The package is
 * host-agnostic by construction, which leaves exactly one thing to wire: how
 * to find an agent's CLI. On a developer's machine that is `env.mjs` — a
 * login-shell PATH, user-pinned binaries, per-platform install dirs — and the
 * package cannot know any of that.
 *
 * So this module configures the adapter on import and re-exports the package.
 * Import metering FROM HERE and nowhere else: going straight to @pounce/meter
 * inside the bridge would silently get you the standalone defaults, and
 * `ccusage` would go missing on any machine where PATH is not already right.
 */
import { configureMeterHost } from "@pounce/meter";
import { agentEnv, binPath } from "./env.mjs";
import { binOverride } from "./config.mjs";

configureMeterHost({ agentEnv, binPath, binOverride });

export * from "@pounce/meter";
