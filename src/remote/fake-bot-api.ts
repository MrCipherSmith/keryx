// An in-process fake of the Telegram Bot API (flow 376, block 1).
//
// Every remote-control test runs against this class; none opens a socket. It is
// a production-tree module rather than a test helper because the packaged
// smoke (AC16) starts `keryx serve` against it too.
//
// What it models, because the serve side depends on each of these:
//   - getUpdates offset semantics: an update stays until a later call carries a
//     higher `offset`; `update_id` is a strictly increasing sequence.
//   - long polling: an empty call parks until an update arrives, the timeout
//     elapses or the caller aborts.
//   - ONE poller per token: a second client's getUpdates while another client's
//     call is in flight gets 409 Conflict, as Telegram answers it.
//   - forum topics: ids from a counter, sendMessage into a missing topic is a
//     400, deleting twice is a 400.
//   - 429 with retry_after, 5xx and a whole-API outage, injected per method.
//   - callback queries, with the message the buttons belong to.
//   - `parse_mode: "HTML"`: the text is checked as strictly as Telegram checks it
//     (documented tags, balanced, `&` `<` `>` escaped); a malformed text is a 400
//     "can't parse entities", and the 4096 limit counts the text AFTER parsing.
//
// `connect(label)` returns another client over the SAME state: that is how a
// test models two `keryx serve` processes on one bot token.

import {
  type BotApi,
  BotApiError,
  type BotCallbackQuery,
  type BotChatAction,
  type BotCommandMenuEntry,
  type BotChatInfo,
  type BotChatMemberInfo,
  type BotIdentity,
  type BotUpdate,
  type GetUpdatesParams,
  type InlineKeyboard,
  type SendMessageParams,
  TELEGRAM_MAX_TEXT,
} from "./types";
import { checkTelegramHtml } from "./format-html";

export interface FakeTopic {
  messageThreadId: number;
  name: string;
  createdAt: number;
}

export interface FakeSentMessage {
  messageId: number;
  chatId: number;
  messageThreadId?: number;
  /** As sent: Telegram HTML when `parseMode` is "HTML". */
  text: string;
  parseMode?: "HTML";
  inlineKeyboard?: InlineKeyboard;
  at: number;
}

/** One edit of a message the bot sent. */
export interface FakeEdit {
  messageId: number;
  kind: "text" | "markup";
  /** The new text, for a text edit. */
  text?: string;
  /** The keyboard after the edit; empty when the buttons were removed. */
  inlineKeyboard: InlineKeyboard;
  at: number;
}

export interface FakeReaction {
  messageId: number;
  chatId: number;
  /** Undefined: the reaction was cleared. */
  emoji?: string;
  at: number;
}

export interface FakeChatAction {
  chatId: number;
  action: BotChatAction;
  messageThreadId?: number;
  at: number;
}

export interface FakeAnsweredCallback {
  callbackQueryId: string;
  text?: string;
}

export interface FakeBotApiOptions {
  /** The supergroup the topics live in. Default -1001234567890. */
  chatId?: number;
  firstUpdateId?: number;
  firstThreadId?: number;
  now?: () => number;
  /** The bot's own user id and username (getMe). */
  botId?: number;
  botUsername?: string;
}

export type FakeMethod =
  | "getUpdates"
  | "sendMessage"
  | "editMessageReplyMarkup"
  | "editMessageText"
  | "setMyCommands"
  | "setMessageReaction"
  | "sendChatAction"
  | "createForumTopic"
  | "deleteForumTopic"
  | "editForumTopic"
  | "answerCallbackQuery"
  | "getMe"
  | "getChat"
  | "getChatMember";

interface Fault {
  error: BotApiError;
  remaining: number;
}

/** A client over the shared fake state, with its own poller identity. */
export interface FakeBotClient extends BotApi {
  readonly label: string;
}

