// The shell's side of remote control (flow 376, block 3): everything between a
// `RemoteClient` and a shell session that does not need a renderer.
//
// The TUI (and any other host) gives it a handful of callbacks and calls five
// hooks. It owns:
//
//   - the lifecycle: OFF by default, turned on only by `enable()` (the explicit
//     `/remote-control` command), turned off by `disable()` or when the shell
//     closes (`disable()` deregisters, which deletes the topic);
//   - a line from Telegram: idle, it runs as a typed line; busy, it goes through
//     the host's ordinary user queue. It does not invent a queue of its own;
//   - the reply: the final assistant text of a Telegram-originated turn,
//     redacted and capped, sent back to the topic. Tool calls, tool results and
//     reasoning never pass through here;
//   - approvals raised while such a turn runs: asked in the topic, and anything
//     but an explicit allow is a deny (a timeout, a dropped stream, no client);
//   - the run time limit serve told it about at registration;
//   - a small ring of recent events and the heartbeat age, for the UI.
//
// Nothing here prints the shell token or reads it: that stays in `client.ts`.

import { redactSensitiveText } from "../security/service";
import { type ClientStatus, type InboundMeta, RemoteClient, type RemoteClientOptions, type StartResult } from "./client";
import { DEFAULT_ROUTER_LIMITS, type RemoteCommandHost, RemoteCommandRouter } from "./command-router";
import type { NormalizedMessage } from "../harness/provider/types";
import { APPROVAL_INPUT_PREVIEW_CHARS, DEFAULT_APPROVAL_TIMEOUT_MS, MAX_APPROVAL_PROMPT_CHARS, type MessageState } from "./protocol";
import { HISTORY_DEFAULT_COUNT, HISTORY_EMPTY_MESSAGE, formatHistoryItem, parseHistoryArgs, selectHistory } from "./history";

/** The label a Telegram line carries in the queue and the transcript. */
export const TG_SOURCE = "tg" as const;
export type RemoteLineSource = typeof TG_SOURCE;

/** How many recent events the status display keeps. */
export const REMOTE_EVENT_LIMIT = 20;
/** A reply longer than this is cut, with a note, before it is sent (the outbound queue splits what is left into parts of 4096). */
export const REMOTE_REPLY_MAX_CHARS = 16_000;
const EVENT_PREVIEW_CHARS = 80;

export type RemoteState = "off" | "on" | "offline";
export type RemoteEventKind = "line" | "reply" | "approval" | "status" | "error" | "command";

export interface RemoteEvent {
  at: number;
  kind: RemoteEventKind;
  text: string;
}

/** The last time the session's history was posted to the topic (flow 399). */
export interface RemoteHistoryStatus {
  at: number;
  /** How many messages that post carried. */
  count: number;
  /** Posted by the automatic restore of a resumed session, not by `/history`. */
  auto: boolean;
}

export type HistoryOutcome =
  | { ok: true; posted: number }
  | { ok: false; reason: "off" | "empty" | "running" | "failed" | "unavailable"; posted: number; message: string };

export interface RemoteStatus {
  state: RemoteState;
  /** The topic name, once registered. */
  name?: string;
  /** The last history post, once there was one. */
  history?: RemoteHistoryStatus;
  /** Milliseconds since serve last answered; absent when off or never answered. */
  heartbeatAgeMs?: number;
  /**
   * Approval decisions that arrived from Telegram whose ack serve has not confirmed (flow 397).
   * Absent while zero; the Telegram message for those reads "not confirmed" until it is.
   */
  unconfirmedApprovals?: number;
  /** Newest last, at most {@link REMOTE_EVENT_LIMIT}. */
  events: readonly RemoteEvent[];
}

/** The part of {@link RemoteClient} the bridge uses; tests pass a fake. */
export type RemoteClientLike = Pick<
  RemoteClient,
  "start" | "close" | "reply" | "requestApproval" | "requestChoice" | "connected" | "name" | "runTimeoutMs" | "lastHeartbeatAt"
> &
  Partial<Pick<RemoteClient, "reportState" | "unconfirmedApprovals" | "askApproval" | "reportApprovalResult" | "permissionMode" | "approvalTimeoutMs">>;

/** What the topic answered to one approval (flow 396). */
export interface RemoteApprovalAnswer {
  decision: "allow" | "deny";
  /** "Always" was pressed: the shell saves the rule it offered, then calls {@link RemoteBridge.reportRemembered}. */
  always: boolean;
  approvalId?: string;
  /** The Telegram user who pressed; absent when nobody did (timeout, no stream). */
  fromId?: number;
}

