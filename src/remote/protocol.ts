// The wire contract between a running shell and `keryx serve` (flow 376, block 2).
//
// One module both ends import, so the server surface and the client library cannot
// drift: route paths, body limits, id shapes and the SSE event payloads live here
// and nowhere else. Nothing in this file does I/O.
//
// Auth is NOT in here. These routes are reached with the local shell token, a
// secret separate from the serve bearer; see `shell-token.ts` and the header of
// `lib/serve-server.ts`.

export const REMOTE_API_PREFIX = "/v1/remote";
export const REMOTE_SCHEMA_VERSION = "1.0.0";

export type RemoteRoute =
  | "register"
  | "deregister"
  | "heartbeat"
  | "reply"
  | "approval"
  | "approval-result"
  | "approval-ack"
  | "prompt"
  | "prompt-close"
  | "state"
  | "ack"
  | "stream";

export const REMOTE_ROUTE_METHODS: Readonly<Record<RemoteRoute, "GET" | "POST">> = {
  register: "POST",
  deregister: "POST",
  heartbeat: "POST",
  reply: "POST",
  approval: "POST",
  "approval-result": "POST",
  prompt: "POST",
  "prompt-close": "POST",
  state: "POST",
  ack: "POST",
  "approval-ack": "POST",
  stream: "GET",
};

export function remoteRoutePath(route: RemoteRoute): string {
  return `${REMOTE_API_PREFIX}/${route}`;
}

// ---- channels (flow 377) ---------------------------------------------------------
//
// The shell connects Telegram by asking the local serve, over the same loopback
// shell-token plane. These routes exist on every serve that minted a shell token,
// whether or not remote control is configured yet. The BOT TOKEN is not in any of
// them: the shell writes it to disk itself and serve reads it from there. What does
// travel is not secret (a pairing code, a user id, a group id, a machine name).

export type ChannelsRoute =
  | "channels-status"
  | "channels-pair"
  | "channels-pairing"
  | "channels-cancel"
  | "channels-reload"
  | "channels-test"
  | "channels-disconnect";

export const CHANNELS_ROUTE_METHODS: Readonly<Record<ChannelsRoute, "GET" | "POST">> = {
  "channels-status": "GET",
  "channels-pair": "POST",
  "channels-pairing": "GET",
  "channels-cancel": "POST",
  "channels-reload": "POST",
  "channels-test": "POST",
  "channels-disconnect": "POST",
};

export function channelsRoutePath(route: ChannelsRoute): string {
  return `${REMOTE_API_PREFIX}/${route}`;
}

export type TelegramChannelState =
  /** Nothing is configured on this machine. */
  | "not-connected"
  /** A pairing is waiting for the operator. */
  | "pairing"
  /** The hub is polling. */
  | "connected"
  /** Configured, but the hub is not running (another poller owns the token, a bad config ...). `reason` says why. */
  | "off";

/** The rendering mode in effect and the last fallback (flow 395), as `/channels` shows them. */
export interface ChannelsRendering {
  mode: "auto" | "rich" | "html" | "plain";
  lastFallback?: {
    step: "rich-to-html" | "html-to-plain";
    /** Redacted, never message text. */
    reason: string;
    /** Epoch ms. */
    at: number;
  };
  /** Epoch ms until which rich messages are skipped because the bot or server refused them. */
  richPausedUntil?: number;
}

export interface ChannelsStatusResponse {
  schemaVersion: string;
  /** This machine's name (the hostname), as it appears in the Test message and in topic names. */
  machine: string;
  telegram: {
    state: TelegramChannelState;
    reason?: string;
    /** Registered sessions, i.e. open topics. */
    sessions: number;
    /** Absent when nothing is configured on this machine. */
    rendering?: ChannelsRendering;
  };
}

export type PairingState = "waiting-for-user" | "waiting-for-group" | "ready" | "failed" | "expired" | "cancelled";

