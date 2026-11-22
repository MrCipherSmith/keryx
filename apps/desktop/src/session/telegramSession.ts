export const TELEGRAM_SESSION = "_keryx/telegram/session";
export const TELEGRAM_TURN = "_keryx/telegram/turn";

const states = ["detached", "attaching", "active", "reconnecting", "unavailable"] as const;
type AttachmentState = typeof states[number];

export interface TelegramAttachment {
  state: AttachmentState;
  topicUrl?: string;
  reason?: string;
}

export function readTelegramAttachment(value: unknown, sessionId: string): TelegramAttachment | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const state = states.find(state => state === candidate.state);
  if (!state || candidate.sessionId !== sessionId) return null;
  const topicUrl = state === "active" && typeof candidate.topicUrl === "string" &&
    /^https:\/\/t\.me\/(?:c\/\d+|[A-Za-z][A-Za-z0-9_]{4,31})\/\d+(?:\/\d+)?$/.test(candidate.topicUrl)
    ? candidate.topicUrl : undefined;
  return { state, ...(topicUrl ? { topicUrl } : {}), ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}) };
}

export interface TelegramTurn {
  generation: string;
  updateId: number;
}

export function readTelegramTurn(value: { [key: string]: unknown }): (TelegramTurn & { phase: "started" | "finished" }) | null {
  const { source, phase, generation, updateId } = value;
  if (source !== "telegram" || (phase !== "started" && phase !== "finished") ||
    typeof generation !== "string" || !generation || typeof updateId !== "number" ||
    !Number.isSafeInteger(updateId) || updateId < 0) return null;
  return { phase, generation, updateId };
}