export class FakeBotApi implements BotApi {
  readonly chatId: number;
  readonly sent: FakeSentMessage[] = [];
  readonly answeredCallbacks: FakeAnsweredCallback[] = [];
  /** Every successful edit, in order. The edited message itself in `sent` shows the state after the edit. */
  readonly edits: FakeEdit[] = [];
  /** Every successful reaction call, in order. */
  readonly reactions: FakeReaction[] = [];
  /** Every successful chat action, in order. */
  readonly chatActions: FakeChatAction[] = [];
  /** The last command menu the bot set, and every call. */
  myCommands: BotCommandMenuEntry[] = [];
  readonly myCommandsCalls: BotCommandMenuEntry[][] = [];
  readonly deletedTopics: { chatId: number; messageThreadId: number }[] = [];
  readonly renamedTopics: { messageThreadId: number; name: string }[] = [];
  /** Every call, in order, by client label. */
  readonly calls: { method: FakeMethod; label: string }[] = [];

  private readonly now: () => number;
  private updateSeq: number;
  private threadSeq: number;
  private messageSeq = 1000;
  private callbackSeq = 1;
  private updates: BotUpdate[] = [];
  private readonly liveTopics = new Map<number, FakeTopic>();
  private readonly faults = new Map<FakeMethod, Fault[]>();
  private down = false;
  private tokenRejected = false;
  private forum = true;
  private botCanManageTopics = true;
  private botStatus = "administrator";
  private botCanReact = true;
  private readonly botId: number;
  private readonly botUsername: string;
  private readonly inFlightPollers = new Set<string>();
  private readonly waiters = new Set<() => void>();
  private readonly defaultClient: FakeBotClient;

  constructor(options: FakeBotApiOptions = {}) {
    this.chatId = options.chatId ?? -1001234567890;
    this.updateSeq = options.firstUpdateId ?? 1000;
    this.threadSeq = options.firstThreadId ?? 100;
    this.now = options.now ?? Date.now;
    this.botId = options.botId ?? 777000111;
    this.botUsername = options.botUsername ?? "keryx_fake_bot";
    this.defaultClient = this.connect("default");
  }

  // ---- test-side controls -------------------------------------------------

  /** A client with its own poller identity over the same state. */
  connect(label: string): FakeBotClient {
    return {
      label,
      getUpdates: (params) => this.getUpdatesFor(label, params),
      sendMessage: (params) => this.sendMessageFor(label, params),
      editMessageReplyMarkup: (params) => this.editMarkupFor(label, params),
      editMessageText: (params) => this.editTextFor(label, params),
      setMyCommands: (params) => this.setCommandsFor(label, params),
      setMessageReaction: (params) => this.reactFor(label, params),
      sendChatAction: (params) => this.chatActionFor(label, params),
      createForumTopic: (params) => this.createTopicFor(label, params),
      deleteForumTopic: (params) => this.deleteTopicFor(label, params),
      editForumTopic: (params) => this.editTopicFor(label, params),
      answerCallbackQuery: (params) => this.answerFor(label, params),
      getMe: () => this.getMeFor(label),
      getChat: (params) => this.getChatFor(label, params),
      getChatMember: (params) => this.getChatMemberFor(label, params),
    };
  }

  /** A private message to the bot: the chat is the sender's own. */
  pushPrivateMessage(input: { fromId: number; text: string; forwarded?: boolean }): BotUpdate {
    const message = {
      message_id: ++this.messageSeq,
      from: { id: input.fromId },
      chat: { id: input.fromId, type: "private" },
      date: Math.floor(this.now() / 1000),
      text: input.text,
      ...(input.forwarded === true ? { forward_origin: { type: "user", date: 1 }, forward_date: 1 } : {}),
    };
    return this.enqueueUpdate({ message });
  }

