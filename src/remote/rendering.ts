// Sending and editing one message part in the configured rendering mode (flow 395).
//
// The chain, for every part, whatever the mode:
//
//   rich  ->  HTML  ->  plain
//
// A step is left only on a refusal, and only for the step below it:
//   - rich is refused (any 4xx: a 400 for the blocks, 404 for a server that lacks the method,
//     403 for a bot that may not use it, or a client with no rich method at all): the SAME text
//     goes once as HTML;
//   - HTML is refused as unparseable (400 "can't parse entities"): once as plain text;
//   - a network error, a 5xx and a 429 are not refusals: they are thrown as before and the
//     durable queue retries the part, in the same mode.
// Nothing is dropped by a fallback. Each one is written to the `RenderingState` with its step,
// its reason (redacted) and its time, which `/channels` shows; a restart forgets it.
//
// A refusal of the METHOD (404 or 405 with no chat in the description, a 403 that names the rich
// method, a client with no rich method) will not heal in a minute, so the state pauses rich for
// `RICH_PAUSE_MS` and the parts in that window go straight to HTML (still recorded as a
// fallback, with the reason that paused rich). A 400 about one part's blocks does not pause it,
// and neither does an error that belongs to one chat or topic (403 bot kicked or blocked, 404 or
// 400 chat or thread not found): rich works elsewhere, so it is neither paused nor recorded as a
// refusal of rich. The part still goes once as HTML, and whatever that answers decides its fate.
//
// A 5xx on the rich call is retried by the queue, but not for ever: after `RICH_SERVER_ATTEMPTS`
// failures of the same message the part goes once as HTML, so a rich gateway that stays down
// cannot stall the queue behind one table.

import { redactSensitiveText } from "../security/service";
import { editHtml, isNotModified, sendHtml } from "./format-html";
import { containsTable, renderRichMessage, RichRenderError } from "./format-rich";
import { renderPlainText } from "./format-plain";
import { DEFAULT_RENDER_MODE, type RenderMode } from "./rendering-mode";
import { type BotApi, type BotApiError, type InlineKeyboard, isBotApiError, type SendMessageParams } from "./types";

/** The step a message fell to: from rich to HTML, or from HTML to plain text. */
export type FallbackStep = "rich-to-html" | "html-to-plain";

export interface RenderFallback {
  step: FallbackStep;
  /** Redacted, never message text. */
  reason: string;
  at: number;
}

export interface RenderingSnapshot {
  /** The mode in effect now. */
  mode: RenderMode;
  /** The most recent fallback since this process started. */
  lastFallback?: RenderFallback;
  /** Rich messages are paused until this time (ms), because the bot or server refuses them. */
  richPausedUntil?: number;
}

/** How long rich is skipped after a refusal that will not heal by itself. */
export const RICH_PAUSE_MS = 10 * 60_000;
/** Failed 5xx attempts of rich for one message before it goes as HTML instead. */
export const RICH_SERVER_ATTEMPTS = 3;
/** The longest reason kept: a description may echo a long fragment of the message. */
export const MAX_REASON_LENGTH = 200;

