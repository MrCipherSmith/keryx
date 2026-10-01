// Pairing: find the operator's Telegram ids from Telegram itself (flow 377).
//
// Nothing here is typed by the operator except the bot token, which is not in this
// file at all (the caller hands over a `BotApi` that already holds it). The ids come
// from what Telegram reports:
//
//   1. The operator sends the bot a private message that carries a one-time code.
//      The first message that does adds its SENDER to the allowlist (`userId`). The
//      code is single-use and lives ten minutes; a message without the right code is
//      ignored without a reply, so a stranger learns nothing.
//   2. The operator adds the bot to a group. The group id comes from the
//      `my_chat_member` update, and only one whose sender is the paired user counts,
//      so nobody else can nominate a group. The group is then checked: it must be a
//      forum (topics on) and the bot must hold the manage-topics right. What is
//      missing is named, and the check repeats until it passes.
//
// The poller here is the only getUpdates consumer for this token while a pairing is
// open (serve starts no hub for an unconfigured channel), so Telegram's one-poller
// rule holds.

import { randomInt } from "node:crypto";
import { redactSensitiveText } from "../security/service";
import { type HubTimers, realTimers } from "./hub";
import { type PollerStatus, UpdatePoller } from "./poller";
import type { PairingState } from "./protocol";
import { type BotApi, type BotUpdate, isBotApiError } from "./types";

export const PAIRING_CODE_TTL_MS = 10 * 60_000;
// No 0/O, 1/I/L: the code is read off a screen and typed on a phone.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export function newPairingCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export interface PairingSnapshot {
  state: PairingState;
  /** Present until a user has been paired: a used code is gone. */
  code?: string;
  botUsername?: string;
  expiresAt: number;
  userId?: number;
  chatId?: number;
  chatTitle?: string;
  problems: string[];
  reason?: string;
}

export interface PairingOptions {
  api: BotApi;
  now?: () => number;
  ttlMs?: number;
  timers?: HubTimers;
  /** Test seam: the code to use. */
  code?: string;
  pollTimeoutSec?: number;
  pollBackoffMs?: number[];
  pollSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called once when the pairing reaches a final state (ready, failed, expired, cancelled). */
  onFinished?: (snapshot: PairingSnapshot) => void;
}

export type OpenPairingResult =
  | { ok: true; pairing: Pairing }
  | { ok: false; kind: "rejected" | "unreachable"; reason: string };

