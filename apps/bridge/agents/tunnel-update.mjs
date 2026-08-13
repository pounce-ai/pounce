/**
 * Replacing the tunnel binary underneath a running bridge.
 *
 * The hard part of the whole feature, and the reason it lives in its own file
 * with every dependency injected: on a remote server this update arrives
 * THROUGH the tunnel it replaces, so there is no way to watch it happen and no
 * second chance if it goes wrong. The order of operations is the safety, and
 * the order of operations is exactly what a test can pin.
 *
 * Two properties make it survivable rather than merely fast:
 *
 *   The identity key is never touched, so the node id is the SAME afterwards.
 *   Whoever asked for the update can re-dial the machine they were already
 *   talking to and ask how it went.
 *
 *   The binary being replaced is kept. If the new one won't stand up, the one
 *   that was working sixty seconds ago goes back — on a machine that may have
 *   no other way in, that is the difference between a failed update and a lost
 *   server.
 *
 * "Stood up" deliberately means republished an identity, not "the process
 * exists". A binary that starts and immediately fails to bind is the precise
 * failure being guarded against, and it would pass a liveness check.
 */

/**
 * @param {object} io
 * @param {() => string|null} io.currentVersion  what we're on now
 * @param {() => Promise<{version?: string|null, tag?: string|null}>} io.install
 *        download + verify + swap; must not touch the running process
 * @param {() => Promise<void>} io.restart       stop `serve`, start it again
 * @param {() => Promise<boolean>} io.isUp       did it republish an identity?
 * @param {() => boolean} io.rollback            put the previous binary back
 * @param {(msg: string) => void} [io.log]
 */
export async function runTunnelUpdate(io) {
  const log = io.log ?? (() => {});
  const from = io.currentVersion();
  const started = { state: "updating", from, to: null, error: null };

  let target = null;
  try {
    const installed = await io.install();
    target = installed?.version ?? installed?.tag ?? null;
  } catch (e) {
    // Nothing was swapped. install() verifies and stages before it replaces
    // anything, so a download or digest failure leaves the machine exactly as
    // it was — still on a working tunnel, which is the point.
    return {
      ...started,
      state: "failed",
      error: String(e?.message || e),
      swapped: false,
    };
  }

  await io.restart();
  if (await io.isUp()) {
    log(`[tunnel] updated ${from ?? "unknown"} -> ${target ?? "latest"}`);
    return { ...started, state: "ok", to: target, swapped: true };
  }

  // It didn't come up. Everything from here is about getting back to reachable.
  const restored = io.rollback();
  await io.restart();
  const recovered = restored && (await io.isUp());
  const error = recovered
    ? `${target ?? "the new tunnel"} did not start; restored ${from ?? "the previous binary"}`
    : `${target ?? "the new tunnel"} did not start and the previous binary could not be restored`;
  log(`[tunnel] update failed: ${error}`);
  return {
    ...started,
    state: recovered ? "rolled-back" : "failed",
    to: target,
    error,
    swapped: true,
  };
}
