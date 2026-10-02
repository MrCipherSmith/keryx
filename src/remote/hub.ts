// The serve-side remote-control hub (flow 376, block 1).
//
// Owns the registry of remote sessions, the topic lifecycle, the durable queues
// and the single poller. Every external effect is injected: the Bot API (`api`),
// the shell-side consumer (`deliver`), the clock (`now`) and the timers, so a
// test drives it with the in-process fake and a manual clock and nothing waits.
//
// Concurrency: the mutating entry points (register, deregister, heartbeat,
// sweep and the poller's `accept`) run one at a time through `serial`. Delivery
// to the consumer runs outside that lock, one drain per topic, so a slow or
// hung consumer never blocks the poller or the lifecycle.
//
// What a topic is bound to is its NAME, not a session id. A returning session
// with the same name finds its topic (and any messages queued while it was
// away); a different live session asking for a held name is refused, never
// handed the topic.

import { redactSensitiveText } from "../security/service";
import { SESSION_LEASE_HEARTBEAT_MS, SESSION_LEASE_STALE_MS } from "../session/lease";
import type { RemoteConfig } from "./config";
import { editHtml, isNotModified, sendHtml } from "./format-html";
import { InboundQueues, type InboundEntry, inboundEntryId, MAX_INBOUND_PER_TOPIC, PollerState } from "./inbound";
import { RejectedJournal } from "./journal";
import { checkName, defaultNameCandidates, nameKey } from "./naming";
import { OutboundQueue, type SentMessageInfo } from "./outbound-queue";
import { remoteMenu } from "./command-gateway";
import { isReactionForbidden, MAX_TRACKED_MESSAGES, REACTION_FOR_STATE, type ReactionState, STATE_CALL_TIMEOUT_MS, TYPING_REFRESH_MS } from "./message-state";
import type { MessageState } from "./protocol";
import { type PollerStatus, UpdatePoller } from "./poller";
import { isLive, type RemoteSessionRecord, SessionRegistry } from "./registry";
import { type BotApi, type BotApiError, type BotUpdate, type InlineKeyboard, isBotApiError, isRetryable } from "./types";

export interface DeliverMeta {
  updateId: number;
  threadId: number;
  fromId: number;
  receivedAt: number;
}

export interface CallbackDelivery {
  updateId: number;
  callbackQueryId: string;
  data: string;
  messageId?: number;
  threadId: number;
  fromId: number;
}

/** What the hub needs from the shell side. Both must reject when the line was not taken. */
export interface RemoteConsumer {
  deliver(sessionId: string, line: string, meta: DeliverMeta): Promise<void>;
  /** Optional: without it, button presses are acknowledged to Telegram and dropped. */
  deliverCallback?(sessionId: string, callback: CallbackDelivery): Promise<void>;
}

export interface HubTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: HubTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export type RemoteEventType =
  | "topic-created"
  | "topic-reused"
  | "topic-renamed"
  | "topic-deleted"
  | "topic-delete-failed"
  | "session-unavailable"
  | "session-returned"
  | "sender-refused"
  | "update-unrouted"
  | "delivery-failed"
  | "outbound-dropped"
  | "format-fallback"
  | "menu-failed"
  | "reactions-unavailable"
  | "poller-status";

export interface RemoteEvent {
  at: number;
  type: RemoteEventType;
  /** Redacted, and never message text. */
  detail?: string;
}

export interface RemoteHubOptions extends RemoteConsumer {
  api: BotApi;
  config: RemoteConfig;
  /** This machine's name; when set, default topic names start with it so two machines never collide. */
  machine?: string;
  /** User-global directory override (the test seam). */
  dir?: string;
  now?: () => number;
  timers?: HubTimers;
  /** How often `start` sweeps for stale heartbeats. Default: the lease heartbeat period. */
  sweepIntervalMs?: number;
  /** Wait before redelivering to a consumer that rejected. Default 2 s. */
  deliverRetryMs?: number;
  pollTimeoutSec?: number;
  pollBackoffMs?: number[];
  pollSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: RemoteEvent) => void;
  onPollerStatus?: (status: PollerStatus) => void;
  /** Test seam: runs after `deliver` resolved and before the ack is written. */
  beforeAck?: (entry: InboundEntry) => void | Promise<void>;
}

export type RegisterResult =
  | { ok: true; name: string; threadId: number; reused: boolean }
  | { ok: false; code: "name-taken" | "invalid-name" | "api-error"; message: string };

