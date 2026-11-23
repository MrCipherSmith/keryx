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
//      missing is named, and the check repeats until it passes. Turning Topics on makes
//      Telegram move a basic group to a new supergroup id; the `migrate_to_chat_id` /
//      `migrate_from_chat_id` service message moves the candidate along with it.
//
// The poller here is the only getUpdates consumer for this token while a pairing is
// open (serve starts no hub for an unconfigured channel), so Telegram's one-poller
// rule holds.

import { randomInt } from "node:crypto";
import { redactSensitiveText } from "../security/service";
import { sendHtml } from "./format-html";
import { type HubTimers, realTimers } from "./hub";
import { type PollerStatus, UpdatePoller } from "./poller";
import type { PairingMembershipDiagnostic, PairingState } from "./protocol";
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
  /** A separate, short-lived command challenge for a forum where the bot is already installed. */
  forumCode?: string;
  membership?: PairingMembershipDiagnostic;
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
  requireConfirmation?: boolean;
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
// The bot may be added to the group a moment before the code is sent; that event is kept, not lost.
const EARLY_GROUP_EVENTS = 20;

export class Pairing {
  private state: PairingState = "waiting-for-user";
  private code: string | undefined;
  private forumCode: string | undefined;
  private membership: PairingMembershipDiagnostic = { received: 0, last: "none" };
  private expiresAt: number;
  private readonly ttlMs: number;
  private readonly earlyGroups = new Map<number, BotUpdate>();
  // Basic group -> supergroup moves seen before the code: replayed after the group events, so the candidate ends on the new id.
  private earlyMigrations: BotUpdate[] = [];
  private userId: number | undefined;
  private chatId: number | undefined;
  private chatTitle: string | undefined;
  private problems: string[] = [];
  private reason: string | undefined;
  private candidate: number | undefined;
  private candidateRequiresOperatorAdmin = false;
  private readonly poller: UpdatePoller;
  private readonly now: () => number;
  private readonly timers: HubTimers;
  private expiryTimer: unknown;
  private finished = false;
  private begun = false;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: PairingOptions,
    private readonly bot: { id: number; username?: string },
  ) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? realTimers;
    this.code = options.code ?? newPairingCode();
    this.ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
    this.expiresAt = this.now() + this.ttlMs;
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
    const prepared = await Pairing.prepare(options);
    if (prepared.ok) {
      prepared.pairing.begin();
    }
    return prepared;
  }

  /**
   * Validate the token (getMe) but do not listen yet. The caller starts it with `begin()`, so it can
   * end a pairing that already exists for the same token in between (Telegram allows one poller per
   * token) and a bad token never disturbs it.
   */
  static async prepare(options: PairingOptions): Promise<OpenPairingResult> {
    let bot: { id: number; username?: string };
    try {
      bot = await options.api.getMe();
    } catch (error) {
      if (isBotApiError(error) && error.kind === "rejected") {
        return { ok: false, kind: "rejected", reason: "Telegram does not accept this bot token; check it with BotFather and try again." };
      }
      return { ok: false, kind: "unreachable", reason: `could not reach Telegram: ${describe(error)}` };
    }
    return { ok: true, pairing: new Pairing(options, bot) };
  }

  /** Start the ten minutes of the code and the listening. Only once, and not for a pairing that has ended. */
  begin(): void {
    if (this.begun || FINAL.has(this.state)) {
      return;
    }
    this.begun = true;
    this.expiresAt = this.now() + this.ttlMs;
    this.armExpiryTimer();
    this.poller.start();
  }

  private armExpiryTimer(): void {
    if (this.expiryTimer !== undefined) {
      this.timers.clearTimeout(this.expiryTimer);
    }
    const handle = this.timers.setTimeout(() => this.expireIfDue(), Math.max(0, this.expiresAt - this.now()) + 1);
    (handle as { unref?: () => void } | undefined)?.unref?.();
    this.expiryTimer = handle;
  }

  snapshot(): PairingSnapshot {
    this.expireIfDue();
    return {
      state: this.state,
      ...(this.code === undefined ? {} : { code: this.code }),
      ...(this.forumCode === undefined ? {} : { forumCode: this.forumCode }),
      ...(this.options.requireConfirmation === true ? { membership: { ...this.membership } } : {}),
      ...(this.bot.username === undefined ? {} : { botUsername: this.bot.username }),
      expiresAt: this.expiresAt,
      ...(this.userId === undefined ? {} : { userId: this.userId }),
      ...(this.chatId === undefined ? {} : { chatId: this.chatId }),
      ...(this.chatTitle === undefined ? {} : { chatTitle: this.chatTitle }),
      problems: [...this.problems],
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    };
  }

  identity(): { id: number; username?: string } { return { ...this.bot }; }

  isFinal(): boolean {
    this.expireIfDue();
    return FINAL.has(this.state);
  }

  /** The Telegram steps are done and nothing has consumed the result yet: Resume can still connect it. */
  isReady(): boolean {
    this.expireIfDue();
    return this.state === "ready";
  }

  /** Confirm the account before inspecting any nominated group. */
  async confirmAccount(): Promise<boolean> {
    let confirmed = false;
    await this.enqueue(async () => {
      this.expireIfDue();
      if (this.state !== "waiting-for-confirmation" || this.userId === undefined) return;
      this.state = "waiting-for-group";
      this.forumCode = newPairingCode();
      this.expiresAt = this.now() + this.ttlMs;
      this.armExpiryTimer();
      confirmed = true;
      await this.replayGroupEvents();
    });
    return confirmed;
  }

  /** Look at the group again (the operator has just changed its settings). */
  async recheck(): Promise<void> {
    if (this.state === "waiting-for-group" && this.candidate !== undefined) {
      // Read the candidate when the work runs, not now: a queued migration may move it in between.
      await this.enqueue(async () => {
        if (this.state === "waiting-for-group" && this.candidate !== undefined) {
          await this.inspectGroup(this.candidate);
        }
      });
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
    if (FINAL.has(this.state)) {
      return;
    }
    this.state = state;
    if (FINAL.has(state)) {
      this.code = undefined;
      this.forumCode = undefined;
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
        if (update.my_chat_member !== undefined) this.membership.received += 1;
        if (this.state === "waiting-for-user") {
          if (this.options.requireConfirmation !== true) this.rememberGroupEvent(update);
          else if (update.my_chat_member !== undefined) this.membership.last = "before-claim";
          await this.takeCode(update);
        } else if (this.state === "waiting-for-confirmation") {
          this.deferGroupEvent(update);
        } else if (this.state === "waiting-for-group") {
          await this.takeGroup(update);
          await this.takeForumCommand(update);
          await this.takeMigration(update);
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
    if (this.options.requireConfirmation === true) {
      this.state = "waiting-for-confirmation";
      this.earlyGroups.clear();
      this.earlyMigrations = [];
      return;
    }
    this.state = "waiting-for-group";
    // The code's ten minutes are spent; the group step gets its own.
    this.expiresAt = this.now() + this.ttlMs;
    this.armExpiryTimer();
    await sendHtml(this.options.api, {
      chatId: message.chat.id,
      text: "Paired. Now add me to your group (a group with Topics turned on) and make me an administrator.",
    }).catch(() => undefined);
    await this.replayGroupEvents();
  }

  private async replayGroupEvents(): Promise<void> {
    const early = [...this.earlyGroups.values()];
    const earlyMoves = this.earlyMigrations;
    this.earlyGroups.clear();
    this.earlyMigrations = [];
    for (const event of early) {
      if (this.state !== "waiting-for-group") {
        break;
      }
      await this.takeGroup(event);
    }
    // After the groups, in the order they arrived: a move only applies to the candidate the groups settled on.
    for (const event of earlyMoves) {
      if (this.state !== "waiting-for-group") {
        break;
      }
      await this.takeMigration(event);
    }
  }

  private deferGroupEvent(update: BotUpdate): void {
    if (update.my_chat_member !== undefined) {
      const result = this.membershipResult(update.my_chat_member);
      this.membership.last = result === "inspecting" ? "deferred" : result;
      if (result !== "inspecting") return;
    }
    this.rememberGroupEvent(update);
  }

  private rememberGroupEvent(update: BotUpdate): void {
    const message = update.message;
    if (message !== undefined && (typeof message.migrate_to_chat_id === "number" || typeof message.migrate_from_chat_id === "number")) {
      this.earlyMigrations.push(update);
      if (this.earlyMigrations.length > EARLY_GROUP_EVENTS) {
        this.earlyMigrations.shift();
      }
      return;
    }
    const change = update.my_chat_member;
    if (change === undefined) {
      return;
    }
    this.earlyGroups.delete(change.chat.id);
    this.earlyGroups.set(change.chat.id, update);
    if (this.earlyGroups.size > EARLY_GROUP_EVENTS) {
      const oldest = this.earlyGroups.keys().next().value;
      if (oldest !== undefined) {
        this.earlyGroups.delete(oldest);
      }
    }
  }

  private async takeGroup(update: BotUpdate): Promise<void> {
    const change = update.my_chat_member;
    if (change === undefined) return;
    const result = this.membershipResult(change);
    this.membership.last = result;
    if (result !== "inspecting") return;
    this.candidate = change.chat.id;
    this.candidateRequiresOperatorAdmin = false;
    this.chatTitle = change.chat.title;
    await this.inspectGroup(change.chat.id);
  }

  private membershipResult(change: NonNullable<BotUpdate["my_chat_member"]>): PairingMembershipDiagnostic["last"] {
    if (change.from.id !== this.userId) return "different-account";
    if (change.chat.type !== "group" && change.chat.type !== "supergroup") return "unsupported-chat";
    const role = change.new_chat_member.status;
    return role === "member" || role === "administrator" ? "inspecting" : "unsupported-role";
  }

  private async takeForumCommand(update: BotUpdate): Promise<void> {
    const message = update.message;
    if (this.state !== "waiting-for-group" || this.forumCode === undefined || message?.chat.type !== "supergroup" ||
      message.from?.id !== this.userId || message.sender_chat !== undefined || message.forward_origin !== undefined ||
      message.forward_date !== undefined || typeof message.text !== "string") return;
    const [command, code, extra] = message.text.trim().split(/\s+/);
    const addressed = this.bot.username && `/keryx_pair_forum@${this.bot.username.toLowerCase()}`;
    if ((command?.toLowerCase() !== "/keryx_pair_forum" && command?.toLowerCase() !== addressed) ||
      code?.toUpperCase() !== this.forumCode || extra !== undefined) return;
    this.candidate = message.chat.id;
    this.candidateRequiresOperatorAdmin = true;
    this.chatTitle = undefined;
    await this.inspectGroup(message.chat.id);
  }

  /**
   * Turning Topics on converts a basic group into a supergroup with a NEW chat id: Telegram sends a
   * service message with `migrate_to_chat_id` on the old chat and `migrate_from_chat_id` on the new one.
   * The sender is not checked. The guard is the candidate match: a `migrate_to_chat_id` counts only when it
   * arrives in the candidate chat (`chat.id === candidate`), and a `migrate_from_chat_id` only when it names
   * the candidate. A move from any other chat is ignored; the new chat is then inspected like any group.
   */
  private async takeMigration(update: BotUpdate): Promise<void> {
    const message = update.message;
    if (message === undefined || this.candidate === undefined || FINAL.has(this.state)) {
      return;
    }
    let next: number | undefined;
    if (typeof message.migrate_to_chat_id === "number" && message.chat.id === this.candidate) {
      next = message.migrate_to_chat_id;
    } else if (typeof message.migrate_from_chat_id === "number" && message.migrate_from_chat_id === this.candidate) {
      next = message.chat.id;
    }
    if (next === undefined || next === this.candidate) {
      return;
    }
    this.candidate = next;
    await this.inspectGroup(next);
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
      if (this.candidateRequiresOperatorAdmin && this.userId !== undefined && problems.length === 0) {
        const operator = await this.options.api.getChatMember({ chatId, userId: this.userId });
        if (operator.status !== "administrator" && operator.status !== "creator") {
          problems.push("The confirmed Telegram account must be an administrator of this forum.");
        }
      }
    } catch (error) {
      problems.push(`could not inspect the group: ${describe(error)}`);
    }
    // The pairing may have been cancelled, have expired or have failed while Telegram was answering.
    this.expireIfDue();
    if (FINAL.has(this.state)) {
      return;
    }
    this.problems = problems;
    if (problems.length === 0) {
      this.chatId = chatId;
      this.settle("ready");
    }
  }
}
