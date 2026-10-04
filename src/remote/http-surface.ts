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
//   - `Last-Event-ID` on a reconnect acknowledges that ONE id, exactly as an ack
//     would. Nothing here treats an update id as an ordering key: Telegram can
//     restart its numbering, and a "completed up to N" mark would then swallow
//     every new line below N. Completed ids are remembered by exact value (a
//     bounded set per session), and an ack or Last-Event-ID is honoured only for
//     an id this surface actually sent to that session.
//   - The shell dedupes by exact update id as well, so a retry after a lost ack
//     cannot run a line twice.
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
  type ApprovalAckBody,
  type ApprovalBody,
  type ApprovalDecision,
  type ApprovalEvent,
  type ApprovalResultBody,
  MAX_REMEMBER_PATTERN_CHARS,
  MAX_OWN_ANSWER_CHARS,
  OWN_ANSWER_BUTTON_LABEL,
  OWN_ANSWER_WINDOW_MS,
  OWN_REPLY_PROMPT,
  ownCallbackData,
  parseOwnCallback,
  type PromptCloseBody,
  type CallbackEvent,
  type ChoiceEvent,
  choiceCallbackData,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_APPROVAL_ACK_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_KEEPALIVE_MS,
  encodeSseEvent,
  type InboundEvent,
  isApprovalId,
  isMessageState,
  isPromptId,
  isSessionId,
  MAX_APPROVAL_PROMPT_CHARS,
  MAX_APPROVAL_TIMEOUT_MS,
  MAX_BUTTON_TEXT_CHARS,
  MAX_CALLBACK_DATA_BYTES,
  MAX_KEYBOARD_BUTTONS_PER_ROW,
  MAX_KEYBOARD_ROWS,
  MAX_PROJECT_CHARS,
  MAX_PROMPT_BUTTONS,
  MAX_REMOTE_BODY_BYTES,
  MIN_APPROVAL_TIMEOUT_MS,
  parseApprovalCallback,
  parseChoiceCallback,
  approvalCallbackData,
  CHANNELS_ROUTE_METHODS,
  type ChannelsRoute,
  REMOTE_ROUTE_METHODS,
  REMOTE_SCHEMA_VERSION,
  type RegisterBody,
  type RemoteRoute,
  type PromptBody,
  type ReplyBody,
  RESERVED_CALLBACK_PREFIX,
  RESERVED_CHOICE_PREFIX,
  RESERVED_INTAKE_PREFIX,
  type SessionBody,
  SSE_KEEPALIVE_FRAME,
  type StatusEvent,
  type StreamEventName,
} from "./protocol";
import { derivedBearerNonce, SERVE_PROOF_HEADER } from "./shell-token";
import { type InlineKeyboard } from "./types";

const MAX_REPLY_CHARS = 20_000;
const MAX_PENDING_APPROVALS_PER_SESSION = 8;
const MAX_PENDING_CHOICES_PER_SESSION = 8;
/** How many exact update ids a session's `completed` and `sent` books each remember. */
const MAX_REMEMBERED_IDS_PER_SESSION = 512;
const MAX_PROJECT_NAME_CHARS = 128;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

export interface RemoteSurfaceOptions {
  /** Constant-time check of the presented bearer against the local shell token. */
  verifyShellToken: (presented: string) => boolean;
  /**
   * Serve's proof for one answer to an authenticated shell request (F-002): HMAC over
   * the request's nonce, the route, the status and the body. Undefined while no
   * token is minted; then no proof is sent and a current shell refuses the answer.
   */
  proveResponse?: (nonce: string, route: string, status: number, body: string) => string | undefined;
  now?: () => number;
  timers?: HubTimers;
  keepaliveMs?: number;
  ackTimeoutMs?: number;
  /** How long a pressed approval waits for the shell to confirm it received the decision (flow 397). */
  approvalAckMs?: number;
  /** Test seam: the approval id generator. Must produce `ap` and 12 lowercase hex characters. */
  approvalIds?: () => string;
  /** Test seam: the choice prompt id generator. Must produce `pk` and 12 lowercase hex characters. */
  promptIds?: () => string;
}

export function ok(body: Record<string, unknown>, status = 200): Response {
  return new Response(`${JSON.stringify({ schemaVersion: REMOTE_SCHEMA_VERSION, ...body })}\n`, { status, headers: JSON_HEADERS });
}

