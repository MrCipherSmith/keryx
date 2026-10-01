// The shell-side client of `keryx serve`'s remote hub (flow 376, block 2).
//
// A library, not a feature: no TUI, no shell, nothing from `src/tui`. The shell
// (block 3) constructs one, hands it `onLine`, and calls `reply` and
// `requestApproval`. Everything else is this file's problem:
//
//   - it finds serve by `endpoint.json` and authenticates with the local shell
//     token, both RE-READ on every connection attempt, so a serve that restarted
//     on another port, or rotated the token, is followed without the shell doing
//     anything;
//   - it registers (again, after every reconnect: the same session and name give
//     back the same topic), heartbeats at the lease cadence, and keeps the SSE
//     stream open with exponential backoff and `Last-Event-ID`;
//   - an inbound line is run through `onLine` exactly once (it dedupes by update
//     id) and acknowledged only after `onLine` resolved;
//   - `requestApproval` fails closed: anything but an explicit allow from the
//     topic, including a timeout, a refusal and a dropped stream, is a deny.
//
// The only network this file performs is to the serve address read from
// `endpoint.json`, and that address must be a loopback address: it is checked on
// every attempt, so a tampered endpoint file cannot send the shell token anywhere
// else. It never logs or returns the token.

import { isLoopbackAddress } from "../lib/serve-config";
import { SESSION_LEASE_HEARTBEAT_MS } from "../session/lease";
import {
  type AckBody,
  type ApprovalBody,
  type ApprovalDecision,
  type ApprovalEvent,
  type ApprovalResponse,
  type CallbackEvent,
  type InboundEvent,
  type RegisterBody,
  type RegisterResponse,
  type ReplyBody,
  type ReplyButton,
  remoteRoutePath,
  type RemoteRoute,
  SseParser,
  type StatusEvent,
} from "./protocol";
import { readEndpoint } from "./endpoint";
import { readShellToken } from "./shell-token";

export interface InboundMeta {
  updateId: number;
  threadId: number;
  fromId: number;
  receivedAt: number;
}

export type ClientState = "connected" | "disconnected" | "stopped";

export interface ClientStatus {
  state: ClientState;
  reason?: string;
}

export interface RemoteClientOptions {
  sessionId: string;
  project: string;
  /** The topic name to ask for. Absent: serve picks one from the project. */
  name?: string;
  /** Called once per line; the line is acknowledged after the returned promise resolves. */
  onLine: (text: string, meta: InboundMeta) => void | Promise<void>;
  /** Buttons the shell attached to a reply itself (not approvals). */
  onCallback?: (data: string, meta: { updateId: number; threadId: number; fromId: number }) => void | Promise<void>;
  onStatus?: (status: ClientStatus) => void;
  /** User-global directory override (the test seam). */
  dir?: string | undefined;
  fetchImpl?: typeof fetch;
  heartbeatMs?: number;
  backoff?: { initialMs?: number; maxMs?: number };
  /** Abortable sleep, injectable so tests need not wait out a backoff. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Timeout for the non-stream requests. */
  requestTimeoutMs?: number;
}

export type StartResult =
  | { ok: true; name: string; threadId: number; runTimeoutMs: number }
  | { ok: false; code: string; message: string; retrying: boolean };

class FatalClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class TransientClientError extends Error {}

const DEFAULT_BACKOFF_INITIAL_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_EARLY_DECISIONS = 32;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** A URL host for an address; IPv6 literals need brackets. */
function authority(address: string, port: number): string {
  const bare = address.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `[${bare}]:${port}` : `${bare}:${port}`;
}

