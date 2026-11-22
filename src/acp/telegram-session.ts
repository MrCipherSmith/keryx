import type { ApprovalAnswer, ChoiceAnswer, ClientStatus, InboundMeta, PressedApproval } from "../remote/client";
/** Desktop Telegram session-control contract. The server must not advertise this
 * capability until delegated actor, turn, and decision handling are implemented. */
export const ACP_TELEGRAM_SESSION_METHOD = "_keryx/telegram/session";
const MAX_PENDING_MIRROR_REPLIES = 16;

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
  start(): Promise<{ ok: true; threadId: number; topicUrl?: string } | { ok: false; message: string }>;
  close(): Promise<void>;
  reply(text: string): Promise<boolean>;
  askApproval?(prompt: string, timeoutMs: number, options: { signal: AbortSignal; claim: (answer: PressedApproval) => boolean }): Promise<ApprovalAnswer>;
  askChoice?(text: string, rows: string[][], timeoutMs: number, options: { signal: AbortSignal; claim: (index: number, fromId: number) => boolean }): Promise<ChoiceAnswer>;
}

export interface TelegramBindingDependencies {
  /** Resolves only a live session held by this ACP connection. */
  held(sessionId: string): { project: string; lease: object } | undefined;
  /** Checks that this exact hold still owns its lease. */
  owns(sessionId: string, lease: object): boolean;
  create(input: { sessionId: string; project: string; topicName?: string; owner: { kind: "desktop"; incarnation: string; generation: string }; onLine: (text: string, meta: InboundMeta) => Promise<void>; onStatus: (status: ClientStatus) => void; onChannelRevoked: (cutoverId: string) => boolean }): TelegramBindingClient;
  onStop(sessionId: string, generation: string): boolean;
  isBusy?(sessionId: string): boolean;
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
  topicUrl?: string;
  seen: Set<number>;
  mirrorTail: Promise<boolean>;
  pendingMirrors: number;
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
      onStatus: (status) => this.connectionChanged(sessionId, generation, status),
      onChannelRevoked: () => this.revoke(sessionId, generation),
    });
    const binding: Binding = {
      lease: held.lease, generation, client, state: { sessionId, state: "attaching" }, seen: new Set(),
      mirrorTail: Promise.resolve(true), pendingMirrors: 0,
    };
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
    if (started.topicUrl !== undefined) binding.topicUrl = started.topicUrl;
    binding.state = { sessionId, state: "active", ...(started.topicUrl === undefined ? {} : { topicUrl: started.topicUrl }) };
    delete binding.pending;
    this.deps.onState?.(binding.state);
    return binding.state;
  }

  /** Called before the transport acknowledges a different-bot cutover. */
  private revoke(sessionId: string, generation: string): boolean {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || binding.generation !== generation || !this.deps.owns(sessionId, binding.lease)) return false;
    this.bindings.delete(sessionId);
    this.deps.onStop(sessionId, generation);
    this.deps.onState?.({ sessionId, state: "detached" });
    return true;
  }

  private connectionChanged(sessionId: string, generation: string, status: ClientStatus): void {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || binding.generation !== generation || binding.state.state === "attaching" || !this.deps.owns(sessionId, binding.lease)) return;
    if (status.state === "disconnected" || status.state === "stopped") {
      binding.state = { sessionId, state: status.state === "stopped" ? "unavailable" : "reconnecting", reason: "connection-lost" };
      this.deps.onState?.(binding.state);
    } else if (status.state === "connected" && binding.threadId !== undefined && binding.state.state === "reconnecting") {
      binding.state = { sessionId, state: "active", ...(binding.topicUrl === undefined ? {} : { topicUrl: binding.topicUrl }) };
      this.deps.onState?.(binding.state);
    }
  }

  projectChoice(sessionId: string, generation: string, signal: AbortSignal, claim: (index: number, fromId: number) => boolean): boolean {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || !this.isCurrent(sessionId, generation) || binding.client.askChoice === undefined) return false;
    void binding.client.askChoice("Which response format do you prefer?", [["Concise"], ["Detailed"]], 300_000, { signal, claim }).catch(() => undefined);
    return true;
  }

  projectApproval(sessionId: string, generation: string, prompt: string, timeoutMs: number, signal: AbortSignal, claim: (answer: PressedApproval) => boolean): boolean {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || !this.isCurrent(sessionId, generation) || binding.client.askApproval === undefined) return false;
    void binding.client.askApproval(prompt, timeoutMs, { signal, claim }).catch(() => undefined);
    return true;
  }

  async send(sessionId: string, generation: string, text: string): Promise<boolean> {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || !this.isCurrent(sessionId, generation)) return false;
    return binding.client.reply(text);
  }

  /** Order mirrored messages across turns without holding the ACP turn slot. */
  async enqueueMirror(sessionId: string, generation: string, text: string): Promise<boolean> {
    const binding = this.bindings.get(sessionId);
    if (binding === undefined || !this.isCurrent(sessionId, generation) ||
        binding.pendingMirrors >= MAX_PENDING_MIRROR_REPLIES) return false;
    binding.pendingMirrors++;
    const queued = binding.mirrorTail.then(() => this.send(sessionId, generation, text)).catch(() => false);
    binding.mirrorTail = queued;
    try {
      return await queued;
    } finally {
      binding.pendingMirrors--;
    }
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
    if (command === "/status") {
      await binding.client.reply(this.deps.isBusy?.(sessionId) === true ? "Connected. A turn is running." : "Connected. The session is idle.");
      return;
    }
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
