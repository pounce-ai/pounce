/**
 * SSH targets: which suggested hosts you already have, and what to call one.
 *
 * Add-a-machine offers every host this computer knows how to reach, and until
 * now offered them all identically — including the ones already in the list.
 * Adding a machine twice is not harmful (pairing collapses on bridgeId) but the
 * list was still lying: it presented settled work as work to do, and the only
 * way to find out was to run a two-minute bootstrap and watch it land on a row
 * you already had.
 *
 * The hard part is that the two ends name the machine differently. You add
 * `pneucons-prod`, an alias for `ubuntu@13.202.151.116`, and the machine
 * introduces itself as `ip-172-31-45-115` — three names, no overlap. So the
 * match is provenance-first: a device added over SSH records the target it was
 * dialled at, and that is what we compare. The name/address fallbacks below are
 * for devices stored before that was recorded, and they are deliberately
 * conservative — a false "Added" hides the button you came for, which is worse
 * than a duplicate offer.
 */
import { hostFromUrl } from "./deviceIdentity";
import { LOOPBACK_HOSTS } from "./deviceProvenance";

/** A stored machine, as much of it as these questions need. */
export interface AddedMachine {
  /** What the machine calls itself — for an SSH add, the target it was dialled
   *  at (see `machineName`). */
  readonly name?: string;
  /** Its bridge address. Its host part is only sometimes a name you'd recognise. */
  readonly url?: string;
  /** The SSH target it was added at. Authoritative when present. */
  readonly sshHost?: string;
}

/** A host being offered — `~/.ssh/config` alias or `known_hosts` entry. */
export interface SuggestedMachine {
  readonly name: string;
  readonly hostName?: string | null;
}

/**
 * An ssh target split the way ssh reads it.
 *
 * Exported because the screen has to dial the same string this file matches on,
 * and two parsers over one value is how the app comes to dial one machine and
 * mark another as added.
 */
export function parseTarget(value: string | null | undefined): {
  user: string | null;
  host: string;
} {
  const v = (value ?? "").trim();
  const at = v.lastIndexOf("@");
  return {
    user: at === -1 ? null : v.slice(0, at) || null,
    // A fully-qualified name may be written with the root's trailing dot.
    host: v.slice(at + 1).replace(/\.$/, ""),
  };
}

/** Compare hosts the way ssh does: case-insensitively, and by the host alone. */
function norm(value: string | null | undefined): string {
  return parseTarget(value).host.toLowerCase();
}

/**
 * Drop the names that describe wherever this is running rather than a machine.
 *
 * Every bridge's own device row is stored as `http://127.0.0.1:8099`, so
 * matching on loopback would mark `orb` (`default@127.0.0.1`) as added purely
 * because this Mac is in the list — the exact false positive that costs someone
 * the button.
 */
function usable(values: readonly string[]): string[] {
  return values.filter((v) => v && !LOOPBACK_HOSTS.has(v));
}

/** Every name a stored machine can be recognised by. */
function namesOf(d: AddedMachine): string[] {
  return usable([norm(d.sshHost), norm(d.name), norm(hostFromUrl(d.url ?? ""))]);
}

/**
 * Index the machines you already have, once.
 *
 * The list is rebuilt as you type — the host field doubles as its filter — so
 * the side that doesn't change per row shouldn't be recomputed per row.
 */
export function addedHostKeys(devices: readonly AddedMachine[]): ReadonlySet<string> {
  return new Set(devices.flatMap(namesOf));
}

/**
 * Is this suggestion a machine we already have?
 *
 * Matches on the alias as well as the address it resolves to, because either
 * one may be what got recorded — you can add `gpu-box` today and type its IP
 * tomorrow, and both are the same machine.
 */
export function isHostAdded(h: SuggestedMachine, added: ReadonlySet<string>): boolean {
  return usable([norm(h.name), norm(h.hostName)]).some((key) => added.has(key));
}

/** An IPv4 or IPv6 literal. Verbatim from the bridge's own ssh-hosts scanner
 *  (apps/bridge/agents/ssh-hosts.mjs), which uses it to decide whether a line
 *  has a friendlier name than its address — the same judgement about the same
 *  strings, one hop upstream, and it must not drift from it. */
const IS_ADDRESS = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f]*:[0-9a-f:]*$/i;

/**
 * What to call a machine added over SSH.
 *
 * You reached it as `pneucons-prod`, and it introduced itself as
 * `ip-172-31-45-115`. The first is a name — you chose it, it's in your
 * `~/.ssh/config`, and it's what you'll look for in the sidebar. The second is
 * a label AWS generated from a private IP you can't even route to. So the name
 * you gave it wins.
 *
 * Except when what you typed was itself an address: `13.202.151.116` is not a
 * name either, and between two non-names the machine's own is the more useful
 * one. Hence the fallback rather than a flat preference.
 */
export function machineName(sshHost: string | null | undefined, reported: string): string {
  const target = norm(sshHost);
  if (!target || IS_ADDRESS.test(target)) return reported;
  return target;
}
