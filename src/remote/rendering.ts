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
// A 404, a 403 or a missing method will not heal in a minute, so the state pauses rich for
// `RICH_PAUSE_MS` and the parts in that window go straight to HTML (still recorded as a
// fallback, with the reason that paused rich). A 400 about one part's blocks does not pause it.

import { redactSensitiveText } from "../security/service";
import { editHtml, isNotModified, sendHtml } from "./format-html";
import { containsTable, renderRichMessage, RichRenderError } from "./format-rich";
import { renderPlainText } from "./format-plain";
import { DEFAULT_RENDER_MODE, type RenderMode } from "./rendering-mode";
import { type BotApi, type InlineKeyboard, isBotApiError, type SendMessageParams } from "./types";

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

export class RenderingState {
  private readonly now: () => number;
  private readonly readMode: () => RenderMode;
  private last: RenderFallback | undefined;
  private pausedUntil = 0;
  private pauseReason: string | undefined;

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
    this.last = { step, reason: redactSensitiveText(reason), at: this.now() };
    return this.last;
  }

  /** Skip rich for `RICH_PAUSE_MS`. */
  pauseRich(reason: string): void {
    this.pausedUntil = this.now() + RICH_PAUSE_MS;
    this.pauseReason = redactSensitiveText(reason);
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

function describe(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

/** A rejection of the rich call that is worth retrying as HTML: any 4xx. */
function isRefusal(error: unknown): boolean {
  return isBotApiError(error) && error.kind === "rejected";
}

/** A refusal that will not heal in a minute: no such method, the bot may not use it. */
function isStanding(error: unknown): boolean {
  return isBotApiError(error) && error.kind === "rejected" && (error.status === 403 || error.status === 404 || error.status === 405);
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
  const step = firstStep(hooks.state.mode(), params.text);
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
        return await api.sendRichMessage({
          chatId: params.chatId,
          richMessage: renderRichMessage(params.text),
          ...(params.messageThreadId === undefined ? {} : { messageThreadId: params.messageThreadId }),
          ...(params.inlineKeyboard === undefined ? {} : { inlineKeyboard: params.inlineKeyboard }),
        });
      } catch (error) {
        handleRichFailure(error, hooks);
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
        return;
      } catch (error) {
        // "message is not modified" is the state we wanted, not a refusal of rich.
        if (isNotModified(error)) {
          throw error;
        }
        handleRichFailure(error, hooks);
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
function handleRichFailure(error: unknown, hooks: RenderHooks): void {
  if (error instanceof RichUnavailable) {
    hooks.state.pauseRich(error.message);
    fallTo(hooks, "rich-to-html", error.message);
    return;
  }
  if (error instanceof RichRenderError) {
    fallTo(hooks, "rich-to-html", describe(error));
    return;
  }
  if (!isRefusal(error)) {
    throw error;
  }
  const reason = describe(error);
  if (isStanding(error)) {
    hooks.state.pauseRich(reason);
  }
  fallTo(hooks, "rich-to-html", reason);
}