function capReason(reason: string): string {
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…` : reason;
}

export class RenderingState {
  private readonly now: () => number;
  private readonly readMode: () => RenderMode;
  private last: RenderFallback | undefined;
  private pausedUntil = 0;
  private pauseReason: string | undefined;
  private serverKey: string | undefined;
  private serverFailures = 0;

  constructor(options: { now?: () => number; mode?: () => RenderMode } = {}) {
    this.now = options.now ?? Date.now;
    this.readMode = options.mode ?? (() => DEFAULT_RENDER_MODE);
  }

  /** The mode in effect now. A reader that throws counts as the default: sending never stops on it. */
  mode(): RenderMode {
    try {
      return this.readMode();
    } catch {
      return DEFAULT_RENDER_MODE;
    }
  }

  lastFallback(): RenderFallback | undefined {
    return this.last;
  }

  record(step: FallbackStep, reason: string): RenderFallback {
    this.last = { step, reason: capReason(redactSensitiveText(reason)), at: this.now() };
    return this.last;
  }

  /** Skip rich for `RICH_PAUSE_MS`. */
  pauseRich(reason: string): void {
    this.pausedUntil = this.now() + RICH_PAUSE_MS;
    this.pauseReason = capReason(redactSensitiveText(reason));
  }

  /** Count one 5xx of rich for the message `key`; the count restarts when the message changes. */
  richServerFailure(key: string): number {
    this.serverFailures = this.serverKey === key ? this.serverFailures + 1 : 1;
    this.serverKey = key;
    return this.serverFailures;
  }

  richServerReset(): void {
    this.serverKey = undefined;
    this.serverFailures = 0;
  }

  /** The reason rich is skipped right now, or undefined when it may be tried. */
  richPausedReason(): string | undefined {
    if (this.pausedUntil > this.now()) {
      return this.pauseReason ?? "rich messages are paused";
    }
    return undefined;
  }

  snapshot(): RenderingSnapshot {
    return {
      mode: this.mode(),
      ...(this.last === undefined ? {} : { lastFallback: this.last }),
      ...(this.pausedUntil > this.now() ? { richPausedUntil: this.pausedUntil } : {}),
    };
  }
}

export interface RenderHooks {
  state: RenderingState;
  /** Told of each fallback, after it was recorded. A throwing observer never costs the message. */
  onFallback?: (fallback: RenderFallback) => void;
}

type FirstStep = "rich" | "html" | "plain";

/** Which step a part starts at, from the mode: `auto` is rich only for a part with a table. */
export function firstStep(mode: RenderMode, text: string): FirstStep {
  if (mode === "auto") {
    return containsTable(text) ? "rich" : "html";
  }
  return mode;
}

/** The description Telegram gave, without the `method: status` prefix the transport adds. */
function descriptionOf(error: BotApiError): string {
  return error.message.replace(/^\w+:\s*(?:\d{3}\s*)?/, "");
}

/**
 * What is kept of a failure: the status and the description up to the first quotation mark.
 * Telegram echoes fragments of the message after a quote ("... start tag \"b\""), and those are
 * the operator's text, so they are not stored. Redacted, and never longer than `MAX_REASON_LENGTH`.
 */
function describe(error: unknown): string {
  if (!isBotApiError(error)) {
    return capReason(redactSensitiveText(error instanceof Error ? error.message : String(error)));
  }
  const text = redactSensitiveText(descriptionOf(error));
  const cut = text.search(/["\u201c\u00ab`]/);
  const head = (cut < 0 ? text : text.slice(0, cut)).replace(/[\s:,(]+$/, "");
  return capReason(error.status === undefined ? head : `${error.status} ${head}`);
}

/** A rejection of the rich call that is worth retrying as HTML: any 4xx. */
function isRefusal(error: unknown): boolean {
  return isBotApiError(error) && error.kind === "rejected";
}

const MENTIONS_RICH_METHOD = /rich|method|unknown parameter|not supported|unsupported/i;
const MENTIONS_CHAT = /chat|thread|topic|user|member|group|channel|blocked|kicked|deactivated|rights/i;

/** A refusal of the method itself, which will not heal in a minute and holds for every chat. */
function isStanding(error: unknown): boolean {
  if (!isBotApiError(error) || error.kind !== "rejected") {
    return false;
  }
  const text = descriptionOf(error);
  if (error.status === 404 || error.status === 405) {
    return MENTIONS_RICH_METHOD.test(text) || !MENTIONS_CHAT.test(text);
  }
  return error.status === 403 && MENTIONS_RICH_METHOD.test(text);
}

/** A 403, 404 or 400 about this chat or topic: the bot was kicked, the thread is gone. Rich is fine. */
function isChatScoped(error: unknown): boolean {
  if (!isBotApiError(error) || error.kind !== "rejected" || isStanding(error)) {
    return false;
  }
  const text = descriptionOf(error);
  return !MENTIONS_RICH_METHOD.test(text) && (error.status === 403 || ((error.status === 400 || error.status === 404) && MENTIONS_CHAT.test(text)));
}

function fallTo(hooks: RenderHooks, step: FallbackStep, reason: string): void {
  const recorded = hooks.state.record(step, reason);
  try {
    hooks.onFallback?.(recorded);
  } catch {
    // A throwing observer must never cost the operator the message.
  }
}

const MISSING_METHOD = "this Bot API client has no rich message method";