export interface RemoteBridgeHost extends Partial<Omit<RemoteCommandHost, "isBusy" | "cancelTurn" | "stopTelegramTurn">> {
  sessionId(): string;
  project(): string;
  /** A turn is running, or something the user typed is waiting to run. */
  isBusy(): boolean;
  /** Idle path: run `text` like a typed line, labelled `tg`. */
  runLine(text: string): void;
  /** Busy path: queue `text` through the same queue a typed line takes, labelled `tg`. */
  enqueue(text: string): void;
  /** One line in the transcript. */
  notice(text: string): void;
  /** Stop the running turn (the run time limit). */
  cancelTurn(): void;
  /** Session history (AC4): remote control went on for this session / went off. */
  recordOn(name: string): void;
  recordOff(): void;
  /**
   * Remote control is going off: remove the Telegram-labelled lines still waiting in
   * the shell's queue (they have no topic to answer in) and return their text.
   */
  dropQueuedTelegramLines?(): string[];
  /** Something the display shows changed. */
  onChange?(): void;
  /**
   * The session's messages, oldest first, the whole conversation when the host keeps it (flow 399).
   * Absent: `/history` answers that this shell cannot post it.
   */
  history?(): readonly NormalizedMessage[];
  /**
   * An assistant turn is being written right now, so the last assistant message in `history()`
   * is unfinished. Absent: `isBusy()` stands in, which only errs towards leaving the newest
   * answer out.
   */
  turnRunning?(): boolean;
  /** The live session was resumed (`-r`, `-c`, `/resume`), not started fresh. The automatic restore needs it. */
  sessionResumed?(): boolean;
}

