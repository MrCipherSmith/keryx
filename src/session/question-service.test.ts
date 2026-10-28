import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionApprovalService } from "./question-service";
import { createApproval, newApprovalId, readApproval } from "../lib/serve-approvals-store";

test("headless broker applies only the exact live action and records the authenticated human before consumption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-session-approvals-"));
  let question!: { approvalId: string; fingerprint: string; summary: string };
  let delivered!: () => void;
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  const fingerprint = "apply_patch\u0000{\"patch\":\"private local action\"}"; const policyDigest = "b".repeat(64);
  const service = createSessionApprovalService({ dir, sessionId: "session", connected: () => true,
    deliver: (value) => { question = value; delivered(); } });
  try {
    const waiting = service.request({ runId: "run", turnId: "turn", policyDigest, toolName: "apply_patch", input: JSON.stringify({ patch: "*** Begin Patch\n*** Add File: reviewed.txt\n+reviewed-content\n*** End Patch" }), fingerprint });
    await delivery;
    expect(question.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(question.fingerprint).not.toContain("private local action");
    expect(question.summary).toContain("reviewed.txt"); expect(question.summary).toContain("reviewed-content");
    expect(await service.answer({ approvalId: question.approvalId, runId: "run", turnId: "turn", actorId: "human", policyDigest, fingerprint: "c".repeat(64), decision: "allow-once" })).toMatchObject({ status: "rejected" });
    expect(readApproval(question.approvalId, dir).ok).toBe(true);
    const applied = await service.answer({ approvalId: question.approvalId, runId: "run", turnId: "turn", actorId: "human", policyDigest, fingerprint: question.fingerprint, decision: "allow-once" });
    expect(applied.status).toBe("applied");
    expect(await waiting).toEqual({ approved: true, fingerprint });
    const stored = readApproval(question.approvalId, dir); expect(stored.ok).toBe(true);
    if (stored.ok) { expect(stored.value.answeredBy).toBe("human"); expect(stored.value.consumed).toBe(true); expect(stored.value.callFingerprint).toBe(question.fingerprint); expect(stored.value.summary).toBe(question.summary); }
    expect((await service.answer({ approvalId: question.approvalId, runId: "run", turnId: "turn", actorId: "human", policyDigest, fingerprint, decision: "allow-once" })).status).toBe("not-pending");
  } finally { service.denyAll("test-end"); await rm(dir, { recursive: true, force: true }); }
});

test("ambiguous secret-bearing or oversized action details require local review and never deliver a blind allow card", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-private-approval-")); let delivered = 0;
  const service = createSessionApprovalService({ dir, sessionId: "session", connected: () => true, expirySeconds: 1, deliver() { delivered++; } });
  try {
    const base = { runId: "run", turnId: "turn", policyDigest: "b".repeat(64), toolName: "shell_exec", fingerprint: "opaque" };
    expect(await service.request({ ...base, input: JSON.stringify({ command: "echo x", env: { OPENROUTER_API_KEY: "secret-value" } }) })).toMatchObject({ approved: false });
    expect(await service.request({ ...base, input: JSON.stringify({ command: "x".repeat(9000) }) })).toMatchObject({ approved: false });
    expect(delivered).toBe(0);
  } finally { service.denyAll("test-end"); await rm(dir, { recursive: true, force: true }); }
});

test("native action summaries preserve reviewable patches up to wire byte limit while legacy stores retain their default limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "keryx-native-action-details-"));
  let question: { approvalId: string; summary: string } | undefined; let deliver!: () => void;
  const delivered = new Promise<void>((resolve) => { deliver = resolve; });
  const service = createSessionApprovalService({ dir, sessionId: "session", connected: () => true, deliver(value) { question = value; deliver(); } });
  try {
    const legacy = createApproval({ approvalId: newApprovalId(), turnId: "legacy", sessionId: "legacy", summary: "x".repeat(2000), scope: "one call", consequence: "changes files",
      expiresAt: new Date(Date.now() + 1000), correlationId: "legacy", callFingerprint: "a".repeat(64), floors: [] }, dir);
    expect(legacy.summary.length).toBe(500);
    const input = JSON.stringify({ patch: `*** Begin Patch\n*** Add File: readable.txt\n${"+reviewable-line\n".repeat(100)}*** End Patch` });
    const pending = service.request({ runId: "run", turnId: "turn", policyDigest: "b".repeat(64), toolName: "apply_patch", input, fingerprint: "native-action" });
    await Promise.race([delivered, pending]);
    expect((question?.summary.length ?? 0) > 500).toBe(true);
    expect(question?.summary.endsWith('*** End Patch"\n}')).toBe(true);
    const stored = readApproval(question!.approvalId, dir); expect(stored.ok && stored.value.summary === question!.summary).toBe(true);
    service.denyAll("test-end"); await pending;
  } finally { service.denyAll("test-end"); await rm(dir, { recursive: true, force: true }); }
});
