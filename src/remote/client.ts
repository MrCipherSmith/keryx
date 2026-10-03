// The shell-side client of `keryx serve`'s remote hub (flow 376, block 2).
//
// A library, not a feature: no TUI, no shell, nothing from `src/tui`. The shell
// (block 3) constructs one, hands it `onLine`, and calls `reply` and
// `requestApproval`. Everything else is this file's problem:
//
//   - it finds serve by `endpoint.json` and authenticates with the local shell
//     token, both RE-READ on every request and every connection attempt, so a serve
//     that restarted on another port, or minted a new token (serve does on every
//     start), is followed without the shell doing anything;
//   - it registers (again, after every reconnect: the same session and name give
//     back the same topic), heartbeats at the lease cadence, and keeps the SSE
//     stream open with exponential backoff and `Last-Event-ID`;
//   - an inbound line is run through `onLine` exactly once (it dedupes by EXACT
//     update id over a bounded window of recent ones, never by a high-water
//     mark: Telegram may restart its numbering) and acknowledged only after
//     `onLine` resolved;
//   - `requestApproval` fails closed: anything but an explicit allow from the
//     topic, including a timeout, a refusal and a dropped stream, is a deny.
//
// The only network this file performs is to the serve address read from
// `endpoint.json`, and that address must be a loopback address: it is checked on
// every attempt, so a tampered endpoint file cannot send the shell token anywhere
// else. The serve named by the file must also be a running process of this user:
// a serve that was killed leaves its `endpoint.json` behind, and the port may by
// then belong to someone else, who must not be handed the token. A reused pid can
// still pass that check, so the raw token is never sent at all (each request
// carries a bearer derived from it and a fresh nonce) and every answer, the event
// stream included, must carry serve's proof for that nonce before it is used
// (F-002). It never logs or returns the token.

import { isLoopbackAddress } from "../lib/serve-config";
import { SESSION_LEASE_HEARTBEAT_MS } from "../session/lease";
import {
  type AckBody,
  type ApprovalAckBody,
  type ApprovalBody,
  type ApprovalDecision,
  type ApprovalResultBody,
  isApprovalId,
  type ChoiceEvent,
  type PromptBody,
  type PromptResponse,
  type ApprovalResponse,
  type CallbackEvent,
  type InboundEvent,
  type MessageState,
  type RegisterBody,
  type RegisterResponse,
  type ReplyBody,
  type ReplyButton,
  remoteRoutePath,
  type RemoteRoute,
  SseParser,
  type StateBody,
  type StatusEvent,
} from "./protocol";
import { readEndpoint } from "./endpoint";
import { readShellToken, SERVE_PROOF_HEADER, shellRequestCredential, verifyServeResponseProof } from "./shell-token";

const UNVERIFIED_SERVE_MESSAGE =
  "the program answering on keryx serve's port did not prove it is the keryx serve this shell trusts; its answer was ignored. Restart `keryx serve` (an older serve cannot prove itself; update keryx on both sides)";

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
  /**
   * An approval decision frame arrived from the topic (flow 397, AC5). Called once per approval id,
   * before the shell acknowledges it, so the operator sees the decision as it lands. `applied` is
   * whether it reached a live question here: false for a stale id, one the shell already gave up on,
   * or one that was never asked, and the shell must not say it acted on those.
   */
  onApprovalFrame?: (frame: { approvalId: string; decision: ApprovalDecision; applied: boolean }) => void;
  /** {@link RemoteClient.unconfirmedApprovals} changed (a decision arrived, was confirmed, or aged out): repaint what shows it. */
  onUnconfirmedChange?: () => void;
  /** User-global directory override (the test seam). */
  dir?: string | undefined;
  fetchImpl?: typeof fetch;
  heartbeatMs?: number;
  backoff?: { initialMs?: number; maxMs?: number };
  /** Abortable sleep, injectable so tests need not wait out a backoff. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Timeout for the non-stream requests. */
  requestTimeoutMs?: number;
  /** Test seam: is the serve process named in `endpoint.json` running, as this user? */
  isAlive?: (pid: number) => boolean;
  /** How long a decision that beat the question it answers may wait for that question to register (default 2 s). */
  earlyDecisionMs?: number;
}

/** What came back for one approval (flow 396). `approvalId` is absent when nothing was ever asked. */
export interface ApprovalAnswer {
  decision: ApprovalDecision;
  approvalId?: string;
  /** The Telegram user who pressed the button; absent for a deny that was not a press (timeout, dropped stream). */
  fromId?: number;
}