export interface RemoteBridgeOptions {
  host: RemoteBridgeHost;
  /** Test seam. Default: a real `RemoteClient`. */
  makeClient?: (options: RemoteClientOptions) => RemoteClientLike;
  /** User-global directory override, forwarded to the client (test seam). */
  dir?: string | undefined;
  now?: () => number;
  approvalTimeoutMs?: number;
  /** A command still running after this long says so in the topic (flow 387). */
  commandRunningNoticeMs?: number;
  /** A command still running after this long is stopped and reported. */
  commandLimitMs?: number;
  /** How long a picker or a Yes/No waits for a press. */
  choiceTimeoutMs?: number;
  /** Pause between two restored messages, so the topic is not flooded (flow 399). */
  historyPaceMs?: number;
  /** Test seam for the pause. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** The policy values `/remote-policy` can change in a running shell. */
export interface RemotePolicyOverride {
  permissionMode?: "ask" | "trust";
  approvalTimeoutMs?: number;
  runTimeoutMs?: number;
}

/** Between two restored messages: well inside Telegram's per-group rate, and a 429 still pauses the queue. */
export const HISTORY_PACE_MS = 2_000;

export type EnableResult = StartResult | { ok: false; code: "already-on"; message: string; retrying: false };

function preview(text: string): string {
  const one = redactSensitiveText(text).replace(/\s+/g, " ").trim();
  return one.length > EVENT_PREVIEW_CHARS ? `${one.slice(0, EVENT_PREVIEW_CHARS - 1)}…` : one;
}

/** What goes to the topic: redacted, trimmed and capped. Exported for the tests. */
export function composeReply(text: string): string {
  const safe = redactSensitiveText(text).trim();
  if (safe.length <= REMOTE_REPLY_MAX_CHARS) return safe;
  return `${safe.slice(0, REMOTE_REPLY_MAX_CHARS)}\n[cut: the full reply is in the shell]`;
}

/**
 * What the shell takes from the client's answer. Fail closed: only an explicit `allow` or `always` is a
 * yes; a missing, unknown or malformed decision is a deny, and `always` counts as one only when an
 * "Always" was offered. Exported for the tests.
 */
export function mapApprovalAnswer(got: unknown, offered: boolean): RemoteApprovalAnswer {
  if (got === null || typeof got !== "object") return { decision: "deny", always: false };
  const o = got as { decision?: unknown; approvalId?: unknown; fromId?: unknown };
  const yes = o.decision === "allow" || o.decision === "always";
  const approvalId = typeof o.approvalId === "string" && o.approvalId.length > 0 ? o.approvalId : undefined;
  const fromId = typeof o.fromId === "number" && Number.isSafeInteger(o.fromId) ? o.fromId : undefined;
  return {
    decision: yes ? "allow" : "deny",
    always: o.decision === "always" && offered,
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(fromId === undefined ? {} : { fromId }),
  };
}

/** The approval prompt: redacted and within the server's limit. Exported for the tests. */
export function composeApprovalPrompt(prompt: string): string {
  const safe = redactSensitiveText(prompt).trim();
  if (safe.length <= MAX_APPROVAL_PROMPT_CHARS) return safe;
  const note = "\n[cut: the rest of this prompt is in the shell]";
  return `${safe.slice(0, MAX_APPROVAL_PROMPT_CHARS - note.length - 1)}…${note}`;
}

/**
 * What the topic is asked: the tool, the command or input a human would read, and the
 * flags that make a call risky. Never the tool's full payload; redaction and the
 * server's size limit are applied again when it is sent.
 */
export function describeApprovalForTopic(
  tool: string,
  inputJson: string,
  meta?: { destructive?: boolean; credentials?: boolean; untrustedOrigin?: boolean; card?: readonly string[] },
): string {
  const lines: string[] = [];
  if (meta?.card !== undefined && meta.card.length > 0) {
    lines.push(...meta.card);
  } else {
    let shown = inputJson;
    try {
      const parsed: unknown = JSON.parse(inputJson);
      if (parsed !== null && typeof parsed === "object") {
        const o = parsed as { command?: unknown; patch?: unknown; task?: unknown };
        if (typeof o.command === "string") shown = o.command;
        else if (typeof o.task === "string") shown = o.task;
        else if (typeof o.patch === "string") shown = o.patch;
      }
    } catch {
      // not JSON: show it as it is
    }
    const total = shown.length;
    shown = total > APPROVAL_INPUT_PREVIEW_CHARS ? `${shown.slice(0, APPROVAL_INPUT_PREVIEW_CHARS)}…` : shown;
    lines.push(`Approve ${tool}?`, shown);
    // Said out loud: a cut tail is not shown, and the operator must know the prompt is not the whole call.
    if (total > APPROVAL_INPUT_PREVIEW_CHARS) {
      lines.push(`[cut: only the first ${APPROVAL_INPUT_PREVIEW_CHARS} of ${total} characters are shown; the rest is in the shell]`);
    }
  }
  if (meta?.destructive === true) lines.push("Warning: this can delete or overwrite files.");
  if (meta?.credentials === true) lines.push("Warning: this touches the agent's own permission or credential files.");
  if (meta?.untrustedOrigin === true) lines.push("Warning: this follows content fetched from outside.");
  return lines.join("\n");
}

export class RemoteBridge {
  private client: RemoteClientLike | undefined;
  private readonly events: RemoteEvent[] = [];
  private readonly host: RemoteBridgeHost;
  private readonly now: () => number;
  private readonly approvalOverrideMs: number | undefined;
  /** What `/remote-policy` changed in this shell since it registered; wins over what serve delivered (flow 396). */
  private policyOverride: RemotePolicyOverride = {};
  private connectedOnce = false;
  private clientConnected = false;
  private tgTurn = false;
  private lastAssistantText = "";
  private runTimer: ReturnType<typeof setTimeout> | undefined;
  private timedOut = false;
  /** `/stop` ended the running Telegram turn (flow 396). */
  private stoppedByUser = false;
  /** Aborts a pending approval wait when the turn is stopped or runs out of time. */
  private turnAbort: AbortController | undefined;
  /** The close of the client being turned off, while it runs. */
  private closing: Promise<void> | undefined;
  private readonly router: RemoteCommandRouter;
  /** A remote `/new`, `/clear` or `/resume` is running: the topic follows the session instead of closing. */
  private keepTopic = false;
  private switched = false;
  /** Plain lines taken from the topic whose turn has not started yet, oldest first (flow 387, AC18). */
  private readonly waiting: Array<{ updateId: number; line: string; fromId?: number }> = [];
  /** The Telegram message the running turn belongs to. */
  private currentUpdate: number | undefined;
  /** The Telegram user whose line started the running turn (flow 396): who an auto-approval is recorded against. */
  private currentFromId: number | undefined;
  /** The last history post to this topic; cleared with the topic. */
  private lastHistory: RemoteHistoryStatus | undefined;
  /**
   * The client a history post is running for (the pacing makes it take a while). A second post to
   * the SAME client is refused; one to a newer client (off, then on again within the pause) is
   * not, because the older run stops at its next step and never sends to the newer topic.
   */
  private postingClient: RemoteClientLike | undefined;
  /** Remote control has been turned on once in this process; only that first time can restore on its own. */
  private enabledOnce = false;

