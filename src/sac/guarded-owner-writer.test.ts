import { expect, test } from "bun:test";
import { createGuardedOwnerWriter, receiptMatchesIntent, type OwnerWriteIntent } from "./guarded-owner-writer";

const intent: OwnerWriteIntent = {
  intentRef: "./proposals/proposal-a.key.write-intent.json",
  proposalId: "proposal-a",
  proposalRevision: "r1",
  workspaceId: "workspace-a",
  correlationId: "proposal-review-correlation-0001",
  idempotencyKey: "proposal-review-idempotency-0001",
  reviewerSubject: "user:reviewer",
  reviewerAuthority: "editor",
  policyRevision: "policy-r1",
};

test("owner writer derives a receipt structurally bound to the immutable intent", async () => {
  let mutations = 0;
  const writer = createGuardedOwnerWriter({
    owner: "wiki",
    authorize: async (received) => received.reviewerAuthority === "editor",
    recover: async () => undefined,
    persist: async () => { mutations += 1; return { receiptRef: "./receipts/wiki-a.json", targetRef: "./wiki/a.md", completedAt: "2026-08-12T00:00:00.000Z" }; },
  });
  const result = await writer.write(intent);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(mutations).toBe(1);
  expect(receiptMatchesIntent({ owner: "wiki", receipt: result.receipt, intent })).toBe(true);
  expect(receiptMatchesIntent({ owner: "wiki", receipt: result.receipt, intent: { ...intent, policyRevision: "policy-r2" } })).toBe(false);
});

test("denied owner authority prevents target mutation", async () => {
  let mutations = 0;
  const writer = createGuardedOwnerWriter({ owner: "memory", authorize: async () => false, recover: async () => undefined, persist: async () => { mutations += 1; return { receiptRef: "./receipts/a", targetRef: "./memory/a.md", completedAt: "2026-08-12T00:00:00.000Z" }; } });
  await expect(writer.write(intent)).resolves.toEqual({ ok: false, code: "owner_write_denied" });
  expect(mutations).toBe(0);
});