/**
 * An approval event from the stream, read without trusting its shape (flow 396). It needs an id to
 * mean anything; a decision that is not exactly `allow`, `always` or `deny` is a `deny`, never a yes.
 * `fromId` is kept only when it is a whole number. Exported for the tests.
 */
export function readApprovalEvent(parsed: unknown): { approvalId: string; pressed: PressedApproval } | undefined {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const o = parsed as { approvalId?: unknown; decision?: unknown; fromId?: unknown };
  if (typeof o.approvalId !== "string" || o.approvalId.length === 0) return undefined;
  const decision: ApprovalDecision = o.decision === "allow" || o.decision === "always" ? o.decision : "deny";
  const fromId = typeof o.fromId === "number" && Number.isSafeInteger(o.fromId) ? o.fromId : undefined;
  return { approvalId: o.approvalId, pressed: { decision, ...(fromId === undefined ? {} : { fromId }) } };
}

export interface PressedApproval {
  decision: ApprovalDecision;
  fromId?: number;
}

export type StartResult =
  | { ok: true; name: string; threadId: number; runTimeoutMs: number; permissionMode?: "ask" | "trust"; approvalTimeoutMs?: number }
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
/**
 * A decision frame can beat the response that names its approval id by a few milliseconds. That is the
 * only reason to park one; a frame no question claims within this long was for a question that is gone.
 * Serve waits 5 s for the ack, so this must stay well under it.
 */
const DEFAULT_EARLY_DECISION_MS = 2_000;
/** Approval ids already seen and how they ended, so a repeated frame is acknowledged again but never resolves a waiter twice. */
const MAX_SEEN_APPROVALS = 256;
/** How long a decision whose ack did not go through still counts as "not confirmed" in the status. */
const UNCONFIRMED_APPROVAL_LINGER_MS = 60_000;
const MAX_UNCONFIRMED_APPROVALS = 64;
/** How many recently completed update ids the shell remembers, to drop a redelivery without running it again. */
const MAX_COMPLETED_IDS = 256;

/**
 * Whether a process we may signal exists. ESRCH is a dead serve; EPERM is a live
 * process of ANOTHER user (a pid that was reused, or a squatter). Neither is a
 * serve of ours, so both are refused.
 */
