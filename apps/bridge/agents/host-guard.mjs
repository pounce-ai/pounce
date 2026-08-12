/**
 * The DNS-rebinding gate: is a request's Host an ADDRESS rather than a name?
 *
 * Split out of server.mjs so it can be tested without binding a port, the same
 * reason ssh-script.mjs lives next to ssh.mjs.
 *
 * WHY THIS EXISTS, given the Origin check right beside it. Rebinding works by
 * making the attacker's page same-origin with us. The browser loads evil.com,
 * the attacker's own DNS then answers 127.0.0.1 for that same name, and every
 * fetch afterwards is same-origin — so no Origin header is sent (the spec omits
 * it on same-origin GET), no preflight happens, and the socket really is
 * loopback. Origin, isLoopback and isOwner all say "fine", and /ui answers with
 * the bridge token, which is /v1/exec, which is RCE from a merely-visited page.
 * The Host header is the one part of that request still carrying the
 * attacker's own name, so it is the only thing left to check.
 *
 * An IP literal is the check, because DNS cannot point a browser at a name that
 * is not a name. Every real client already sends one: `pairUrl` and the
 * discovery beacon are both built as `http://<ip>:<port>`, the desktop window
 * loads 127.0.0.1, and the tunnel's local proxy listens on 127.0.0.1 too — at
 * its own port, not ours, which is why only the host half is examined.
 */
import net from "node:net";

/**
 * @param {string | undefined | null} hostHeader the raw `Host:` value
 * @returns {boolean} true if it is safe to serve
 */
export function hostIsAddress(hostHeader) {
  if (!hostHeader) {
    // HTTP/1.1 requires a Host and every browser engine sends one, so its
    // absence means a non-browser client — which cannot be rebound, since
    // rebinding is a trick played on a browser's DNS cache.
    return true;
  }
  if (typeof hostHeader !== "string") return false;
  // `[::1]:8099` → `::1`; `192.168.1.3:8099` → `192.168.1.3`. Bracketed IPv6
  // literals are unwrapped before the port is stripped so their own colons live.
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : hostHeader.replace(/:\d+$/, "");
  return host === "localhost" || net.isIP(host) !== 0;
}
