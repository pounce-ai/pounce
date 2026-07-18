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
pounce status     bridge / tunnel / phone status
pounce stop       stop the background bridge and its tunnel
pounce logs [-f]  show (or follow) the bridge log

--port <n>        bridge port                 (default 8099)
--token <t>       pairing token               (default: random, kept in ~/.pounce)
--lan             skip the tunnel — QR pairs on this Wi-Fi only
--foreground      run the bridge attached to this terminal
```

Installed globally (`npm i -g use-pounce`), the command is just `pounce`.

## What it does

- Bridge: an HTTP server on port 8099 that reads your coding-agent sessions from disk and drives the agent CLIs. State lives in `~/.pounce/`.
- Tunnel: a `pounce-tunnel` binary (downloaded to `~/.pounce/bin/` on first run) that accepts iroh QUIC streams from the phone and proxies them to the bridge. Off-LAN is optional — without it, pairing works on the same Wi-Fi.
- Auth: requests need the pairing token from the QR. The token is minted randomly per machine.

Part of the [Pounce monorepo](https://github.com/pounce-ai/pounce).