export class RemoteClient {
  private readonly fetchImpl: typeof fetch;
  private readonly heartbeatMs: number;
  private readonly backoffInitialMs: number;
  private readonly backoffMaxMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly lifetime = new AbortController();
  private streamAbort: AbortController | undefined;
  private runLoop: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private assignedName: string | undefined;
  private started = false;
  private stopped = false;
  private leaving = false;
  private streamOpen = false;
  private lastCompleted = 0;
  private readonly inFlight = new Set<number>();
  private inboundChain: Promise<void> = Promise.resolve();
  private readonly waiters = new Map<string, { resolve: (decision: ApprovalDecision) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly earlyDecisions = new Map<string, ApprovalDecision>();
  private firstResult: ((result: StartResult) => void) | undefined;

  /** The topic name and thread, once registered. */
  name: string | undefined;
  threadId: number | undefined;
  /** How long a run started from Telegram may take; learned at registration. */
  runTimeoutMs: number | undefined;
  /** When serve last answered a heartbeat (or the stream last said ready), epoch ms. For the shell's status display. */
  lastHeartbeatAt: number | undefined;

  constructor(private readonly options: RemoteClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.heartbeatMs = options.heartbeatMs ?? SESSION_LEASE_HEARTBEAT_MS;
    this.backoffInitialMs = options.backoff?.initialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
    this.backoffMaxMs = options.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.sleep = options.sleep ?? abortableSleep;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.streamOpen && !this.stopped;
  }

  // ---- lifecycle -----------------------------------------------------------

  /**
   * Register and start the heartbeat and the stream. Resolves after the FIRST
   * attempt: `ok`, or a reason. A permanent refusal (name held, invalid name) does
   * not retry; a transient one (serve not up yet) keeps retrying in the background.
   */
  start(): Promise<StartResult> {
    if (this.started) {
      return Promise.resolve({ ok: false, code: "already-started", message: "this client was already started", retrying: false });
    }
    this.started = true;
    const first = new Promise<StartResult>((resolve) => {
      this.firstResult = resolve;
    });
    this.runLoop = this.run();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, this.heartbeatMs);
    return first;
  }

  /** Leave: deregister (best effort), close the stream, deny anything waiting. */
  async close(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.leaving = true;
    if (this.started && this.name !== undefined) {
      await this.post("deregister", { sessionId: this.options.sessionId }).catch(() => undefined);
    }
    await this.halt("closed");
  }

  /** Vanish without deregistering: what a killed shell looks like to serve. */
  async drop(): Promise<void> {
    await this.halt("dropped");
  }

  private async halt(reason: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.teardown();
    await this.runLoop?.catch(() => undefined);
    this.options.onStatus?.({ state: "stopped", reason });
  }

  /** The synchronous half of stopping: timers, the stream, anything waiting. */
  private teardown(): void {
    this.stopped = true;
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.lifetime.abort();
    this.streamAbort?.abort();
    this.failApprovals();
    this.firstResult?.({ ok: false, code: "stopped", message: "the client was stopped before it connected", retrying: false });
    this.firstResult = undefined;
  }

  // ---- messages to the topic -----------------------------------------------