  constructor(private readonly options: RemoteBridgeOptions) {
    this.host = options.host;
    this.now = options.now ?? Date.now;
    this.approvalOverrideMs = options.approvalTimeoutMs;
    this.router = new RemoteCommandRouter({
      host: {
        isBusy: () => this.host.isBusy(),
        cancelTurn: () => this.host.cancelTurn(),
        stopTelegramTurn: () => this.stopTelegramTurn(),
        ...(this.host.runCommand !== undefined ? { runCommand: (line: string) => this.host.runCommand!(line) } : {}),
        ...(this.host.busyRefusal !== undefined ? { busyRefusal: (line: string) => this.host.busyRefusal!(line) } : {}),
        ...(this.host.listModels !== undefined ? { listModels: (id?: string) => this.host.listModels!(id) } : {}),
        ...(this.host.listProviders !== undefined ? { listProviders: () => this.host.listProviders!() } : {}),
        ...(this.host.switchModel !== undefined ? { switchModel: (model: string, provider?: string) => this.host.switchModel!(model, provider) } : {}),
        ...(this.host.listSessions !== undefined ? { listSessions: () => this.host.listSessions!() } : {}),
        ...(this.host.resumeSession !== undefined ? { resumeSession: (id: string) => this.host.resumeSession!(id) } : {}),
      },
      reply: async (text) => (this.client !== undefined ? await this.client.reply(text) : false),
      history: async (args) => await this.historyForCommand(args),
      record: (text) => this.push("command", text),
      compose: composeReply,
      choose: async (text, rows, timeoutMs, forUserId) => {
        const client = this.client;
        if (client === undefined || !client.connected) {
          return undefined;
        }
        try {
          return await client.requestChoice(text, rows, timeoutMs, forUserId);
        } catch {
          return undefined;
        }
      },
      holdTopic: (on) => {
        this.keepTopic = on;
        if (on) {
          this.switched = false;
        }
      },
      takeSwitched: () => {
        const was = this.switched;
        this.switched = false;
        return was;
      },
      limits: {
        runningNoticeMs: options.commandRunningNoticeMs ?? DEFAULT_ROUTER_LIMITS.runningNoticeMs,
        commandLimitMs: options.commandLimitMs ?? DEFAULT_ROUTER_LIMITS.commandLimitMs,
        choiceTimeoutMs: options.choiceTimeoutMs ?? DEFAULT_ROUTER_LIMITS.choiceTimeoutMs,
      },
    });
  }

  // ---- state -----------------------------------------------------------------

  /** Whether remote control is on (connected or not). */
  get active(): boolean {
    return this.client !== undefined;
  }

  /** The running turn came from Telegram. */
  get telegramTurnActive(): boolean {
    return this.tgTurn;
  }

  /** The Telegram user who started the running turn, when known (flow 396). */
  get telegramTurnUserId(): number | undefined {
    return this.tgTurn ? this.currentFromId : undefined;
  }

  /**
   * The mode serve says a Telegram-started turn starts under. A serve that did not say (older than this
   * shell) is read as `ask`: today's behaviour, never a silent widening.
   */
  get configuredPermissionMode(): "ask" | "trust" {
    return this.policyOverride.permissionMode ?? this.client?.permissionMode ?? "ask";
  }

