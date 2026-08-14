/**
 * How a machine got into the list, and what that changes about showing it.
 *
 * A server added over SSH is not the same kind of thing as a Mac on the same
 * Wi-Fi. Its `url` is an address on its own network that nothing here can
 * reach, so it lives or dies by its tunnel — which means "Offline" carries a
 * different meaning and a different fix. Until this existed the two were
 * indistinguishable in Settings: same generic icon, same bare "Offline".
 *
 * Kept free of react-native imports so the rules can be tested directly; the
 * screens and the icon component are thin callers.
 */
import { hostFromUrl } from "./deviceIdentity";

/** The only provenance worth recording so far — the one that changes what the
 *  machine IS, rather than merely how it was introduced. */
export type AddedVia = "ssh";

/** Just enough of a stored config to judge provenance. */
interface ProvenanceInput {
  readonly addedVia?: AddedVia;
  readonly nodeId?: string;
  readonly grant?: unknown;
}

/**
 * Recognise an SSH-added machine that predates us recording it.
 *
 * Only two paths ever put a `nodeId` on a stored config: the SSH bootstrap, and
 * being granted access to someone else's machine — and a grant is stamped as
 * one. A QR pairing keeps its node id in the single global pairing instead,
 * never on the device row. So `nodeId` without a `grant` is an SSH-added
 * server, and machines already in people's lists get the right treatment
 * without anybody having to add them again.
 */
export function addedViaFor(d: ProvenanceInput): AddedVia | undefined {
  if (d.addedVia) return d.addedVia;
  if (d.grant || !d.nodeId) return undefined;
  return "ssh";
}

/**
 * The icon glyph for a machine.
 *
 * Provenance beats the name heuristic, always. Guessing is a reasonable
 * fallback for a Mac someone named after their cat; it is not a reason to
 * override something we actually know. "Pneucons Prod" matches none of the
 * server patterns and was drawn as a desktop Mac — a confident wrong answer,
 * given the truth was on record.
 */
export function deviceIconFor(name: string, addedVia?: AddedVia): string {
  if (addedVia === "ssh") return "server-outline";
  const n = name.toLowerCase();
  if (/(macbook|laptop|\bbook\b|\bair\b|notebook)/.test(n)) return "laptop-outline";
  if (/(iphone|ipad|phone|mobile|android|pixel)/.test(n)) return "phone-portrait-outline";
  if (/(server|ssh|\bvm\b|ec2|remote|cloud|linux|ubuntu|debian|docker|droplet|\bpi\b)/.test(n))
    return "server-outline";
  // mini / studio / imac / mac pro / tower / desktop → a desktop Mac
  return "desktop-outline";
}

/**
 * The hosts that mean "wherever this is running", not a machine.
 *
 * One list, because anything that recognises loopback has to recognise all of
 * it: a second copy elsewhere is a copy that will be missing whichever form
 * gets added next. Both the `[::1]` a URL carries and the bare `::1` a hostname
 * does are here for the same reason.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

/**
 * Is this the machine the app itself is running on?
 *
 * The desktop pairs with its own bridge over loopback, so a loopback url is the
 * marker. Worth knowing because "@ this machine" is noise on every row — the
 * host is only information when it is somewhere else.
 */
export function isThisMachine(url: string): boolean {
  const host = hostFromUrl(url.trim());
  return !!host && LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * The reachability line under a machine's name.
 *
 * A remote server earns a word of its own. "Offline" on a Mac across the room
 * means the lid is shut; on a machine reached over a tunnel it means the tunnel
 * isn't carrying. Different situation, different fix, and this row is the only
 * place the difference can be drawn before somebody starts guessing.
 */
export function deviceStatusText(d: { online: boolean; addedVia?: AddedVia }): string {
  if (d.addedVia !== "ssh") return d.online ? "Online" : "Offline";
  return d.online ? "Online · remote" : "Offline · remote, over SSH";
}
