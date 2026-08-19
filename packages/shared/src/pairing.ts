/**
 * Pairing & host identity.
 *
 * Mirrors the alleycat daemon's Iroh pairing surface, recovered from the
 * compiled binary:
 *   struct PairPayload  { node_id, token, host_name, relay, ... }   (5 fields)
 *   struct StatusInfo   { pid, token_short, config_path, uptime_secs, version, ... } (8)
 *   struct AgentInfo    { display_name, available, presentation, capabilities, ... } (6)
 *
 * A phone becomes a "paired client" by importing a {@link PairPayload} (scanned
 * as a QR ticket from the desktop, or pasted). `node_id` + `relay` let the Iroh
 * QUIC client dial the daemon from anywhere; `token` authenticates the session.
 */

/** Iroh node id (z-base-32 public key) of the daemon endpoint. */
export type NodeId = string;

/** A pairing ticket the daemon hands out to authorize a remote client. */
export interface PairPayload {
  /** Iroh public key the client dials. */
  readonly nodeId: NodeId;
  /**
   * The tunnel's QUIC handshake secret.
   *
   * Null when the payload came from a NETWORK caller: `/v1/pair` discloses the
   * secret only over loopback, because a route that hands it to anyone holding
   * a bearer token turns one sniffed LAN request into permanent off-LAN access.
   * A device receives it once, in the `/v1/device/adopt` response, and keeps it
   * on its own config — see `tunnelToken` on DeviceConfig.
   */
  readonly token: string | null;
  /** Human label for the host machine, e.g. "dirgha-mbp". */
  readonly hostName: string;
  /** Relay URL used for hole-punching / fallback (n0 iroh relay). */
  readonly relay: string | null;
  /** Optional direct socket addrs the client may try before relaying. */
  readonly directAddrs?: readonly string[];
}

/** Daemon status, returned on connect (`StatusInfo`). */
export interface HostStatus {
  readonly pid: number;
  readonly tokenShort: string;
  readonly configPath: string;
  readonly uptimeSecs: number;
  readonly version: string;
  readonly hostName: string;
  readonly nodeId: NodeId;
  readonly relayConnected: boolean;
}

/** The agent backends the daemon multiplexes (from host.toml + *-bridge crates). */
export type AgentId =
  | "claude"
  | "codex"
  | "cursor"
  | "pi"
  | "amp"
  | "opencode"
  | "droid"
  | "devin"
  | "grok"
  | "hermes";

/** Per-agent descriptor (`AgentInfo`). */
export interface AgentInfo {
  readonly id: AgentId;
  readonly displayName: string;
  /** Whether the backing CLI is installed & enabled on the host. */
  readonly available: boolean;
  /** How the agent presents itself ("cli" | "appServer" | "acp"). */
  readonly presentation: string;
  readonly capabilities: AgentCapabilities;
}

export interface AgentCapabilities {
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly images: boolean;
  readonly thinking: boolean;
  readonly terminal: boolean;
  readonly git: boolean;
}
