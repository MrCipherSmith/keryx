// RED tests — W15 H-01 security hardening, NaN-date fail-closed closure
// (flow 017, dispatch 017-T5, task H-01, reviewer track: security).
//
// Closes the AC2 deferred @release-0 concern pinned in
// `.metaproject/flows/017-2026-07-13-keryx-harness-w15-hardening/context.md`:
// `src/harness/mutation/approval.ts:139` —
// `if (Date.parse(now) >= Date.parse(request.expiresAt)) return invalid("expired");`
// `Date.parse` returns `NaN` for an unparseable string, and `NaN >= NaN` (and
// any comparison involving `NaN`) is always `false` — so an unparseable
// `expiresAt` OR `now` currently makes the "expired" branch silently skip and
// `checkApproval` falls through to `{ kind: "valid" }`: a fail-OPEN. This
// suite pins the fail-closed fix: an unparseable/NaN `expiresAt` or `now`
// must be treated as INVALID, never valid. Expected RED until W15 T6 (impl)
// adds the NaN guard — additively, per AC2, never touching the existing
// expired/valid comparison behaviour for parseable timestamps.
//
// Fixture pattern mirrors `src/harness/mutation/approval.test.ts`
// (`sha256`, `makeBinding`, `makeRequest`, `makeApprovedResult`,
// `WireApprovalResult`) so this suite composes with the same deterministic,
// side-effect-free contract (fixed ISO timestamp strings; NO `Date.now`/
// `Math.random`/network/fs — `now` and `expiresAt` are always injected
// strings, per `ApprovalCheckInput`).
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  checkApproval,
  type ApprovalCheck,
  type ApprovalRequest,
  type ApprovalResult,
} from "./approval";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function makeBinding(actionFp: string) {
  return {
    policyProfileId: "monitored-trusted-local",
    policyFingerprint: sha256("policy-v1"),
    actionFingerprint: actionFp,
    provenanceId: "prov-1",
  };
}

function makeRequest(actionFp: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    schemaVersion: 1,
    approvalId: "appr-1",
    toolCallId: "call-1",
    causal: { runId: "run-1", sessionId: "session-1", correlationId: "corr-1" },
    binding: makeBinding(actionFp),
    toolId: "fs.write",
    toolVersion: "1.0.0",
    inputHash: actionFp,
    requestedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
    status: "pending",
    ...overrides,
  };
}

type WireApprovalResult = ApprovalResult & { consumedAt?: string; reason?: string };

function makeApprovedResult(actionFp: string, overrides: Partial<WireApprovalResult> = {}): WireApprovalResult {
  return {
    schemaVersion: 1,
    approvalResultId: "appr-result-1",
    approvalId: "appr-1",
    binding: makeBinding(actionFp),
    decision: "approved",
    actorId: "actor-1",
    decidedAt: "2026-01-01T00:01:00.000Z",
    consumedAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC2 — NaN/unparseable `expiresAt` or `now` must fail closed (invalid), NEVER
// silently fall through to `{ kind: "valid" }`.
// ---------------------------------------------------------------------------

describe("checkApproval — NaN-date fail-closed (AC2, Date.parse(NaN) >= Date.parse(NaN) is false, must not fail-open)", () => {
  test("an unparseable expiresAt with a valid now is invalid, never valid (fail-closed)", () => {
    const fp = sha256("nan-expiresat-action");
    const request = makeRequest(fp, { expiresAt: "not-a-date" });
    const result = makeApprovedResult(fp);
    const check: ApprovalCheck = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: true,
      consumed: false,
    });
    expect(check.kind).toBe("invalid");
    expect(check.kind).not.toBe("valid");
  });

  test("an unparseable now with a valid expiresAt is invalid, never valid (fail-closed)", () => {
    const fp = sha256("nan-now-action");
    const request = makeRequest(fp, { expiresAt: "2026-01-01T00:05:00.000Z" });
    const result = makeApprovedResult(fp);
    const check: ApprovalCheck = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "not-a-date",
      interactive: true,
      consumed: false,
    });
    expect(check.kind).toBe("invalid");
    expect(check.kind).not.toBe("valid");
  });

  test("both now and expiresAt unparseable is invalid, never valid (fail-closed)", () => {
    const fp = sha256("nan-both-action");
    const request = makeRequest(fp, { expiresAt: "garbage-timestamp" });
    const result = makeApprovedResult(fp);
    const check: ApprovalCheck = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "also-garbage",
      interactive: true,
      consumed: false,
    });
    expect(check.kind).toBe("invalid");
    expect(check.kind).not.toBe("valid");
  });

  test("an empty-string expiresAt is invalid, never valid (fail-closed)", () => {
    const fp = sha256("empty-expiresat-action");
    const request = makeRequest(fp, { expiresAt: "" });
    const result = makeApprovedResult(fp);
    const check: ApprovalCheck = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: true,
      consumed: false,
    });
    expect(check.kind).toBe("invalid");
    expect(check.kind).not.toBe("valid");
  });
});

// ---------------------------------------------------------------------------
// Regression lock — parseable timestamps behave exactly as before (additive,
// backward-compatible; AC2's "valid timestamps behave exactly as before").
// ---------------------------------------------------------------------------

describe("checkApproval — NaN-date hardening stays additive (regression lock, parseable timestamps unaffected)", () => {
  test("a normal, unexpired, otherwise-valid approval still returns valid", () => {
    const fp = sha256("regression-happy-path-action");
    const request = makeRequest(fp, { expiresAt: "2026-01-01T00:05:00.000Z" });
    const result = makeApprovedResult(fp);
    const check = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: true,
      consumed: false,
    });
    expect(check).toEqual({ kind: "valid" });
  });

  test("a genuinely expired approval (now >= expiresAt, both parseable) still returns invalid \"expired\"", () => {
    const fp = sha256("regression-expired-action");
    const request = makeRequest(fp, { expiresAt: "2026-01-01T00:05:00.000Z" });
    const result = makeApprovedResult(fp);
    const check = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "2026-01-01T00:05:00.000Z",
      interactive: true,
      consumed: false,
    });
    expect(check).toEqual({ kind: "invalid", reason: "expired" });
  });
});