export interface PairingResponse {
  schemaVersion: string;
  state: PairingState;
  /** One-time code the operator sends the bot in a private message. Present until the user is paired. */
  code?: string;
  botUsername?: string;
  /** Epoch ms after which the code stops working. */
  expiresAt: number;
  /** Set once a private message carried the code. Not secret. */
  userId?: number;
  /** Set once the bot was added to a group by that user. Not secret. */
  chatId?: number;
  chatTitle?: string;
  /** What is still missing in the group ("topics are off", "the bot may not manage topics"). Empty when ready. */
  problems: string[];
  /** Why the pairing failed, for `failed`. */
  reason?: string;
}

export interface ChannelsReloadResponse {
  schemaVersion: string;
  state: TelegramChannelState;
}

export interface ChannelsTestResponse {
  schemaVersion: string;
  delivered: true;
  machine: string;
}

export interface ChannelsDisconnectResponse {
  schemaVersion: string;
  /** Topics deleted, and topics Telegram would not delete (they stay in the group). */
  deleted: number;
  remaining: number;
  /** False when serve had no running hub, so it could not reach the topics: they stay in the group. */
  hubWasRunning: boolean;
}

/** Every body is small: a line, a reply, a prompt. Bigger is refused before it is parsed. */
export const MAX_REMOTE_BODY_BYTES = 64 * 1024;
export const MAX_PROJECT_CHARS = 256;
export const MAX_APPROVAL_PROMPT_CHARS = 3_000;
export const MAX_KEYBOARD_ROWS = 8;
export const MAX_KEYBOARD_BUTTONS_PER_ROW = 8;
export const MAX_BUTTON_TEXT_CHARS = 64;
/** Telegram's own limit on `callback_data`. */
export const MAX_CALLBACK_DATA_BYTES = 64;

/** How long an approval stays answerable when the shell names no timeout, and the most it may name. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;
export const MAX_APPROVAL_TIMEOUT_MS = 60 * 60_000;
export const MIN_APPROVAL_TIMEOUT_MS = 100;
/**
 * How long serve waits, after it wrote an approval decision to the shell's stream, for the shell
 * to say it received it (flow 397). Without that word the approval is shown as "not confirmed",
 * never as granted: a write that went into a stalled socket proves nothing.
 */
export const DEFAULT_APPROVAL_ACK_MS = 5_000;

/** Server comment line on an otherwise idle stream; keeps proxies and the client's own watchdog honest. */
export const DEFAULT_KEEPALIVE_MS = 15_000;
/** How long the server waits for the shell to acknowledge a delivered line before treating it as undelivered. */
export const DEFAULT_ACK_TIMEOUT_MS = 30_000;

/**
 * A session id is chosen by the shell. Structural, never "starts with": it becomes
 * a registry key and appears in query strings, so it is a short token of a closed
 * alphabet that cannot carry a path, a space, a control character or a delimiter.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** An approval id is generated by the server: "ap" and twelve lowercase hex characters. */
export const APPROVAL_ID_PATTERN = /^ap[0-9a-f]{12}$/;

export function isApprovalId(value: unknown): value is string {
  return typeof value === "string" && APPROVAL_ID_PATTERN.test(value);
}

/** `ap:<id>:allow` / `ap:<id>:deny` / `ap:<id>:always`: 21 bytes at most, inside Telegram's 64. */
const APPROVAL_CALLBACK_PATTERN = /^ap:(ap[0-9a-f]{12}):(allow|deny|always)$/;

export function approvalCallbackData(approvalId: string, decision: ApprovalDecision): string {
  return `ap:${approvalId}:${decision}`;
}

export function parseApprovalCallback(data: string): { approvalId: string; decision: ApprovalDecision } | undefined {
  const match = APPROVAL_CALLBACK_PATTERN.exec(data);
  if (match === null) {
    return undefined;
  }
  return { approvalId: match[1] as string, decision: match[2] as ApprovalDecision };
}

