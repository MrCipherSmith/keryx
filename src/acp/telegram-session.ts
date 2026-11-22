import type { InboundMeta } from "../remote/client";
/** Desktop Telegram session-control contract. The server must not advertise this
 * capability until delegated actor, turn, and decision handling are implemented. */
export const ACP_TELEGRAM_SESSION_METHOD = "_keryx/telegram/session";

export type TelegramSessionRequest =
  | { operation: "status"; sessionId: string }
  | { operation: "detach"; sessionId: string }
  | { operation: "attach"; sessionId: string; topicName?: string };

export type TelegramSessionReason =
  | "serve-unavailable" | "connection-lost" | "pairing-required" | "capability-unavailable"
  | "lease-lost" | "topic-archived" | "operation-failed";

export type TelegramSessionState =
  | { sessionId: string; state: "active"; topicUrl?: string }
  | { sessionId: string; state: "detached" | "attaching" | "reconnecting" | "unavailable"; reason?: TelegramSessionReason };

/** Parse the closed schema before looking up a session or doing any work. */
export function parseTelegramSessionRequest(value: unknown): TelegramSessionRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== "operation" && key !== "sessionId" && key !== "topicName")) return undefined;
  if (typeof request.sessionId !== "string" || request.sessionId.length === 0) return undefined;
  if (request.operation === "attach") {
    if (request.topicName !== undefined && (typeof request.topicName !== "string" || request.topicName.length === 0 || request.topicName.length > 100)) return undefined;
    return { operation: "attach", sessionId: request.sessionId, ...(request.topicName === undefined ? {} : { topicName: request.topicName }) };
  }
  if ((request.operation === "status" || request.operation === "detach") && request.topicName === undefined) {
    return { operation: request.operation, sessionId: request.sessionId };
  }
  return undefined;
}

/** Explicitly fail closed until the complete delegated execution boundary exists. */
export function unavailableTelegramSession(sessionId: string): TelegramSessionState {
  return { sessionId, state: "unavailable", reason: "capability-unavailable" };
}

export interface TelegramBindingClient {
  start(): Promise<{ ok: true; threadId: number } | { ok: false; message: string }>;
  close(): Promise<void>;
  reply(text: string): Promise<boolean>;
}

export interface TelegramBindingDependencies {
  /** Resolves only a live session held by this ACP connection. */
  held(sessionId: string): { project: string; lease: object } | undefined;
  /** Checks that this exact hold still owns its lease. */
  owns(sessionId: string, lease: object): boolean;
  create(input: { sessionId: string; project: string; topicName?: string; owner: { kind: "desktop"; incarnation: string; generation: string }; onLine: (text: string, meta: InboundMeta) => Promise<void> }): TelegramBindingClient;
  onStop(sessionId: string, generation: string): boolean;
  onInput(input: { sessionId: string; generation: string; text: string; actorId: number; updateId: number }): Promise<"accepted" | "busy" | "refused">;
  generation(): string;
  incarnation: string;
  onState?(state: TelegramSessionState): void;
}

interface Binding {
  lease: object;
  generation: string;
  client: TelegramBindingClient;
  state: TelegramSessionState;
  pending?: Promise<TelegramSessionState>;
  threadId?: number;
  seen: Set<number>;
}

/** Manages only binding lifetimes; it does not admit turns or advertise ACP capability. */
export class TelegramSessionBindings {
  private readonly bindings = new Map<string, Binding>();
  constructor(private readonly deps: TelegramBindingDependencies) {}

  status(sessionId: string): TelegramSessionState {
    const held = this.deps.held(sessionId);
    if (held === undefined || !this.deps.owns(sessionId, held.lease)) return { sessionId, state: "unavailable", reason: "lease-lost" };
    const binding = this.bindings.get(sessionId);
    if (binding !== undefined && binding.lease !== held.lease) return { sessionId, state: "unavailable", reason: "lease-lost" };
    return binding?.state ?? { sessionId, state: "detached" };
  }

  attach(sessionId: string, topicName?: string): Promise<TelegramSessionState> {
    const held = this.deps.held(sessionId);
    if (held === undefined || !this.deps.owns(sessionId, held.lease)) return Promise.resolve({ sessionId, state: "unavailable", reason: "lease-lost" });
    const existing = this.bindings.get(sessionId);
    if (existing !== undefined) {
      if (existing.lease !== held.lease) return Promise.resolve({ sessionId, state: "unavailable", reason: "lease-lost" });
      return existing.pending ?? Promise.resolve(existing.state);
    }
    const generation = this.deps.generation();
    const client = this.deps.create({ sessionId, project: held.project, ...(topicName === undefined ? {} : { topicName }), owner: { kind: "desktop", incarnation: this.deps.incarnation, generation },
      onLine: (text, meta) => this.receive(sessionId, generation, text, meta),
    });
    const binding: Binding = { lease: held.lease, generation, client, state: { sessionId, state: "attaching" }, seen: new Set() };
    this.bindings.set(sessionId, binding);
    this.deps.onState?.(binding.state);
    binding.pending = this.finishAttach(sessionId, binding);
    return binding.pending;
  }

