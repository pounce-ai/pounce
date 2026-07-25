/**
 * HttpTransport — talks to the alleycat daemon's local HTTP surface.
 *
 * Endpoints (recovered from the binary):
 *   POST /v1/runs           -> create a run/turn
 *   POST /v1/runs/:id/...    -> control (interrupt/stop/...)
 *   GET  /events             -> text/event-stream, seq-numbered envelopes
 *
 * Auth: the host.toml `token` as a bearer header.
 *
 * This is the runnable baseline (LAN or tunnel). The Iroh transport will reuse
 * this exact JSON shape over QUIC streams, so the adapter never changes.
 *
 * `subscribe()` reads `response.body` as a ReadableStream. RN's stock fetch
 * can't do that, so on-device callers inject a streaming-capable `fetchImpl`
 * (react-native-nitro-fetch). In Node/tests the global fetch already streams.
 */

import type {
  AgentInfo,
  CreateRunRequest,
  CreateRunResponse,
  DiffRequest,
  ExecRequest,
  ExecResizeRequest,
  ExecWriteRequest,
  GitCommitRequest,
  GitStatusRequest,
  HostStatus,
  PairPayload,
  RunControlRequest,
  WireEnvelope,
} from "@pounce/shared";
import type { ConnectionState, SubscribeOptions, Transport } from "./types";

export interface HttpTransportConfig {
  /** Base URL of the daemon, e.g. http://192.168.1.10:8389 or a tunnel. */
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

export class HttpTransport implements Transport {
  readonly kind = "http" as const;

  #cfg: HttpTransportConfig;
  #token: string | null = null;
  #state: ConnectionState = "disconnected";
  #listeners = new Set<(s: ConnectionState) => void>();
  #fetch: typeof fetch;

  constructor(cfg: HttpTransportConfig) {
    this.#cfg = cfg;
    this.#fetch = cfg.fetchImpl ?? globalThis.fetch;
  }

  onStateChange(cb: (s: ConnectionState) => void): () => void {
    this.#listeners.add(cb);
    cb(this.#state);
    return () => this.#listeners.delete(cb);
  }

  #setState(s: ConnectionState) {
    if (this.#state === s) return;
    this.#state = s;
    for (const cb of this.#listeners) cb(s);
  }

  async connect(pairing: PairPayload): Promise<HostStatus> {
    this.#setState("connecting");
    this.#token = pairing.token;
    try {
      const status = await this.#json<HostStatus>("GET", "/v1/status");
      this.#setState("connected");
      return status;
    } catch (err) {
      this.#setState("disconnected");
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.#token = null;
    this.#setState("disconnected");
  }

  listAgents(): Promise<readonly AgentInfo[]> {
    return this.#json<readonly AgentInfo[]>("GET", "/v1/agents");
  }

  createRun(req: CreateRunRequest): Promise<CreateRunResponse> {
    return this.#json<CreateRunResponse>("POST", "/v1/runs", req);
  }

  async controlRun(req: RunControlRequest): Promise<void> {
    await this.#json("POST", `/v1/runs/${encodeURIComponent(req.runId)}/control`, {
      action: req.action,
    });
  }

  async *subscribe(opts: SubscribeOptions): AsyncIterable<WireEnvelope> {
    const params = new URLSearchParams();
    if (opts.runId) params.set("run_id", opts.runId);
    if (opts.conversationId) params.set("conversation_id", opts.conversationId);
    if (opts.sinceSeq != null) params.set("since_seq", String(opts.sinceSeq));
    const url = `${this.#cfg.baseUrl}/events?${params.toString()}`;

    const res = await this.#fetch(url, {
      method: "GET",
      headers: { ...this.#authHeader(), accept: "text/event-stream" },
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      throw new TransportError(res.status, `subscribe failed: ${res.status}`);
    }
    this.#setState("connected");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = parseSseData(frame);
          if (data) yield data as WireEnvelope;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async exec(req: ExecRequest): Promise<{ readonly terminalId: string }> {
    return this.#json("POST", "/v1/exec", req);
  }
  async execWrite(req: ExecWriteRequest): Promise<void> {
    await this.#json("POST", "/v1/exec/write", req);
  }
  async execResize(req: ExecResizeRequest): Promise<void> {
    await this.#json("POST", "/v1/exec/resize", req);
  }
  async execTerminate(terminalId: string): Promise<void> {
    await this.#json("POST", "/v1/exec/terminate", { terminalId });
  }

  gitStatus(req: GitStatusRequest): Promise<unknown> {
    return this.#json("POST", "/v1/git/status", req);
  }
  async gitDiff(req: DiffRequest): Promise<string> {
    const r = await this.#json<{ patch: string }>("POST", "/v1/git/diff", req);
    return r.patch;
  }
  async gitCommit(req: GitCommitRequest): Promise<void> {
    await this.#json("POST", "/v1/git/commit", req);
  }

  // --- internals ---

  #authHeader(): Record<string, string> {
    return this.#token ? { authorization: `Bearer ${this.#token}` } : {};
  }

  async #json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(`${this.#cfg.baseUrl}${path}`, {
      method,
      headers: {
        ...this.#authHeader(),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new TransportError(res.status, `${method} ${path} -> ${res.status}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }
}

export class TransportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

function parseSseData(frame: string): unknown | null {
  const lines = frame.split("\n");
  const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
