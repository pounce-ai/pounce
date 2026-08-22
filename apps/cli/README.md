# use-pounce

Pair your phone with this machine in one command:

```sh
npx use-pounce
```

That starts the [Pounce](https://use-pounce.com) bridge in the background, prints a QR code in your terminal, and waits. Scan it with the Pounce app (or your camera) and your phone is connected to this machine's coding agents — Claude Code, Codex, Cursor, and friends.

**Works over SSH.** Pairing doesn't need the phone and the machine to share a network: the QR carries an [iroh](https://github.com/n0-computer/iroh) p2p tunnel identity, so you can `ssh` into a server, run `npx use-pounce`, scan, and drive that server's agents from anywhere. No port-forwarding, no VPN.

The bridge keeps running after you close the terminal.

## Commands

```
pounce            start the bridge (background) + show the pairing QR + wait
pounce qr         same, but don't wait for the phone
pounce configure  set this machine up for good — the app, or a login-time bridge
pounce status     bridge / tunnel / phone status
pounce stop       stop the background bridge and its tunnel
pounce logs [-f]  show (or follow) the bridge log
pounce update     update what's installed here    (--check just says what's behind)
pounce mcp        serve this machine's agent history over MCP (stdio)

--port <n>        bridge port                 (default 8099)
--token <t>       pairing token               (default: random, kept in ~/.pounce)
--lan             skip the tunnel — QR pairs on this Wi-Fi only
--foreground      run the bridge attached to this terminal
```

## Keeping a machine up to date

`npx use-pounce` fetches a fresh CLI every run, so the command itself never goes
stale. What it leaves behind does. `pounce configure --bridge` installs its own
copy of `use-pounce` under `~/.pounce/app` and points the login service at it —
deliberately, so npm can't prune the running bridge out from under you — and
that copy stays on whatever version it was installed at. The `pounce-tunnel`
binary is downloaded once and never looked at again.

```sh
npx use-pounce update          # bring them all up to date, restart what needs it
npx use-pounce update --check  # just say what's behind
```

It updates the permanent copy, restarts the login service (and any bridge this
CLI started) so the new code is actually running, and asks the bridge to replace
its tunnel binary. The desktop app is reported but never touched — it has its
own updater.

## Setting a machine up for good

`npx use-pounce` is perfect for a one-off, but the bridge only lives as long as
you leave it running. `pounce configure` makes it permanent:

```sh
npx use-pounce configure
```

It looks at the machine you're on — OS, chip, whether there's a screen, whether
you're at the far end of an SSH connection — and offers only what can actually
run there:

- **The desktop app.** The whole Pounce UI with the bridge built in and the
  pairing QR in the window. Downloads and installs the right build for you:
  `Pounce.dmg` on Apple Silicon Macs, the installer on Windows, a `.deb` or the
  tarball on Linux. Not offered on an Intel Mac, on macOS 13 or older, or on a
  machine with no desktop session — with the reason shown, not just hidden.
- **The background bridge.** No window. A launchd agent on macOS, a systemd
  user service on Linux, a scheduled task on Windows: starts at login, restarts
  on crash. The recommendation on a headless box or over SSH.

Answer with flags to skip the question:

```
--desktop     install the desktop app
--bridge      install the background bridge as a login service
--remove      take that login service back off again
-y, --yes     don't ask — take the recommendation for this machine
```

Run through `npx`, the bridge service can't point at the npx cache (npm prunes
it), so `--bridge` installs its own copy of `use-pounce` under `~/.pounce/app`
and runs that. The pairing token is whatever this machine already uses, so
phones that paired before keep working.

Installed globally (`npm i -g use-pounce`), the command is just `pounce`.

## Sharing threads with another machine

Your laptop can read the threads running on your desktop, without either of them
going through the cloud. Both machines need Pounce running on the same network.

```
pounce peers               who is nearby, who is asking, who has access
pounce ask <machine>       ask a machine to share its threads with you
pounce approve <code>      let a machine in
pounce deny <code>         turn a request down
pounce revoke <id|host>    take access away again

--spaces a,b       limit to these projects           (ask + approve)
--all              ask for everything they allow
--hours <n>        how long the access lasts         (default 24; --forever for none)
--note <text>      a line for the person approving
--visible on|off   let other computers here find this one (hidden by default)
```

Nothing here happens behind your back:

- **Being findable is opt-in.** A machine is invisible until you run
  `pounce peers --visible on`.
- **Someone has to say yes.** `ask` prints a short code and waits; the other
  machine sees the same code and approves it there. Matching codes are how you
  know you're answering the request you think you are.
- **Access is read-only, scoped, and expires.** A grant covers the projects you
  name and lapses after a day unless you say otherwise — `--forever` is a
  choice, not the default. Revoke it early with `pounce revoke`.

On a machine with a browser the same handshake lives at
`http://127.0.0.1:8099/peers`; these commands are for the ones you only reach
over SSH.

## What it does

- Bridge: an HTTP server on port 8099 that reads your coding-agent sessions from disk and drives the agent CLIs. State lives in `~/.pounce/`.
- Tunnel: a `pounce-tunnel` binary (downloaded to `~/.pounce/bin/` on first run) that accepts iroh QUIC streams from the phone and proxies them to the bridge. Off-LAN is optional — without it, pairing works on the same Wi-Fi.
- Auth: requests need the pairing token from the QR. The token is minted randomly per machine.

Part of the [Pounce monorepo](https://github.com/pounce-ai/pounce).