export function ownProcessIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
export function authority(address: string, port: number): string {
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
  private readonly isAlive: (pid: number) => boolean;
  private readonly lifetime = new AbortController();
  private streamAbort: AbortController | undefined;
  private runLoop: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private assignedName: string | undefined;
  private started = false;
  private stopped = false;
  private leaving = false;
  private streamOpen = false;
  /** The most recent update id this shell finished; sent as `Last-Event-ID`. Never a filter. */
  private lastCompleted = 0;
  /** Exact ids finished recently (insertion ordered, bounded): what a redelivery is checked against. */
  private readonly completedIds = new Set<number>();
  private readonly inFlight = new Set<number>();
  /** The register request in flight, so `close` can wait for it and deregister what it created. */
  private registering: Promise<void> | undefined;
  private inboundChain: Promise<void> = Promise.resolve();
  private readonly waiters = new Map<string, { resolve: (answer: PressedApproval) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly earlyDecisions = new Map<string, { pressed: PressedApproval; timer: ReturnType<typeof setTimeout> }>();
  /** `pending` is a parked decision whose question has not claimed it yet; its ack goes out when it settles. */
  private readonly seenApprovals = new Map<string, "applied" | "not-applied" | "pending">();
  private readonly earlyDecisionMs: number;
  /** Decision frames received whose ack has not gone through (approval id to when it arrived). Bounded and aged out. */
  private readonly unackedApprovals = new Map<string, number>();
  private readonly lingerTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly choiceWaiters = new Map<string, { resolve: (index: number | undefined) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly earlyChoices = new Map<string, number>();
  private firstResult: ((result: StartResult) => void) | undefined;

  /** The topic name and thread, once registered. */
  name: string | undefined;
  threadId: number | undefined;
  /** How long a run started from Telegram may take; learned at registration. */
  runTimeoutMs: number | undefined;
  /**
   * What serve says a Telegram-started turn starts under, and how long an approval waits (flow 396).
   * Undefined when the serve that answered is older than this client: the shell then keeps today's
   * behaviour (`ask`, 5 minutes) rather than guess.
   */
  permissionMode: "ask" | "trust" | undefined;
  approvalTimeoutMs: number | undefined;
  /** When serve last answered a heartbeat (or the stream last said ready), epoch ms. For the shell's status display. */
  lastHeartbeatAt: number | undefined;

  constructor(private readonly options: RemoteClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.heartbeatMs = options.heartbeatMs ?? SESSION_LEASE_HEARTBEAT_MS;
    this.backoffInitialMs = options.backoff?.initialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
    this.backoffMaxMs = options.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.sleep = options.sleep ?? abortableSleep;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.isAlive = options.isAlive ?? ownProcessIsAlive;
    this.earlyDecisionMs = options.earlyDecisionMs ?? DEFAULT_EARLY_DECISION_MS;
  }

  get connected(): boolean {
    return this.streamOpen && !this.stopped;
  }

  /** How many approval decisions arrived whose ack serve has not confirmed (in flight, or failed within the last minute). */
  get unconfirmedApprovals(): number {
    const cutoff = Date.now() - UNCONFIRMED_APPROVAL_LINGER_MS;
    for (const [id, at] of [...this.unackedApprovals.entries()]) {
      if (at < cutoff) {
        this.unackedApprovals.delete(id);
      }
    }
    return this.unackedApprovals.size;
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
    // A register still in flight may be creating the topic right now: let it
    // finish, so there is something to deregister instead of an orphan topic.
    await this.registering?.catch(() => undefined);
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
    for (const timer of this.lingerTimers) {
      clearTimeout(timer);
    }
    this.lingerTimers.clear();
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
    return (await this.askApproval(prompt, timeoutMs)).decision;
  }

  /**
   * Like {@link requestApproval}, and it can offer "Always: <remember>" (flow 396). The answer names the
   * approval and the Telegram user who pressed, so the shell can audit it and report what became of an
   * "Always" press with {@link reportApprovalResult}. Same fail-closed rule: no press is a deny.
   */
  async askApproval(prompt: string, timeoutMs: number, options: { remember?: string; signal?: AbortSignal } = {}): Promise<ApprovalAnswer> {
    if (!this.connected || options.signal?.aborted === true) {
      return { decision: "deny" };
    }
    const body: ApprovalBody = {
      sessionId: this.options.sessionId,
      prompt,
      timeoutMs,
      ...(options.remember === undefined ? {} : { remember: options.remember }),
    };
    let approvalId: string;
    try {
      const response = await this.post("approval", body);
      if (!response.ok) {
        return { decision: "deny" };
      }
      const id = ((await response.json()) as Partial<ApprovalResponse> | null)?.approvalId;
      if (typeof id !== "string" || id.length === 0) {
        return { decision: "deny" };
      }
      approvalId = id;
    } catch {
      return { decision: "deny" };
    }
    const early = this.earlyDecisions.get(approvalId);
    if (early !== undefined) {
      // The frame beat this response: now it reaches a live question, so it is applied, and only now.
      clearTimeout(early.timer);
      this.earlyDecisions.delete(approvalId);
      this.settleApproval(approvalId, early.pressed.decision, true);
      return { ...early.pressed, approvalId };
    }
    if (!this.connected) {
      return { decision: "deny" };
    }
    return new Promise<ApprovalAnswer>((resolve) => {
      const signal = options.signal;
      const onAbort = (): void => {
        // The turn was stopped (flow 396 `/stop`): the question is moot, so it is a deny and a late press finds nothing.
        const waiter = this.waiters.get(approvalId);
        if (waiter !== undefined) clearTimeout(waiter.timer);
        this.waiters.delete(approvalId);
        resolve({ decision: "deny", approvalId });
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(approvalId);
        resolve({ decision: "deny" });
      }, timeoutMs);
      this.waiters.set(approvalId, {
        resolve: (pressed) => {
          signal?.removeEventListener("abort", onAbort);
          resolve({ ...pressed, approvalId });
        },
        timer,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Tell the topic whether an "Always" press became a saved rule. Best effort: the approval itself already counted. */
  async reportApprovalResult(approvalId: string, remembered: boolean): Promise<void> {
    try {
      await this.post("approval-result", { sessionId: this.options.sessionId, approvalId, remembered });
    } catch {
      // The message keeps saying "Saving the rule"; nothing else depends on this.
    }
  }

  /**
   * Ask the topic with buttons (flow 387). Resolves with the position of the pressed button,
   * counting across the rows, or undefined: no press in time, a refusal, no stream, a dropped
   * stream. Nothing here ever turns an absent answer into a yes.
   */
  async requestChoice(text: string, rows: string[][], timeoutMs: number, forUserId?: number): Promise<number | undefined> {
    if (!this.connected) {
      return undefined;
    }
    const body: PromptBody = { sessionId: this.options.sessionId, text, rows, timeoutMs, ...(forUserId === undefined ? {} : { forUserId }) };
    let promptId: string;
    try {
      const response = await this.post("prompt", body);
      if (!response.ok) {
        return undefined;
      }
      promptId = ((await response.json()) as PromptResponse).promptId;
    } catch {
      return undefined;
    }
    const early = this.earlyChoices.get(promptId);
    if (early !== undefined) {
      this.earlyChoices.delete(promptId);
      return early;
    }
    if (!this.connected) {
      return undefined;
    }
    return new Promise<number | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.choiceWaiters.delete(promptId);
        resolve(undefined);
      }, timeoutMs);
      this.choiceWaiters.set(promptId, { resolve, timer });
    });
  }

  /**
   * Tell serve where a message from the topic is (flow 387, AC18): it shows the state as a
   * reaction and the typing indicator. Best effort: a failure here never touches the message.
   */
  async reportState(updateId: number, state: MessageState): Promise<void> {
    if (!this.connected) {
      return;
    }
    try {
      await this.post("state", { sessionId: this.options.sessionId, updateId, state });
    } catch {
      // The state is a courtesy; the message itself is unaffected.
    }
  }

  // ---- requests --------------------------------------------------------------

  /** The one place a URL is built, and the one place the loopback rule is enforced. */
  private target(route: RemoteRoute, query = ""): { url: string; token: string } {
    // The token is read before the endpoint: serve removes the old endpoint before it mints a token, so a
    // new token can never be paired with an endpoint left over from an earlier serve.
    const token = readShellToken(this.options.dir);
    const endpoint = readEndpoint(this.options.dir);
    if (!endpoint.ok) {
      throw new TransientClientError(endpoint.reason);
    }
    if (!isLoopbackAddress(endpoint.value.address)) {
      throw new FatalClientError("non-loopback-endpoint", "the serve endpoint is not a loopback address; refusing to send the shell token there");
    }
    if (!this.isAlive(endpoint.value.pid)) {
      // A killed serve leaves its endpoint file behind and the port may be someone else's by now.
      throw new TransientClientError(
        `the serve named in the endpoint file (pid ${endpoint.value.pid}) is not running as this user; refusing to send the shell token to whatever listens on that port`,
      );
    }
    if (!token.ok) {
      throw new TransientClientError(token.reason);
    }
    return { url: `http://${authority(endpoint.value.address, endpoint.value.port)}${remoteRoutePath(route)}${query}`, token: token.value };
  }

  /**
   * A non-stream request. The bearer is derived from the token and a fresh nonce (the raw
   * token never leaves the shell), and the answer is returned only once serve's proof for
   * that nonce, route, status and body checks out: a listener that is not this serve
   * (another program on a freed port, or a serve too old to prove itself) gets nothing
   * acted on. Throws `TransientClientError` on a missing or wrong proof (F-002).
   */
  private async post(route: RemoteRoute, body: RegisterBody | ReplyBody | ApprovalBody | PromptBody | StateBody | AckBody | ApprovalAckBody | ApprovalResultBody | { sessionId: string }): Promise<Response> {
    const { url, token } = this.target(route);
    const { nonce, bearer } = shellRequestCredential(token);
    const response = await this.fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(this.requestTimeoutMs), this.lifetime.signal]),
    });
    const text = await response.text();
    if (!verifyServeResponseProof(token, nonce, route, response.status, text, response.headers.get(SERVE_PROOF_HEADER))) {
      throw new TransientClientError(UNVERIFIED_SERVE_MESSAGE);
    }
    return new Response(text, { status: response.status, headers: response.headers });
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
    const registering = this.register();
    this.registering = registering;
    try {
      await registering;
    } finally {
      if (this.registering === registering) {
        this.registering = undefined;
      }
    }
    if (this.stopped || this.leaving) {
      return false;
    }
    const abort = new AbortController();
    this.streamAbort = abort;
    const { url, token } = this.target("stream", `?sessionId=${encodeURIComponent(this.options.sessionId)}`);
    const { nonce, bearer } = shellRequestCredential(token);
    const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, accept: "text/event-stream" };
    if (this.lastCompleted > 0) {
      // "The last line I completed was this one": serve settles that exact id if it is still waiting for it.
      headers["last-event-id"] = String(this.lastCompleted);
    }
    const response = await this.fetchImpl(url, { method: "GET", redirect: "manual", headers, signal: AbortSignal.any([abort.signal, this.lifetime.signal]) });
    // The stream is proven by its headers: every frame after them comes over this same loopback connection.
    // Unproven, not one frame is read: a forged stream could otherwise feed lines to run and approvals to allow.
    if (!verifyServeResponseProof(token, nonce, "stream", response.status, "", response.headers.get(SERVE_PROOF_HEADER))) {
      await response.body?.cancel().catch(() => undefined);
      throw new TransientClientError(UNVERIFIED_SERVE_MESSAGE);
    }
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
                this.settleFirst({
                  ok: true,
                  name: this.name,
                  threadId: this.threadId,
                  runTimeoutMs: this.runTimeoutMs,
                  ...(this.permissionMode === undefined ? {} : { permissionMode: this.permissionMode }),
                  ...(this.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: this.approvalTimeoutMs }),
                });
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
      this.permissionMode = result.permissionMode;
      this.approvalTimeoutMs = result.approvalTimeoutMs;
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
      this.handleApprovalFrame(parsed);
    } else if (event === "choice") {
      const choice = parsed as ChoiceEvent;
      this.resolveChoice(choice.promptId, choice.index);
    } else if (event === "callback") {
      const callback = parsed as CallbackEvent;
      if (this.options.onCallback !== undefined) {
        void Promise.resolve(this.options.onCallback(callback.data, { updateId: callback.updateId, threadId: callback.threadId, fromId: callback.fromId })).catch(() => undefined);
      }
    }
  }

  private async handleInbound(event: InboundEvent): Promise<void> {
    const id = event.updateId;
    if (this.completedIds.has(id)) {
      // Already done (a redelivery after a lost ack or a serve restart): say so again, run nothing.
      // By exact id: a LOWER id than one seen before is not a repeat (Telegram may restart its numbering).
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
    this.lastCompleted = id;
    this.completedIds.add(id);
    if (this.completedIds.size > MAX_COMPLETED_IDS) {
      const oldest = this.completedIds.values().next().value;
      if (oldest !== undefined) {
        this.completedIds.delete(oldest);
      }
    }
    await this.ack(id);
  }

  private async ack(updateId: number): Promise<void> {
    try {
      await this.post("ack", { sessionId: this.options.sessionId, updateId });
    } catch {
      // A lost ack is repaired by the next redelivery (re-acked above) or the next Last-Event-ID.
    }
  }

  /**
   * A decision frame. The ack says whether the decision was APPLIED to a live question here, not
   * only that the frame arrived: serve shows "Allowed" only for an applied one, so what the operator
   * reads in the topic is what the shell did. With a question waiting it is applied at once. With none
   * it is parked for a moment (the frame can beat the response that names its id) and acked as applied
   * only if a question claims it in time, otherwise as not applied (a stale id, a reconnect, a
   * question already given up on). A repeat for an id already settled is acknowledged again with the
   * same outcome (the first ack may have been lost) but is not said or resolved twice.
   */
  private handleApprovalFrame(parsed: unknown): void {
    const read = readApprovalEvent(parsed);
    if (read === undefined || !isApprovalId(read.approvalId)) {
      return;
    }
    const { approvalId, pressed } = read;
    const seen = this.seenApprovals.get(approvalId);
    if (seen === "pending") {
      // Parked and waiting: its own ack goes out when it settles.
      return;
    }
    this.countUnconfirmed(approvalId);
    if (seen !== undefined) {
      void this.ackApproval(approvalId, seen === "applied");
      return;
    }
    if (this.waiters.has(approvalId)) {
      this.settleApproval(approvalId, pressed.decision, true, () => this.resolveApproval(approvalId, pressed));
      return;
    }
    this.rememberSeen(approvalId, "pending");
    this.parkEarlyDecision(approvalId, pressed);
  }

  private rememberSeen(approvalId: string, outcome: "applied" | "not-applied" | "pending"): void {
    this.seenApprovals.delete(approvalId);
    this.seenApprovals.set(approvalId, outcome);
    if (this.seenApprovals.size > MAX_SEEN_APPROVALS) {
      const oldest = this.seenApprovals.keys().next().value;
      if (oldest !== undefined) {
        this.seenApprovals.delete(oldest);
      }
    }
  }

  /** Count a decision as not confirmed until its ack goes through; the oldest drop past the bound. */
  private countUnconfirmed(approvalId: string): void {
    this.unackedApprovals.delete(approvalId);
    this.unackedApprovals.set(approvalId, Date.now());
    this.notifyUnconfirmed();
    while (this.unackedApprovals.size > MAX_UNCONFIRMED_APPROVALS) {
      const oldest = this.unackedApprovals.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.unackedApprovals.delete(oldest);
    }
  }

  /** Say what happened on screen, then (optionally) hand the decision over, then acknowledge it to serve. */
  private settleApproval(approvalId: string, decision: ApprovalDecision, applied: boolean, apply?: () => void): void {
    this.rememberSeen(approvalId, applied ? "applied" : "not-applied");
    try {
      this.options.onApprovalFrame?.({ approvalId, decision, applied });
    } catch {
      // A failing display never costs the decision.
    }
    apply?.();
    void this.ackApproval(approvalId, applied);
  }

  /** Park a decision no question has claimed yet, for a short bounded time. */
  private parkEarlyDecision(approvalId: string, pressed: PressedApproval): void {
    while (this.earlyDecisions.size >= MAX_EARLY_DECISIONS) {
      const oldest = this.earlyDecisions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.dropEarlyDecision(oldest);
    }
    const timer = setTimeout(() => this.dropEarlyDecision(approvalId), this.earlyDecisionMs);
    (timer as { unref?: () => void }).unref?.();
    this.earlyDecisions.set(approvalId, { pressed, timer });
  }

  /** Nobody claimed it: it was for a question that is gone, so it is acked as not applied. */
  private dropEarlyDecision(approvalId: string): void {
    const early = this.earlyDecisions.get(approvalId);
    if (early === undefined) {
      return;
    }
    clearTimeout(early.timer);
    this.earlyDecisions.delete(approvalId);
    if (!this.stopped) {
      this.settleApproval(approvalId, early.pressed.decision, false);
    }
  }

  private async ackApproval(approvalId: string, applied: boolean): Promise<void> {
    let confirmed = false;
    try {
      const response = await this.post("approval-ack", { sessionId: this.options.sessionId, approvalId, applied });
      confirmed = response.ok;
    } catch {
      // Stays counted as not confirmed for a minute; serve shows the approval as not confirmed after its own wait.
    }
    if (this.stopped) {
      // The ack finished after stop(): no timer (teardown already cleared them all) and no repaint of a dead panel.
      return;
    }
    if (confirmed) {
      this.unackedApprovals.delete(approvalId);
      this.notifyUnconfirmed();
      return;
    }
    this.lingerTimers.add(
      this.scheduleUnref(() => {
        // Aged out: the display must not keep showing it after the count has dropped.
        this.notifyUnconfirmed();
      }, UNCONFIRMED_APPROVAL_LINGER_MS + 50),
    );
  }

  private notifyUnconfirmed(): void {
    try {
      this.options.onUnconfirmedChange?.();
    } catch {
      // A failing repaint never costs an approval.
    }
  }

  private scheduleUnref(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.lingerTimers.delete(timer);
      fn();
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  private resolveApproval(approvalId: string, decision: PressedApproval): void {
    const waiter = this.waiters.get(approvalId);
    if (waiter === undefined) {
      return;
    }
    clearTimeout(waiter.timer);
    this.waiters.delete(approvalId);
    waiter.resolve(decision);
  }

  private resolveChoice(promptId: string, index: number): void {
    const waiter = this.choiceWaiters.get(promptId);
    if (waiter === undefined) {
      // The press beat the response that names its id; park it briefly.
      if (this.earlyChoices.size >= MAX_EARLY_DECISIONS) {
        const oldest = this.earlyChoices.keys().next().value;
        if (oldest !== undefined) {
          this.earlyChoices.delete(oldest);
        }
      }
      this.earlyChoices.set(promptId, index);
      return;
    }
    clearTimeout(waiter.timer);
    this.choiceWaiters.delete(promptId);
    waiter.resolve(index);
  }

  private failChoices(): void {
    for (const [id, waiter] of [...this.choiceWaiters.entries()]) {
      clearTimeout(waiter.timer);
      this.choiceWaiters.delete(id);
      waiter.resolve(undefined);
    }
    this.earlyChoices.clear();
  }

  private failApprovals(): void {
    for (const [id, waiter] of [...this.waiters.entries()]) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve({ decision: "deny" });
    }
    for (const id of [...this.earlyDecisions.keys()]) {
      // Nobody is coming for these: each is acked as not applied (and said so), unless the shell is gone.
      this.dropEarlyDecision(id);
    }
    this.failChoices();
  }
}
