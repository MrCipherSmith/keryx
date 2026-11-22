// Disabled until activation, rollback and compatible clients are implemented.
import { createHttpBotApi } from "./bot-api-http";
import { DEFAULT_APPROVAL_WAIT_MS, DEFAULT_ORPHAN_MS, DEFAULT_REMOTE_PERMISSION_MODE, DEFAULT_RUN_TIMEOUT_MS, REMOTE_CONFIG_SCHEMA_VERSION, type RemoteConfig } from "./config";
import { loadChannelRecord, type ChannelBotIdentity } from "./channel-record";
import { ChannelOperationFence } from "./channel-operation";
import { consumeChannelToken } from "./channel-staging";
import { fail, ok, readJsonBody } from "./http-surface";
import { Pairing, type PairingOptions } from "./pairing";
import type { BotApi } from "./types";

export interface ChannelControlOptions {
  dir?: string | undefined;
  hasActiveHub: () => boolean;
  openCandidate?: (token: string) => BotApi;
  activate?: (candidate: { token: string; api: BotApi; bot: ChannelBotIdentity; config: RemoteConfig; expectedRevision: number | null; stillOwned: () => boolean; stillActive: () => boolean }) => Promise<{ ok: true; revision: number } | { ok: false; reason: string }>;
  pairing?: Pick<PairingOptions, "ttlMs" | "code" | "timers" | "pollTimeoutSec" | "pollBackoffMs" | "pollSleep">;
}

export class ChannelControl {
  private readonly fence: ChannelOperationFence;
  private pending: { id: string; revision: number | null; pairing?: Pairing; token?: string; api?: BotApi; sameBot?: boolean; activating?: boolean } | undefined;
  constructor(private readonly options: ChannelControlOptions) { this.fence = new ChannelOperationFence(options.dir); }

  pendingOperation(): { operationId: string; revision: number | null } | undefined {
    return this.pending === undefined ? undefined : { operationId: this.pending.id, revision: this.pending.revision };
  }

  async handle(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const doc = body.value;
    const revision = doc.expectedRevision;
    if (doc.version !== 1 || !(revision === null || (typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0))) return fail(400, "invalid-request", "A version and expected revision are required.");
    if (doc.action === "begin") {
      if (Object.keys(doc).some((key) => !["version", "action", "expectedRevision", "stagingId"].includes(key)) || typeof doc.stagingId !== "string") return fail(400, "invalid-request", "A staging id is required.");
      const opened = this.fence.begin(revision);
      if (!opened.ok) return fail(409, opened.code, opened.reason);
      this.pending = { id: opened.operationId, revision };
      const token = consumeChannelToken(doc.stagingId, this.options.dir);
      if (!token.ok) { this.clear(opened.operationId); return fail(422, "invalid-staging", token.reason); }
      const api = this.options.openCandidate?.(token.value) ?? createHttpBotApi({ token: token.value });
      const prepared = await Pairing.prepare({ api, ...this.options.pairing });
      const stillOwned = this.fence.check(opened.operationId, revision);
      if (!stillOwned.ok || this.pending?.id !== opened.operationId) {
        this.clear(opened.operationId);
        return fail(409, "conflict", "Channel operation is stale.");
      }
      if (!prepared.ok) { this.clear(opened.operationId); return fail(422, prepared.kind, prepared.reason); }
      const record = loadChannelRecord(this.options.dir);
      if (!record.ok) { this.clear(opened.operationId); return fail(503, "unavailable", record.reason); }
      if (this.options.hasActiveHub()) {
        const active = record.value;
        if (active?.state !== "connected" || active.bot === null) {
          this.clear(opened.operationId);
          return fail(409, "identity-unknown", "The active bot identity must be verified before starting another poller.");
        }
        this.pending.sameBot = active.bot.id === prepared.pairing.identity().id;
      }
      this.pending.pairing = prepared.pairing;
      this.pending.token = token.value;
      this.pending.api = api;
      if (!this.pending.sameBot) prepared.pairing.begin();
      return ok({ operationId: opened.operationId, revision, ...(this.pending.sameBot ? { state: "same-bot-ready" } : { pairing: prepared.pairing.snapshot() }) });
    }
    if (Object.keys(doc).some((key) => !["version", "action", "expectedRevision", "operationId"].includes(key)) || typeof doc.operationId !== "string" || !["status", "cancel", "confirm"].includes(String(doc.action))) return fail(400, "invalid-request", "A channel operation is required.");
    const owned = this.fence.check(doc.operationId, revision);
    if (!owned.ok || this.pending?.id !== doc.operationId) return fail(409, "conflict", "Channel operation is stale.");
    if (this.pending.activating) return fail(409, "activation-in-progress", "Channel activation is in progress.");
    if (doc.action === "cancel") {
      const pairing = this.pending.pairing;
      this.clear(doc.operationId);
      await pairing?.cancel();
      return ok({ operationId: doc.operationId, revision, state: "cancelled" });
    }
    const pairing = this.pending.pairing;
    if (pairing === undefined) return fail(409, "preparing", "Channel preparation is still in progress.");
    if (doc.action === "confirm") {
      if (this.options.activate === undefined) return fail(503, "activation-unavailable", "Channel activation is not available yet.");
      const sameBot = this.pending.sameBot === true;
      const snapshot = pairing.snapshot();
      const token = this.pending.token;
      const api = this.pending.api;
      if ((!sameBot && (!pairing.isReady() || snapshot.userId === undefined || snapshot.chatId === undefined)) || token === undefined || api === undefined) return fail(409, "pairing-incomplete", "Complete pairing before confirming.");
      this.pending.activating = true;
      await pairing.stop();
      const existing = loadChannelRecord(this.options.dir);
      if (!existing.ok) { this.clear(doc.operationId); return fail(503, "unavailable", existing.reason); }
      if (sameBot && (existing.value?.state !== "connected" || existing.value.bot?.id !== pairing.identity().id)) { this.clear(doc.operationId); return fail(409, "conflict", "Channel identity changed."); }
      const config: RemoteConfig = sameBot && existing.value?.state === "connected" ? existing.value.config : { schemaVersion: REMOTE_CONFIG_SCHEMA_VERSION, chatId: snapshot.chatId!, allowedUserIds: [snapshot.userId!], orphanMs: DEFAULT_ORPHAN_MS, runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS, permissionMode: DEFAULT_REMOTE_PERMISSION_MODE, approvalTimeoutMs: DEFAULT_APPROVAL_WAIT_MS };
      const result = await this.options.activate({ token, api, bot: pairing.identity(), config, expectedRevision: revision, stillOwned: () => this.fence.check(doc.operationId as string, revision).ok && this.pending?.pairing === pairing, stillActive: () => this.pending?.id === doc.operationId && this.pending?.pairing === pairing });
      this.clear(doc.operationId);
      if (!result.ok) return fail(503, "activation-failed", result.reason);
      return ok({ operationId: doc.operationId, revision: result.revision, state: "connected" });
    }
    if (this.pending.sameBot) return ok({ operationId: doc.operationId, revision, state: "same-bot-ready" });
    await pairing.recheck();
    if (!this.fence.check(doc.operationId, revision).ok || this.pending?.pairing !== pairing) return fail(409, "conflict", "Channel operation is stale.");
    return ok({ operationId: doc.operationId, revision, pairing: pairing.snapshot() });
  }

  async stop(): Promise<void> {
    const pending = this.pending;
    if (pending === undefined) return;
    this.clear(pending.id);
    await pending.pairing?.cancel();
  }

  private clear(id: string): void {
    if (this.pending?.id === id) this.pending = undefined;
    this.fence.finish(id);
  }
}