  /** Post text (and optional buttons) to the topic. False when it could not be queued. */
  async reply(text: string, options: { keyboard?: ReplyButton[][] } = {}): Promise<boolean> {
    const body: ReplyBody = { sessionId: this.options.sessionId, text, ...(options.keyboard === undefined ? {} : { keyboard: options.keyboard }) };
    try {
      const response = await this.post("reply", body);
      if (response.status === 404) {
        this.streamAbort?.abort();
      }
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Ask the topic to allow or deny. Fails closed: anything but an explicit allow
   * pressed in the topic is `deny` — a timeout, a refusal, no stream, a dropped
   * stream, an error.
   */
  async requestApproval(prompt: string, timeoutMs: number): Promise<ApprovalDecision> {
    if (!this.connected) {
      return "deny";
    }
    const body: ApprovalBody = { sessionId: this.options.sessionId, prompt, timeoutMs };
    let approvalId: string;
    try {
      const response = await this.post("approval", body);
      if (!response.ok) {
        return "deny";
      }
      approvalId = ((await response.json()) as ApprovalResponse).approvalId;
    } catch {
      return "deny";
    }
    const early = this.earlyDecisions.get(approvalId);
    if (early !== undefined) {
      this.earlyDecisions.delete(approvalId);
      return early;
    }
    if (!this.connected) {
      return "deny";
    }
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(approvalId);
        resolve("deny");
      }, timeoutMs);
      this.waiters.set(approvalId, { resolve, timer });
    });
  }

  // ---- requests --------------------------------------------------------------

  /** The one place a URL is built, and the one place the loopback rule is enforced. */
  private target(route: RemoteRoute, query = ""): { url: string; token: string } {
    const endpoint = readEndpoint(this.options.dir);
    if (!endpoint.ok) {
      throw new TransientClientError(endpoint.reason);
    }
    if (!isLoopbackAddress(endpoint.value.address)) {
      throw new FatalClientError("non-loopback-endpoint", "the serve endpoint is not a loopback address; refusing to send the shell token there");
    }
    const token = readShellToken(this.options.dir);
    if (!token.ok) {
      throw new TransientClientError(token.reason);
    }
    return { url: `http://${authority(endpoint.value.address, endpoint.value.port)}${remoteRoutePath(route)}${query}`, token: token.value };
  }

  private async post(route: RemoteRoute, body: RegisterBody | ReplyBody | ApprovalBody | AckBody | { sessionId: string }): Promise<Response> {
    const { url, token } = this.target(route);
    return this.fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(this.requestTimeoutMs), this.lifetime.signal]),
    });
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped || this.name === undefined) {
      return;
    }
    try {
      const response = await this.post("heartbeat", { sessionId: this.options.sessionId });
      if (response.ok) {
        this.lastHeartbeatAt = Date.now();
      }
      if (response.status === 404) {
        // Serve forgot us. Dropping the stream sends the loop back through register.
        this.streamAbort?.abort();
      }
    } catch {
      // Unreachable serve: the stream loop is already dealing with it.
    }
  }

  // ---- the connection loop -------------------------------------------------

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped && !this.leaving) {
      let reachedReady = false;
      try {
        reachedReady = await this.connectOnce();
      } catch (error) {
        if (error instanceof FatalClientError) {
          this.settleFirst({ ok: false, code: error.code, message: error.message, retrying: false });
          this.teardown();
          this.options.onStatus?.({ state: "stopped", reason: error.message });
          return;
        }
        this.settleFirst({ ok: false, code: "unreachable", message: error instanceof Error ? error.message : String(error), retrying: true });
      }
      if (this.stopped || this.leaving) {
        return;
      }
      if (reachedReady) {
        attempt = 0;
      }
      const delay = Math.min(this.backoffMaxMs, this.backoffInitialMs * 2 ** Math.min(attempt, 20));
      attempt += 1;
      await this.sleep(delay, this.lifetime.signal);
    }
  }

  private settleFirst(result: StartResult): void {
    this.firstResult?.(result);
    this.firstResult = undefined;
  }

  /** One connection: register, open the stream, read it until it ends. True once the stream said ready. */
  private async connectOnce(): Promise<boolean> {
    await this.register();
    const abort = new AbortController();
    this.streamAbort = abort;
    const { url, token } = this.target("stream", `?sessionId=${encodeURIComponent(this.options.sessionId)}`);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "text/event-stream" };
    if (this.lastCompleted > 0) {
      // Cumulative: "I have completed everything up to this id".
      headers["last-event-id"] = String(this.lastCompleted);
    }
    const response = await this.fetchImpl(url, { method: "GET", headers, signal: AbortSignal.any([abort.signal, this.lifetime.signal]) });
    if (!response.ok || response.body === null) {
      await response.text().catch(() => "");
      if (response.status === 404) {
        // Not registered (serve lost us): the next loop registers again at once.
        return false;
      }
      throw new TransientClientError(`the stream was refused (HTTP ${response.status})`);
    }
    let ready = false;
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.event === "status") {
            const status = JSON.parse(frame.data) as StatusEvent;
            if (status.kind === "ready") {
              ready = true;
              this.streamOpen = true;
              this.lastHeartbeatAt = Date.now();
              this.options.onStatus?.({ state: "connected" });
              if (this.name !== undefined && this.threadId !== undefined && this.runTimeoutMs !== undefined) {
                this.settleFirst({ ok: true, name: this.name, threadId: this.threadId, runTimeoutMs: this.runTimeoutMs });
              }
            } else if (status.kind === "superseded") {
              // Another connection for this session id took over; fighting it would loop forever.
              throw new FatalClientError("superseded", "another connection for this session replaced this one");
            }
            continue;
          }
          this.handleFrame(frame.event, frame.data);
        }
      }
    } catch (error) {
      if (error instanceof FatalClientError) {
        throw error;
      }
      // A broken or aborted stream is an ordinary reason to reconnect.
    } finally {
      this.streamOpen = false;
      // A decision can only arrive over the stream; with it gone, nobody is coming.
      this.failApprovals();
      if (!this.stopped) {
        this.options.onStatus?.({ state: "disconnected" });
      }
    }
    return ready;
  }

  private async register(): Promise<void> {
    const body: RegisterBody = {
      sessionId: this.options.sessionId,
      project: this.options.project,
      ...(this.assignedName !== undefined ? { name: this.assignedName } : this.options.name === undefined ? {} : { name: this.options.name }),
    };
    const response = await this.post("register", body);
    if (response.ok) {
      const result = (await response.json()) as RegisterResponse;
      this.assignedName = result.name;
      this.name = result.name;
      this.threadId = result.threadId;
      this.runTimeoutMs = result.runTimeoutMs;
      return;
    }
    const error = (await response.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const code = error.error?.code ?? `http-${response.status}`;
    const message = error.error?.message ?? `registration was refused (HTTP ${response.status})`;
    // These do not get better by asking again.
    if (response.status === 400 || response.status === 409) {
      throw new FatalClientError(code, message);
    }
    throw new TransientClientError(message);
  }

  // ---- frames --------------------------------------------------------------

  private handleFrame(event: string, data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "inbound") {
      const inbound = parsed as InboundEvent;
      // Ordered among lines, but never behind a long `onLine`: approvals and
      // callbacks are handled at once, below.
      this.inboundChain = this.inboundChain.then(() => this.handleInbound(inbound)).catch(() => undefined);
    } else if (event === "approval") {
      const approval = parsed as ApprovalEvent;
      this.resolveApproval(approval.approvalId, approval.decision);
    } else if (event === "callback") {
      const callback = parsed as CallbackEvent;
      if (this.options.onCallback !== undefined) {
        void Promise.resolve(this.options.onCallback(callback.data, { updateId: callback.updateId, threadId: callback.threadId, fromId: callback.fromId })).catch(() => undefined);
      }
    }
  }

  private async handleInbound(event: InboundEvent): Promise<void> {
    const id = event.updateId;
    if (id <= this.lastCompleted) {
      // Already done (a redelivery after a lost ack or a serve restart): say so again, run nothing.
      await this.ack(id);
      return;
    }
    if (this.inFlight.has(id)) {
      return;
    }
    this.inFlight.add(id);
    try {
      await this.options.onLine(event.text, { updateId: id, threadId: event.threadId, fromId: event.fromId, receivedAt: event.receivedAt });
    } catch {
      // Not accepted: no ack, so serve redelivers it.
      this.inFlight.delete(id);
      return;
    }
    this.inFlight.delete(id);
    this.lastCompleted = Math.max(this.lastCompleted, id);
    await this.ack(id);
  }

  private async ack(updateId: number): Promise<void> {
    try {
      await this.post("ack", { sessionId: this.options.sessionId, updateId });
    } catch {
      // A lost ack is repaired by the next redelivery (re-acked above) or the next Last-Event-ID.
    }
  }

  private resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    const waiter = this.waiters.get(approvalId);
    if (waiter === undefined) {
      // The decision beat the response that names its id; park it briefly.
      if (this.earlyDecisions.size >= MAX_EARLY_DECISIONS) {
        const oldest = this.earlyDecisions.keys().next().value;
        if (oldest !== undefined) {
          this.earlyDecisions.delete(oldest);
        }
      }
      this.earlyDecisions.set(approvalId, decision);
      return;
    }
    clearTimeout(waiter.timer);
    this.waiters.delete(approvalId);
    waiter.resolve(decision);
  }

  private failApprovals(): void {
    for (const [id, waiter] of [...this.waiters.entries()]) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve("deny");
    }
    this.earlyDecisions.clear();
  }
}
