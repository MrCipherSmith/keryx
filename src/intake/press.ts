// Flow 403: a button press on an intake card, from the hub to a decision and back to the card.
//
// The hub has already checked the allowlist and that the press came from the service topic. Here the press is
// matched to a card (the ids of the message must be the card's own), the decision goes through `decideIntakeCard`
// (which reads what to do from the registry, not from the press), the card is edited in place so its buttons are
// gone, and the result is the toast.

import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { IntakeCallbackHandler, IntakeCallbackPress, ServiceSendResult } from "../remote/hub";
import type { SentMessageInfo } from "../remote/outbound-queue";
import type { InlineKeyboard } from "../remote/types";
import { decideIntakeCard, type IntakeActionDeps } from "./actions";
import { parseIntakeCallbackData, plainText, renderIntakeCard } from "./card";
import { intakeDataDir, readIntakeConfig } from "./config";
import { appendIntakeIfState, ensureIntakeDataIgnored, readIntakeCardView } from "./store";
import type { IntakeCardView } from "./types";

export const INTAKE_REJECTED_PRESSES_FILE = "rejected-presses.jsonl";

/** The part of the hub the press handler uses; a test passes a fake. */
export interface IntakePressHub {
  editServiceMessage(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean>;
  sendToServiceTopic(name: string, text: string, options?: { keyboard?: InlineKeyboard; onSent?: (info: SentMessageInfo) => void }): Promise<ServiceSendResult>;
}

export interface IntakePressDeps {
  readonly hub: IntakePressHub;
  /** Every project root that may hold intake cards: serve's working directory and the registered projects. */
  readonly roots: () => readonly string[];
  readonly actionDeps?: IntakeActionDeps;
  readonly now?: () => Date;
}

async function findCard(roots: readonly string[], cardId: string): Promise<{ root: string; view: IntakeCardView } | undefined> {
  for (const root of roots) {
    const view = await readIntakeCardView(root, cardId);
    if (view !== undefined) return { root, view };
  }
  return undefined;
}

/** A press that does not belong to the card it names is ignored; only its ids and time are kept, never text. */
async function journalRejected(root: string, press: IntakeCallbackPress, cardId: string, at: Date): Promise<void> {
  try {
    await ensureIntakeDataIgnored(root);
    const line = JSON.stringify({ at: at.toISOString(), updateId: press.updateId, cardId, reason: "message does not match the card" });
    await appendFile(path.join(intakeDataDir(root), INTAKE_REJECTED_PRESSES_FILE), `${line}\n`, "utf8");
  } catch {
    // The journal is evidence, not a gate: a full disk must not turn an ignored press into a decision.
  }
}

/** A card delivered by the durable queue learned its message id only now: keep it, and keep the original send time. */
async function adoptIds(root: string, view: IntakeCardView, press: IntakeCallbackPress): Promise<void> {
  if (view.state !== "sent" || view.sentAt === undefined) return;
  await appendIntakeIfState(root, view.id, ["sent"], { state: "sent", at: view.sentAt, chatId: String(press.chatId), messageId: String(press.messageId) });
}

function fenced(text: string): string {
  return `\`\`\`\n${text.replace(/```/g, "'''")}\n\`\`\``;
}

export function createIntakePressHandler(deps: IntakePressDeps): IntakeCallbackHandler {
  const now = deps.now ?? (() => new Date());
  return async (press) => {
    try {
      const parsed = parseIntakeCallbackData(press.data);
      if (parsed === undefined) return { text: "Кнопка не распознана" };
      const found = await findCard(deps.roots(), parsed.cardId);
      if (found === undefined) return { text: "Карточка не найдена" };
      const { root, view } = found;
      if (view.messageId !== undefined && (view.messageId !== String(press.messageId) || (view.chatId !== undefined && view.chatId !== String(press.chatId)))) {
        await journalRejected(root, press, view.id, now());
        return undefined;
      }
      if (view.messageId === undefined) await adoptIds(root, view, press);
      const at = now();
      const result = await decideIntakeCard(root, view.id, parsed.action, { decidedBy: String(press.fromId), now: at, ...(deps.actionDeps !== undefined ? { deps: deps.actionDeps } : {}) });
      if (result.statusLine !== undefined) await deps.hub.editServiceMessage(press.chatId, press.messageId, renderIntakeCard(view, result.statusLine));
      if (result.detail !== undefined) {
        const topic = (await readIntakeConfig(root)).topic;
        await deps.hub.sendToServiceTopic(topic, `Разбор CI ${plainText(view.repo ?? "", 80)} run ${plainText(view.ref, 40)}\n${fenced(result.detail)}`);
      }
      return { text: result.message };
    } catch {
      return { text: "Не получилось обработать нажатие" };
    }
  };
}
