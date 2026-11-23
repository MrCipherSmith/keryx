import { invoke } from "./backend";

export interface TelegramPairing {
  state: "waiting-for-user" | "waiting-for-confirmation" | "waiting-for-group" | "ready" | "failed" | "expired" | "cancelled";
  code?: string;
  forumCode?: string;
  membership?: { received: number; last: string };
  botUsername?: string;
  expiresAt: number;
  userId?: number;
  chatId?: number;
  chatTitle?: string;
  problems: string[];
}
export interface TelegramChannelStatus {
  capabilities?: { desktopTelegram?: 1 };
  revision?: number | null;
  pendingOperation?: { operationId: string; revision: number | null };
  lastActivationFailure?: { reason: string; at: number };
  telegram: { state: string; sessions: number };
}
export interface TelegramChannelOperation {
  schemaVersion: string;
  operationId: string;
  revision: number | null;
  state?: string;
  pairing?: TelegramPairing;
}
export type TelegramChannelRequest =
  | { action: "begin"; token: string; expectedRevision: number | null }
  | { action: "operation-status" | "cancel" | "confirm-account" | "confirm"; operationId: string; expectedRevision: number | null }
  | { action: "test" | "disconnect"; expectedRevision: number | null };
export type TelegramChannelActionValue = TelegramChannelOperation | { delivered: true } | { deleted: number; remaining: number; revision: number };
export type TelegramChannelResult<T> = { ok: true; value: T } | { ok: false; code: string };
export const telegramChannelStatus = () => invoke<TelegramChannelResult<TelegramChannelStatus>>("telegram_channel_status");
export const telegramChannelAction = (request: TelegramChannelRequest) => invoke<TelegramChannelResult<TelegramChannelActionValue>>("telegram_channel_action", { request });
