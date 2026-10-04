// Flow 403: what an intake card looks like in Telegram, and how a button press is named.
//
// Ticket text is untrusted. A title, an assessment or a link never reaches the Telegram text as markup: every
// free field goes through `plainText`, which drops the characters the outbound renderer turns into formatting,
// and a link is added only when it is a plain https URL. The buttons carry `in:<card id>:<code>` and nothing
// else: no URL, no title. What a press DOES is read from the card registry, never from the press.

import type { ServiceSendResult } from "../remote/hub";
import { INTAKE_SERVICE_TOPIC } from "../remote/protocol";
import type { SentMessageInfo } from "../remote/outbound-queue";
import type { InlineKeyboard } from "../remote/types";
import { INTAKE_ACTIONS, type IntakeAction, type IntakeCardKind, type IntakeCardSink, type IntakeCardView, type IntakeSendResult } from "./types";

export const INTAKE_ACTION_LABELS: Readonly<Record<IntakeAction, string>> = {
  take: "Взять в работу",
  decline: "Отклонить",
  later: "Позже",
  "review-flow": "Открыть ревью-flow",
  skip: "Пропустить",
  "ci-triage": "Разобрать",
  ignore: "Игнорировать",
  understood: "Понятно",
};

const ACTION_CODES: Readonly<Record<IntakeAction, string>> = {
  take: "t",
  decline: "d",
  later: "l",
  "review-flow": "r",
  skip: "s",
  "ci-triage": "c",
  ignore: "i",
  understood: "u",
};

const KIND_LABELS: Readonly<Record<IntakeCardKind, string>> = {
  issue: "Новая задача",
  review: "Просят ревью",
  ci: "Упал CI",
  comment: "Новый комментарий",
  board: "Изменение на доске",
  overflow: "Ещё события",
};

const TITLE_MAX = 200;
const ASSESSMENT_MAX = 400;

/** `in:<card id>:<code>`; a card id is at most 12 characters, so this is far below Telegram's 64 bytes. */
export function intakeCallbackData(cardId: string, action: IntakeAction): string {
  return `in:${cardId}:${ACTION_CODES[action]}`;
}

export function parseIntakeCallbackData(data: string): { readonly cardId: string; readonly action: IntakeAction } | undefined {
  const match = /^in:([a-z0-9]{1,24}):([a-z])$/.exec(data);
  if (match === null) return undefined;
  const action = INTAKE_ACTIONS.find((a) => ACTION_CODES[a] === match[2]);
  return action === undefined ? undefined : { cardId: match[1]!, action };
}

/** One line of untrusted text with every character that could become markup removed, cut to `max`. */
export function plainText(value: string, max: number): string {
  const flat = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029\u00a0]+/g, " ")
    .replace(/[*_~`[\]<>|\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[#>\-+=]+\s*/, "");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const SAFE_URL = /^https:\/\/[^\s()<>[\]`*_~|\\]+$/;

function reference(card: IntakeCardView): string {
  // The repo matches `owner/name` of the config, so it is safe inside a code span; the ref is digits or a run id.
  const ref = /^[A-Za-z0-9_.-]+$/.test(card.ref) ? card.ref : "";
  const joiner = card.kind === "ci" ? " run " : "#";
  const repo = card.repo !== undefined && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(card.repo) ? card.repo : "";
  const text = `${repo}${repo.length > 0 && ref.length > 0 ? joiner : ""}${ref}`.trim();
  return text.length > 0 ? ` · \`${text}\`` : "";
}

export function renderIntakeCard(card: IntakeCardView, status?: string): string {
  const lines: string[] = [];
  if (card.kind === "overflow") {
    const n = card.collapsedIds?.length ?? 0;
    lines.push(`**Ещё ${n} ${n === 1 ? "событие" : "событий"}**`);
    lines.push("Подробности: `keryx intake status` или вкладка Intake в TUI.");
  } else {
    lines.push(`**${KIND_LABELS[card.kind]}**${reference(card)}`);
    lines.push(`Название: ${plainText(card.title, TITLE_MAX)}`);
    if (card.url !== undefined && SAFE_URL.test(card.url)) lines.push(`Ссылка: [открыть](${card.url})`);
    lines.push(card.assessment !== undefined && card.assessment.length > 0 ? `Оценка: ${plainText(card.assessment, ASSESSMENT_MAX)}` : "Оценка: недоступна");
    if (card.suggestion !== undefined) lines.push(`Совет: ${INTAKE_ACTION_LABELS[card.suggestion]}`);
  }
  if (status !== undefined) lines.push("", plainText(status, 300));
  return lines.join("\n");
}

/** The buttons of a card, in order. An overflow card and a card the take button is forbidden on get none of it. */
export function intakeKeyboard(card: IntakeCardView): InlineKeyboard {
  if (card.kind === "overflow") return [];
  const row = card.actions
    .filter((a) => a !== "take" || card.takeAllowed)
    .map((a) => ({ text: INTAKE_ACTION_LABELS[a], callback_data: intakeCallbackData(card.id, a) }));
  return row.length === 0 ? [] : [row];
}

/** The part of the hub the sink uses; a test passes a fake. */
export interface IntakeSinkHub {
  sendToServiceTopic(name: string, text: string, options?: { keyboard?: InlineKeyboard; onSent?: (info: SentMessageInfo) => void }): Promise<ServiceSendResult>;
  editServiceMessage?(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean>;
}

/**
 * The poll's Telegram path. Everything goes to the ONE topic `INTAKE_SERVICE_TOPIC`: it is not configurable, because
 * it is the topic the hub accepts presses from. A card that Telegram took at once reports its chat and message ids;
 * one the durable queue holds for a retry is still `ok` (it WILL go out) but has no message id yet, and the press
 * handler adopts the ids of the first press on it.
 */
export function createIntakeCardSink(hub: IntakeSinkHub): IntakeCardSink {
  const topic = INTAKE_SERVICE_TOPIC;
  return {
    async editCard(card: IntakeCardView, status?: string): Promise<{ readonly ok: boolean }> {
      if (hub.editServiceMessage === undefined || card.chatId === undefined || card.messageId === undefined) return { ok: false };
      const chatId = Number(card.chatId);
      const messageId = Number(card.messageId);
      if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) return { ok: false };
      // A card with a status line is settled: no buttons. Without one (an overflow count that grew) it keeps its own.
      const keyboard = status === undefined ? intakeKeyboard(card) : undefined;
      const ok = await hub.editServiceMessage(chatId, messageId, renderIntakeCard(card, status), keyboard !== undefined && keyboard.length > 0 ? keyboard : undefined);
      return { ok };
    },
    async sendCard(card: IntakeCardView): Promise<IntakeSendResult> {
      let sent: SentMessageInfo | undefined;
      const keyboard = intakeKeyboard(card);
      const result = await hub.sendToServiceTopic(topic, renderIntakeCard(card), {
        ...(keyboard.length > 0 ? { keyboard } : {}),
        onSent: (info) => {
          sent = info;
        },
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      return sent === undefined ? { ok: true } : { ok: true, chatId: String(sent.chatId), messageId: String(sent.messageId) };
    },
    async sendStatus(text: string): Promise<{ readonly ok: boolean }> {
      const result = await hub.sendToServiceTopic(topic, plainText(text, 600));
      return { ok: result.ok };
    },
  };
}
