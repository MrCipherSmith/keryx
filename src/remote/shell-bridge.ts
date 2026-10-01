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
import { DEFAULT_APPROVAL_TIMEOUT_MS, MAX_APPROVAL_PROMPT_CHARS } from "./protocol";

/** The label a Telegram line carries in the queue and the transcript. */
export const TG_SOURCE = "tg" as const;
export type RemoteLineSource = typeof TG_SOURCE;

/** How many recent events the status display keeps. */
export const REMOTE_EVENT_LIMIT = 20;
/** A reply longer than this is cut, with a note, before it is sent (the outbound queue splits what is left into parts of 4096). */
export const REMOTE_REPLY_MAX_CHARS = 16_000;
const EVENT_PREVIEW_CHARS = 80;

export type RemoteState = "off" | "on" | "offline";
export type RemoteEventKind = "line" | "reply" | "approval" | "status" | "error";

export interface RemoteEvent {
  at: number;
  kind: RemoteEventKind;
  text: string;
}

export interface RemoteStatus {
  state: RemoteState;
  /** The topic name, once registered. */
  name?: string;
  /** Milliseconds since serve last answered; absent when off or never answered. */
  heartbeatAgeMs?: number;
  /** Newest last, at most {@link REMOTE_EVENT_LIMIT}. */
  events: readonly RemoteEvent[];
}

/** The part of {@link RemoteClient} the bridge uses; tests pass a fake. */
export type RemoteClientLike = Pick<
  RemoteClient,
  "start" | "close" | "reply" | "requestApproval" | "connected" | "name" | "runTimeoutMs" | "lastHeartbeatAt"
>;

export interface RemoteBridgeHost {
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
}

export interface RemoteBridgeOptions {
  host: RemoteBridgeHost;
  /** Test seam. Default: a real `RemoteClient`. */
  makeClient?: (options: RemoteClientOptions) => RemoteClientLike;
  /** User-global directory override, forwarded to the client (test seam). */
  dir?: string | undefined;
  now?: () => number;
  approvalTimeoutMs?: number;
}

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

/** The approval prompt: redacted and within the server's limit. Exported for the tests. */
export function composeApprovalPrompt(prompt: string): string {
  const safe = redactSensitiveText(prompt).trim();
  return safe.length <= MAX_APPROVAL_PROMPT_CHARS ? safe : `${safe.slice(0, MAX_APPROVAL_PROMPT_CHARS - 1)}…`;
}

const APPROVAL_INPUT_PREVIEW_CHARS = 1_500;

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
    shown = shown.length > APPROVAL_INPUT_PREVIEW_CHARS ? `${shown.slice(0, APPROVAL_INPUT_PREVIEW_CHARS)}…` : shown;
    lines.push(`Approve ${tool}?`, shown);
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
  private readonly approvalTimeoutMs: number;
  private connectedOnce = false;
  private clientConnected = false;
  private tgTurn = false;
  private lastAssistantText = "";
  private runTimer: ReturnType<typeof setTimeout> | undefined;
  private timedOut = false;
  /** The close of the client being turned off, while it runs. */
  private closing: Promise<void> | undefined;

  constructor(private readonly options: RemoteBridgeOptions) {
    this.host = options.host;
    this.now = options.now ?? Date.now;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
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

  status(): RemoteStatus {
    const client = this.client;
    if (client === undefined) {
      return { state: "off", events: [...this.events] };
    }
    const online = this.clientConnected && client.connected;
    const heartbeat = client.lastHeartbeatAt;
    return {
      state: online ? "on" : "offline",
      ...(client.name !== undefined ? { name: client.name } : {}),
      ...(heartbeat !== undefined ? { heartbeatAgeMs: Math.max(0, this.now() - heartbeat) } : {}),
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
    };
    const client = this.options.makeClient !== undefined ? this.options.makeClient(clientOptions) : new RemoteClient(clientOptions);
    this.client = client;
    this.connectedOnce = false;
    this.clientConnected = false;
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
    this.endTurnState();
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
  private accept(text: string, _meta: InboundMeta): void {
    const line = text.trim();
    if (line.length === 0 || this.client === undefined) return;
    // A slash command is the operator's own control surface (`/exit`, `/bash`,
    // `/remote-control off`...). Someone typing in a topic gets plain prompts to
    // the model only, so the shell cannot be steered around its approvals.
    if (line.startsWith("/")) {
      this.push("line", `Telegram: slash command refused (${preview(line.split(/\s+/)[0] ?? "")})`);
      void this.client.reply("Slash commands are not run from Telegram. Send plain text.").catch(() => false);
      return;
    }
    this.push("line", `Telegram: ${preview(line)}`);
    if (this.host.isBusy()) {
      this.host.enqueue(line);
    } else {
      this.host.runLine(line);
    }
  }

  // ---- hooks the host calls around a turn ------------------------------------------

  /** A turn is starting. `source` is `tg` only for a line that came from Telegram. */
  turnStarted(source: RemoteLineSource | undefined): void {
    this.endTurnState();
    if (source !== TG_SOURCE || this.client === undefined) return;
    this.tgTurn = true;
    this.lastAssistantText = "";
    this.timedOut = false;
    const limit = this.client.runTimeoutMs;
    if (limit !== undefined && limit > 0) {
      this.runTimer = setTimeout(() => {
        this.timedOut = true;
        this.push("error", "run time limit reached; stopping the turn");
        this.host.cancelTurn();
      }, limit);
    }
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
    this.endTurnState();
    if (client === undefined) return;
    let body: string;
    if (timedOut) {
      body = "Stopped: this run went over the time limit for runs started from Telegram.";
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
    this.lastAssistantText = "";
    this.timedOut = false;
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
    const client = this.client;
    if (client === undefined || !client.connected) {
      this.push("approval", "denied: not connected");
      return "deny";
    }
    this.push("approval", "asked in the topic");
    let decision: "allow" | "deny";
    try {
      decision = await client.requestApproval(composeApprovalPrompt(prompt), this.approvalTimeoutMs);
    } catch {
      decision = "deny";
    }
    this.push("approval", decision === "allow" ? "allowed in the topic" : "denied (or no answer)");
    return decision;
  }
}