/** Buttons a shell may attach to a reply may not collide with the approval namespace. */
export const RESERVED_CALLBACK_PREFIX = "ap:";

// ---- choice prompts (flow 387) ----------------------------------------------------------
//
// A picker or a Yes/No asked in the topic. Serve owns the buttons: it generates the prompt id,
// puts `pk:<id>:<n>` in each button (n is the button's position, so the label never travels in
// callback_data and 64 bytes is never in question), accepts a press once, from the person it was
// asked of, on the message it was sent as, before it expires, and tells the shell the position.

/** A prompt id is generated by the server: "pk" and twelve lowercase hex characters. */
export const PROMPT_ID_PATTERN = /^pk[0-9a-f]{12}$/;

export function isPromptId(value: unknown): value is string {
  return typeof value === "string" && PROMPT_ID_PATTERN.test(value);
}

/** `pk:<id>:<n>`: 20 bytes at most. */
const CHOICE_CALLBACK_PATTERN = /^pk:(pk[0-9a-f]{12}):(\d{1,3})$/;

export function choiceCallbackData(promptId: string, index: number): string {
  return `pk:${promptId}:${index}`;
}

export function parseChoiceCallback(data: string): { promptId: string; index: number } | undefined {
  const match = CHOICE_CALLBACK_PATTERN.exec(data);
  if (match === null) {
    return undefined;
  }
  return { promptId: match[1] as string, index: Number(match[2]) };
}

// ---- own answers (flow 401) ---------------------------------------------------------------
//
// A prompt asked with `own: true` carries one more button, "✍ Свой ответ", whose callback is
// `pk:<id>:own`. Pressing it (same message, same person, before the prompt expires) makes serve send
// a ForceReply message and remember its message id. Only a reply TO THAT MESSAGE, from the person who
// pressed, before the window closes, is the answer: it is never "the next message in the topic", and
// it never starts a turn. Approvals have no such path.

/** The label of the own-answer button. */
export const OWN_ANSWER_BUTTON_LABEL = "✍ Свой ответ";
/** How long an own answer may take after the button is pressed. At least five minutes, whatever the options' own timeout. */
export const OWN_ANSWER_WINDOW_MS = 5 * 60_000;
/**
 * The text of the ForceReply message. A reply whose replied-to text opens with it is a reply to a reply box,
 * so one this serve no longer knows (a restart, a box resent from the durable queue) is told it is late
 * instead of starting a turn.
 */
export const OWN_REPLY_PROMPT = "Reply to this message with your own answer. It is open for 5 minutes.";
/** The most characters of an own answer a reply may carry through the stream (Telegram's own message limit). */
export const MAX_OWN_ANSWER_CHARS = 4_096;

const OWN_CALLBACK_PATTERN = /^pk:(pk[0-9a-f]{12}):own$/;

/** `pk:<id>:own`: 20 bytes. */
export function ownCallbackData(promptId: string): string {
  return `pk:${promptId}:own`;
}

export function parseOwnCallback(data: string): { promptId: string } | undefined {
  const match = OWN_CALLBACK_PATTERN.exec(data);
  return match === null ? undefined : { promptId: match[1] as string };
}

/** Buttons a shell may attach to a reply may not collide with the picker namespace either. */
export const RESERVED_CHOICE_PREFIX = "pk:";
/** The most buttons one prompt may carry in total. */
export const MAX_PROMPT_BUTTONS = 24;

// ---- work intake cards (flow 403) ---------------------------------------------------------
//
// Intake cards live in the service topic "Intake", not in a session topic. Their buttons carry
// `in:<card id>:<action code>`; the hub hands such a press to the intake handler only when it came
// from an allowlisted user, in this chat, on a message of that topic. What the press does is read
// from the intake registry, never from the data.

/** The service topic the intake cards are written into. */
export const INTAKE_SERVICE_TOPIC = "Intake";
/** Button data of an intake card starts with this; shells may not use it and the hub routes it to intake. */
export const RESERVED_INTAKE_PREFIX = "in:";