  /** How long an approval waits in the topic: a test override, then what serve delivered, then the old five minutes. */
  get approvalTimeoutMs(): number {
    return this.policyOverride.approvalTimeoutMs ?? this.approvalOverrideMs ?? this.client?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  /** The run limit for a Telegram-started turn: what `/remote-policy` set, then what serve delivered; 0 or absent is no limit. */
  get runTimeoutMs(): number {
    return this.policyOverride.runTimeoutMs ?? this.client?.runTimeoutMs ?? 0;
  }

  /**
   * `/remote-policy` changed the saved defaults: the running shell takes them now. Only the values named
   * change. This is the Telegram default and nothing else: the shell's own mode and the "changed this
   * session" flag are the host's, and are not touched here. A turn already running keeps the limit it
   * started with; the next one uses the new value.
   */
  applyPolicy(next: RemotePolicyOverride): void {
    this.policyOverride = { ...this.policyOverride, ...next };
    this.host.onChange?.();
  }

  /** Put a line in the remote event ring from the host (an auto-approval, a saved rule): redacted and capped. */
  recordApproval(text: string): void {
    this.push("approval", preview(text));
  }

  status(): RemoteStatus {
    const client = this.client;
    if (client === undefined) {
      return { state: "off", events: [...this.events] };
    }
    const online = this.clientConnected && client.connected;
    const heartbeat = client.lastHeartbeatAt;
    const unconfirmed = client.unconfirmedApprovals ?? 0;
    return {
      state: online ? "on" : "offline",
      ...(client.name !== undefined ? { name: client.name } : {}),
      ...(this.lastHistory !== undefined ? { history: { ...this.lastHistory } } : {}),
      ...(heartbeat !== undefined ? { heartbeatAgeMs: Math.max(0, this.now() - heartbeat) } : {}),
      ...(unconfirmed > 0 ? { unconfirmedApprovals: unconfirmed } : {}),
      events: [...this.events],
    };
  }

  private push(kind: RemoteEventKind, text: string): void {
    this.events.push({ at: this.now(), kind, text });
    while (this.events.length > REMOTE_EVENT_LIMIT) this.events.shift();
    this.host.onChange?.();
  }

  // ---- lifecycle ---------------------------------------------------------------

  /** Turn remote control on. The only way it ever starts. */
  async enable(name?: string): Promise<EnableResult> {
    if (this.closing !== undefined) await this.closing;
    if (this.client !== undefined) {
      return {
        ok: false,
        code: "already-on",
        message: `remote control is already on${this.client.name !== undefined ? ` (${this.client.name})` : ""}; turn it off first`,
        retrying: false,
      };
    }
    const clientOptions: RemoteClientOptions = {
      sessionId: this.host.sessionId(),
      project: this.host.project(),
      ...(name !== undefined ? { name } : {}),
      ...(this.options.dir !== undefined ? { dir: this.options.dir } : {}),
      onLine: (text, meta) => this.accept(text, meta),
      onStatus: (status) => this.onStatus(status),
      // Said before the client acknowledges the frame, so the line is on screen when serve shows its ending.
      // A decision that reached no live question is said as exactly that, never as allowed or denied here.
      onApprovalFrame: (frame) =>
        this.host.notice(
          frame.applied
            ? `◇ approval ${frame.approvalId} ${frame.decision === "allow" ? "allowed" : "denied"} from Telegram`
            : `◇ approval ${frame.approvalId}: ${frame.decision === "allow" ? "an allow" : "a deny"} from Telegram arrived but nothing here was waiting for it; not applied`,
        ),
      onUnconfirmedChange: () => this.host.onChange?.(),
    };
    const client = this.options.makeClient !== undefined ? this.options.makeClient(clientOptions) : new RemoteClient(clientOptions);
    this.client = client;
    this.connectedOnce = false;
    this.clientConnected = false;
    this.lastHistory = undefined;
    const result = await client.start();
    if (!result.ok) {
      // Remote control starts only on an explicit command and only when it
      // worked: a serve that is not there is reported, not retried behind the
      // operator's back.
      this.client = undefined;
      await client.close().catch(() => undefined);
      this.push("error", `could not start: ${result.message}`);
      return result;
    }
    this.clientConnected = true;
    this.host.recordOn(result.name);
    this.push("status", `on as ${result.name}`);
    // Flow 399: a resumed session whose topic was just CREATED (not found again) is an empty
    // topic over a conversation the operator wants to see. Nothing else restores on its own: a
    // reconnect (`result.reused` is the FIRST registration's, a reconnect never changes it), a
    // reused topic, a session that started fresh, and turning it off and on again in the same
    // process (that new topic is empty on purpose; `/history` fills it). Not awaited: ten paced
    // posts take a while and `enable()` must return the topic at once.
    const firstEnable = !this.enabledOnce;
    this.enabledOnce = true;
    if (firstEnable && result.reused === false && this.host.sessionResumed?.() === true) {
      void this.postHistory(HISTORY_DEFAULT_COUNT, true)
        .then((outcome) => {
          // A restore that did not happen says why, in the transcript: the operator is looking at an empty topic.
          if (!outcome.ok && this.client === client) {
            this.host.notice(`history was not restored automatically: ${outcome.message}`);
          }
        })
        .catch(() => undefined);
    }
    return result;
  }

  /**
   * Turn it off: deregisters, which deletes the topic. Safe when already off. A
   * second call while the first is still closing waits for it (and returns false):
   * "off" is only true once the topic is actually gone.
   */
  async disable(): Promise<boolean> {
    if (this.closing !== undefined) {
      await this.closing;
      return false;
    }
    const client = this.client;
    if (client === undefined) return false;
    this.client = undefined;
    this.clientConnected = false;
    this.lastHistory = undefined;
    this.endTurnState();
    this.waiting.length = 0;
    // History first, before anything awaits: a host that is about to swap its session
    // (`/new`, `/resume`) calls this and must close the interval on the session it opened.
    this.host.recordOff();
    // Lines from Telegram that never got to run are dropped with the topic; say so,
    // here and (best effort, the topic is about to go) in the topic itself.
    const dropped = this.host.dropQueuedTelegramLines?.() ?? [];
    if (dropped.length > 0) {
      this.host.notice(
        `remote control off: ${dropped.length} queued Telegram line${dropped.length === 1 ? "" : "s"} dropped (${dropped.map((line) => `"${preview(line)}"`).join(", ")}).`,
      );
    }
    const shutdown = (async () => {
      if (dropped.length > 0) {
        await client
          .reply(
            `Remote control is turning off. ${dropped.length} message${dropped.length === 1 ? "" : "s"} you sent will not run: ${dropped.map((line) => `"${preview(line)}"`).join(", ")}.`,
          )
          .catch(() => false);
      }
      await client.close().catch(() => undefined);
    })();
    this.closing = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.closing === shutdown) this.closing = undefined;
    }
    this.push("status", "off");
    return true;
  }