  /** The bot's membership of a chat changed (Telegram's `my_chat_member`). */
  pushMyChatMember(input: { fromId: number; chatId?: number; status?: string; type?: string; title?: string }): BotUpdate {
    return this.enqueueUpdate({
      my_chat_member: {
        chat: { id: input.chatId ?? this.chatId, type: input.type ?? "supergroup", ...(input.title === undefined ? {} : { title: input.title }) },
        from: { id: input.fromId },
        date: Math.floor(this.now() / 1000),
        old_chat_member: { status: "left" },
        new_chat_member: { status: input.status ?? "member" },
      },
    });
  }

  /**
   * A basic group became a supergroup (Topics turned on): Telegram's service message with
   * `migrate_to_chat_id` on the old chat (`side: "to"`) or `migrate_from_chat_id` on the new one (`side: "from"`).
   */
  pushMigration(input: { fromId: number; oldChatId: number; newChatId: number; side?: "to" | "from" }): BotUpdate {
    const from = input.side === "from";
    const message = {
      message_id: ++this.messageSeq,
      from: { id: input.fromId },
      chat: { id: from ? input.newChatId : input.oldChatId, type: from ? "supergroup" : "group" },
      date: Math.floor(this.now() / 1000),
      ...(from ? { migrate_from_chat_id: input.oldChatId } : { migrate_to_chat_id: input.newChatId }),
    };
    return this.enqueueUpdate({ message });
  }

  /** Every call answers 401, as Telegram does for a token it does not know. */
  setTokenRejected(rejected: boolean): void {
    this.tokenRejected = rejected;
  }

  /** Whether the bot may put reactions on messages. Off: `setMessageReaction` is a 400, as in a group that forbids it. */
  setBotCanReact(canReact: boolean): void {
    this.botCanReact = canReact;
  }

  /** The reaction currently on a message (the last call wins), if any. */
  reactionOn(messageId: number): string | undefined {
    for (let index = this.reactions.length - 1; index >= 0; index -= 1) {
      const entry = this.reactions[index];
      if (entry !== undefined && entry.messageId === messageId) {
        return entry.emoji;
      }
    }
    return undefined;
  }

  /** The message the bot sent with this id, as it shows now (after edits). */
  message(messageId: number): FakeSentMessage | undefined {
    return this.sent.find((entry) => entry.messageId === messageId);
  }

  /** Whether the group has topics enabled. */
  setForum(forum: boolean): void {
    this.forum = forum;
  }

  /** The bot's right to manage topics, and its status in the group. */
  setBotRights(rights: { canManageTopics: boolean; status?: string }): void {
    this.botCanManageTopics = rights.canManageTopics;
    if (rights.status !== undefined) {
      this.botStatus = rights.status;
    }
  }

  /** Simulate an operator or an attacker writing in a topic. */
  pushMessage(input: { fromId: number; text: string; threadId?: number; chatId?: number }): BotUpdate {
    const message = {
      message_id: ++this.messageSeq,
      ...(input.threadId === undefined ? {} : { message_thread_id: input.threadId }),
      from: { id: input.fromId },
      chat: { id: input.chatId ?? this.chatId },
      date: Math.floor(this.now() / 1000),
      text: input.text,
    };
    return this.enqueueUpdate({ message });
  }

  /** Simulate a press on an inline button. */
  pushCallback(input: { fromId: number; data: string; threadId?: number; chatId?: number; messageId?: number }): BotUpdate {
    const query: BotCallbackQuery = {
      id: `cb-${this.callbackSeq++}`,
      from: { id: input.fromId },
      data: input.data,
      message: {
        message_id: input.messageId ?? this.messageSeq,
        ...(input.threadId === undefined ? {} : { message_thread_id: input.threadId }),
        chat: { id: input.chatId ?? this.chatId },
        date: Math.floor(this.now() / 1000),
      },
    };
    return this.enqueueUpdate({ callback_query: query });
  }

  /** Every call of every method fails as a network error until switched off. */
  setDown(down: boolean): void {
    this.down = down;
    if (!down) {
      this.wake();
    }
  }