/** True when `data` is within Telegram's limit and in the intake namespace. */
export function isIntakeCallbackData(data: unknown): data is string {
  return typeof data === "string" && data.startsWith(RESERVED_INTAKE_PREFIX) && Buffer.byteLength(data, "utf8") <= MAX_CALLBACK_DATA_BYTES;
}

/**
 * `always` (flow 396) is "allow this call and remember the offered pattern". It can only be the
 * answer to an approval that carried a `remember` offer; serve ignores it otherwise.
 */
export type ApprovalDecision = "allow" | "deny" | "always";

/** The longest pattern a `remember` offer may carry. */
export const MAX_REMEMBER_PATTERN_CHARS = 300;

/**
 * How much of a tool's command or input an approval prompt shows (flow 396). A longer call is cut and
 * the prompt says so; and no "Always" is offered for a call whose tail the operator could not see.
 */
export const APPROVAL_INPUT_PREVIEW_CHARS = 1_500;

// ---- request bodies -----------------------------------------------------------

export interface RegisterBody {
  sessionId: string;
  project: string;
  name?: string;
}

export interface SessionBody {
  sessionId: string;
}

export interface ReplyButton {
  text: string;
  data: string;
}

export interface ReplyBody {
  sessionId: string;
  text: string;
  keyboard?: ReplyButton[][];
}

export interface ApprovalBody {
  sessionId: string;
  prompt: string;
  timeoutMs?: number;
  /**
   * The shell pattern the shell is willing to store if the operator presses "Always" (flow 396).
   * Chosen by the shell from its own classification of the command, never from model text.
   */
  remember?: string;
}

/** The shell's report of what became of an "Always" press (flow 396): serve edits the message once. */
export interface ApprovalResultBody {
  sessionId: string;
  approvalId: string;
  remembered: boolean;
}

export interface PromptBody {
  sessionId: string;
  text: string;
  /** Button labels, row by row. Serve builds the callback data; the shell never sees it. */
  rows: string[][];
  timeoutMs?: number;
  /** Only this Telegram user may answer. */
  forUserId?: number;
  /**
   * Flow 401: add the "✍ Свой ответ" button after the rows. Serve builds it (the shell sends no label)
   * and counts it against the button limit. Absent: the prompt is exactly what it was.
   */
  own?: boolean;
}

/** The shell closes a prompt it no longer needs (flow 401): the answer came from the dock, or the turn stopped. */
export interface PromptCloseBody {
  sessionId: string;
  promptId: string;
  /** What the topic message says: "shell" for an answer given in the shell, otherwise "cancelled". */
  by?: "shell" | "cancelled";
}

export interface AckBody {
  sessionId: string;
  updateId: number;
}

/**
 * The shell's word on the decision frame for this approval (flow 397). One per frame, repeats allowed.
 * `applied` says whether the decision reached a live question in the shell. A shell that sends no
 * `applied` (one older than this field) is read as received-only and treated as applied, which is all
 * it ever claimed; a present `applied: false` ends the topic message as "not applied", never "Allowed".
 */
export interface ApprovalAckBody {
  sessionId: string;
  approvalId: string;
  applied?: boolean;
}

/**
 * Where a message from the topic is in the shell (flow 387, AC18). "received" is not in the list:
 * serve sets it itself the moment the update arrives.
 */