export type HeartbeatResult =
  | { ok: true; name: string; threadId: number }
  | { ok: false; code: "unknown-session"; message: string };

export interface RemoteSessionInfo {
  name: string;
  sessionId: string;
  project: string;
  threadId: number;
  status: "live" | "unavailable";
  lastHeartbeat: number;
}

/** A message from a topic whose state is shown as a reaction (flow 387). */
interface TrackedMessage {
  chatId: number;
  threadId: number;
  messageId: number;
  state: ReactionState;
  /** Reaction calls for this message run one after another, so each replaces the one before it. */
  chain: Promise<void>;
}

const MAX_EVENTS = 50;
/** How long a callback acknowledgement may take before it is abandoned. It is never worth holding anything for. */
const ANSWER_CALLBACK_TIMEOUT_MS = 5_000;

function describeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function isThreadGone(error: BotApiError): boolean {
  return error.kind === "rejected" && /thread not found|topic_id_invalid|topic.*not found/i.test(error.message);
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export class RemoteHub {
  private readonly api: BotApi;
  private readonly config: RemoteConfig;
  private readonly machine: string | undefined;
  private readonly consumer: RemoteConsumer;
  private readonly now: () => number;
  private readonly timers: HubTimers;
  private readonly sweepIntervalMs: number;
  private readonly deliverRetryMs: number;
  private readonly beforeAck: ((entry: InboundEntry) => void | Promise<void>) | undefined;
  private readonly emit: (event: RemoteEvent) => void;
  private readonly registry: SessionRegistry;
  private readonly inbound: InboundQueues;
  private readonly outbound: OutboundQueue;
  private readonly journal: RejectedJournal;
  private readonly offset: PollerState;
  private readonly poller: UpdatePoller;
  private readonly recent: RemoteEvent[] = [];
  private readonly dispatching = new Map<string, Promise<void>>();
  private readonly redispatch = new Set<string>();
  private readonly retryTimers = new Map<string, unknown>();
  private lock: Promise<unknown> = Promise.resolve();
  private flushTimer: unknown;
  private sweepTimer: unknown;
  private stopped = false;
  private readonly tracked = new Map<string, TrackedMessage>();
  /** Per topic: the interval that keeps the typing indicator alive while a turn runs. */
  private readonly typing = new Map<string, unknown>();
  /** The bot may not react in this group: reactions are off for good and only typing is left. */
  private reactionsOff = false;

  constructor(options: RemoteHubOptions) {
    this.api = options.api;
    this.config = options.config;
    this.machine = options.machine;
    this.consumer = { deliver: options.deliver, ...(options.deliverCallback === undefined ? {} : { deliverCallback: options.deliverCallback }) };
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? realTimers;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SESSION_LEASE_HEARTBEAT_MS;
    this.deliverRetryMs = options.deliverRetryMs ?? 2_000;
    this.beforeAck = options.beforeAck;
    const onEvent = options.onEvent ?? (() => undefined);
    this.emit = (event) => {
      this.recent.push(event);
      if (this.recent.length > MAX_EVENTS) {
        this.recent.shift();
      }
      onEvent(event);
    };
    this.registry = new SessionRegistry({ ...(options.dir === undefined ? {} : { dir: options.dir }), now: this.now });
    this.inbound = new InboundQueues(options.dir === undefined ? {} : { dir: options.dir });
    this.outbound = new OutboundQueue({
      api: this.api,
      ...(options.dir === undefined ? {} : { dir: options.dir }),
      now: this.now,
      onDrop: (entry, reason) => this.event("outbound-dropped", `${reason}${entry.threadId === undefined ? "" : ` (topic ${entry.threadId})`}`),
      onFallback: (entry) => this.event("format-fallback", `Telegram refused the formatting; sent as plain text${entry.threadId === undefined ? "" : ` (topic ${entry.threadId})`}`),
    });
    this.journal = new RejectedJournal({ ...(options.dir === undefined ? {} : { dir: options.dir }), now: this.now });
    this.offset = new PollerState(options.dir === undefined ? {} : { dir: options.dir });
    this.registry.load();
    this.outbound.load();
    this.offset.load();
    this.forgetOtherGroups();
    const onPollerStatus = options.onPollerStatus ?? (() => undefined);
    this.poller = new UpdatePoller({
      api: this.api,
      sink: { accept: (updates) => this.receive(updates) },
      ...(options.pollTimeoutSec === undefined ? {} : { timeoutSec: options.pollTimeoutSec }),
      ...(options.pollSleep === undefined ? {} : { sleep: options.pollSleep }),
      ...(options.pollBackoffMs === undefined ? {} : { backoffMs: options.pollBackoffMs }),
      onStatus: (status) => {
        this.event("poller-status", status.reason === undefined ? status.state : `${status.state}: ${status.reason}`);
        onPollerStatus(status);
      },
    });
  }

  /** Records left by a channel connected to another group are not ours: reusing one would answer into the old group. */
  private forgetOtherGroups(): void {
    const foreign = this.registry.records().filter((record) => record.chatId !== this.config.chatId);
    if (foreign.length === 0) {
      return;
    }
    for (const record of foreign) {
      this.outbound.discardForThread(record.chatId, record.threadId);
      this.inbound.remove(nameKey(record.name));
      this.registry.remove(record.name);
      this.event("topic-deleted", `${record.name}: forgotten, it belonged to another group`);
    }
    this.registry.save();
  }

  // ---- lifecycle of the hub ------------------------------------------------

  /** Begin polling, sweeping and flushing; redeliver whatever a previous run left behind. */
  async start(): Promise<void> {
    this.stopped = false;
    this.poller.start();
    this.sweepTimer = this.timers.setInterval(() => {
      void this.sweep();
    }, this.sweepIntervalMs);
    await this.flushOutbound();
    for (const record of this.registry.records()) {
      void this.dispatch(nameKey(record.name));
    }
    await this.publishCommandMenu();
  }

  /**
   * The command menu in the group is exactly the commands the gateway lets a topic run (flow 387,
   * AC12). A failure is one event: the menu is a convenience, typing the command still works.
   */
  private async publishCommandMenu(): Promise<void> {
    try {
      await this.api.setMyCommands({ commands: remoteMenu(), chatId: this.config.chatId });
    } catch (error) {
      this.event("menu-failed", describeError(error));
    }
  }

  /** Stop polling and timers. In-flight deliveries are abandoned, not awaited. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer !== undefined) {
      this.timers.clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    if (this.flushTimer !== undefined) {
      this.timers.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    for (const handle of this.retryTimers.values()) {
      this.timers.clearTimeout(handle);
    }
    this.retryTimers.clear();
    for (const handle of this.typing.values()) {
      this.timers.clearInterval(handle);
    }
    this.typing.clear();
    await this.poller.stop();
  }

  pollerStatus(): PollerStatus {
    return this.poller.status();
  }

  /** Resolves once every delivery currently in flight has finished or failed. */
  async idle(): Promise<void> {
    while (this.dispatching.size > 0) {
      await Promise.all([...this.dispatching.values()]);
    }
  }

  events(): RemoteEvent[] {
    return [...this.recent];
  }

  list(): RemoteSessionInfo[] {
    return this.registry.records().map((record) => ({
      name: record.name,
      sessionId: record.sessionId,
      project: record.project,
      threadId: record.threadId,
      status: record.status,
      lastHeartbeat: record.lastHeartbeat,
    }));
  }

  /** What a shell needs to know about this hub's limits (the run guard reads `runTimeoutMs`). */
  limits(): { runTimeoutMs: number; orphanMs: number } {
    return { runTimeoutMs: this.config.runTimeoutMs, orphanMs: this.config.orphanMs };
  }

  hasSession(sessionId: string): boolean {
    return this.registry.bySession(sessionId) !== undefined;
  }

  /** Try a session's pending deliveries now rather than at the next retry (a stream just connected). */
  redeliver(sessionId: string): void {
    const record = this.registry.bySession(sessionId);
    if (record === undefined || this.stopped) {
      return;
    }
    const key = nameKey(record.name);
    const handle = this.retryTimers.get(key);
    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
      this.retryTimers.delete(key);
    }
    void this.dispatch(key);
  }

  // ---- session lifecycle ---------------------------------------------------

  register(input: { sessionId: string; project: string; name?: string }): Promise<RegisterResult> {
    return this.serial(() => this.doRegister(input));
  }

  deregister(sessionId: string): Promise<{ ok: true; existed: boolean }> {
    return this.serial(async () => {
      const record = this.registry.bySession(sessionId);
      if (record === undefined) {
        return { ok: true as const, existed: false };
      }
      await this.retire(record, "closed by the session");
      return { ok: true as const, existed: true };
    });
  }

  /**
   * Delete every topic this hub owns (a channel is being disconnected). Reports how
   * many were deleted and how many could not be, which stay recorded so a later
   * sweep or a second disconnect retries them.
   */
  deleteAllTopics(): Promise<{ deleted: number; remaining: number }> {
    return this.serial(async () => {
      const records = this.registry.records();
      for (const record of records) {
        await this.retire(record, "channel disconnected", true);
      }
      const remaining = this.registry.records().length;
      return { deleted: records.length - remaining, remaining };
    });
  }

  /** One message to the General topic of the group, sent now (not queued): the caller reports the outcome. */
  async sendGeneral(text: string): Promise<void> {
    await sendHtml(this.api, { chatId: this.config.chatId, text }, () => this.event("format-fallback", "Telegram refused the formatting; sent as plain text (General)"));
  }

  heartbeat(sessionId: string): Promise<HeartbeatResult> {
    return this.serial(async () => {
      const record = this.registry.bySession(sessionId);
      if (record === undefined) {
        return { ok: false as const, code: "unknown-session" as const, message: "this session is not registered for remote control; register again" };
      }
      record.lastHeartbeat = this.now();
      if (record.status === "unavailable") {
        this.markLive(record);
        this.registry.save();
        this.event("session-returned", record.name);
        this.queueStatus(record, "Session available again.");
        await this.flushOutbound();
        void this.dispatch(nameKey(record.name));
      }
      return { ok: true as const, name: record.name, threadId: record.threadId };
    });
  }

  /** Mark stale heartbeats unavailable and delete topics whose orphan timeout has run out. */
  sweep(): Promise<void> {
    return this.serial(async () => {
      const now = this.now();
      for (const record of this.registry.records()) {
        if (record.status === "live") {
          if (record.lastHeartbeat - now >= SESSION_LEASE_STALE_MS) {
            // The clock went backwards by more than a lease: trust the present.
            record.lastHeartbeat = now;
            continue;
          }
          if (isLive(record, now)) {
            continue;
          }
          record.status = "unavailable";
          record.unavailableSince = Math.min(now, record.lastHeartbeat + SESSION_LEASE_STALE_MS);
          this.registry.save();
          this.event("session-unavailable", record.name);
          // The shell is not coming back on its own: stop typing and fail what it was working on.
          this.endActivity(record.sessionId);
          if (now - record.unavailableSince < this.config.orphanMs) {
            this.queueStatus(
              record,
              `Session unavailable: the shell stopped responding. This topic is deleted in ${formatDuration(this.config.orphanMs)} unless the session returns.`,
            );
          }
        }
        if (record.status === "unavailable" && record.unavailableSince !== undefined && now - record.unavailableSince >= this.config.orphanMs) {
          await this.retire(record, "orphan timeout");
        }
      }
      await this.flushOutbound();
    });
  }

  // ---- messages to Telegram ------------------------------------------------

  /**
   * Queue text for a session's topic and try to send it. False when the session is unknown.
   * `onSent` learns the id of the message once it is in the topic (in memory only), so the
   * caller can edit it later.
   */
  async send(
    sessionId: string,
    text: string,
    options: { keyboard?: InlineKeyboard; onSent?: (info: SentMessageInfo) => void } = {},
  ): Promise<boolean> {
    const record = this.registry.bySession(sessionId);
    if (record === undefined) {
      return false;
    }
    this.outbound.enqueue({
      chatId: record.chatId,
      threadId: record.threadId,
      text,
      ...(options.keyboard === undefined ? {} : { keyboard: options.keyboard }),
      ...(options.onSent === undefined ? {} : { onSent: options.onSent }),
    });
    await this.flushOutbound();
    return true;
  }

  /**
   * Put a message the bot sent into its final state: the text is replaced and the buttons are
   * gone (flow 387, AC21). If the edit fails, the buttons are removed on their own and ONE short
   * reply carries the result, so a prompt never keeps live buttons and never answers twice.
   * An edit that changes nothing (a replayed press on a settled message) counts as done.
   */
  async settleMessage(
    sessionId: string,
    messageId: number,
    text: string,
    shortReply: string = text,
  ): Promise<"edited" | "replied" | "gone"> {
    const record = this.registry.bySession(sessionId);
    if (record === undefined) {
      return "gone";
    }
    try {
      await editHtml(this.api, { chatId: record.chatId, messageId, text }, () =>
        this.event("format-fallback", `Telegram refused the formatting; edited as plain text (topic ${record.threadId})`),
      );
      return "edited";
    } catch (error) {
      if (isNotModified(error)) {
        return "edited";
      }
      try {
        await this.api.editMessageReplyMarkup({ chatId: record.chatId, messageId });
      } catch {
        // Already gone or unchanged: the short reply below still carries the result.
      }
      await this.send(sessionId, shortReply);
      return "replied";
    }
  }

  /** Try to send everything queued. Safe to call at any time. */
  async flushOutbound(): Promise<void> {
    const result = await this.outbound.flush();
    if (result.retryInMs !== undefined && !this.stopped && this.flushTimer === undefined) {
      this.flushTimer = this.timers.setTimeout(() => {
        this.flushTimer = undefined;
        void this.flushOutbound();
      }, result.retryInMs);
    }
  }

  outboundPending(): number {
    return this.outbound.size;
  }

  // ---- messages from Telegram ----------------------------------------------

  /**
   * The poller's sink: persist, then remember the ids, then deliver. Returning
   * is what lets the poller confirm the batch to Telegram.
   *
   * A repeat is recognised by exact id, never by "at or below the highest": an id
   * we have never taken is new however low it is. A batch holding such an id while
   * we remember higher ones is a sequence restart (Telegram renumbered), and the
   * ids remembered from the old sequence are forgotten rather than allowed to
   * swallow new messages.
   */
  receive(updates: BotUpdate[]): Promise<void> {
    return this.serial(async () => {
      const touched = new Set<string>();
      const callbacks: string[] = [];
      const dropped = new Map<string, number>();
      const ordered = [...updates].sort((a, b) => a.update_id - b.update_id);
      const top = this.offset.highest;
      if (ordered.some((update) => update.update_id < top && !this.offset.seen(update.update_id))) {
        this.offset.reset();
        this.event("poller-status", `update numbering restarted (an id below ${top}); treating this batch as new`);
      }
      const taken: number[] = [];
      for (const update of ordered) {
        if (this.offset.seen(update.update_id)) {
          continue;
        }
        taken.push(update.update_id);
        const routed = this.route(update);
        if (routed === undefined) {
          continue;
        }
        touched.add(routed.key);
        if (routed.dropped > 0) {
          dropped.set(routed.key, (dropped.get(routed.key) ?? 0) + routed.dropped);
        }
        if (routed.callbackQueryId !== undefined) {
          callbacks.push(routed.callbackQueryId);
        }
      }
      // Everything above is on disk; only now are the ids remembered (and so the batch confirmable).
      this.offset.record(taken);
      for (const [key, count] of dropped) {
        const record = this.registry.byNameKey(key);
        if (record !== undefined) {
          this.event("delivery-failed", `topic ${record.threadId}: ${count} oldest queued message${count === 1 ? "" : "s"} dropped (cap ${MAX_INBOUND_PER_TOPIC})`);
          this.queueStatus(
            record,
            `This topic already held ${MAX_INBOUND_PER_TOPIC} messages the session has not taken, so the ${count} oldest ${count === 1 ? "was" : "were"} dropped. Send fewer messages, or bring the session back.`,
          );
        }
      }
      if (dropped.size > 0) {
        await this.flushOutbound();
      }
      for (const id of callbacks) {
        this.answerCallback(id);
      }
      for (const key of touched) {
        void this.dispatch(key);
      }
    });
  }

  /**
   * Tell Telegram a button press was seen. Fire and forget, with a short timeout:
   * this runs inside the serial lock's turn and a slow Bot API must never hold up
   * the poller or the lifecycle, so nothing waits for it.
   */
  private answerCallback(callbackQueryId: string): void {
    let timer: unknown;
    const timeout = new Promise<void>((resolve) => {
      timer = this.timers.setTimeout(resolve, ANSWER_CALLBACK_TIMEOUT_MS);
    });
    const answered = this.api.answerCallbackQuery({ callbackQueryId }).then(
      () => undefined,
      () => undefined,
    );
    void Promise.race([answered, timeout]).finally(() => {
      this.timers.clearTimeout(timer);
    });
  }

  // ---- internals -----------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private event(type: RemoteEventType, detail?: string): void {
    this.emit({ at: this.now(), type, ...(detail === undefined ? {} : { detail: redactSensitiveText(detail) }) });
  }

  private markLive(record: RemoteSessionRecord): void {
    record.status = "live";
    delete record.unavailableSince;
  }

  private queueStatus(record: RemoteSessionRecord, text: string): void {
    this.outbound.enqueue({ chatId: record.chatId, threadId: record.threadId, text });
  }

  private async doRegister(input: { sessionId: string; project: string; name?: string }): Promise<RegisterResult> {
    const now = this.now();
    const existing = this.registry.bySession(input.sessionId);
    let name: string;
    if (input.name !== undefined && input.name.trim().length > 0) {
      const checked = checkName(input.name);
      if (!checked.ok) {
        return { ok: false, code: "invalid-name", message: checked.reason };
      }
      name = checked.name;
      const holder = this.registry.byNameKey(name);
      if (holder !== undefined && holder.sessionId !== input.sessionId && isLive(holder, now)) {
        return { ok: false, code: "name-taken", message: `the name "${name}" is held by a live remote session` };
      }
    } else if (existing !== undefined) {
      name = existing.name;
    } else {
      let chosen: string | undefined;
      for (const candidate of defaultNameCandidates(input.project, input.sessionId, this.machine)) {
        const holder = this.registry.byNameKey(candidate);
        if (holder === undefined || holder.sessionId === input.sessionId || !isLive(holder, now)) {
          chosen = candidate;
          break;
        }
      }
      if (chosen === undefined) {
        return { ok: false, code: "name-taken", message: "every default name for this session is held by a live remote session" };
      }
      name = chosen;
    }

    // The same session asking for a different name leaves its old topic first.
    if (existing !== undefined && nameKey(existing.name) !== nameKey(name)) {
      await this.retire(existing, "renamed by the session");
    }

    const holder = this.registry.byNameKey(name);
    if (holder !== undefined) {
      const wasHeld = holder.status === "live" && holder.sessionId === input.sessionId;
      holder.sessionId = input.sessionId;
      holder.project = input.project;
      holder.lastHeartbeat = now;
      this.markLive(holder);
      if (!wasHeld) {
        holder.registeredAt = now;
      }
      this.registry.save();
      if (!wasHeld) {
        this.event("topic-reused", holder.name);
        this.queueStatus(holder, `Remote control attached: ${holder.name}.`);
      }
      await this.flushOutbound();
      void this.dispatch(nameKey(holder.name));
      return { ok: true, name: holder.name, threadId: holder.threadId, reused: true };
    }

    let created: { message_thread_id: number };
    try {
      created = await this.api.createForumTopic({ chatId: this.config.chatId, name });
    } catch (error) {
      return { ok: false, code: "api-error", message: `could not create the topic: ${describeError(error)}` };
    }
    const record: RemoteSessionRecord = {
      name,
      sessionId: input.sessionId,
      project: input.project,
      chatId: this.config.chatId,
      threadId: created.message_thread_id,
      registeredAt: now,
      lastHeartbeat: now,
      status: "live",
    };
    this.registry.put(record);
    this.registry.save();
    this.event("topic-created", name);
    this.queueStatus(record, `Remote control on: ${name}. Messages here go to the session.`);
    await this.flushOutbound();
    return { ok: true, name, threadId: record.threadId, reused: false };
  }

  /**
   * Delete a record's topic and forget it. A topic that is already gone counts
   * as deleted; a transient failure leaves an ownerless, already-expired record
   * behind so the next sweep retries the deletion instead of leaking the topic.
   */
  private async retire(record: RemoteSessionRecord, why: string, strict = false): Promise<void> {
    this.outbound.discardForThread(record.chatId, record.threadId);
    this.stopTyping(record);
    try {
      await this.api.deleteForumTopic({ chatId: record.chatId, messageThreadId: record.threadId });
    } catch (error) {
      // Strict (a disconnect): only "the topic is gone" counts as deleted. A 403 (the bot lost its rights) leaves a topic that is still there.
      const stillThere = strict && isBotApiError(error) && !isThreadGone(error);
      if (isBotApiError(error) && (isRetryable(error) || stillThere)) {
        record.sessionId = "";
        record.status = "unavailable";
        record.unavailableSince = this.now() - this.config.orphanMs;
        this.registry.save();
        this.event("topic-delete-failed", `${record.name}: ${describeError(error)}`);
        return;
      }
      // A non-retryable refusal (thread not found) means there is nothing to delete.
    }
    this.inbound.remove(nameKey(record.name));
    this.registry.remove(record.name);
    this.registry.save();
    this.event("topic-deleted", `${record.name}: ${why}`);
  }

  /** Persist one update into its topic's queue. Returns where it went, or undefined when dropped. */
  private route(update: BotUpdate): { key: string; dropped: number; callbackQueryId?: string } | undefined {
    const message = update.message;
    const query = update.callback_query;
    if (message === undefined && query === undefined) {
      // A membership change (my_chat_member) is the pairing's business, not a message for a topic.
      return undefined;
    }
    const fromId = message?.from?.id ?? query?.from.id;
    if (fromId === undefined || !this.config.allowedUserIds.includes(fromId)) {
      this.journal.record(fromId);
      this.event("sender-refused", fromId === undefined ? "no sender id" : `user ${fromId}`);
      return undefined;
    }
    const origin = message ?? query?.message;
    const threadId = origin?.message_thread_id;
    if (origin === undefined || origin.chat.id !== this.config.chatId || threadId === undefined) {
      this.event("update-unrouted", `update ${update.update_id}`);
      return undefined;
    }
    const record = this.registry.byThread(origin.chat.id, threadId);
    if (record === undefined) {
      this.event("update-unrouted", `update ${update.update_id}: no session in topic ${threadId}`);
      return undefined;
    }
    const key = nameKey(record.name);
    const base = { id: inboundEntryId(update.update_id), updateId: update.update_id, fromId, receivedAt: this.now() };
    if (message !== undefined) {
      if (typeof message.text !== "string" || message.text.length === 0) {
        return undefined;
      }
      const appended = this.inbound.append(key, { ...base, kind: "text", text: message.text, messageId: message.message_id });
      if (appended.added) {
        // The first thing the sender sees: the message was received. Fire and forget.
        const tracked = this.track(record, update.update_id, message.message_id);
        this.react(tracked, "received");
      }
      return { key, dropped: appended.dropped };
    }
    if (query?.data === undefined) {
      return undefined;
    }
    const appended = this.inbound.append(key, {
      ...base,
      kind: "callback",
      callback: { id: query.id, data: query.data, ...(query.message === undefined ? {} : { messageId: query.message.message_id }) },
    });
    return { key, dropped: appended.dropped, callbackQueryId: query.id };
  }

  // ---- message state: reactions and typing (flow 387, AC18 to AC20) ------------

  private trackKey(threadId: number, updateId: number): string {
    return `${threadId}:${updateId}`;
  }

  private track(record: RemoteSessionRecord, updateId: number, messageId: number): TrackedMessage {
    const key = this.trackKey(record.threadId, updateId);
    const existing = this.tracked.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const entry: TrackedMessage = { chatId: record.chatId, threadId: record.threadId, messageId, state: "received", chain: Promise.resolve() };
    this.tracked.set(key, entry);
    while (this.tracked.size > MAX_TRACKED_MESSAGES) {
      const oldest = this.tracked.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.tracked.delete(oldest);
    }
    return entry;
  }

  /**
   * Put a state on a message as its one reaction. Never awaited by the caller and never throws: a
   * failed reaction must not block or delay the message. A refusal that says the bot may not react
   * in this group turns reactions off and is recorded once.
   */
  private react(message: TrackedMessage, state: ReactionState): void {
    message.state = state;
    if (this.reactionsOff || this.stopped) {
      return;
    }
    message.chain = message.chain.then(async () => {
      if (this.reactionsOff) {
        return;
      }
      let timer: unknown;
      const timeout = new Promise<void>((resolve) => {
        timer = this.timers.setTimeout(resolve, STATE_CALL_TIMEOUT_MS);
      });
      const call = this.api.setMessageReaction({ chatId: message.chatId, messageId: message.messageId, emoji: REACTION_FOR_STATE[state] }).then(
        () => undefined,
        (error: unknown) => this.reactionFailed(error),
      );
      await Promise.race([call, timeout]);
      this.timers.clearTimeout(timer);
    });
  }

  private reactionFailed(error: unknown): void {
    if (!isBotApiError(error) || error.kind !== "rejected" || !isReactionForbidden(error.status, error.message)) {
      return;
    }
    if (!this.reactionsOff) {
      this.reactionsOff = true;
      this.event("reactions-unavailable", `this bot may not react in the group; the topic shows typing only (${describeError(error)})`);
    }
  }

  /**
   * The shell reports where one of its messages is. The state replaces the reaction; "working" also
   * starts the typing indicator and "done"/"failed" stop it. False for an unknown session or a message
   * this hub does not track (a restart forgets them).
   */
  messageState(sessionId: string, updateId: number, state: MessageState): boolean {
    const record = this.registry.bySession(sessionId);
    if (record === undefined) {
      return false;
    }
    const message = this.tracked.get(this.trackKey(record.threadId, updateId));
    if (message === undefined) {
      return false;
    }
    this.react(message, state);
    if (state === "working") {
      this.startTyping(record);
    } else if (state === "done" || state === "failed") {
      this.stopTyping(record);
    }
    return true;
  }

  /** The shell is gone: stop typing, and a message it was still working on is marked failed. */
  endActivity(sessionId: string): void {
    const record = this.registry.bySession(sessionId);
    if (record === undefined) {
      return;
    }
    this.stopTyping(record);
    for (const message of this.tracked.values()) {
      if (message.threadId === record.threadId && (message.state === "reading" || message.state === "working")) {
        this.react(message, "failed");
      }
    }
  }

  private typingKey(record: RemoteSessionRecord): string {
    return `${record.chatId}:${record.threadId}`;
  }

  private startTyping(record: RemoteSessionRecord): void {
    const key = this.typingKey(record);
    if (this.typing.has(key) || this.stopped) {
      return;
    }
    const send = (): void => {
      void this.api.sendChatAction({ chatId: record.chatId, action: "typing", messageThreadId: record.threadId }).catch(() => undefined);
    };
    send();
    this.typing.set(key, this.timers.setInterval(send, TYPING_REFRESH_MS));
  }

  private stopTyping(record: RemoteSessionRecord): void {
    const key = this.typingKey(record);
    const handle = this.typing.get(key);
    if (handle !== undefined) {
      this.timers.clearInterval(handle);
      this.typing.delete(key);
    }
  }

  private dispatch(key: string): Promise<void> {
    const running = this.dispatching.get(key);
    if (running !== undefined) {
      this.redispatch.add(key);
      return running;
    }
    const promise = this.drain(key).finally(() => {
      this.dispatching.delete(key);
    });
    this.dispatching.set(key, promise);
    return promise;
  }

  /** Deliver a topic's pending entries in order; stop at the first the consumer refuses. */
  private async drain(key: string): Promise<void> {
    do {
      this.redispatch.delete(key);
      for (const entry of this.inbound.pending(key)) {
        const record = this.registry.byNameKey(key);
        if (record === undefined || record.status !== "live") {
          return;
        }
        try {
          if (entry.kind === "text") {
            if (entry.messageId !== undefined) {
              // An entry replayed after a restart: its state can still be shown.
              this.track(record, entry.updateId, entry.messageId);
            }
            await this.consumer.deliver(record.sessionId, entry.text ?? "", {
              updateId: entry.updateId,
              threadId: record.threadId,
              fromId: entry.fromId,
              receivedAt: entry.receivedAt,
            });
          } else if (entry.callback !== undefined && this.consumer.deliverCallback !== undefined) {
            await this.consumer.deliverCallback(record.sessionId, {
              updateId: entry.updateId,
              callbackQueryId: entry.callback.id,
              data: entry.callback.data,
              ...(entry.callback.messageId === undefined ? {} : { messageId: entry.callback.messageId }),
              threadId: record.threadId,
              fromId: entry.fromId,
            });
          }
          await this.beforeAck?.(entry);
        } catch (error) {
          this.event("delivery-failed", `${record.name}: ${describeError(error)}`);
          this.scheduleRetry(key);
          return;
        }
        this.inbound.ack(key, entry.id);
      }
    } while (this.redispatch.has(key) && !this.stopped);
  }

  private scheduleRetry(key: string): void {
    if (this.stopped || this.retryTimers.has(key)) {
      return;
    }
    this.retryTimers.set(
      key,
      this.timers.setTimeout(() => {
        this.retryTimers.delete(key);
        void this.dispatch(key);
      }, this.deliverRetryMs),
    );
  }
}