  private async finishAttach(sessionId: string, binding: Binding): Promise<TelegramSessionState> {
    let started: Awaited<ReturnType<TelegramBindingClient["start"]>>;
    try { started = await binding.client.start(); } catch { started = { ok: false, message: "connection failed" }; }
    if (this.bindings.get(sessionId) !== binding || !this.deps.owns(sessionId, binding.lease)) {
      if (this.bindings.get(sessionId) === binding) this.bindings.delete(sessionId);
      await binding.client.close().catch(() => undefined);
      return { sessionId, state: "unavailable", reason: "lease-lost" };
    }
    if (!started.ok) {
      this.bindings.delete(sessionId);
      await binding.client.close().catch(() => undefined);
      const failed: TelegramSessionState = { sessionId, state: "unavailable", reason: "operation-failed" };
      if (!this.bindings.has(sessionId) && this.deps.owns(sessionId, binding.lease)) this.deps.onState?.(failed);
      return failed;
    }
    binding.threadId = started.threadId;
    binding.state = { sessionId, state: "active" };
    delete binding.pending;
    this.deps.onState?.(binding.state);
    return binding.state;
  }

  async send(sessionId: string, generation: string, text: string): Promise<boolean> {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || !this.isCurrent(sessionId, generation)) return false;
    return binding.client.reply(text);
  }

  currentGeneration(sessionId: string): string | undefined {
    const binding = this.bindings.get(sessionId);
    return binding !== undefined && this.isCurrent(sessionId, binding.generation) ? binding.generation : undefined;
  }

  isCurrent(sessionId: string, generation: string): boolean {
    const binding = this.bindings.get(sessionId);
    return binding !== undefined && binding.generation === generation && binding.state.state === "active" && this.deps.owns(sessionId, binding.lease);
  }

  private async receive(sessionId: string, generation: string, text: string, meta: InboundMeta): Promise<void> {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || binding.generation !== generation || binding.state.state !== "active" ||
        !this.deps.owns(sessionId, binding.lease) || binding.threadId !== meta.threadId) return;
    if (!Number.isSafeInteger(meta.fromId) || meta.fromId <= 0 || !Number.isSafeInteger(meta.updateId) || meta.updateId < 0 || typeof text !== "string" || !text.trim()) {
      await binding.client.reply("Input refused: invalid sender or message.");
      return;
    }
    if (binding.seen.has(meta.updateId)) {
      await binding.client.reply("Input refused: this update was already received.");
      return;
    }
    binding.seen.add(meta.updateId);
    if (binding.seen.size > 1000) binding.seen.delete(binding.seen.values().next().value as number);
    const command = text.trim().toLowerCase();
    if (command === "/stop") {
      const stopped = this.deps.onStop(sessionId, generation);
      await binding.client.reply(stopped ? "Stopping the Telegram turn." : "No Telegram turn is running for this attachment.");
      return;
    }
    const result = text.trimStart().startsWith("/") ? "refused" : await this.deps.onInput({ sessionId, generation, text, actorId: meta.fromId, updateId: meta.updateId });
    if (result !== "accepted" && this.bindings.get(sessionId) === binding && this.deps.owns(sessionId, binding.lease)) {
      await binding.client.reply(result === "busy" ? "Input refused: this session is busy." : "Input refused.");
    }
  }

  async detach(sessionId: string): Promise<TelegramSessionState> {
    const held = this.deps.held(sessionId);
    if (held === undefined || !this.deps.owns(sessionId, held.lease)) return { sessionId, state: "unavailable", reason: "lease-lost" };
    const binding = this.bindings.get(sessionId);
    if (binding !== undefined && binding.lease !== held.lease) return { sessionId, state: "unavailable", reason: "lease-lost" };
    if (binding !== undefined) {
      this.deps.onStop(sessionId, binding.generation);
      this.bindings.delete(sessionId);
      await binding.client.close().catch(() => undefined);
    }
    if (!this.deps.owns(sessionId, held.lease)) return { sessionId, state: "unavailable", reason: "lease-lost" };
    if (this.bindings.has(sessionId)) return this.status(sessionId);
    const state: TelegramSessionState = { sessionId, state: "detached" };
    this.deps.onState?.(state);
    return state;
  }

  /** Called by the owning ACP connection on release or shutdown, without a new lease lookup. */
  async release(sessionId: string, lease: object): Promise<void> {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || binding.lease !== lease) return;
    this.deps.onStop(sessionId, binding.generation);
    this.bindings.delete(sessionId);
    await binding.client.close().catch(() => undefined);
  }
}