export async function sendRendered(api: BotApi, params: SendMessageParams, hooks: RenderHooks): Promise<{ message_id: number }> {
  const { parseMode: _ignored, ...plain } = params;
  // A force-reply prompt (flow 401) never goes out as a rich message: that method carries no `force_reply`.
  const first = firstStep(hooks.state.mode(), params.text);
  const step = params.forceReply !== undefined && first === "rich" ? "html" : first;
  if (step === "plain") {
    return api.sendMessage({ ...plain, text: renderPlainText(params.text) });
  }
  if (step === "rich") {
    const paused = hooks.state.richPausedReason();
    if (paused !== undefined) {
      fallTo(hooks, "rich-to-html", `rich messages paused: ${paused}`);
    } else {
      try {
        if (api.sendRichMessage === undefined) {
          throw new RichUnavailable(MISSING_METHOD);
        }
        const sent = await api.sendRichMessage({
          chatId: params.chatId,
          richMessage: renderRichMessage(params.text),
          ...(params.messageThreadId === undefined ? {} : { messageThreadId: params.messageThreadId }),
          ...(params.inlineKeyboard === undefined ? {} : { inlineKeyboard: params.inlineKeyboard }),
        });
        hooks.state.richServerReset();
        return sent;
      } catch (error) {
        handleRichFailure(error, hooks, `send:${params.chatId}:${params.messageThreadId ?? ""}:${params.text}`);
      }
    }
  }
  return sendHtml(api, plain, (error) => fallTo(hooks, "html-to-plain", describe(error)));
}

export async function editRendered(
  api: BotApi,
  params: { chatId: number; messageId: number; text: string; inlineKeyboard?: InlineKeyboard },
  hooks: RenderHooks,
): Promise<void> {
  const step = firstStep(hooks.state.mode(), params.text);
  if (step === "plain") {
    await api.editMessageText({ ...params, text: renderPlainText(params.text) });
    return;
  }
  if (step === "rich") {
    const paused = hooks.state.richPausedReason();
    if (paused !== undefined) {
      fallTo(hooks, "rich-to-html", `rich messages paused: ${paused}`);
    } else {
      try {
        if (api.editRichMessage === undefined) {
          throw new RichUnavailable(MISSING_METHOD);
        }
        await api.editRichMessage({
          chatId: params.chatId,
          messageId: params.messageId,
          richMessage: renderRichMessage(params.text),
          ...(params.inlineKeyboard === undefined ? {} : { inlineKeyboard: params.inlineKeyboard }),
        });
        hooks.state.richServerReset();
        return;
      } catch (error) {
        // "message is not modified" is the state we wanted, not a refusal of rich.
        if (isNotModified(error)) {
          throw error;
        }
        handleRichFailure(error, hooks, `edit:${params.chatId}:${params.messageId}:${params.text}`);
      }
    }
  }
  await editHtml(api, params, (error) => fallTo(hooks, "html-to-plain", describe(error)));
}

/** The caller's own error, so a client without the method and a refusal are told apart. */
class RichUnavailable extends Error {}

/**
 * Record the fall from rich to HTML, or rethrow when this is not a refusal: a network error, a
 * 5xx and a 429 are for the queue to retry in the same mode, not reasons to change the message.
 */
function handleRichFailure(error: unknown, hooks: RenderHooks, key: string): void {
  if (error instanceof RichUnavailable) {
    hooks.state.pauseRich(error.message);
    fallTo(hooks, "rich-to-html", error.message);
    return;
  }
  if (error instanceof RichRenderError) {
    fallTo(hooks, "rich-to-html", describe(error));
    return;
  }
  if (isBotApiError(error) && error.kind === "server") {
    // The queue retries a 5xx, but a gateway that stays down must not stall it behind this part.
    if (hooks.state.richServerFailure(key) < RICH_SERVER_ATTEMPTS) {
      throw error;
    }
    hooks.state.richServerReset();
    fallTo(hooks, "rich-to-html", `rich failed ${RICH_SERVER_ATTEMPTS} times: ${describe(error)}`);
    return;
  }
  if (!isRefusal(error)) {
    throw error;
  }
  if (isChatScoped(error)) {
    // Not a refusal of rich: nothing is paused or recorded, and the HTML resend that follows
    // meets the same chat or topic error if it is real.
    return;
  }
  const reason = describe(error);
  if (isStanding(error)) {
    hooks.state.pauseRich(reason);
  }
  fallTo(hooks, "rich-to-html", reason);
}