function describe(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function normalise(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const FINAL: ReadonlySet<PairingState> = new Set(["ready", "failed", "expired", "cancelled"]);

export class Pairing {
  private state: PairingState = "waiting-for-user";
  private code: string | undefined;
  private readonly expiresAt: number;
  private userId: number | undefined;
  private chatId: number | undefined;
  private chatTitle: string | undefined;
  private problems: string[] = [];
  private reason: string | undefined;
  private candidate: number | undefined;
  private readonly poller: UpdatePoller;
  private readonly now: () => number;
  private readonly timers: HubTimers;
  private expiryTimer: unknown;
  private finished = false;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: PairingOptions,
    private readonly bot: { id: number; username?: string },
  ) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? realTimers;
    this.code = options.code ?? newPairingCode();
    this.expiresAt = this.now() + (options.ttlMs ?? PAIRING_CODE_TTL_MS);
    this.poller = new UpdatePoller({
      api: options.api,
      sink: { accept: (updates) => this.accept(updates) },
      ...(options.pollTimeoutSec === undefined ? {} : { timeoutSec: options.pollTimeoutSec }),
      ...(options.pollBackoffMs === undefined ? {} : { backoffMs: options.pollBackoffMs }),
      ...(options.pollSleep === undefined ? {} : { sleep: options.pollSleep }),
      onStatus: (status) => this.onPollerStatus(status),
    });
  }

  /** Ask Telegram who the token belongs to, then begin listening. A bad token is refused here, before anything else happens. */
  static async open(options: PairingOptions): Promise<OpenPairingResult> {
    let bot: { id: number; username?: string };
    try {
      bot = await options.api.getMe();
    } catch (error) {
      if (isBotApiError(error) && error.kind === "rejected") {
        return { ok: false, kind: "rejected", reason: "Telegram does not accept this bot token; check it with BotFather and try again." };
      }
      return { ok: false, kind: "unreachable", reason: `could not reach Telegram: ${describe(error)}` };
    }
    const pairing = new Pairing(options, bot);
    pairing.begin();
    return { ok: true, pairing };
  }

  private begin(): void {
    const handle = this.timers.setTimeout(() => this.expireIfDue(), Math.max(0, this.expiresAt - this.now()) + 1);
    (handle as { unref?: () => void } | undefined)?.unref?.();
    this.expiryTimer = handle;
    this.poller.start();
  }

  snapshot(): PairingSnapshot {
    this.expireIfDue();
    return {
      state: this.state,
      ...(this.code === undefined ? {} : { code: this.code }),
      ...(this.bot.username === undefined ? {} : { botUsername: this.bot.username }),
      expiresAt: this.expiresAt,
      ...(this.userId === undefined ? {} : { userId: this.userId }),
      ...(this.chatId === undefined ? {} : { chatId: this.chatId }),
      ...(this.chatTitle === undefined ? {} : { chatTitle: this.chatTitle }),
      problems: [...this.problems],
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    };
  }

  isFinal(): boolean {
    this.expireIfDue();
    return FINAL.has(this.state);
  }

  /** Look at the group again (the operator has just changed its settings). */
  async recheck(): Promise<void> {
    if (this.state === "waiting-for-group" && this.candidate !== undefined) {
      const chatId = this.candidate;
      await this.enqueue(() => this.inspectGroup(chatId));
    }
  }

  async cancel(): Promise<void> {
    if (!FINAL.has(this.state)) {
      this.settle("cancelled");
    }
    await this.poller.stop();
  }

  /** Stop listening and wait for the loop to end. */
  async stop(): Promise<void> {
    await this.poller.stop();
  }

  private onPollerStatus(status: PollerStatus): void {
    if (status.state === "conflict" && !FINAL.has(this.state)) {
      this.reason = status.reason ?? "another poller owns this bot token";
      this.settle("failed");
    }
  }

  private expireIfDue(): void {
    if (!FINAL.has(this.state) && this.now() > this.expiresAt) {
      this.code = undefined;
      this.settle("expired");
    }
  }

  private settle(state: PairingState): void {
    this.state = state;
    if (FINAL.has(state)) {
      this.code = undefined;
      if (this.expiryTimer !== undefined) {
        this.timers.clearTimeout(this.expiryTimer);
        this.expiryTimer = undefined;
      }
      // Stopping the loop from inside its own sink would wait on itself; let it unwind first.
      void this.poller.stop();
      if (!this.finished) {
        this.finished = true;
        this.options.onFinished?.(this.snapshot());
      }
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private accept(updates: BotUpdate[]): Promise<void> {
    return this.enqueue(async () => {
      for (const update of updates) {
        if (FINAL.has(this.state)) {
          return;
        }
        if (this.now() > this.expiresAt) {
          this.expireIfDue();
          return;
        }
        if (this.state === "waiting-for-user") {
          await this.takeCode(update);
        } else if (this.state === "waiting-for-group") {
          await this.takeGroup(update);
        }
      }
    });
  }

  private async takeCode(update: BotUpdate): Promise<void> {
    const message = update.message;
    if (message === undefined || message.chat.type !== "private" || message.from === undefined || typeof message.text !== "string") {
      return;
    }
    // A forwarded message was typed by someone else; the code must be the whole message (or the `/start <code>` deep link).
    if (message.forward_origin !== undefined || message.forward_date !== undefined) {
      return;
    }
    const sent = message.text.trim().replace(/^\/start(?:@\w+)?\s+/i, "");
    if (this.code === undefined || normalise(sent) !== this.code) {
      // No reply: a stranger learns nothing, not even that a pairing is open.
      return;
    }
    this.userId = message.from.id;
    this.code = undefined;
    this.state = "waiting-for-group";
    await this.options.api
      .sendMessage({ chatId: message.chat.id, text: "Paired. Now add me to your group (a group with Topics turned on) and make me an administrator." })
      .catch(() => undefined);
  }

  private async takeGroup(update: BotUpdate): Promise<void> {
    const change = update.my_chat_member;
    if (change === undefined || change.from.id !== this.userId) {
      return;
    }
    const type = change.chat.type;
    if (type !== "group" && type !== "supergroup") {
      return;
    }
    const status = change.new_chat_member.status;
    if (status !== "member" && status !== "administrator") {
      return;
    }
    this.candidate = change.chat.id;
    if (change.chat.title !== undefined) {
      this.chatTitle = change.chat.title;
    }
    await this.inspectGroup(change.chat.id);
  }

  private async inspectGroup(chatId: number): Promise<void> {
    if (FINAL.has(this.state)) {
      return;
    }
    const problems: string[] = [];
    try {
      const chat = await this.options.api.getChat({ chatId });
      if (chat.title !== undefined) {
        this.chatTitle = chat.title;
      }
      if (chat.is_forum !== true) {
        problems.push("Topics are off in this group: open the group settings and turn Topics on.");
      }
      const member = await this.options.api.getChatMember({ chatId, userId: this.bot.id });
      if (member.status !== "administrator" && member.status !== "creator") {
        problems.push("Make the bot an administrator of the group.");
      } else if (member.status === "administrator" && member.can_manage_topics !== true) {
        problems.push("Give the bot the Manage Topics right in the group's administrator settings.");
      }
    } catch (error) {
      problems.push(`could not inspect the group: ${describe(error)}`);
    }
    this.problems = problems;
    if (problems.length === 0) {
      this.chatId = chatId;
      this.settle("ready");
    }
  }
}
