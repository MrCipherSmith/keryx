// The `/v1/remote/*` surface of `keryx serve` (flow 376, block 2).
//
// Implements the structural interface `ServeRemoteSurface` that `lib/serve-server.ts`
// declares, and is the hub's `RemoteConsumer`: the hub hands inbound lines here,
// this turns them into SSE frames for the shell that holds the topic's session and
// waits for the shell's acknowledgement before the hub marks them delivered.
//
// Delivery protocol (at-least-once on the wire, exactly-once at the shell):
//   - `deliver` rejects while no stream is connected, so the hub keeps the line
//     and retries; `redeliver` is called the moment a stream connects.
//   - With a stream it writes an `inbound` frame and waits for `POST /ack`. The
//     wait is bounded (`ackTimeoutMs`); a timeout rejects and the hub retries.
//   - `Last-Event-ID` on a reconnect is a CUMULATIVE acknowledgement: everything at
//     or below it was completed by the shell, so a redelivery at or below it
//     resolves at once without being sent again. Per-topic order is ascending, so
//     a cumulative mark can never skip a line.
//   - The shell dedupes by update id as well, so a retry after a lost ack cannot
//     run a line twice.
//
// Approvals fail closed at every seam: the server only accepts a press for an id
// it generated, for that session, before its expiry, and a stream that ends drops
// every approval it held. The shell side denies on timeout and on disconnect.

import { randomBytes } from "node:crypto";
import { redactSensitiveText } from "../security/service";
import type { RemoteHub, RemoteConsumer, HubTimers, CallbackDelivery, DeliverMeta } from "./hub";
import { realTimers } from "./hub";
import {
  type AckBody,
  type ApprovalBody,
  type ApprovalDecision,
  type ApprovalEvent,
  type CallbackEvent,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_KEEPALIVE_MS,
  encodeSseEvent,
  type InboundEvent,
  isSessionId,
  MAX_APPROVAL_PROMPT_CHARS,
  MAX_APPROVAL_TIMEOUT_MS,
  MAX_BUTTON_TEXT_CHARS,
  MAX_CALLBACK_DATA_BYTES,
  MAX_KEYBOARD_BUTTONS_PER_ROW,
  MAX_KEYBOARD_ROWS,
  MAX_PROJECT_CHARS,
  MAX_REMOTE_BODY_BYTES,
  MIN_APPROVAL_TIMEOUT_MS,
  parseApprovalCallback,
  approvalCallbackData,
  REMOTE_ROUTE_METHODS,
  REMOTE_SCHEMA_VERSION,
  type RegisterBody,
  type RemoteRoute,
  type ReplyBody,
  RESERVED_CALLBACK_PREFIX,
  type SessionBody,
  SSE_KEEPALIVE_FRAME,
  type StatusEvent,
  type StreamEventName,
} from "./protocol";
import { type InlineKeyboard } from "./types";

const MAX_REPLY_CHARS = 20_000;
const MAX_PENDING_APPROVALS_PER_SESSION = 8;
const MAX_PROJECT_NAME_CHARS = 128;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

export interface RemoteSurfaceOptions {
  /** Constant-time check of the presented bearer against the local shell token. */
  verifyShellToken: (presented: string) => boolean;
  now?: () => number;
  timers?: HubTimers;
  keepaliveMs?: number;
  ackTimeoutMs?: number;
  /** Test seam: the approval id generator. Must produce `ap` and 12 lowercase hex characters. */
  approvalIds?: () => string;
}

function ok(body: Record<string, unknown>, status = 200): Response {
  return new Response(`${JSON.stringify({ schemaVersion: REMOTE_SCHEMA_VERSION, ...body })}\n`, { status, headers: JSON_HEADERS });
}

