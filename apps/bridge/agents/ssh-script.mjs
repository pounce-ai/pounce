/**
 * What we say to a remote machine over SSH, and how we read its answer.
 *
 * Split out from ssh.mjs so it can be tested without zigpty: everything here is
 * string in, string out. The half that spawns a process lives next door.
 *
 * Two deliberate choices shape all of it:
 *
 *   `pounce qr`, not bare `pounce`. The default command ends in waitForPhone(),
 *   which polls forever with no timeout — over SSH that hangs the channel
 *   rather than finishing.
 *
 *   Sentinels, not screen-scraping. The CLI has no machine-readable output, so
 *   the remote script prints its own phase markers and wraps the /ui JSON in a
 *   delimiter. We parse those, never the human text or the ASCII QR, which are
 *   free to change.
 */

/** Marker vocabulary spoken by the remote script. Short and unmistakable:
 *  these travel through a TTY alongside npm's progress output. */
export const PHASE_RE = /@@POUNCE:([a-z-]+)@@/g;
const UI_BLOCK = /@@POUNCE_UI@@([\s\S]*?)@@END@@/;
const HOST_BLOCK = /@@POUNCE_HOST@@([\s\S]*?)@@END@@/;

/**
 * Things SSH stops and asks about. We surface these to the app rather than
 * answering them: a host-key fingerprint is a security decision that belongs to
 * the person, and we hold no passwords to type.
 *
 * `secret` drives the input control — a passphrase must not echo.
 */