  private onStatus(status: ClientStatus): void {
    if (this.client === undefined) return;
    if (status.state === "connected") {
      this.clientConnected = true;
      if (this.connectedOnce) this.push("status", "reconnected");
      this.connectedOnce = true;
    } else if (status.state === "disconnected") {
      this.clientConnected = false;
      this.push("status", "disconnected from serve; retrying");
    } else {
      this.clientConnected = false;
      this.push("status", `stopped${status.reason !== undefined ? `: ${preview(status.reason)}` : ""}`);
    }
  }

  // ---- a line from Telegram -------------------------------------------------------

  /** Resolves as soon as the line is in the session or its queue, never after the turn: serve is told it arrived then. */
  private accept(text: string, meta: InboundMeta): void {
    const line = text.trim();
    if (line.length === 0 || this.client === undefined) return;
    // A slash command goes to the gateway (flow 387): an allowlist of commands that print text,
    // the rest refused with the reason. A refusal is answered before this returns.
    if (line.startsWith("/")) {
      this.push("line", `Telegram: ${preview(line)}`);
      this.router.handle(line, meta.fromId, (result) => this.report(meta.updateId, result));
      return;
    }
    this.push("line", `Telegram: ${preview(line)}`);
    this.waiting.push({ updateId: meta.updateId, line, ...(meta.fromId === undefined ? {} : { fromId: meta.fromId }) });
    if (this.host.isBusy()) {
      // Queued: the message keeps its "received" reaction until its own turn starts.
      this.host.enqueue(line);
    } else {
      this.report(meta.updateId, "reading");
      this.host.runLine(line);
    }
  }