export function fail(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify({ error: { code, message } })}\n`, { status, headers: { ...JSON_HEADERS, ...headers } });
}

export type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/** Read a bounded JSON object. Refuses on the declared length, the media type, and the bytes actually received. */
export async function readJsonBody(request: Request): Promise<BodyResult> {
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
  /** Why the stream was closed on purpose; undefined for a dropped connection. */
  endedBecause: "superseded" | "closing" | undefined;
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
    this.endedBecause = kind;
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
  /** Set once the prompt is in the topic: what to edit when it is answered or expires. */
  messageId?: number;
  /** The plain text of that message, so the final state keeps what was asked. */
  text?: string;
  /** The pattern an "Always" press would remember (flow 396), as shown in the topic. Absent: no Always button. */
  remember?: string;
}

/**
 * An approval whose decision frame was written to the shell's stream and is waiting for the shell's
 * word that it arrived (flow 397). The message is not finished until then: a write is not receipt.
 */
interface AwaitingApproval {
  sessionId: string;
  decision: ApprovalDecision;
  /** `user <id>`, as it appears in the final text. */
  who: string;
  /** When the decision was sent, as the final text shows it. */
  sentAt: string;
  timer: unknown;
  messageId?: number;
  text?: string;
  /** The pattern an "Always" press would remember (flow 396); absent for allow and deny. */
  remember?: string;
  /** The shell's `approval-result` when it beat the ack here: applied as soon as the ack settles the message. */
  reported?: boolean;
}

/** A picker or a Yes/No waiting for a press (flow 387). */
interface PendingChoice extends PendingApproval {
  /** The label of each button, in reading order across the rows. */
  labels: string[];
  /** Only this Telegram user may answer. */
  forUserId?: number;
  /** Flow 401: the prompt carries the own-answer button. */
  own?: boolean;
  /** Flow 401: the ForceReply message sent for it, once the own button was pressed and the message is in the topic. */
  armedReplyId?: number;
  /** Flow 401: set the moment the own button is accepted, before the ForceReply message has an id. */
  armed?: boolean;
}

/**
 * Flow 401: a ForceReply message that waits for one own answer. Keyed by its Telegram message id, which is
 * what a reply names (`reply_to_message`). It outlives its prompt in state `done`, so a late reply is
 * recognised as late and never taken for an ordinary line.
 */
interface ArmedOwn {
  promptId: string;
  sessionId: string;
  /** The person who pressed the button: the only one whose reply counts. */
  userId: number;
  expiresAt: number;
  state: "live" | "done";
}

const MAX_ARMED_OWN = 128;

/** A prompt that reached its final state: kept so a late press can be put back to it (flow 387, AC21). */
interface FinishedPrompt {
  sessionId: string;
  messageId?: number;
  finalText: string;
  shortReply: string;
  /**
   * Set when the approval was answered with "Always" (flow 396): the shell reports whether the rule was
   * stored (`approval-result`), once, and the message is edited to say which.
   */
  rememberOf?: { original: string | undefined; who: string; when: string; pattern: string } | undefined;
  /**
   * Set when an own answer was written to the shell's stream (flow 401): a write is not receipt, so if the
   * shell then says it was answered in the dock (`prompt-close` by "shell"), the message is corrected.
   */
  ownSent?: { original: string | undefined } | undefined;
}

const MAX_FINISHED_PROMPTS = 128;
/** How many answered approval ids are remembered so a late or repeated ack is recognised and ignored. */
const MAX_DECIDED_APPROVALS = 256;
/** Edits stay under Telegram's limit even after the result line is added. */
const MAX_SETTLED_TEXT_CHARS = 3_600;

/** `12:03:11 UTC`: when something happened, for the final text of an answered prompt. */
export function clockText(at: number): string {
  return `${new Date(at).toISOString().slice(11, 19)} UTC`;
}

/** The final text of a prompt: what was asked, a blank line, then the result. */
export function settledText(original: string | undefined, result: string): string {
  if (original === undefined || original.length === 0) {
    return result;
  }
  const kept = `${original}\n\n${result}`;
  return kept.length <= MAX_SETTLED_TEXT_CHARS ? kept : result;
}

/** Answers the channels routes (flow 377); they work whether or not a hub is running. */
export type ChannelsHandler = (route: ChannelsRoute, request: Request) => Promise<Response>;

function isChannelsRoute(route: string): route is ChannelsRoute {
  return Object.hasOwn(CHANNELS_ROUTE_METHODS, route);
}

export class RemoteHttpSurface {
  readonly consumer: RemoteConsumer;
  private hub: RemoteHub | undefined;
  private channels: ChannelsHandler | undefined;
  private unavailableReason = "remote control is not running in this serve";
  private closed = false;
  private readonly now: () => number;
  private readonly timers: HubTimers;
  private readonly keepaliveMs: number;
  private readonly ackTimeoutMs: number;
  private readonly approvalAckMs: number;
  private readonly newApprovalId: () => string;
  private readonly newPromptId: () => string;
  private readonly streams = new Map<string, ShellStream>();
  /** Per session: the exact update ids the shell finished (bounded). */
  private readonly completed = new Map<string, Set<number>>();
  /** Per session: the exact update ids written to its stream (bounded). Only these can be acknowledged. */
  private readonly sent = new Map<string, Set<number>>();
  /** Per session: which topic it is bound to, so a rebinding forgets the old topic's ids. */
  private readonly bound = new Map<string, string>();
  private readonly pendingAcks = new Map<string, Map<number, PendingAck>>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly awaiting = new Map<string, AwaitingApproval>();
  /** Approval id to its session, once the decision was sent and either confirmed or given up on (bounded). */
  private readonly decided = new Map<string, string>();
  private readonly choices = new Map<string, PendingChoice>();
  private readonly finished = new Map<string, FinishedPrompt>();
  private readonly armedOwn = new Map<number, ArmedOwn>();

  constructor(private readonly options: RemoteSurfaceOptions) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? realTimers;
    this.keepaliveMs = options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.approvalAckMs = options.approvalAckMs ?? DEFAULT_APPROVAL_ACK_MS;
    this.newApprovalId = options.approvalIds ?? (() => `ap${randomBytes(6).toString("hex")}`);
    this.newPromptId = options.promptIds ?? (() => `pk${randomBytes(6).toString("hex")}`);
    this.consumer = {
      deliver: (sessionId, line, meta) => this.deliver(sessionId, line, meta),
      deliverCallback: (sessionId, callback) => this.deliverCallback(sessionId, callback),
    };
  }

  // ---- what lib/serve-server.ts calls --------------------------------------

  verifyShellToken(presented: string): boolean {
    return this.options.verifyShellToken(presented);
  }

  /**
   * Answer one request that `lib/serve-server.ts` already authenticated with the shell
   * token, and sign the answer for the nonce in its bearer, so the shell can tell this
   * serve from whatever else may hold the port. The event stream is signed over its
   * headers only (an empty body): the frames that follow arrive on the same loopback
   * connection the proven headers did.
   */
  async handle(route: RemoteRoute | ChannelsRoute, request: Request, io: { untimed: () => void }): Promise<Response> {
    const response = await this.dispatch(route, request, io);
    const authorization = request.headers.get("authorization") ?? "";
    const nonce = /^Bearer /i.test(authorization) ? derivedBearerNonce(authorization.slice(7).trim()) : undefined;
    if (nonce === undefined || this.options.proveResponse === undefined) {
      return response;
    }
    if (route === "stream") {
      const proof = this.options.proveResponse(nonce, route, response.status, "");
      if (proof !== undefined) {
        response.headers.set(SERVE_PROOF_HEADER, proof);
      }
      return response;
    }
    const body = await response.text();
    const proof = this.options.proveResponse(nonce, route, response.status, body);
    const headers = new Headers(response.headers);
    if (proof !== undefined) {
      headers.set(SERVE_PROOF_HEADER, proof);
    }
    return new Response(body, { status: response.status, headers });
  }

  private async dispatch(route: RemoteRoute | ChannelsRoute, request: Request, io: { untimed: () => void }): Promise<Response> {
    if (isChannelsRoute(route)) {
      if (this.closed || this.channels === undefined) {
        return fail(503, "remote-unavailable", "channels are not available in this serve");
      }
      if (request.method !== CHANNELS_ROUTE_METHODS[route]) {
        return fail(405, "method-not-allowed", "Method not allowed.", { allow: CHANNELS_ROUTE_METHODS[route] });
      }
      return this.channels(route, request);
    }
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
      case "approval-result":
        return this.approvalResult(hub, request);
      case "prompt":
        return this.requestPrompt(hub, request);
      case "prompt-close":
        return this.closePrompt(request);
      case "state":
        return this.messageState(hub, request);
      case "ack":
        return this.ack(hub, request);
      case "approval-ack":
        return this.approvalAck(hub, request);
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
    for (const id of [...this.awaiting.keys()]) {
      this.dropAwaiting(id);
    }
    for (const id of [...this.choices.keys()]) {
      this.dropChoice(id);
    }
  }

  // ---- composition ---------------------------------------------------------

  /** The channels controller: its routes answer even while no hub is running. */
  setChannels(handler: ChannelsHandler): void {
    this.channels = handler;
  }

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
      const binding = `${result.name}#${result.threadId}`;
      if (this.bound.get(checked.sessionId) !== binding) {
        // A different topic: ids that were completed on the old one say nothing about this one.
        this.completed.delete(checked.sessionId);
        this.sent.delete(checked.sessionId);
        this.bound.set(checked.sessionId, binding);
      }
      const limits = hub.limits();
      return ok({
        name: result.name,
        threadId: result.threadId,
        reused: result.reused,
        runTimeoutMs: limits.runTimeoutMs,
        permissionMode: limits.permissionMode,
        approvalTimeoutMs: limits.approvalTimeoutMs,
      });
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
    this.sent.delete(sessionId);
    this.bound.delete(sessionId);
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
        if (data.startsWith(RESERVED_CHOICE_PREFIX)) {
          return { ok: false, message: `button data may not start with "${RESERVED_CHOICE_PREFIX}" (reserved for pickers).` };
        }
        if (data.startsWith(RESERVED_INTAKE_PREFIX)) {
          return { ok: false, message: `button data may not start with "${RESERVED_INTAKE_PREFIX}" (reserved for work intake).` };
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
    let remember: string | undefined;
    if (value.remember !== undefined) {
      if (typeof value.remember !== "string" || value.remember.length === 0 || value.remember.length > MAX_REMEMBER_PATTERN_CHARS || CONTROL_CHARS.test(value.remember)) {
        return invalid(`remember must be a string of 1 to ${MAX_REMEMBER_PATTERN_CHARS} characters without control characters.`);
      }
      remember = redactSensitiveText(value.remember);
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
      ...(remember === undefined ? {} : { remember }),
    });
    // The operator approves what is shown, so the prompt goes out as a code block: nothing in it is read as markup.
    const offer = remember === undefined ? "" : `\nAlways would remember:\n${asCodeBlock(remember)}`;
    const sent = await hub.send(sessionId, `Approval needed:\n${asCodeBlock(redactSensitiveText(value.prompt))}${offer}`, {
      keyboard: [
        [
          { text: "Allow", callback_data: approvalCallbackData(approvalId, "allow") },
          { text: "Deny", callback_data: approvalCallbackData(approvalId, "deny") },
        ],
        ...(remember === undefined ? [] : [[{ text: alwaysButtonText(remember), callback_data: approvalCallbackData(approvalId, "always") }]]),
      ],
      onSent: (info) => this.onApprovalSent(approvalId, sessionId, info.messageId, info.text),
    });
    if (!sent) {
      this.dropApproval(approvalId);
      return fail(404, "unknown-session", "This session is not registered for remote control; register again.");
    }
    return ok({ approvalId, expiresAt });
  }

  /**
   * The shell's report of what became of an "Always" press (flow 396). It counts once, for the session
   * whose approval it was, and only for an approval that was answered with "Always": the message is
   * edited to say whether the rule was remembered. Anything else changes nothing.
   */
  private async approvalResult(hub: RemoteHub, request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return body.response;
    }
    const value = body.value as Partial<ApprovalResultBody> & Record<string, unknown>;
    if (!isSessionId(value.sessionId)) {
      return invalid("sessionId must be 1 to 64 characters of letters, digits, '-' and '_'.");
    }
    if (!isApprovalId(value.approvalId) || typeof value.remembered !== "boolean") {
      return invalid("approvalId must be an approval id and remembered a boolean.");
    }
    const waiting = this.awaiting.get(value.approvalId);
    if (waiting !== undefined && waiting.sessionId === value.sessionId && waiting.remember !== undefined) {
      // The report beat the shell's ack here: keep it, and apply it when the ack settles the message.
      waiting.reported ??= value.remembered;
      return ok({ settled: true });
    }
    const done = this.finished.get(value.approvalId);
    if (done === undefined || done.sessionId !== value.sessionId || done.rememberOf === undefined) {
      return fail(404, "unknown-approval", "No approval of this session is waiting for that report.");
    }
    this.settleRemembered(hub, value.sessionId, done, value.remembered);
    return ok({ settled: true });
  }

  /** Edit a finished "Always" approval to say whether its rule was stored. Counts once. */
  private settleRemembered(hub: RemoteHub, sessionId: string, done: FinishedPrompt, remembered: boolean): void {
    const info = done.rememberOf;
    if (info === undefined) {
      return;
    }
    done.rememberOf = undefined;
    const result = remembered
      ? `Allowed by ${info.who} at ${info.when}. Remembered: ${info.pattern}`
      : `Allowed by ${info.who} at ${info.when}. Not remembered: ${info.pattern} (approved this once).`;
    done.shortReply = remembered ? "Approval granted and remembered." : "Approval granted once; the rule was not remembered.";
    done.finalText = done.messageId === undefined ? result : settledText(info.original, result);
    if (done.messageId !== undefined) {
      void hub.settleMessage(sessionId, done.messageId, done.finalText, done.shortReply).catch(() => undefined);
    }
  }

  /**
   * A picker or a Yes/No (flow 387). The shell sends labels; this builds the buttons so their
   * `callback_data` is `pk:<id>:<n>` (never a label, never near Telegram's 64 bytes, never `ap:`).
   * The prompt is registered before it is sent, so a press cannot beat the record.
   */
  private async requestPrompt(hub: RemoteHub, request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return body.response;
    }
    const value = body.value as Partial<PromptBody> & Record<string, unknown>;
    if (!isSessionId(value.sessionId)) {
      return invalid("sessionId must be 1 to 64 characters of letters, digits, '-' and '_'.");
    }
    if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > MAX_APPROVAL_PROMPT_CHARS) {
      return invalid(`text must be a string of 1 to ${MAX_APPROVAL_PROMPT_CHARS} characters.`);
    }
    const timeoutMs = value.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_APPROVAL_TIMEOUT_MS || timeoutMs > MAX_APPROVAL_TIMEOUT_MS) {
      return invalid(`timeoutMs must be an integer from ${MIN_APPROVAL_TIMEOUT_MS} to ${MAX_APPROVAL_TIMEOUT_MS}.`);
    }
    if (value.forUserId !== undefined && (typeof value.forUserId !== "number" || !Number.isSafeInteger(value.forUserId))) {
      return invalid("forUserId must be an integer.");
    }
    if (value.own !== undefined && typeof value.own !== "boolean") {
      return invalid("own must be a boolean.");
    }
    const own = value.own === true;
    const rows = value.rows;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_KEYBOARD_ROWS) {
      return invalid(`rows must be 1 to ${MAX_KEYBOARD_ROWS} rows of button labels.`);
    }
    const labels: string[] = [];
    const layout: number[] = [];
    for (const row of rows as unknown[]) {
      if (!Array.isArray(row) || row.length === 0 || row.length > MAX_KEYBOARD_BUTTONS_PER_ROW) {
        return invalid(`each row must hold 1 to ${MAX_KEYBOARD_BUTTONS_PER_ROW} labels.`);
      }
      for (const label of row as unknown[]) {
        if (typeof label !== "string" || label.length === 0 || label.length > MAX_BUTTON_TEXT_CHARS) {
          return invalid(`a label must be 1 to ${MAX_BUTTON_TEXT_CHARS} characters.`);
        }
        labels.push(redactSensitiveText(label));
      }
      layout.push((row as unknown[]).length);
    }
    if (labels.length + (own ? 1 : 0) > MAX_PROMPT_BUTTONS) {
      return invalid(`a prompt may carry at most ${MAX_PROMPT_BUTTONS} buttons.`);
    }
    const sessionId = value.sessionId;
    if (!hub.hasSession(sessionId)) {
      return fail(404, "unknown-session", "This session is not registered for remote control; register again.");
    }
    if (this.streams.get(sessionId) === undefined) {
      return fail(409, "no-stream", "No stream is connected for this session; the prompt cannot be answered.");
    }
    let held = 0;
    for (const entry of this.choices.values()) {
      if (entry.sessionId === sessionId) {
        held += 1;
      }
    }
    if (held >= MAX_PENDING_CHOICES_PER_SESSION) {
      return fail(429, "too-many-prompts", "Too many questions are waiting for this session.");
    }

    const promptId = this.newPromptId();
    const expiresAt = this.now() + timeoutMs;
    this.choices.set(promptId, {
      sessionId,
      expiresAt,
      labels,
      ...(value.forUserId === undefined ? {} : { forUserId: value.forUserId }),
      ...(own ? { own: true } : {}),
      timer: this.timers.setTimeout(() => this.expireChoice(promptId), timeoutMs),
    });
    const keyboard: InlineKeyboard = [];
    let position = 0;
    for (const width of layout) {
      const line: InlineKeyboard[number] = [];
      for (let column = 0; column < width; column += 1) {
        line.push({ text: labels[position] as string, callback_data: choiceCallbackData(promptId, position) });
        position += 1;
      }
      keyboard.push(line);
    }
    if (own) {
      keyboard.push([{ text: OWN_ANSWER_BUTTON_LABEL, callback_data: ownCallbackData(promptId) }]);
    }
    const sent = await hub.send(sessionId, redactSensitiveText(value.text), {
      keyboard,
      onSent: (info) => this.onChoiceSent(promptId, sessionId, info.messageId, info.text),
    });
    if (!sent) {
      this.dropChoice(promptId);
      return fail(404, "unknown-session", "This session is not registered for remote control; register again.");
    }
    return ok({ promptId, expiresAt });
  }

  /**
   * Flow 401: the shell no longer needs this prompt (the dock answered first, or the turn stopped).
   * Only the session that asked can close it. The message is put in its final state and a later press or
   * reply finds nothing to answer.
   */
  private async closePrompt(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return body.response;
    }
    const value = body.value as Partial<PromptCloseBody> & Record<string, unknown>;
    if (!isSessionId(value.sessionId)) {
      return invalid("sessionId must be 1 to 64 characters of letters, digits, '-' and '_'.");
    }
    if (typeof value.promptId !== "string" || !isPromptId(value.promptId)) {
      return invalid("promptId must be a prompt id this serve issued.");
    }
    if (value.by !== undefined && value.by !== "shell" && value.by !== "cancelled") {
      return invalid("by must be 'shell' or 'cancelled'.");
    }
    const entry = this.choices.get(value.promptId);
    if (entry === undefined || entry.sessionId !== value.sessionId) {
      const done = this.finished.get(value.promptId);
      if (done?.ownSent !== undefined && done.sessionId === value.sessionId && value.by === "shell") {
        // The own answer was confirmed in the topic, but the dock answered first and the shell dropped it.
        this.finishApproval(value.promptId, done.sessionId, done.messageId, done.ownSent.original, {
          result: `Answered in the shell at ${clockText(this.now())}: your own answer was not used.`,
          shortReply: "The shell answered first, so your own answer was not used.",
        });
        return ok({ closed: true });
      }
      return ok({ closed: false });
    }
    this.dropChoice(value.promptId);
    const when = clockText(this.now());
    const answered = value.by === "shell";
    this.finishApproval(value.promptId, entry.sessionId, entry.messageId, entry.text, {
      result: answered ? `Answered in the shell at ${when}.` : `Cancelled at ${when}: the question is no longer open.`,
      shortReply: answered ? "Answered in the shell." : "That question is no longer open.",
    });
    return ok({ closed: true });
  }

  /** The shell says where one of its messages is; the hub shows it as a reaction and typing (flow 387, AC18). */
  private async messageState(hub: RemoteHub, request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return body.response;
    }
    const value = body.value;
    if (!isSessionId(value.sessionId)) {
      return invalid("sessionId must be 1 to 64 characters of letters, digits, '-' and '_'.");
    }
    if (typeof value.updateId !== "number" || !Number.isSafeInteger(value.updateId) || value.updateId < 0) {
      return invalid("updateId must be a non-negative integer.");
    }
    if (!isMessageState(value.state)) {
      return invalid("state must be one of reading, working, done, failed.");
    }
    if (!hub.hasSession(value.sessionId)) {
      return fail(404, "unknown-session", "This session is not registered for remote control; register again.");
    }
    return ok({ shown: hub.messageState(value.sessionId, value.updateId, value.state) });
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

  /**
   * The shell says it received the decision frame for an approval (flow 397). Only the session the
   * decision went to can confirm it. A late or repeated ack for an approval already finished is
   * accepted and changes nothing; an id this surface never sent, or sent to another session, is refused.
   */
  private async approvalAck(hub: RemoteHub, request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return body.response;
    }
    const value = body.value as Partial<ApprovalAckBody> & Record<string, unknown>;
    if (!isSessionId(value.sessionId)) {
      return invalid("sessionId must be 1 to 64 characters of letters, digits, '-' and '_'.");
    }
    if (!isApprovalId(value.approvalId)) {
      return invalid("approvalId must be 'ap' and 12 lowercase hex characters.");
    }
    if (!hub.hasSession(value.sessionId)) {
      return fail(404, "unknown-session", "This session is not registered for remote control; register again.");
    }
    if (value.applied !== undefined && typeof value.applied !== "boolean") {
      return invalid("applied must be true or false when present.");
    }
    const sessionId = value.sessionId;
    const id = value.approvalId;
    const waiting = this.awaiting.get(id);
    if (waiting !== undefined && waiting.sessionId === sessionId) {
      this.dropAwaiting(id);
      this.rememberDecided(id, sessionId);
      if (value.applied === false) {
        // The shell got the frame but no live question took it: say so, never "Allowed".
        this.finishApproval(id, sessionId, waiting.messageId, waiting.text, {
          result: `Not applied at ${waiting.sentAt}: the shell was no longer waiting for this question, so the ${waiting.decision === "deny" ? "Deny" : "Allow"} from ${waiting.who} changed nothing.`,
          shortReply: "Not applied: the shell was no longer waiting for this question.",
        });
        return ok({ acknowledged: true });
      }
      if (waiting.decision === "always" && waiting.remember !== undefined) {
        // Applied now; whether the rule was stored is the shell's to report (`approval-result`), once.
        this.finishApproval(id, sessionId, waiting.messageId, waiting.text, {
          result: `Allowed by ${waiting.who} at ${waiting.sentAt}. Saving the rule: ${waiting.remember}`,
          shortReply: "Approval granted; saving the rule.",
        });
        const done = this.finished.get(id);
        if (done !== undefined) {
          done.rememberOf = { original: waiting.text, who: waiting.who, when: waiting.sentAt, pattern: waiting.remember };
          if (waiting.reported !== undefined) {
            this.settleRemembered(hub, sessionId, done, waiting.reported);
          }
        }
        return ok({ acknowledged: true });
      }
      // `applied` true, or absent: an older shell, whose ack only ever meant "received".
      this.finishApproval(id, sessionId, waiting.messageId, waiting.text, {
        result: waiting.decision === "allow" ? `Allowed by ${waiting.who} at ${waiting.sentAt}.` : `Denied by ${waiting.who} at ${waiting.sentAt}.`,
        shortReply: waiting.decision === "allow" ? "Approval granted." : "Approval denied.",
      });
      return ok({ acknowledged: true });
    }
    if (this.decided.get(id) === sessionId) {
      return ok({ acknowledged: true });
    }
    return fail(404, "unknown-approval", "No approval with that id was sent to this session.");
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

  private remember(book: Map<string, Set<number>>, sessionId: string, updateId: number): void {
    let ids = book.get(sessionId);
    if (ids === undefined) {
      ids = new Set();
      book.set(sessionId, ids);
    }
    ids.delete(updateId);
    ids.add(updateId);
    while (ids.size > MAX_REMEMBERED_IDS_PER_SESSION) {
      const oldest = ids.values().next().value;
      if (oldest === undefined) {
        break;
      }
      ids.delete(oldest);
    }
  }

  /**
   * The shell finished this exact update. Honoured only for an id this surface
   * sent to the session (or is waiting on): a made-up id settles nothing and
   * poisons nothing. Settles that one pending delivery.
   */
  private complete(sessionId: string, updateId: number): void {
    const pending = this.pendingAcks.get(sessionId);
    const waiting = pending?.get(updateId);
    if (waiting === undefined && this.sent.get(sessionId)?.has(updateId) !== true) {
      return;
    }
    this.remember(this.completed, sessionId, updateId);
    if (pending === undefined || waiting === undefined) {
      return;
    }
    this.timers.clearTimeout(waiting.timer);
    pending.delete(updateId);
    waiting.resolve();
    if (pending.size === 0) {
      this.pendingAcks.delete(sessionId);
    }
  }

  private deliver(sessionId: string, line: string, meta: DeliverMeta): Promise<void> {
    if (meta.replyToMessageId !== undefined && this.armedOwn.has(meta.replyToMessageId)) {
      // A reply to a message this serve armed for an own answer is never an ordinary line: it either
      // answers that prompt or answers nothing, and it starts no turn (flow 401).
      this.replyToArmed(sessionId, line, meta, this.armedOwn.get(meta.replyToMessageId) as ArmedOwn);
      return Promise.resolve();
    }
    if (meta.replyToMessageId !== undefined && meta.replyToText?.startsWith(OWN_REPLY_PROMPT) === true) {
      // A reply to a reply box this serve has no record of (it restarted, or the box was resent from the
      // durable queue): the question is gone, so the reply is told so and is not an ordinary line (flow 401).
      void this.hub?.send(sessionId, "That question is no longer open, so your reply was not used.").catch(() => undefined);
      return Promise.resolve();
    }
    if (this.completed.get(sessionId)?.has(meta.updateId) === true) {
      // The shell already finished this exact update (a redelivery after a lost ack or a restart).
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
    } else {
      this.remember(this.sent, sessionId, meta.updateId);
    }
    return promise;
  }

  private deliverCallback(sessionId: string, callback: CallbackDelivery): Promise<void> {
    const stream = this.streams.get(sessionId);
    const approval = parseApprovalCallback(callback.data);
    if (approval !== undefined) {
      this.pressApproval(sessionId, callback, approval, stream);
      return Promise.resolve();
    }
    const own = parseOwnCallback(callback.data);
    if (own !== undefined) {
      this.pressChoice(sessionId, callback, { promptId: own.promptId, own: true }, stream);
      return Promise.resolve();
    }
    const choice = parseChoiceCallback(callback.data);
    if (choice !== undefined) {
      this.pressChoice(sessionId, callback, choice, stream);
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

  /**
   * A press on an approval button. Only an id this server generated, for THIS session, still
   * inside its window, decides anything. Every press, valid or not, leaves the message it came
   * from in its final state (buttons gone, result shown): a replay or a late press never
   * resurrects the buttons and never sends a second message.
   */
  private pressApproval(
    sessionId: string,
    callback: CallbackDelivery,
    approval: { approvalId: string; decision: ApprovalDecision },
    stream: ShellStream | undefined,
  ): void {
    const id = approval.approvalId;
    const entry = this.approvals.get(id);
    if (entry !== undefined && entry.sessionId !== sessionId) {
      // Another topic's button: not ours to answer or to edit.
      return;
    }
    if (entry !== undefined && entry.expiresAt > this.now()) {
      if (approval.decision === "always" && entry.remember === undefined) {
        // No "Always" was ever offered for this approval: nothing to remember and nothing approved.
        return;
      }
      this.dropApproval(id);
      const event: ApprovalEvent = { updateId: callback.updateId, approvalId: id, decision: approval.decision, fromId: callback.fromId };
      // Say "allowed" only if the shell was actually told: a decision that went nowhere is not one.
      const told = stream?.write(encodeSseEvent("approval", event, callback.updateId)) === true;
      const messageId = entry.messageId ?? callback.messageId;
      const when = clockText(this.now());
      if (!told) {
        this.finishApproval(id, sessionId, messageId, entry.text, {
          result: `Not delivered at ${when}: the shell is not connected, so nothing was approved.`,
          shortReply: "Approval not delivered: the shell is not connected, so nothing was approved.",
        });
        return;
      }
      // Written is not received: the message stays as it is until the shell's ack arrives, or
      // the wait runs out and it is shown as "not confirmed" (flow 397, F-004).
      this.awaiting.set(id, {
        sessionId,
        decision: approval.decision,
        who: `user ${callback.fromId}`,
        sentAt: when,
        ...(messageId === undefined ? {} : { messageId }),
        ...(entry.text === undefined ? {} : { text: entry.text }),
        ...(approval.decision === "always" && entry.remember !== undefined ? { remember: entry.remember } : {}),
        timer: this.timers.setTimeout(() => this.giveUpOnAck(id), this.approvalAckMs),
      });
      return;
    }
    if (entry !== undefined) {
      // The window closed and the timer has not run yet: it is expired now.
      this.expireApproval(id);
      return;
    }
    if (this.awaiting.has(id)) {
      // Decided, waiting for the shell's ack: a second press is not a second answer, and the
      // message it came from still carries the question until the ack or the timeout settles it.
      return;
    }
    const done = this.finished.get(id);
    if (done !== undefined) {
      if (done.sessionId === sessionId) {
        // Answered or expired already: put the pressed message back to that final state (a no-op when it is).
        const messageId = callback.messageId ?? done.messageId;
        if (messageId !== undefined) {
          void this.hub?.settleMessage(sessionId, messageId, done.finalText, done.shortReply).catch(() => undefined);
        }
      }
      return;
    }
    // An id this server never issued or no longer remembers (a restart): the message is stale.
    // Never touch a message that carries a live approval.
    const pressed = callback.messageId;
    if (pressed !== undefined && !this.carriesLivePrompt(pressed)) {
      void this.hub
        ?.settleMessage(sessionId, pressed, "This request is no longer active.", "That request is no longer active.")
        .catch(() => undefined);
    }
  }

  private carriesLivePrompt(messageId: number): boolean {
    return [...this.approvals.values(), ...this.awaiting.values(), ...this.choices.values()].some((live) => live.messageId === messageId);
  }

  /**
   * A press on a picker or Yes/No button. It counts once, from the person it was asked of, in the
   * topic and on the message it was sent as, before it expires. Anything else changes nothing: a
   * press for another session, message or user leaves the prompt as it was, and a late or repeated
   * press puts the message back to its final state.
   */
  private pressChoice(
    sessionId: string,
    callback: CallbackDelivery,
    choice: { promptId: string; index: number } | { promptId: string; own: true },
    stream: ShellStream | undefined,
  ): void {
    const id = choice.promptId;
    const entry = this.choices.get(id);
    if (entry !== undefined && entry.sessionId !== sessionId) {
      return;
    }
    if (entry !== undefined && entry.expiresAt > this.now()) {
      const sameMessage = entry.messageId !== undefined && callback.messageId === entry.messageId;
      const sameUser = entry.forUserId === undefined || entry.forUserId === callback.fromId;
      if ("own" in choice) {
        if (sameMessage && sameUser && entry.own === true) {
          this.armOwn(id, entry, callback);
        }
        return;
      }
      if (!sameMessage || !sameUser || choice.index >= entry.labels.length) {
        return;
      }
      this.dropChoice(id);
      const event: ChoiceEvent = { updateId: callback.updateId, promptId: id, index: choice.index, fromId: callback.fromId };
      const told = stream?.write(encodeSseEvent("choice", event, callback.updateId)) === true;
      const when = clockText(this.now());
      if (!told) {
        this.finishApproval(id, sessionId, entry.messageId, entry.text, {
          result: `Not delivered at ${when}: the shell is not connected, so nothing changed.`,
          shortReply: "Not delivered: the shell is not connected, so nothing changed.",
        });
        return;
      }
      this.finishApproval(id, sessionId, entry.messageId, entry.text, {
        result: `Chosen: ${entry.labels[choice.index]} (user ${callback.fromId}, ${when}).`,
        shortReply: `Chosen: ${entry.labels[choice.index]}.`,
      });
      return;
    }
    if (entry !== undefined) {
      this.expireChoice(id);
      return;
    }
    const done = this.finished.get(id);
    if (done !== undefined) {
      if (done.sessionId === sessionId) {
        const messageId = callback.messageId ?? done.messageId;
        if (messageId !== undefined) {
          void this.hub?.settleMessage(sessionId, messageId, done.finalText, done.shortReply).catch(() => undefined);
        }
      }
      return;
    }
    const pressed = callback.messageId;
    if (pressed !== undefined && !this.carriesLivePrompt(pressed)) {
      void this.hub
        ?.settleMessage(sessionId, pressed, "This request is no longer active.", "That request is no longer active.")
        .catch(() => undefined);
    }
  }

  /**
   * The own button was accepted: send the ForceReply message and remember its id. The prompt (and its
   * buttons) stay live, so the person may still pick an option instead; whichever comes first wins. The
   * prompt's life is extended to at least the own-answer window from now, so a slow typist is not cut
   * off by an option timeout that was sized for a tap.
   */
  private armOwn(promptId: string, entry: PendingChoice, callback: CallbackDelivery): void {
    const hub = this.hub;
    if (entry.armed === true || hub === undefined) {
      return;
    }
    entry.armed = true;
    const now = this.now();
    const expiresAt = Math.max(entry.expiresAt, now + OWN_ANSWER_WINDOW_MS);
    entry.expiresAt = expiresAt;
    this.timers.clearTimeout(entry.timer);
    entry.timer = this.timers.setTimeout(() => this.expireChoice(promptId), expiresAt - now);
    const sessionId = entry.sessionId;
    const userId = callback.fromId;
    void hub
      .send(sessionId, OWN_REPLY_PROMPT, {
        forceReply: { placeholder: "Your own answer" },
        onSent: (info) => this.onArmedSent(promptId, sessionId, userId, expiresAt, info.messageId),
      })
      .then((queued) => {
        // Not queued (the session is unknown to the hub): nothing was sent, so the button must work again.
        if (!queued) entry.armed = false;
      })
      .catch(() => {
        // The ForceReply message could not be queued: let the person press the button again.
        entry.armed = false;
      });
  }

  private onArmedSent(promptId: string, sessionId: string, userId: number, expiresAt: number, replyMessageId: number): void {
    const live = this.choices.get(promptId);
    this.armedOwn.set(replyMessageId, { promptId, sessionId, userId, expiresAt, state: live === undefined ? "done" : "live" });
    if (live !== undefined) {
      live.armedReplyId = replyMessageId;
    }
    while (this.armedOwn.size > MAX_ARMED_OWN) {
      const oldest = this.armedOwn.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.armedOwn.delete(oldest);
    }
  }

  /**
   * A reply to an armed own-answer message. It answers the prompt only when it comes from the person who
   * pressed the button, inside the window, while the prompt is still open. A reply from anyone else, or to
   * a prompt that belongs to another session, answers nothing and is not a line. A late reply answers
   * nothing and is told so (every late reply, from whoever sent it).
   */
  private replyToArmed(sessionId: string, line: string, meta: DeliverMeta, armed: ArmedOwn): void {
    if (armed.sessionId !== sessionId) {
      return;
    }
    const entry = this.choices.get(armed.promptId);
    const live = armed.state === "live" && entry !== undefined && armed.expiresAt > this.now();
    if (!live) {
      void this.hub?.send(sessionId, "That question is no longer open, so your reply was not used.").catch(() => undefined);
      return;
    }
    if (meta.fromId !== armed.userId) {
      return;
    }
    const text = line.trim();
    if (text.length === 0) {
      return;
    }
    const stream = this.streams.get(sessionId);
    this.dropChoice(armed.promptId);
    const event: ChoiceEvent = { updateId: meta.updateId, promptId: armed.promptId, index: -1, fromId: meta.fromId, own: text.slice(0, MAX_OWN_ANSWER_CHARS) };
    const told = stream?.write(encodeSseEvent("choice", event, meta.updateId)) === true;
    const when = clockText(this.now());
    this.finishApproval(
      armed.promptId,
      sessionId,
      entry.messageId,
      entry.text,
      {
        result: told
          ? `Own answer (user ${meta.fromId}, ${when}).`
          : `Not delivered at ${when}: the shell is not connected, so nothing changed.`,
        shortReply: told ? "Your own answer was sent." : "Not delivered: the shell is not connected, so nothing changed.",
      },
      told,
    );
  }

  private onChoiceSent(promptId: string, sessionId: string, messageId: number, text: string): void {
    const live = this.choices.get(promptId);
    if (live !== undefined) {
      live.messageId = messageId;
      live.text = text;
      return;
    }
    this.onApprovalSent(promptId, sessionId, messageId, text);
  }

  private dropChoice(promptId: string): void {
    const entry = this.choices.get(promptId);
    if (entry === undefined) {
      return;
    }
    this.timers.clearTimeout(entry.timer);
    this.choices.delete(promptId);
    if (entry.armedReplyId !== undefined) {
      const armed = this.armedOwn.get(entry.armedReplyId);
      if (armed !== undefined) {
        armed.state = "done";
      }
    }
  }

  private expireChoice(promptId: string): void {
    const entry = this.choices.get(promptId);
    if (entry === undefined) {
      return;
    }
    this.dropChoice(promptId);
    if (entry.own === true) {
      // The shell waits past the options' timeout for an own answer; this is how it learns there is none.
      const closed: ChoiceEvent = { updateId: 0, promptId, index: -1, fromId: 0, closed: "expired" };
      this.streams.get(entry.sessionId)?.write(encodeSseEvent("choice", closed));
    }
    this.finishApproval(promptId, entry.sessionId, entry.messageId, entry.text, {
      result: `Expired at ${clockText(this.now())}: no answer, nothing changed.`,
      shortReply: "That question expired: no answer, nothing changed.",
    });
  }

  private onApprovalSent(approvalId: string, sessionId: string, messageId: number, text: string): void {
    const live = this.approvals.get(approvalId) ?? this.awaiting.get(approvalId);
    if (live !== undefined) {
      live.messageId = messageId;
      live.text = text;
      return;
    }
    // Answered or expired before the message was in the topic: finish it now.
    const done = this.finished.get(approvalId);
    if (done !== undefined && done.messageId === undefined) {
      done.messageId = messageId;
      done.finalText = settledText(text, done.finalText);
      void this.hub?.settleMessage(sessionId, messageId, done.finalText, done.shortReply).catch(() => undefined);
    }
  }

  /** Record the final state of an approval and put it on the message (or say it once when there is no message). */
  private finishApproval(
    approvalId: string,
    sessionId: string,
    messageId: number | undefined,
    original: string | undefined,
    outcome: { result: string; shortReply: string },
    ownSent = false,
  ): void {
    const finalText = messageId === undefined ? outcome.result : settledText(original, outcome.result);
    this.finished.delete(approvalId);
    this.finished.set(approvalId, {
      sessionId,
      ...(messageId === undefined ? {} : { messageId }),
      finalText,
      shortReply: outcome.shortReply,
      ...(ownSent ? { ownSent: { original } } : {}),
    });
    while (this.finished.size > MAX_FINISHED_PROMPTS) {
      const oldest = this.finished.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.finished.delete(oldest);
    }
    const hub = this.hub;
    if (hub === undefined) {
      return;
    }
    if (messageId === undefined) {
      // The prompt is still in the outbound queue (or was never delivered): say the result once; onSent edits it if it lands later.
      void hub.send(sessionId, outcome.shortReply).catch(() => undefined);
      return;
    }
    void hub.settleMessage(sessionId, messageId, finalText, outcome.shortReply).catch(() => undefined);
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

  private dropAwaiting(approvalId: string): void {
    const entry = this.awaiting.get(approvalId);
    if (entry === undefined) {
      return;
    }
    this.timers.clearTimeout(entry.timer);
    this.awaiting.delete(approvalId);
  }

  private rememberDecided(approvalId: string, sessionId: string): void {
    this.decided.delete(approvalId);
    this.decided.set(approvalId, sessionId);
    while (this.decided.size > MAX_DECIDED_APPROVALS) {
      const oldest = this.decided.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.decided.delete(oldest);
    }
  }

  /** No ack inside the window: say what is known (sent, not confirmed), never "granted". A later ack changes nothing. */
  private giveUpOnAck(approvalId: string): void {
    const entry = this.awaiting.get(approvalId);
    if (entry === undefined) {
      return;
    }
    this.dropAwaiting(approvalId);
    this.rememberDecided(approvalId, entry.sessionId);
    this.finishApproval(approvalId, entry.sessionId, entry.messageId, entry.text, {
      result: `Sent to the shell at ${entry.sentAt}, not confirmed; the shell denies by itself if it did not receive it.`,
      shortReply: "Sent to the shell, not confirmed; it denies by itself if it did not receive it.",
    });
  }

  private expireApproval(approvalId: string): void {
    const entry = this.approvals.get(approvalId);
    if (entry === undefined) {
      return;
    }
    this.timers.clearTimeout(entry.timer);
    this.approvals.delete(approvalId);
    this.finishApproval(approvalId, entry.sessionId, entry.messageId, entry.text, {
      result: `Expired at ${clockText(this.now())}: no answer, so it was denied.`,
      shortReply: "Approval request expired: no answer, so it was denied.",
    });
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
        if (!this.closed && entry.messageId !== undefined) {
          // The shell is gone, so the question is dead: take its buttons away.
          this.finishApproval(id, stream.sessionId, entry.messageId, entry.text, {
            result: `Cancelled at ${clockText(this.now())}: the shell disconnected, so it was denied.`,
            shortReply: "Approval cancelled: the shell disconnected, so it was denied.",
          });
        }
      }
    }
    for (const [id, entry] of [...this.awaiting.entries()]) {
      if (entry.sessionId === stream.sessionId && !this.closed) {
        // The stream is gone, so the ack cannot come on it: settle now as not confirmed.
        this.giveUpOnAck(id);
      }
    }
    for (const [id, entry] of [...this.choices.entries()]) {
      if (entry.sessionId === stream.sessionId) {
        this.dropChoice(id);
        if (!this.closed && entry.messageId !== undefined) {
          this.finishApproval(id, stream.sessionId, entry.messageId, entry.text, {
            result: `Cancelled at ${clockText(this.now())}: the shell disconnected, nothing changed.`,
            shortReply: "Question cancelled: the shell disconnected, nothing changed.",
          });
        }
      }
    }
    // Typing stops and a message the shell was working on is marked failed only when the shell really
    // left (it said it is closing). A dropped connection or a newer stream for the same session is
    // not an exit: the shell reconnects and goes on, and the hub's own sweep ends the activity if
    // it never does.
    if (stream.endedBecause === "closing") {
      this.hub?.endActivity(stream.sessionId);
    }
  }
}

/** The button for an "Always" offer: the pattern, cut to Telegram's button length. */
export function alwaysButtonText(pattern: string): string {
  const text = `Always: ${pattern.replace(/\s+/g, " ")}`;
  return text.length <= MAX_BUTTON_TEXT_CHARS ? text : `${text.slice(0, MAX_BUTTON_TEXT_CHARS - 1)}…`;
}

/** The longest backtick run left in a code block: the fence is one longer, and stays under the renderer's fence limit. */
const MAX_BACKTICK_RUN = 8;

/**
 * `text` in a fenced block that renders as one literal `<pre>` whatever `text` holds.
 * The fence is one backtick longer than any run inside, so no line can close it; a
 * run too long for a fence the renderer accepts is cut with zero-width spaces first.
 */
export function asCodeBlock(text: string): string {
  // An empty block would not render as a pre, so a blank prompt shows a placeholder.
  const safe = (text.trim().length === 0 ? "(empty)" : text).replace(/\r\n?/g, "\n").replace(/`{9,}/g, (run) => (run.match(/`{1,8}/g) as string[]).join("​"));
  const longest = Math.max(0, ...(safe.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, Math.min(longest, MAX_BACKTICK_RUN) + 1));
  return `${fence}\n${safe}\n${fence}`;
}