export const PROMPTS = [
  {
    kind: "host-key",
    secret: false,
    test: /Are you sure you want to continue connecting|fingerprint.*\(yes\/no/i,
  },
  { kind: "passphrase", secret: true, test: /Enter passphrase for key/i },
  { kind: "password", secret: true, test: /(?:password|Password):\s*$/ },
  { kind: "verification", secret: true, test: /Verification code:|Duo two-factor/i },
];

/** Failures worth explaining in the app's own words. SSH's stderr is precise
 *  but assumes you already know what a known_hosts file is. */
export const FAILURES = [
  {
    test: /REMOTE HOST IDENTIFICATION HAS CHANGED/i,
    message:
      "This machine's SSH host key has changed since you last connected. That can mean the server was rebuilt — or that something is impersonating it. Sort it out in a terminal before adding the machine here.",
  },
  {
    test: /Permission denied \(publickey/i,
    message:
      "The server refused the key. Add your key to its authorized_keys, or check that ssh-agent is running.",
  },
  {
    test: /Could not resolve hostname|Name or service not known/i,
    message: "Couldn't resolve that hostname.",
  },
  { test: /Connection refused/i, message: "Nothing is listening for SSH on that host and port." },
  {
    test: /Connection timed out|Operation timed out/i,
    message: "The host didn't answer. Check the address, the port, and any firewall in between.",
  },
  {
    test: /command not found:?\s*(npx|node)|npx: not found/i,
    message:
      "That server has no Node.js, so it can't run `npx use-pounce`. Install Node 18 or newer there and try again.",
  },
];

/**
 * The script that runs on the far side.
 *
 * `pounce qr` is idempotent — it reuses a bridge that's already up rather than
 * starting a second one — so re-adding a machine is safe and fast.
 *
 * We ask for the payload with curl and fall back to node, because by the time
 * we need it npx has proven node exists, while curl is merely likely. `/ui` is
 * loopback-gated on the remote (it hands out that bridge's token), so reading
 * it from inside the SSH session isn't a convenience — it's the only place it
 * can be read from at all.
 */
export function remoteScript({ bridgePort = 8099 } = {}) {
  const ui = `http://127.0.0.1:${bridgePort}/ui`;
  return [
    `printf '@@POUNCE:starting@@\\n'`,
    `npx --yes use-pounce qr --port ${bridgePort} || printf '@@POUNCE:cli-failed@@\\n'`,
    `printf '@@POUNCE:pairing@@\\n'`,
    `printf '@@POUNCE_HOST@@%s@@END@@\\n' "$(hostname 2>/dev/null || echo unknown)"`,
    `printf '@@POUNCE_UI@@'`,
    `if command -v curl >/dev/null 2>&1; then`,
    `  curl -fsS ${ui} || printf '{"error":"could not read %s"}' ${ui};`,
    `else`,
    `  node -e "fetch('${ui}').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>process.stdout.write(JSON.stringify({error:String(e&&e.message||e)})))";`,
    `fi`,
    `printf '@@END@@\\n'`,
    `printf '@@POUNCE:done@@\\n'`,
  ].join("\n");
}

/**
 * Build the argv for the SSH child.
 *
 * The host is passed through untouched so an `~/.ssh/config` alias keeps all
 * its meaning — ProxyJump, IdentityFile, User, the lot. That's why this feature
 * has no key-management UI and shouldn't grow one: OpenSSH already has it.
 *
 * The remote command is base64'd. It crosses two shells (ours via argv, then
 * the login shell sshd starts) and the payload contains quotes, newlines and
 * `%s`; base64 is the only encoding that survives that intact, and its alphabet
 * needs no quoting of its own.
 */
export function sshArgs({ host, user, sshPort, bridgePort, strictHostKey = true }) {
  const b64 = Buffer.from(remoteScript({ bridgePort }), "utf8").toString("base64");
  const args = [
    // Force a TTY: without one ssh reads a password from /dev/tty or not at
    // all, and we'd have no way to let the person answer.
    "-tt",
    "-o",
    "ConnectTimeout=20",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "NumberOfPasswordPrompts=1",
  ];
  if (!strictHostKey) args.push("-o", "StrictHostKeyChecking=accept-new");
  if (sshPort) args.push("-p", String(sshPort));
  if (user) args.push("-l", user);
  args.push(host, `echo ${b64} | base64 -d | sh`);
  return args;
}

/** Pull the JSON `/ui` served on the far side out of the transcript. */
export function parsePayload(text) {
  const block = UI_BLOCK.exec(text);
  if (!block) return null;
  try {
    return JSON.parse(block[1].trim());
  } catch {
    return null;
  }
}

export function parseHostName(text) {
  const name = HOST_BLOCK.exec(text)?.[1]?.trim();
  return name && name !== "unknown" ? name.replace(/\.local$/, "") : null;
}

/**
 * Turn the remote's `/ui` into something `addDeviceConfig` accepts, or explain
 * why we can't.
 *
 * The tunnel identity is not optional here. A remote machine's `pairUrl` is an
 * address on ITS network; without `nodeId` the device we'd store is one this
 * machine can never reach and the phone certainly can't. Better to fail loudly
 * at the moment of adding than to leave a dead machine in the list.
 */
export function toDevice(payload, { hostName, host }) {
  if (!payload) return { error: "The server never returned its pairing details." };
  if (payload.error) return { error: payload.error };
  if (!payload.token) return { error: "The server's bridge is running but returned no token." };
  if (!payload.tunnel?.nodeId) {
    return {
      error:
        "The bridge started on that server, but its remote-access tunnel didn't. Without it the machine is only reachable from its own network. Check ~/.pounce/bridge.log there — usually it's an old glibc or a blocked outbound network.",
    };
  }
  return {
    device: {
      url: payload.pairUrl,
      token: payload.token,
      nodeId: payload.tunnel.nodeId,
      relay: payload.tunnel.relay ?? null,
      hostName: hostName || host,
    },
  };
}

/** The prompt SSH is sitting on, if we recognise it. `tail` is the recent
 *  output — a prompt is always the last thing printed. */
export function detectPrompt(tail) {
  for (const p of PROMPTS) {
    if (p.test.test(tail)) {
      return { kind: p.kind, secret: p.secret, text: tail.trim().split("\n").pop() };
    }
  }
  return null;
}

/** A failure we can name, or null to fall back to the exit code. */
export function namedFailure(text) {
  return FAILURES.find((f) => f.test.test(text))?.message ?? null;
}
