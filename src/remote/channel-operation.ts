// State fencing for a future authenticated channel controller. This does not activate a channel.
import { randomUUID } from "node:crypto";
import { loadChannelRecord } from "./channel-record";

export type ChannelOperationResult =
  | { ok: true; operationId: string; revision: number | null }
  | { ok: false; code: "conflict" | "unavailable"; reason: string };

export class ChannelOperationFence {
  private active: { id: string; revision: number | null } | undefined;
  constructor(private readonly dir?: string) {}

  begin(expectedRevision: number | null): ChannelOperationResult {
    const current = loadChannelRecord(this.dir);
    if (!current.ok) return { ok: false, code: "unavailable", reason: current.reason };
    const revision = current.value?.revision ?? null;
    if (this.active !== undefined || revision !== expectedRevision) return { ok: false, code: "conflict", reason: "channel changed or another operation is active" };
    const operationId = randomUUID();
    this.active = { id: operationId, revision };
    return { ok: true, operationId, revision };
  }

  check(operationId: string, expectedRevision: number | null): ChannelOperationResult {
    const current = loadChannelRecord(this.dir);
    if (!current.ok) return { ok: false, code: "unavailable", reason: current.reason };
    const revision = current.value?.revision ?? null;
    if (this.active?.id !== operationId || this.active.revision !== expectedRevision || revision !== expectedRevision) return { ok: false, code: "conflict", reason: "channel operation is stale" };
    return { ok: true, operationId, revision };
  }

  finish(operationId: string): boolean {
    if (this.active?.id !== operationId) return false;
    this.active = undefined;
    return true;
  }
}