  /** The next `count` calls of `method` fail with `error`. */
  failNext(method: FakeMethod, error: BotApiError, count = 1): void {
    const list = this.faults.get(method) ?? [];
    list.push({ error, remaining: count });
    this.faults.set(method, list);
  }

  /** The next `count` calls of `method` answer 429 with `retry_after`. */
  rateLimitNext(method: FakeMethod, retryAfterSec: number, count = 1): void {
    this.failNext(
      method,
      new BotApiError("rate-limited", `${method}: 429 Too Many Requests: retry after ${retryAfterSec}`, {
        status: 429,
        retryAfterSec,
      }),
      count,
    );
  }

  topics(): FakeTopic[] {
    return [...this.liveTopics.values()];
  }

  topic(messageThreadId: number): FakeTopic | undefined {
    return this.liveTopics.get(messageThreadId);
  }

  /** Messages the bot sent into one topic, oldest first. */
  sentTo(messageThreadId: number): FakeSentMessage[] {
    return this.sent.filter((entry) => entry.messageThreadId === messageThreadId);
  }

  /** Updates still held by Telegram (not yet confirmed by an offset). */
  pendingUpdates(): BotUpdate[] {
    return [...this.updates];
  }

  callCount(method: FakeMethod, label?: string): number {
    return this.calls.filter((call) => call.method === method && (label === undefined || call.label === label)).length;
  }

  /** getUpdates calls currently parked or running. */
  activePollers(): number {
    return this.inFlightPollers.size;
  }

  // ---- BotApi on the default client ---------------------------------------

  getUpdates(params: GetUpdatesParams): Promise<BotUpdate[]> {
    return this.defaultClient.getUpdates(params);
  }

  sendMessage(params: SendMessageParams): Promise<{ message_id: number }> {
    return this.defaultClient.sendMessage(params);
  }

  editMessageReplyMarkup(params: { chatId: number; messageId: number; inlineKeyboard?: InlineKeyboard }): Promise<void> {
    return this.defaultClient.editMessageReplyMarkup(params);
  }

  editMessageText(params: {
    chatId: number;
    messageId: number;
    text: string;
    parseMode?: "HTML";
    inlineKeyboard?: InlineKeyboard;
  }): Promise<void> {
    return this.defaultClient.editMessageText(params);
  }

  setMyCommands(params: { commands: BotCommandMenuEntry[]; chatId?: number }): Promise<void> {
    return this.defaultClient.setMyCommands(params);
  }

  setMessageReaction(params: { chatId: number; messageId: number; emoji?: string }): Promise<void> {
    return this.defaultClient.setMessageReaction(params);
  }

  sendChatAction(params: { chatId: number; action: BotChatAction; messageThreadId?: number }): Promise<void> {
    return this.defaultClient.sendChatAction(params);
  }

  createForumTopic(params: { chatId: number; name: string }): Promise<{ message_thread_id: number }> {
    return this.defaultClient.createForumTopic(params);
  }

  deleteForumTopic(params: { chatId: number; messageThreadId: number }): Promise<void> {
    return this.defaultClient.deleteForumTopic(params);
  }

  editForumTopic(params: { chatId: number; messageThreadId: number; name: string }): Promise<void> {
    return this.defaultClient.editForumTopic(params);
  }

  answerCallbackQuery(params: { callbackQueryId: string; text?: string }): Promise<void> {
    return this.defaultClient.answerCallbackQuery(params);
  }

  getMe(): Promise<BotIdentity> {
    return this.defaultClient.getMe();
  }

  getChat(params: { chatId: number }): Promise<BotChatInfo> {
    return this.defaultClient.getChat(params);
  }

  getChatMember(params: { chatId: number; userId: number }): Promise<BotChatMemberInfo> {
    return this.defaultClient.getChatMember(params);
  }

  // ---- implementation -----------------------------------------------------