  /** Where a message from the topic is. Best effort and never awaited: it cannot hold the line. */
  private report(updateId: number, state: MessageState): void {
    const client = this.client;
    if (client?.reportState === undefined) return;
    // Posts for one message go out one after the other, in the order they were reported: a
    // slow "working" must not land after "done" and leave the typing indicator running.
    const previous = this.reportTails.get(updateId);
    const post = client.reportState.bind(client);
    // With nothing in flight for this message the post starts at once, as before.
    const started: Promise<unknown> = previous === undefined ? post(updateId, state) : previous.then(() => post(updateId, state));
    const tail: Promise<void> = started
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (this.reportTails.get(updateId) === tail) this.reportTails.delete(updateId);
      });
    this.reportTails.set(updateId, tail);
  }

  /** The last state post of each message still in flight; keeps the posts of one message in order. */
  private readonly reportTails = new Map<number, Promise<void>>();

  /** Resolves when every command taken from the topic, and every question asked in it, has finished. */
  idle(): Promise<void> {
    return this.router.idle();
  }

  // ---- the session under the topic (flow 387, AC17) -----------------------------------

  /**
   * The shell is about to swap its session. True when a command from this topic asked for it:
   * the topic stays bound, and the host must call {@link sessionLeaving} and later
   * {@link sessionEntered} instead of turning remote control off.
   */
  get keepingTopic(): boolean {
    return this.keepTopic && this.client !== undefined;
  }

  /** The old session is closing and the topic stays: close its history interval. */
  sessionLeaving(): void {
    if (this.client === undefined) return;
    this.endTurnState();
    this.host.recordOff();
    this.push("status", "session changing; this topic stays bound");
  }

  /** The new session is live: open its history interval and put one separator line in the topic. */
  sessionEntered(kind: "new" | "resumed" = "new"): void {
    const client = this.client;
    if (client === undefined) return;
    this.switched = true;
    if (client.name !== undefined) this.host.recordOn(client.name);
    this.push("status", kind === "new" ? "new session; same topic" : "resumed session; same topic");
    void client.reply(kind === "new" ? "--- new session ---" : "--- resumed session ---").catch(() => false);
  }

  // ---- history (flow 399) ----------------------------------------------------------------

  /**
   * Post the last `count` messages of the session to the topic, oldest first, each as its own
   * message with a role label, `historyPaceMs` apart. `auto` marks the restore that follows a
   * new topic for a resumed session. Safe to call while a turn runs: it only reads.
   *
   * It never repeats on its own: only `enable()` (a topic that was just created) and a typed or
   * remote `/history` call it. Each message is handed to the client once; if the topic goes
   * away or a send is refused the run stops there and says how far it got.
   */
  async postHistory(count: number = HISTORY_DEFAULT_COUNT, auto = false): Promise<HistoryOutcome> {
    const client = this.client;
    if (client === undefined) {
      return { ok: false, reason: "off", posted: 0, message: "Remote control is off, so there is no topic to post to. Turn it on with /remote-control <name>." };
    }
    if (this.host.history === undefined) {
      return { ok: false, reason: "unavailable", posted: 0, message: "This shell cannot post its history." };
    }
    if (this.postingClient === client) {
      return { ok: false, reason: "running", posted: 0, message: "The history is still being posted. Wait for it to finish." };
    }
    let items: ReturnType<typeof selectHistory>;
    try {
      const turnRunning = this.host.turnRunning !== undefined ? this.host.turnRunning() : this.host.isBusy();
      items = selectHistory(this.host.history(), count, { turnRunning });
    } catch {
      return { ok: false, reason: "unavailable", posted: 0, message: "The session history could not be read." };
    }
    if (items.length === 0) {
      return { ok: false, reason: "empty", posted: 0, message: HISTORY_EMPTY_MESSAGE };
    }
    const pace = this.options.historyPaceMs ?? HISTORY_PACE_MS;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.postingClient = client;
    let posted = 0;
    try {
      for (const item of items) {
        if (this.client !== client) break;
        if (posted > 0 && pace > 0) {
          await sleep(pace);
          if (this.client !== client) break;
        }
        const sent = await client.reply(composeReply(formatHistoryItem(item))).catch(() => false);
        if (!sent) break;
        posted += 1;
      }
    } finally {
      if (this.postingClient === client) this.postingClient = undefined;
    }
    if (posted > 0 && this.client === client) {
      this.lastHistory = { at: this.now(), count: posted, auto };
      this.push("status", `history posted: ${posted} message${posted === 1 ? "" : "s"}${auto ? " (restored automatically)" : ""}`);
      this.host.notice(
        `history ${auto ? "restored" : "posted"} to the topic: ${posted} message${posted === 1 ? "" : "s"}${auto ? " (this session was resumed)" : ""}.`,
      );
    }
    if (posted < items.length) {
      this.push("error", `history stopped after ${posted} of ${items.length} messages`);
      return {
        ok: false,
        reason: "failed",
        posted,
        message: `The history stopped after ${posted} of ${items.length} messages: the topic did not take the next one. Send /history again.`,
      };
    }
    return { ok: true, posted };
  }

  /** `/history [N]` as the router and the shell take it: undefined when the messages went out, else the one line to answer with. */
  async historyForCommand(args: string): Promise<string | undefined> {
    const parsed = parseHistoryArgs(args);
    if (!parsed.ok) return parsed.message;
    const outcome = await this.postHistory(parsed.count, false);
    return outcome.ok ? undefined : outcome.message;
  }

  // ---- hooks the host calls around a turn ------------------------------------------

  /** A turn is starting. `source` is `tg` only for a line that came from Telegram. */
  turnStarted(source: RemoteLineSource | undefined): void {
    this.endTurnState();
    if (source !== TG_SOURCE || this.client === undefined) return;
    const next = this.waiting.shift();
    this.currentUpdate = next?.updateId;
    this.currentFromId = next?.fromId;
    if (next !== undefined) this.report(next.updateId, "working");
    this.tgTurn = true;
    this.lastAssistantText = "";
    this.timedOut = false;
    this.stoppedByUser = false;
    this.turnAbort = new AbortController();
    // 0 or absent is "no limit" (flow 396): only `/stop` or the shell ends such a run.
    const limit = this.runTimeoutMs;
    if (limit > 0) {
      this.runTimer = setTimeout(() => {
        this.timedOut = true;
        this.push("error", "run time limit reached; stopping the turn");
        this.turnAbort?.abort();
        this.host.cancelTurn();
      }, limit);
    }
  }

  /**
   * `/stop` from the topic (flow 396). Ends a turn that Telegram started, the way Esc ends it in the shell;
   * a turn the operator started in the shell is not Telegram's to stop. The topic is told by
   * {@link turnSettled} once the turn has actually ended.
   */
  stopTelegramTurn(): "stopped" | "idle" | "operator" {
    if (this.client === undefined) return "idle";
    if (!this.tgTurn) return this.host.isBusy() ? "operator" : "idle";
    if (this.stoppedByUser) return "stopped";
    this.stoppedByUser = true;
    this.push("command", "/stop: stopping the turn");
    this.turnAbort?.abort();
    this.host.cancelTurn();
    return "stopped";
  }

  /** Assistant text the user would see. Only the last one of the turn is sent. */
  assistantText(text: string): void {
    if (!this.tgTurn) return;
    if (text.trim().length > 0) this.lastAssistantText = text;
  }

  /**
   * A tool call started. Assistant text is reported once per model round, BEFORE that
   * round's tool calls run, so text followed by a call is narration ("let me look"),
   * not the answer: drop it. The reply is the text of a round that ended without a
   * tool call.
   */
  toolCall(): void {
    if (!this.tgTurn) return;
    this.lastAssistantText = "";
  }

  /**
   * A line that came from Telegram was removed from the shell's queue by the
   * operator, so it will never run. Tell the topic, or its author waits for a reply.
   */
  queuedLineRemoved(line: string): void {
    const client = this.client;
    if (client === undefined) return;
    this.push("line", `Telegram line removed from the queue: ${preview(line)}`);
    const index = this.waiting.findIndex((entry) => entry.line === line.trim());
    if (index >= 0) {
      const [gone] = this.waiting.splice(index, 1);
      if (gone !== undefined) this.report(gone.updateId, "failed");
    }
    void client
      .reply(`Your message "${preview(line)}" was removed from the queue in the shell, so it will not run.`)
      .catch(() => false);
  }

  /** The turn finished (or was cancelled). Sends the reply for a Telegram turn. */
  async turnSettled(outcome: { failed: boolean }): Promise<void> {
    if (!this.tgTurn) return;
    const client = this.client;
    const text = this.lastAssistantText;
    const timedOut = this.timedOut;
    const stopped = this.stoppedByUser && !timedOut;
    const updateId = this.currentUpdate;
    this.endTurnState();
    if (client === undefined) return;
    if (updateId !== undefined) this.report(updateId, outcome.failed || timedOut || stopped ? "failed" : "done");
    let body: string;
    if (stopped) {
      body = "Stopped by you.";
    } else if (timedOut) {
      body = "Stopped: this run went over the time limit you set for runs started from Telegram (runTimeoutMs).";
    } else if (outcome.failed && text.trim().length === 0) {
      body = "The run failed. The details are in the shell.";
    } else if (text.trim().length === 0) {
      body = "Done. There was no text to show.";
    } else {
      body = composeReply(text);
    }
    const sent = await client.reply(body).catch(() => false);
    this.push(sent ? "reply" : "error", sent ? `reply sent (${body.length} chars)` : "the reply could not be sent");
  }

  private endTurnState(): void {
    this.tgTurn = false;
    this.currentUpdate = undefined;
    this.currentFromId = undefined;
    this.lastAssistantText = "";
    this.timedOut = false;
    this.stoppedByUser = false;
    this.turnAbort?.abort();
    this.turnAbort = undefined;
    if (this.runTimer !== undefined) {
      clearTimeout(this.runTimer);
      this.runTimer = undefined;
    }
  }

  // ---- approvals ---------------------------------------------------------------------

  /**
   * Ask the topic. Fails closed: with no client, no stream, a timeout or any
   * error the answer is `deny`.
   */
  async requestApproval(prompt: string): Promise<"allow" | "deny"> {
    return (await this.askApproval(prompt)).decision;
  }

  /**
   * Like {@link requestApproval}; with `remember` the prompt carries an "Always: <pattern>" button
   * (flow 396). Anything but an explicit press is a deny. The press is recorded with the user id.
   */
  async askApproval(prompt: string, options: { remember?: string } = {}): Promise<RemoteApprovalAnswer> {
    const client = this.client;
    if (client === undefined || !client.connected) {
      this.push("approval", "denied: not connected");
      return { decision: "deny", always: false };
    }
    this.push("approval", "asked in the topic");
    let answer: RemoteApprovalAnswer;
    try {
      const text = composeApprovalPrompt(prompt);
      const timeoutMs = this.approvalTimeoutMs;
      if (client.askApproval !== undefined) {
        const signal = this.turnAbort?.signal;
        const got = await client.askApproval(text, timeoutMs, {
          ...(options.remember === undefined ? {} : { remember: options.remember }),
          ...(signal === undefined ? {} : { signal }),
        });
        answer = mapApprovalAnswer(got, options.remember !== undefined);
      } else {
        const decision: unknown = await client.requestApproval(text, timeoutMs);
        answer = { decision: decision === "allow" || decision === "always" ? "allow" : "deny", always: false };
      }
    } catch {
      answer = { decision: "deny", always: false };
    }
    const by = answer.fromId === undefined ? "" : ` by user ${answer.fromId}`;
    this.push(
      "approval",
      answer.decision === "allow" ? `${answer.always ? "allowed (always)" : "allowed"} in the topic${by}` : `denied${by === "" ? " (or no answer)" : by}`,
    );
    return answer;
  }

  /** Tell the topic whether an "Always" press became a saved rule (flow 396). Best effort. */
  async reportRemembered(approvalId: string | undefined, remembered: boolean): Promise<void> {
    if (approvalId === undefined) return;
    await this.client?.reportApprovalResult?.(approvalId, remembered);
  }
}
