---
title: Away from home
description: How Pounce reaches your machine from anywhere — its own peer-to-peer tunnel, no VPN, no port-forwarding — and how to pair a server over SSH.
---

Pairing on the same Wi-Fi just works. This page is about everywhere else.

## How remote access works

When the Bridge starts, it also brings up Pounce's own **secure peer-to-peer
tunnel** (built on [iroh](https://github.com/n0-computer/iroh)). The pairing
QR carries everything your phone needs to find that machine again — so after
one scan, Pounce reaches it from any network: cellular, hotel Wi-Fi, wherever.

- **No VPN, no port-forwarding, no static IP.** The tunnel dials your machine
  directly by its identity, not its address.
- **On your Wi-Fi, the tunnel isn't used** — the app talks to the Bridge
  directly over the local network and stays fast.
- **End-to-end between your devices.** There's no Pounce relay account and no
  cloud inbox; your code and conversations move between your phone and your
  machine.

You don't configure any of this. If you've paired, it works.

## Pair a server over SSH

The pairing QR doesn't care whether you can walk over to the machine. SSH into
any box and run:

```sh
ssh my-server
npx use-pounce
```

The QR prints right in your terminal. Scan it, and that server's agents are in
your pocket — even though your phone and the server share no network at all.

## Staying LAN-only

Prefer to keep a machine reachable only on your own Wi-Fi? Start the CLI with:

```sh
npx use-pounce --lan
```

The QR then pairs for local-network use only, and no tunnel is started. (If
the tunnel binary isn't available for some reason, the Bridge quietly falls
back to LAN-only mode on its own.)

## Security notes

- Every machine pairs with its own random token, minted on that machine. The
  QR is a credential — treat it like one, and don't post screenshots of a real
  pairing code.
- Off-network access uses a direct peer-to-peer identity to reach home;
  requests without your token are rejected.
- Quit the Bridge (or `pounce stop`) any time to take a machine fully
  offline.