  private enqueueUpdate(body: Omit<BotUpdate, "update_id">): BotUpdate {
    const update: BotUpdate = { update_id: ++this.updateSeq, ...body };
    this.updates.push(update);
    this.wake();
    return update;
  }

  private wake(): void {
    for (const wake of [...this.waiters]) {
      wake();
    }
  }

  private begin(method: FakeMethod, label: string): void {
    this.calls.push({ method, label });
    if (this.tokenRejected) {
      throw rejected(method, 401, "Unauthorized");
    }
    if (this.down) {
      throw new BotApiError("network", `${method}: request failed (fake API is down)`);
    }
    const list = this.faults.get(method);
    const fault = list?.[0];
    if (list !== undefined && fault !== undefined) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) {
        list.shift();
      }
      throw fault.error;
    }
  }

  private async getUpdatesFor(label: string, params: GetUpdatesParams): Promise<BotUpdate[]> {
    this.begin("getUpdates", label);
    const other = [...this.inFlightPollers].find((candidate) => candidate !== label);
    if (other !== undefined) {
      throw new BotApiError(
        "conflict",
        "getUpdates: 409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
        { status: 409 },
      );
    }
    if (params.signal?.aborted === true) {
      throw abortError();
    }
    if (params.offset !== undefined) {
      const offset = params.offset;
      this.updates = this.updates.filter((update) => update.update_id >= offset);
    }
    const limit = params.limit ?? 100;
    const timeoutSec = params.timeoutSec ?? 0;
    this.inFlightPollers.add(label);
    try {
      if (this.updates.length === 0 && timeoutSec > 0) {
        await this.park(timeoutSec * 1000, params.signal);
      }
      if (this.down) {
        throw new BotApiError("network", "getUpdates: request failed (fake API is down)");
      }
      return this.updates.slice(0, limit);
    } finally {
      this.inFlightPollers.delete(label);
    }
  }

  private park(timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.waiters.delete(done);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const done = (): void => {
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError());
      };
      this.waiters.add(done);
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async sendMessageFor(label: string, params: SendMessageParams): Promise<{ message_id: number }> {
    this.begin("sendMessage", label);
    if (params.chatId !== this.chatId && params.chatId <= 0) {
      throw rejected("sendMessage", 400, "Bad Request: chat not found");
    }
    if (params.text.length === 0) {
      throw rejected("sendMessage", 400, "Bad Request: message text is empty");
    }
    let shown = params.text;
    if (params.parseMode === "HTML") {
      const checked = checkTelegramHtml(params.text);
      if (!checked.ok) {
        throw rejected("sendMessage", 400, `Bad Request: ${checked.reason}`);
      }
      shown = checked.text;
      if (shown.length === 0) {
        throw rejected("sendMessage", 400, "Bad Request: message text is empty");
      }
    }
    if (shown.length > TELEGRAM_MAX_TEXT) {
      throw rejected("sendMessage", 400, "Bad Request: message is too long");
    }
    if (params.messageThreadId !== undefined && !this.liveTopics.has(params.messageThreadId)) {
      throw rejected("sendMessage", 400, "Bad Request: message thread not found");
    }
    const messageId = ++this.messageSeq;
    this.sent.push({
      messageId,
      chatId: params.chatId,
      ...(params.messageThreadId === undefined ? {} : { messageThreadId: params.messageThreadId }),
      text: params.text,
      ...(params.parseMode === undefined ? {} : { parseMode: params.parseMode }),
      ...(params.inlineKeyboard === undefined ? {} : { inlineKeyboard: params.inlineKeyboard }),
      at: this.now(),
    });
    return { message_id: messageId };
  }

  private async editMarkupFor(
    label: string,
    params: { chatId: number; messageId: number; inlineKeyboard?: InlineKeyboard },
  ): Promise<void> {
    this.begin("editMessageReplyMarkup", label);
    const message = this.editable("editMessageReplyMarkup", params.chatId, params.messageId);
    const next = params.inlineKeyboard ?? [];
    if (sameKeyboard(message.inlineKeyboard ?? [], next)) {
      throw rejected("editMessageReplyMarkup", 400, "Bad Request: message is not modified");
    }
    if (next.length === 0) {
      delete message.inlineKeyboard;
    } else {
      message.inlineKeyboard = next;
    }
    this.edits.push({ messageId: message.messageId, kind: "markup", inlineKeyboard: next, at: this.now() });
  }

  private async editTextFor(
    label: string,
    params: { chatId: number; messageId: number; text: string; parseMode?: "HTML"; inlineKeyboard?: InlineKeyboard },
  ): Promise<void> {
    this.begin("editMessageText", label);
    const message = this.editable("editMessageText", params.chatId, params.messageId);
    if (params.text.length === 0) {
      throw rejected("editMessageText", 400, "Bad Request: message text is empty");
    }
    let shown = params.text;
    if (params.parseMode === "HTML") {
      const checked = checkTelegramHtml(params.text);
      if (!checked.ok) {
        throw rejected("editMessageText", 400, `Bad Request: ${checked.reason}`);
      }
      shown = checked.text;
    }
    if (shown.length > TELEGRAM_MAX_TEXT) {
      throw rejected("editMessageText", 400, "Bad Request: message is too long");
    }
    const next = params.inlineKeyboard ?? [];
    if (message.text === params.text && sameKeyboard(message.inlineKeyboard ?? [], next)) {
      throw rejected("editMessageText", 400, "Bad Request: message is not modified");
    }
    message.text = params.text;
    if (params.parseMode === undefined) {
      delete message.parseMode;
    } else {
      message.parseMode = params.parseMode;
    }
    if (next.length === 0) {
      delete message.inlineKeyboard;
    } else {
      message.inlineKeyboard = next;
    }
    this.edits.push({ messageId: message.messageId, kind: "text", text: params.text, inlineKeyboard: next, at: this.now() });
  }

  private editable(method: FakeMethod, chatId: number, messageId: number): FakeSentMessage {
    if (chatId !== this.chatId) {
      throw rejected(method, 400, "Bad Request: chat not found");
    }
    const message = this.sent.find((entry) => entry.messageId === messageId && entry.chatId === chatId);
    if (message === undefined) {
      throw rejected(method, 400, "Bad Request: message to edit not found");
    }
    return message;
  }

  private async setCommandsFor(label: string, params: { commands: BotCommandMenuEntry[]; chatId?: number }): Promise<void> {
    this.begin("setMyCommands", label);
    if (params.commands.length > 100) {
      throw rejected("setMyCommands", 400, "Bad Request: BOT_COMMANDS_TOO_MUCH");
    }
    for (const entry of params.commands) {
      if (!/^[a-z0-9_]{1,32}$/.test(entry.command)) {
        throw rejected("setMyCommands", 400, "Bad Request: BOT_COMMAND_INVALID");
      }
      if (entry.description.length < 1 || entry.description.length > 256) {
        throw rejected("setMyCommands", 400, "Bad Request: BOT_COMMAND_DESCRIPTION_INVALID");
      }
    }
    this.myCommands = params.commands.map((entry) => ({ ...entry }));
    this.myCommandsCalls.push(this.myCommands);
  }

  private async reactFor(label: string, params: { chatId: number; messageId: number; emoji?: string }): Promise<void> {
    this.begin("setMessageReaction", label);
    if (params.chatId !== this.chatId) {
      throw rejected("setMessageReaction", 400, "Bad Request: chat not found");
    }
    if (!this.botCanReact) {
      throw rejected("setMessageReaction", 400, "Bad Request: REACTION_INVALID");
    }
    if (params.messageId > this.messageSeq || params.messageId <= 0) {
      throw rejected("setMessageReaction", 400, "Bad Request: message to react not found");
    }
    this.reactions.push({
      messageId: params.messageId,
      chatId: params.chatId,
      ...(params.emoji === undefined ? {} : { emoji: params.emoji }),
      at: this.now(),
    });
  }

  private async chatActionFor(
    label: string,
    params: { chatId: number; action: BotChatAction; messageThreadId?: number },
  ): Promise<void> {
    this.begin("sendChatAction", label);
    if (params.chatId !== this.chatId) {
      throw rejected("sendChatAction", 400, "Bad Request: chat not found");
    }
    if (params.messageThreadId !== undefined && !this.liveTopics.has(params.messageThreadId)) {
      throw rejected("sendChatAction", 400, "Bad Request: message thread not found");
    }
    this.chatActions.push({
      chatId: params.chatId,
      action: params.action,
      ...(params.messageThreadId === undefined ? {} : { messageThreadId: params.messageThreadId }),
      at: this.now(),
    });
  }

  private async createTopicFor(label: string, params: { chatId: number; name: string }): Promise<{ message_thread_id: number }> {
    this.begin("createForumTopic", label);
    if (params.chatId !== this.chatId) {
      throw rejected("createForumTopic", 400, "Bad Request: chat not found");
    }
    if (params.name.length === 0 || params.name.length > 128) {
      throw rejected("createForumTopic", 400, "Bad Request: topic name must be 1-128 characters");
    }
    const messageThreadId = ++this.threadSeq;
    this.liveTopics.set(messageThreadId, { messageThreadId, name: params.name, createdAt: this.now() });
    return { message_thread_id: messageThreadId };
  }

  private async deleteTopicFor(label: string, params: { chatId: number; messageThreadId: number }): Promise<void> {
    this.begin("deleteForumTopic", label);
    if (!this.liveTopics.delete(params.messageThreadId)) {
      throw rejected("deleteForumTopic", 400, "Bad Request: message thread not found");
    }
    this.deletedTopics.push({ chatId: params.chatId, messageThreadId: params.messageThreadId });
  }

  private async editTopicFor(label: string, params: { chatId: number; messageThreadId: number; name: string }): Promise<void> {
    this.begin("editForumTopic", label);
    const topic = this.liveTopics.get(params.messageThreadId);
    if (topic === undefined) {
      throw rejected("editForumTopic", 400, "Bad Request: message thread not found");
    }
    topic.name = params.name;
    this.renamedTopics.push({ messageThreadId: params.messageThreadId, name: params.name });
  }

  private async getMeFor(label: string): Promise<BotIdentity> {
    this.begin("getMe", label);
    return { id: this.botId, username: this.botUsername };
  }

  private async getChatFor(label: string, params: { chatId: number }): Promise<BotChatInfo> {
    this.begin("getChat", label);
    if (params.chatId !== this.chatId) {
      throw rejected("getChat", 400, "Bad Request: chat not found");
    }
    return { id: this.chatId, type: "supergroup", title: "Keryx", is_forum: this.forum };
  }

  private async getChatMemberFor(label: string, params: { chatId: number; userId: number }): Promise<BotChatMemberInfo> {
    this.begin("getChatMember", label);
    if (params.chatId !== this.chatId) {
      throw rejected("getChatMember", 400, "Bad Request: chat not found");
    }
    if (params.userId === this.botId) {
      return { status: this.botStatus, can_manage_topics: this.botCanManageTopics };
    }
    return { status: "member" };
  }

  private async answerFor(label: string, params: { callbackQueryId: string; text?: string }): Promise<void> {
    this.begin("answerCallbackQuery", label);
    this.answeredCallbacks.push({
      callbackQueryId: params.callbackQueryId,
      ...(params.text === undefined ? {} : { text: params.text }),
    });
  }
}

function sameKeyboard(a: InlineKeyboard, b: InlineKeyboard): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function rejected(method: string, status: number, description: string): BotApiError {
  return new BotApiError("rejected", `${method}: ${status} ${description}`, { status });
}

function abortError(): Error {
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
}
