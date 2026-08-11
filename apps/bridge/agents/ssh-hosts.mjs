/**
 * The machines this computer already knows how to reach.
 *
 * Telling someone "your ~/.ssh/config aliases work here" is a fact they have to
 * act on; showing them the list is the same fact with the work done. Two
 * sources, and they mean different things:
 *
 *   ~/.ssh/config — hosts you deliberately named, usually with the username and
 *   port already worked out. These are the good ones, and we can prefill from
 *   them.
 *
 *   ~/.ssh/known_hosts — everything you've ever connected to, including one-off
 *   git remotes. Useful as a memory aid, but it's a pile, not a curated list,
 *   so it ranks below the aliases and carries nothing but a name.
 *
 * Pure parsing, no I/O in the parsers, so the awkward real-world files can be
 * tested directly.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A `Host` alias is a pattern, and a pattern isn't something you can connect
 *  to — `Host *` sets defaults for everything, not a machine. */
const IS_PATTERN = /[*?!]/;

/** An IPv4 or IPv6 literal. Deliberately loose — this only decides whether a
 *  friendlier name exists on the same line, never whether we can connect. */
const IS_ADDRESS = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f]*:[0-9a-f:]*$/i;

/**
 * Parse an ssh_config into connectable aliases.
 *
 * Keywords are case-insensitive and separated by whitespace OR `=`, which is
 * rarer but legal and would otherwise silently drop someone's entire config.
 * One `Host` line can name several aliases; each becomes its own entry sharing
 * that block's settings.
 */
export function parseSshConfig(text) {
  const entries = [];
  let current = [];
  const includes = [];

  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [keyword, ...rest] = line.split(/[\s=]+/);
    const key = keyword.toLowerCase();
    const value = rest.join(" ").trim();

    if (key === "host") {
      current = [];
      for (const name of value.split(/\s+/).filter(Boolean)) {
        if (IS_PATTERN.test(name)) continue;
        const entry = { name, source: "config", hostName: null, user: null, port: null };
        entries.push(entry);
        current.push(entry);
      }
      continue;
    }
    if (key === "include") {
      includes.push(value);
      continue;
    }
    // `Match` blocks are conditional on things we can't evaluate here (the
    // target, the local user, the exit code of a command), so anything after
    // one is not reliably a property of the preceding Host.
    if (key === "match") {
      current = [];
      continue;
    }
    for (const entry of current) {
      if (key === "hostname") entry.hostName = value;
      else if (key === "user") entry.user = value;
      else if (key === "port") entry.port = Number(value) || null;
    }
  }
  return { entries, includes };
}

/**
 * Pull hostnames out of a known_hosts file.
 *
 * Entries hashed with `HashKnownHosts` (the default on Debian and friends) are
 * one-way — `|1|salt|hash` can be checked against a name but never turned back
 * into one. Those are skipped rather than shown as gibberish, which is why this
 * list can look short on a machine that has connected to plenty.
 */
export function parseKnownHosts(text) {
  const names = new Set();
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // A marker line (@cert-authority, @revoked) shifts every field along one.
    const fields = line.split(/\s+/);
    const hostField = fields[0].startsWith("@") ? fields[1] : fields[0];
    if (!hostField || hostField.startsWith("|")) continue; // hashed
    const online = [];
    for (const host of hostField.split(",")) {
      // `[example.com]:2222` is how a non-standard port is recorded. Keep the
      // name; the port belongs to that record, not to the machine as a whole.
      const name = host.replace(/^\[(.+)\]:\d+$/, "$1").trim();
      if (!name || IS_PATTERN.test(name)) continue;
      online.push(name);
    }
    // ssh records the name AND the address it resolved to, on the same line.
    // Both work, but nobody scanning a list wants "github.com" followed by the
    // four IPs it happened to have that day — so the addresses are only worth
    // keeping when the line has no name at all.
    const named = online.filter((n) => !IS_ADDRESS.test(n));
    for (const name of named.length ? named : online) names.add(name);
  }
  return [...names];
}

/**
 * Merge both sources into one ranked list.
 *
 * Aliases first and deduped against known_hosts: a host you named IS the
 * known_hosts entry, and showing it twice makes the shorter, better list look
 * like a duplicate of the longer one.
 */
export function mergeHosts(configEntries, knownNames) {
  const seen = new Set();
  const out = [];
  for (const e of configEntries) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  for (const name of knownNames.sort((a, b) => a.localeCompare(b))) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, source: "known_hosts", hostName: null, user: null, port: null });
  }
  return out;
}

function read(file) {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    // An unreadable config is not worth failing the screen over — the person
    // can always type the host themselves.
    return null;
  }
}

/** Expand one `Include` value: ~ and relative-to-~/.ssh paths, plus the single
 *  trailing `*` glob that covers essentially every real config.d layout. */
function expandInclude(value, sshDir) {
  const out = [];
  for (const token of value.split(/\s+/).filter(Boolean)) {
    const raw = token.replace(/^~(?=\/|$)/, os.homedir());
    const full = path.isAbsolute(raw) ? raw : path.join(sshDir, raw);
    const dir = path.dirname(full);
    const base = path.basename(full);
    if (!base.includes("*")) {
      out.push(full);
      continue;
    }
    const [prefix, suffix] = base.split("*");
    try {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(prefix) && name.endsWith(suffix)) out.push(path.join(dir, name));
      }
    } catch {
      /* a glob that matches nothing is not an error */
    }
  }
  return out;
}

/**
 * Everything this machine could plausibly connect to, best first.
 *
 * `Include` is followed one level deep — enough for the common
 * `Include ~/.ssh/config.d/*` split, and short of the cycle-chasing a full
 * ssh_config implementation would need for a list that is only ever a
 * convenience.
 */
export function listSshHosts({ home = os.homedir() } = {}) {
  const sshDir = path.join(home, ".ssh");
  const configText = read(path.join(sshDir, "config"));
  const { entries, includes } = configText
    ? parseSshConfig(configText)
    : { entries: [], includes: [] };

  for (const include of includes) {
    for (const file of expandInclude(include, sshDir)) {
      const text = read(file);
      if (text) entries.push(...parseSshConfig(text).entries);
    }
  }

  const known = [];
  for (const file of ["known_hosts", "known_hosts2"]) {
    const text = read(path.join(sshDir, file));
    if (text) known.push(...parseKnownHosts(text));
  }

  return mergeHosts(entries, [...new Set(known)]);
}