export const MESSAGE_STATES = ["reading", "working", "done", "failed"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export function isMessageState(value: unknown): value is MessageState {
  return typeof value === "string" && (MESSAGE_STATES as readonly string[]).includes(value);
}

export interface StateBody {
  sessionId: string;
  updateId: number;
  state: MessageState;
}

// ---- responses ----------------------------------------------------------------

export interface RegisterResponse {
  schemaVersion: string;
  name: string;
  threadId: number;
  reused: boolean;
  /** How long a run started from Telegram may take before the shell interrupts it; 0 means no limit. */
  runTimeoutMs: number;
  /** The mode a Telegram-started turn starts with until `/mode` changes the shell's (flow 396). Absent from an older serve. */
  permissionMode?: "ask" | "trust";
  /** How long an approval prompt waits for a tap before it is denied (flow 396). Absent from an older serve. */
  approvalTimeoutMs?: number;
}

export interface HeartbeatResponse {
  schemaVersion: string;
  name: string;
  threadId: number;
}

export interface ApprovalResponse {
  schemaVersion: string;
  approvalId: string;
  /** Epoch ms after which the server drops a late press instead of delivering it. */
  expiresAt: number;
}

export interface PromptResponse {
  schemaVersion: string;
  promptId: string;
  /** Epoch ms after which the server drops a late press instead of delivering it. */
  expiresAt: number;
}

// ---- the stream ---------------------------------------------------------------
//
// `GET /v1/remote/stream?sessionId=<id>` answers `text/event-stream`. Each frame is
//
//   event: <inbound|approval|choice|callback|status>
//   id: <update id>            (inbound, approval, callback only)
//   data: <one line of JSON>
//
// plus a `: keepalive` comment line every `keepaliveMs`. The `id` is the Telegram
// update id; `Last-Event-ID` on a reconnect means "I have COMPLETED everything up
// to and including this id" (a cumulative acknowledgement), so the server does not
// resend those. A line is acknowledged separately with `POST /v1/remote/ack` after
// the shell has finished handling it.

export interface InboundEvent {
  updateId: number;
  text: string;
  threadId: number;
  fromId: number;
  receivedAt: number;
}

export interface ApprovalEvent {
  updateId: number;
  approvalId: string;
  decision: ApprovalDecision;
  /** The Telegram user who pressed the button (flow 396), for the shell's audit line. */
  fromId?: number;
}

/** A press on a choice prompt: the position of the button, in reading order across the rows. */
export interface ChoiceEvent {
  updateId: number;
  promptId: string;
  /** The pressed button; -1 for an own answer or a close, which carry `own` or `closed` instead. */
  index: number;
  fromId: number;
  /** Flow 401: the person's own answer, from a reply to the armed prompt. Never set for a press. */
  own?: string;
  /** Flow 401: serve ended the prompt without an answer, so the shell stops waiting. */
  closed?: "expired";
}

export interface CallbackEvent {
  updateId: number;
  data: string;
  threadId: number;
  fromId: number;
  messageId?: number;
}

export type StatusKind = "ready" | "superseded" | "closing";

export interface StatusEvent {
  kind: StatusKind;
  name?: string;
  threadId?: number;
}

export type StreamEventName = "inbound" | "approval" | "choice" | "callback" | "status";

export function encodeSseEvent(name: StreamEventName, data: unknown, id?: number): string {
  // `JSON.stringify` never emits a raw newline, so one `data:` line is enough.
  return `event: ${name}\n${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;
}

export const SSE_KEEPALIVE_FRAME = ": keepalive\n\n";

export interface ParsedSseFrame {
  event: string;
  id?: string;
  data: string;
}

/**
 * Incremental SSE parser: feed text chunks, get completed frames. Comment lines
 * (leading ":") and frames with no data are dropped. Tolerates CRLF.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): ParsedSseFrame[] {
    this.buffer += chunk;
    const frames: ParsedSseFrame[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (match === null) {
        break;
      }
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      let event = "message";
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.length === 0 || line.startsWith(":")) {
          continue;
        }
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) {
          value = value.slice(1);
        }
        if (field === "event") {
          event = value;
        } else if (field === "id") {
          id = value;
        } else if (field === "data") {
          data.push(value);
        }
      }
      if (data.length > 0) {
        frames.push({ event, ...(id === undefined ? {} : { id }), data: data.join("\n") });
      }
    }
    return frames;
  }
}