function fail(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify({ error: { code, message } })}\n`, { status, headers: { ...JSON_HEADERS, ...headers } });
}

type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/** Read a bounded JSON object. Refuses on the declared length, the media type, and the bytes actually received. */
async function readJsonBody(request: Request): Promise<BodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_REMOTE_BODY_BYTES) {
    return { ok: false, response: fail(413, "payload-too-large", "The request body is too large.") };
  }
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    return { ok: false, response: fail(415, "unsupported-media-type", "The request body must be application/json.") };
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > MAX_REMOTE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: fail(413, "payload-too-large", "The request body is too large.") };
      }
      chunks.push(value);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { ok: false, response: fail(400, "invalid-request", "The request body is not valid JSON.") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: fail(400, "invalid-request", "The request body must be a JSON object.") };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function invalid(message: string): Response {
  return fail(400, "invalid-request", message);
}

function parseLastEventId(request: Request): number | undefined {
  const raw = request.headers.get("last-event-id");
  if (raw === null || !/^\d{1,15}$/.test(raw.trim())) {
    return undefined;
  }
  return Number(raw.trim());
}

/** One connected shell. All writes go through `write`, which never throws. */
class ShellStream {
  controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  closed = false;
  keepalive: unknown;
  private readonly encoder = new TextEncoder();

  constructor(
    readonly sessionId: string,
    private readonly timers: HubTimers,
    private readonly onEnded: (stream: ShellStream) => void,
  ) {}

  write(frame: string): boolean {
    if (this.closed || this.controller === undefined) {
      return false;
    }
    try {
      this.controller.enqueue(this.encoder.encode(frame));
      return true;
    } catch {
      this.finish();
      return false;
    }
  }

  /** Say why, if there is a reason, then close. Safe to call twice. */
  end(kind?: "superseded" | "closing"): void {
    if (this.closed) {
      return;
    }
    if (kind !== undefined) {
      this.write(encodeSseEvent("status", { kind } satisfies StatusEvent));
    }
    this.finish();
  }

  private finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.keepalive !== undefined) {
      this.timers.clearInterval(this.keepalive);
      this.keepalive = undefined;
    }
    try {
      this.controller?.close();
    } catch {
      // Already closed by the peer.
    }
    this.onEnded(this);
  }
}

interface PendingAck {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: unknown;
  promise: Promise<void>;
}

interface PendingApproval {
  sessionId: string;
  expiresAt: number;
  timer: unknown;
}

export class RemoteHttpSurface {
  readonly consumer: RemoteConsumer;
  private hub: RemoteHub | undefined;
  private unavailableReason = "remote control is not running in this serve";
  private closed = false;
  private readonly now: () => number;
  private readonly timers: HubTimers;
  private readonly keepaliveMs: number;
  private readonly ackTimeoutMs: number;
  private readonly newApprovalId: () => string;
  private readonly streams = new Map<string, ShellStream>();
  private readonly completed = new Map<string, number>();
  private readonly pendingAcks = new Map<string, Map<number, PendingAck>>();
  private readonly approvals = new Map<string, PendingApproval>();

  constructor(private readonly options: RemoteSurfaceOptions) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? realTimers;
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.newApprovalId = options.approvalIds ?? (() => `ap${randomBytes(6).toString("hex")}`);
    this.consumer = {
      deliver: (sessionId, line, meta) => this.deliver(sessionId, line, meta),
      deliverCallback: (sessionId, callback) => this.deliverCallback(sessionId, callback),
    };
  }

  // ---- what lib/serve-server.ts calls --------------------------------------

  verifyShellToken(presented: string): boolean {
    return this.options.verifyShellToken(presented);
  }

  async handle(route: RemoteRoute, request: Request, io: { untimed: () => void }): Promise<Response> {
    const hub = this.hub;
    if (this.closed || hub === undefined) {
      return fail(503, "remote-unavailable", this.unavailableReason);
    }
    if (request.method !== REMOTE_ROUTE_METHODS[route]) {
      return fail(405, "method-not-allowed", "Method not allowed.", { allow: REMOTE_ROUTE_METHODS[route] });
    }
    switch (route) {
      case "register":
        return this.register(hub, request);
      case "deregister":
        return this.deregister(hub, request);
      case "heartbeat":
        return this.heartbeat(hub, request);
      case "reply":
        return this.reply(hub, request);
      case "approval":
        return this.requestApproval(hub, request);
      case "ack":
        return this.ack(hub, request);
      case "stream":
        return this.openStream(hub, request, io);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.hub !== undefined) {
      this.unavailableReason = "remote control is shutting down";
    }
    for (const stream of [...this.streams.values()]) {
      stream.end("closing");
    }
    for (const id of [...this.approvals.keys()]) {
      this.dropApproval(id);
    }
  }

  // ---- composition ---------------------------------------------------------

  /** The hub is up: routes begin answering. */
  attach(hub: RemoteHub): void {
    this.hub = hub;
  }

  /** The hub is not running (and why). Streams end; routes answer 503 with the reason. */
  detach(reason: string): void {
    this.hub = undefined;
    this.unavailableReason = reason;
    for (const stream of [...this.streams.values()]) {
      stream.end("closing");
    }
  }

  // ---- handlers ------------------------------------------------------------

  private async register(hub: RemoteHub, request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return body.response;
    }
    const checked = this.parseRegister(body.value);
    if (typeof checked === "string") {
      return invalid(checked);
    }
    const result = await hub.register(checked);
    if (result.ok) {
      return ok({ name: result.name, threadId: result.threadId, reused: result.reused, runTimeoutMs: hub.limits().runTimeoutMs });
    }
    const status = result.code === "name-taken" ? 409 : result.code === "invalid-name" ? 400 : 502;
    return fail(status, result.code, result.message);
  }

  private parseRegister(value: Record<string, unknown>): RegisterBody | string {
    if (!isSessionId(value.sessionId)) {
      return "sessionId must be 1 to 64 characters of letters, digits, '-' and '_'.";
    }
    const project = value.project;
    if (typeof project !== "string" || project.length === 0 || project.length > MAX_PROJECT_CHARS || CONTROL_CHARS.test(project)) {
      return `project must be a string of 1 to ${MAX_PROJECT_CHARS} characters without control characters.`;
    }
    const name = value.name;
    if (name !== undefined && (typeof name !== "string" || name.length > MAX_PROJECT_NAME_CHARS || CONTROL_CHARS.test(name))) {
      return `name must be a string of at most ${MAX_PROJECT_NAME_CHARS} characters without control characters.`;
    }
    return { sessionId: value.sessionId, project, ...(name === undefined ? {} : { name }) };
  }

  private async sessionBody(request: Request): Promise<{ ok: true; body: SessionBody } | { ok: false; response: Response }> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return body;
    }
    if (!isSessionId(body.value.sessionId)) {
      return { ok: false, response: invalid("sessionId must be 1 to 64 characters of letters, digits, '-' and '_'.") };
    }
    return { ok: true, body: { sessionId: body.value.sessionId } };
  }

  private async deregister(hub: RemoteHub, request: Request): Promise<Response> {
    const parsed = await this.sessionBody(request);
    if (!parsed.ok) {
      return parsed.response;
    }
    const { sessionId } = parsed.body;
    // The shell is leaving: its stream and everything pending for it go first.
    this.streams.get(sessionId)?.end("closing");
    this.completed.delete(sessionId);
    const result = await hub.deregister(sessionId);
    return ok({ existed: result.existed });
  }

  private async heartbeat(hub: RemoteHub, request: Request): Promise<Response> {
    const parsed = await this.sessionBody(request);
    if (!parsed.ok) {
      return parsed.response;
    }
    const result = await hub.heartbeat(parsed.body.sessionId);
    if (result.ok) {
      return ok({ name: result.name, threadId: result.threadId });
    }
    return fail(404, result.code, result.message);
  }

  private parseKeyboard(raw: unknown): { ok: true; keyboard: InlineKeyboard } | { ok: false; message: string } {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_KEYBOARD_ROWS) {
      return { ok: false, message: `keyboard must be 1 to ${MAX_KEYBOARD_ROWS} rows of buttons.` };
    }
    const keyboard: InlineKeyboard = [];
    for (const row of raw as unknown[]) {
      if (!Array.isArray(row) || row.length === 0 || row.length > MAX_KEYBOARD_BUTTONS_PER_ROW) {
        return { ok: false, message: `each keyboard row must hold 1 to ${MAX_KEYBOARD_BUTTONS_PER_ROW} buttons.` };
      }
      const out: InlineKeyboard[number] = [];
      for (const button of row as unknown[]) {
        const candidate = button as { text?: unknown; data?: unknown } | null;
        const text = candidate?.text;
        const data = candidate?.data;
        if (typeof text !== "string" || text.length === 0 || text.length > MAX_BUTTON_TEXT_CHARS) {
          return { ok: false, message: `button text must be 1 to ${MAX_BUTTON_TEXT_CHARS} characters.` };
        }
        if (typeof data !== "string" || data.length === 0 || Buffer.byteLength(data, "utf8") > MAX_CALLBACK_DATA_BYTES) {
          return { ok: false, message: `button data must be 1 to ${MAX_CALLBACK_DATA_BYTES} bytes.` };
        }
        if (data.startsWith(RESERVED_CALLBACK_PREFIX)) {
          return { ok: false, message: `button data may not start with "${RESERVED_CALLBACK_PREFIX}" (reserved for approvals).` };
        }
        out.push({ text: redactSensitiveText(text), callback_data: data });
      }
      keyboard.push(out);
    }
    return { ok: true, keyboard };
  }

  private async reply(hub: RemoteHub, request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return body.response;
    }
    const value = body.value as Partial<ReplyBody> & Record<string, unknown>;
    if (!isSessionId(value.sessionId)) {
      return invalid("sessionId must be 1 to 64 characters of letters, digits, '-' and '_'.");
    }
    if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > MAX_REPLY_CHARS) {
      return invalid(`text must be a string of 1 to ${MAX_REPLY_CHARS} characters.`);
    }
    let keyboard: InlineKeyboard | undefined;
    if (value.keyboard !== undefined) {
      const parsed = this.parseKeyboard(value.keyboard);
      if (!parsed.ok) {
        return invalid(parsed.message);
      }
      keyboard = parsed.keyboard;
    }
    const sent = await hub.send(value.sessionId, redactSensitiveText(value.text), keyboard === undefined ? {} : { keyboard });
    if (!sent) {
      return fail(404, "unknown-session", "This session is not registered for remote control; register again.");
    }
    return ok({ queued: true });
  }

  private async requestApproval(hub: RemoteHub, request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return body.response;
    }
    const value = body.value as Partial<ApprovalBody> & Record<string, unknown>;
    if (!isSessionId(value.sessionId)) {
      return invalid("sessionId must be 1 to 64 characters of letters, digits, '-' and '_'.");
    }
    if (typeof value.prompt !== "string" || value.prompt.length === 0 || value.prompt.length > MAX_APPROVAL_PROMPT_CHARS) {
      return invalid(`prompt must be a string of 1 to ${MAX_APPROVAL_PROMPT_CHARS} characters.`);
    }
    const timeoutMs = value.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_APPROVAL_TIMEOUT_MS || timeoutMs > MAX_APPROVAL_TIMEOUT_MS) {
      return invalid(`timeoutMs must be an integer from ${MIN_APPROVAL_TIMEOUT_MS} to ${MAX_APPROVAL_TIMEOUT_MS}.`);
    }
    const sessionId = value.sessionId;
    if (!hub.hasSession(sessionId)) {
      return fail(404, "unknown-session", "This session is not registered for remote control; register again.");
    }
    // The decision can only come back over the stream. With none connected there
    // is nobody to receive it, so refuse now rather than post buttons that lead nowhere.
    if (this.streams.get(sessionId) === undefined) {
      return fail(409, "no-stream", "No stream is connected for this session; the approval cannot be answered.");
    }
    let held = 0;
    for (const entry of this.approvals.values()) {
      if (entry.sessionId === sessionId) {
        held += 1;
      }
    }
    if (held >= MAX_PENDING_APPROVALS_PER_SESSION) {
      return fail(429, "too-many-approvals", "Too many approvals are waiting for this session.");
    }

    const approvalId = this.newApprovalId();
    const expiresAt = this.now() + timeoutMs;
    // Registered BEFORE the buttons exist, so a press cannot beat the record.
    this.approvals.set(approvalId, {
      sessionId,
      expiresAt,
      timer: this.timers.setTimeout(() => this.expireApproval(approvalId), timeoutMs),
    });
    const sent = await hub.send(sessionId, `Approval needed:\n${redactSensitiveText(value.prompt)}`, {
      keyboard: [
        [
          { text: "Allow", callback_data: approvalCallbackData(approvalId, "allow") },
          { text: "Deny", callback_data: approvalCallbackData(approvalId, "deny") },
        ],
      ],
    });
    if (!sent) {
      this.dropApproval(approvalId);
      return fail(404, "unknown-session", "This session is not registered for remote control; register again.");
    }
    return ok({ approvalId, expiresAt });
  }

  private async ack(hub: RemoteHub, request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return body.response;
    }
    const value = body.value as Partial<AckBody> & Record<string, unknown>;
    if (!isSessionId(value.sessionId)) {
      return invalid("sessionId must be 1 to 64 characters of letters, digits, '-' and '_'.");
    }
    if (typeof value.updateId !== "number" || !Number.isSafeInteger(value.updateId) || value.updateId < 0) {
      return invalid("updateId must be a non-negative integer.");
    }
    if (!hub.hasSession(value.sessionId)) {
      return fail(404, "unknown-session", "This session is not registered for remote control; register again.");
    }
    this.complete(value.sessionId, value.updateId);
    return ok({ acknowledged: true });
  }

  private openStream(hub: RemoteHub, request: Request, io: { untimed: () => void }): Response {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    if (!isSessionId(sessionId)) {
      return invalid("sessionId must be 1 to 64 characters of letters, digits, '-' and '_'.");
    }
    if (!hub.hasSession(sessionId)) {
      return fail(404, "unknown-session", "This session is not registered for remote control; register again.");
    }
    const resumeFrom = parseLastEventId(request);
    if (resumeFrom !== undefined) {
      this.complete(sessionId, resumeFrom);
    }
    // A newer stream for the same session wins; the older one is told and closed.
    this.streams.get(sessionId)?.end("superseded");
    io.untimed();

    const stream = new ShellStream(sessionId, this.timers, (ended) => this.onStreamEnded(ended));
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        stream.controller = controller;
      },
      cancel: () => {
        stream.end();
      },
    });
    this.streams.set(sessionId, stream);
    stream.keepalive = this.timers.setInterval(() => {
      stream.write(SSE_KEEPALIVE_FRAME);
    }, this.keepaliveMs);
    request.signal.addEventListener("abort", () => stream.end(), { once: true });
    stream.write(encodeSseEvent("status", { kind: "ready" } satisfies StatusEvent));
    // Whatever was waiting for a shell can go now, not at the next retry.
    hub.redeliver(sessionId);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  }

  // ---- delivery (the hub's consumer) ---------------------------------------

  private completedUpTo(sessionId: string): number {
    return this.completed.get(sessionId) ?? 0;
  }

  /** Record a cumulative acknowledgement and settle every pending delivery at or below it. */
  private complete(sessionId: string, updateId: number): void {
    if (updateId > this.completedUpTo(sessionId)) {
      this.completed.set(sessionId, updateId);
    }
    const pending = this.pendingAcks.get(sessionId);
    if (pending === undefined) {
      return;
    }
    for (const [id, entry] of [...pending.entries()]) {
      if (id <= updateId) {
        this.timers.clearTimeout(entry.timer);
        pending.delete(id);
        entry.resolve();
      }
    }
    if (pending.size === 0) {
      this.pendingAcks.delete(sessionId);
    }
  }

  private deliver(sessionId: string, line: string, meta: DeliverMeta): Promise<void> {
    if (meta.updateId <= this.completedUpTo(sessionId)) {
      // The shell already finished this one (a redelivery after a lost ack or a restart).
      return Promise.resolve();
    }
    const stream = this.streams.get(sessionId);
    if (stream === undefined) {
      return Promise.reject(new Error("no shell is connected for this session"));
    }
    const existing = this.pendingAcks.get(sessionId)?.get(meta.updateId);
    if (existing !== undefined) {
      return existing.promise;
    }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: PendingAck = {
      resolve,
      reject,
      promise,
      timer: this.timers.setTimeout(() => {
        this.pendingAcks.get(sessionId)?.delete(meta.updateId);
        reject(new Error("the shell did not acknowledge the line in time"));
      }, this.ackTimeoutMs),
    };
    let perSession = this.pendingAcks.get(sessionId);
    if (perSession === undefined) {
      perSession = new Map();
      this.pendingAcks.set(sessionId, perSession);
    }
    perSession.set(meta.updateId, entry);
    const event: InboundEvent = { updateId: meta.updateId, text: line, threadId: meta.threadId, fromId: meta.fromId, receivedAt: meta.receivedAt };
    if (!stream.write(encodeSseEvent("inbound", event, meta.updateId))) {
      this.timers.clearTimeout(entry.timer);
      perSession.delete(meta.updateId);
      reject(new Error("the shell stream closed before the line was sent"));
    }
    return promise;
  }

  private deliverCallback(sessionId: string, callback: CallbackDelivery): Promise<void> {
    const stream = this.streams.get(sessionId);
    const approval = parseApprovalCallback(callback.data);
    if (approval !== undefined) {
      const entry = this.approvals.get(approval.approvalId);
      // Only an id this server generated, for THIS session, still inside its
      // window. Anything else (a replay, another topic's button, a stale press) is dropped.
      if (entry !== undefined && entry.sessionId === sessionId && entry.expiresAt > this.now()) {
        this.dropApproval(approval.approvalId);
        const event: ApprovalEvent = { updateId: callback.updateId, approvalId: approval.approvalId, decision: approval.decision };
        stream?.write(encodeSseEvent("approval", event, callback.updateId));
        void this.noteDecision(sessionId, approval.decision);
      }
      return Promise.resolve();
    }
    // A button the shell attached itself: handed over best effort, never retried.
    const event: CallbackEvent = {
      updateId: callback.updateId,
      data: callback.data,
      threadId: callback.threadId,
      fromId: callback.fromId,
      ...(callback.messageId === undefined ? {} : { messageId: callback.messageId }),
    };
    stream?.write(encodeSseEvent("callback" satisfies StreamEventName, event, callback.updateId));
    return Promise.resolve();
  }

  private async noteDecision(sessionId: string, decision: ApprovalDecision): Promise<void> {
    await this.hub?.send(sessionId, decision === "allow" ? "Approval granted." : "Approval denied.").catch(() => undefined);
  }

  // ---- bookkeeping ---------------------------------------------------------

  private dropApproval(approvalId: string): void {
    const entry = this.approvals.get(approvalId);
    if (entry === undefined) {
      return;
    }
    this.timers.clearTimeout(entry.timer);
    this.approvals.delete(approvalId);
  }

  private expireApproval(approvalId: string): void {
    const entry = this.approvals.get(approvalId);
    if (entry === undefined) {
      return;
    }
    this.approvals.delete(approvalId);
    void this.hub?.send(entry.sessionId, "Approval request expired: no answer, so it was denied.").catch(() => undefined);
  }

  private onStreamEnded(stream: ShellStream): void {
    if (this.streams.get(stream.sessionId) !== stream) {
      return;
    }
    this.streams.delete(stream.sessionId);
    // Nothing a gone stream was waiting for will ever be answered.
    const pending = this.pendingAcks.get(stream.sessionId);
    if (pending !== undefined) {
      this.pendingAcks.delete(stream.sessionId);
      for (const entry of pending.values()) {
        this.timers.clearTimeout(entry.timer);
        entry.reject(new Error("the shell stream ended before the line was acknowledged"));
      }
    }
    for (const [id, entry] of [...this.approvals.entries()]) {
      if (entry.sessionId === stream.sessionId) {
        this.dropApproval(id);
      }
    }
  }
}
