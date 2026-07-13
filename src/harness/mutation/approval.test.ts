// RED tests for W10 M-01 guarded-mutation fingerprint + single-use approval
// (flow 013, dispatch 013-T5, task-M-01, reviewer track: security).
//
// Pins the fingerprint + approval half of the frozen guarded-mutation contract
// per `docs/requirements/keryx-project-agent-harness/acceptance.feature`:
//   - @SC_R05_STALE_APPROVAL  "Invalidate an approval after a fingerprint changes"
//   - @SC_R05_HEADLESS_ASK    "Fail closed when approval is required in headless mode"
// and `docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md`
// §3 "Stale approval" / §2 "Headless / unattended ask" (fail-closed posture).
//
// M-01 impl (next dispatch) implements `src/harness/mutation/fingerprint.ts`
// (`ActionSpec`, `actionFingerprint`) and `src/harness/mutation/approval.ts`
// (`ApprovalRequest`, `ApprovalResult`, `ApprovalCheck`, `checkApproval`) to
// make this suite GREEN; until then the missing-module import below is the
// expected RED failure ("Cannot find module './fingerprint'" / "./approval").
//
// Scenario -> test mapping:
//   1. actionFingerprint determinism      -> describe("actionFingerprint — ...")
//   2. Approval schema-valid              -> describe("ApprovalRequest / ApprovalResult — schema-valid constructions")
//   3. Single-use / consumed              -> describe("checkApproval — single-use / consumed ...")
//   4. Stale on fingerprint change (R05)  -> describe("checkApproval — stale on fingerprint change ...")
//   5. Expired                            -> describe("checkApproval — expired")
//   6. Denied / missing result            -> describe("checkApproval — denied / missing result ...")
//   7. Headless (R05)                     -> describe("checkApproval — headless fails closed ...")
//   8. Valid happy path                   -> describe("checkApproval — valid happy path ...")
//
// ---------------------------------------------------------------------------
// API DELTAS vs. the dispatch's pinned sketch (M-01 impl must honour these):
//
// 1. `approval-result.schema.json` `decision` enum is
//    `["approved", "rejected", "expired", "invalidated"]` — there is NO
//    literal `"allow"`/`"deny"` value (the dispatch's checkApproval doc-comment
//    says "decision=allow", which does not exist on the wire). This suite
//    treats `"approved"` as the only decision that can ever authorize
//    execution; `"rejected"`, `"expired"`, and `"invalidated"` are all
//    non-authorizing.
//
// 2. `approval-result.schema.json` additionally declares optional
//    `consumedAt` (required when `decision === "approved"`) and `reason`
//    (required when `decision` is `rejected"`/`"expired"`/`"invalidated"`) as
//    real schema properties (`additionalProperties` is NOT `false` on this
//    schema, so these are legitimate wire fields) — but the dispatch's pinned
//    `ApprovalResult` TS interface only lists
//    `{schemaVersion, approvalResultId, approvalId, binding, decision,
//    actorId, decidedAt}`. This suite reads/writes those two schema fields
//    through a locally widened `WireApprovalResult` view (mirrors
//    `engine.test.ts`'s `WirePolicyDecision`/`asWire` pattern) instead of
//    widening the pinned `ApprovalResult` type itself.
//
// 3. `approval-request.schema.json` pins `status` to the JSON Schema `const`
//    `"pending"` — an `ApprovalRequest` can never carry any other status
//    value on the wire. There is no schema-level "stale"/"consumed" status;
//    all of `checkApproval`'s invalidation reasons are computed at
//    check-time from the request/result/context, never read off a stored
//    status field. Fixtures below always set `status: "pending"`.
//
// 4. `checkApproval` precedence (the dispatch names the five invalid reasons
//    but not their order; this suite pins the following fail-closed
//    precedence, which M-01 impl must implement so every test below is
//    unambiguous):
//      a. `result` is `undefined`                                -> "denied" (fail-closed: no recorded decision never authorizes)
//      b. `result.decision === "rejected"`                       -> "denied"
//      c. `result.decision === "expired"`                        -> "expired"
//      d. `result.decision === "invalidated"`                    -> "stale"
//      e. `result.decision === "approved"` AND `consumed === true` -> "consumed"
//      f. `result.decision === "approved"` AND `request.inputHash !== currentFingerprint` -> "stale"
//      g. `result.decision === "approved"` AND `now >= request.expiresAt` -> "expired"
//      h. `result.decision === "approved"` AND `interactive === false`  -> "headless"
//      i. otherwise                                              -> `{ kind: "valid" }`
//
// Deterministic + offline: every fixture uses fixed ISO timestamps and fixed
// ids; no `Date.now()`, `Math.random()`, or network anywhere in this file.
// NO real fs — fingerprints are computed over plain data, no filesystem
// access or symlink resolution here (that belongs to `guard.test.ts`).
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";

// PINNED API under test — M-01 impl exports these; imports fail until then
// (expected RED: "Cannot find module './fingerprint'" / "./approval").
import {
  checkApproval,
  type ApprovalCheck,
  type ApprovalRequest,
  type ApprovalResult,
} from "./approval";
import { actionFingerprint, type ActionSpec } from "./fingerprint";

// Frozen schemas dir, computed relative to this file
// (src/harness/mutation/ -> repo root).
const SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 1. actionFingerprint — canonical, deterministic action fingerprint (AC1).
// ---------------------------------------------------------------------------

const worktreeRoot = "/repo/worktree";

const baseSpec: ActionSpec = {
  path: "/repo/worktree/src/index.ts",
  argv: ["cat", "/repo/worktree/src/index.ts"],
  env: { PATH: "/usr/bin", SECRET_TOKEN: "abc123" },
};

const baseOpts = { worktreeRoot, envAllowlist: ["PATH"] };

describe("actionFingerprint — deterministic canonical fingerprint (AC1)", () => {
  test("is stable for identical normalized input across independent calls", () => {
    const a = actionFingerprint(baseSpec, baseOpts);
    const b = actionFingerprint(
      { path: baseSpec.path, argv: [...baseSpec.argv], env: { ...baseSpec.env } },
      { worktreeRoot: baseOpts.worktreeRoot, envAllowlist: [...baseOpts.envAllowlist] },
    );
    expect(a).toBe(b);
  });

  test("differs when the path differs", () => {
    const a = actionFingerprint(baseSpec, baseOpts);
    const b = actionFingerprint({ ...baseSpec, path: "/repo/worktree/src/other.ts" }, baseOpts);
    expect(a).not.toBe(b);
  });

  test("differs when argv differs", () => {
    const a = actionFingerprint(baseSpec, baseOpts);
    const b = actionFingerprint(
      { ...baseSpec, argv: ["cat", "/repo/worktree/src/other.ts"] },
      baseOpts,
    );
    expect(a).not.toBe(b);
  });

  test("differs when an allowlisted env value differs", () => {
    const a = actionFingerprint(baseSpec, baseOpts);
    const b = actionFingerprint(
      { ...baseSpec, env: { ...baseSpec.env, PATH: "/usr/local/bin" } },
      baseOpts,
    );
    expect(a).not.toBe(b);
  });

  test("is unaffected when a non-allowlisted env value changes", () => {
    const a = actionFingerprint(baseSpec, baseOpts);
    const b = actionFingerprint(
      { ...baseSpec, env: { ...baseSpec.env, SECRET_TOKEN: "a-completely-different-value" } },
      baseOpts,
    );
    expect(a).toBe(b);
  });

  test("is unaffected when a non-allowlisted env key is added", () => {
    const a = actionFingerprint(baseSpec, baseOpts);
    const b = actionFingerprint(
      { ...baseSpec, env: { ...baseSpec.env, NOISE_VAR: "irrelevant" } },
      baseOpts,
    );
    expect(a).toBe(b);
  });

  test("produces a lowercase 64-hex-char sha256-shaped string (matches harness-envelope sha256 $def)", () => {
    const fp = actionFingerprint(baseSpec, baseOpts);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 2. Approval fixture builders.
// ---------------------------------------------------------------------------

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

// Widened view: `consumedAt`/`reason` are real `approval-result.schema.json`
// properties (see API DELTA 2 above) absent from the pinned `ApprovalResult`
// TS shape. Fixtures are built at this wider type and passed to `checkApproval`
// (which accepts a plain `ApprovalResult`) via ordinary structural widening —
// mirrors `engine.test.ts`'s `WirePolicyDecision`/`asWire`.
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

function makeDeniedResult(
  actionFp: string,
  decision: "rejected" | "expired" | "invalidated",
  reason: string,
): WireApprovalResult {
  return {
    schemaVersion: 1,
    approvalResultId: "appr-result-2",
    approvalId: "appr-1",
    binding: makeBinding(actionFp),
    decision,
    actorId: "actor-1",
    decidedAt: "2026-01-01T00:01:00.000Z",
    reason,
  };
}

describe("ApprovalRequest / ApprovalResult — schema-valid constructions", () => {
  test("a pending ApprovalRequest validates against approval-request.schema.json", () => {
    const fp = sha256("action-request-1");
    const request = makeRequest(fp);
    const result = validateAgainstSchema("approval-request.schema.json", request, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("an approved ApprovalResult (with consumedAt) validates against approval-result.schema.json", () => {
    const fp = sha256("action-result-approved");
    const result = makeApprovedResult(fp);
    const validation = validateAgainstSchema("approval-result.schema.json", result, { schemaDir: SCHEMA_DIR });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test("a rejected ApprovalResult (with reason, no consumedAt) validates against approval-result.schema.json", () => {
    const fp = sha256("action-result-rejected");
    const result = makeDeniedResult(fp, "rejected", "operator declined the mutation");
    const validation = validateAgainstSchema("approval-result.schema.json", result, { schemaDir: SCHEMA_DIR });
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test("an approved ApprovalResult WITHOUT consumedAt is schema-invalid (consumedAt is conditionally required)", () => {
    const fp = sha256("action-result-missing-consumedat");
    const invalid: WireApprovalResult = {
      schemaVersion: 1,
      approvalResultId: "appr-result-3",
      approvalId: "appr-1",
      binding: makeBinding(fp),
      decision: "approved",
      actorId: "actor-1",
      decidedAt: "2026-01-01T00:01:00.000Z",
    };
    const validation = validateAgainstSchema("approval-result.schema.json", invalid, { schemaDir: SCHEMA_DIR });
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. checkApproval — single-use / consumed (AC1: "single-use ... NEVER executes").
// ---------------------------------------------------------------------------

describe("checkApproval — single-use / consumed approvals never re-authorize (AC1)", () => {
  test("an approval already consumed by the guard is invalid, even with a fresh, matching, approved result", () => {
    const fp = sha256("single-use-action");
    const request = makeRequest(fp);
    const result = makeApprovedResult(fp);
    const check: ApprovalCheck = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: true,
      consumed: true,
    });
    expect(check).toEqual({ kind: "invalid", reason: "consumed" });
  });
});

// ---------------------------------------------------------------------------
// 4. checkApproval — stale on fingerprint change (SC_R05_STALE_APPROVAL).
// ---------------------------------------------------------------------------

describe("checkApproval — stale on fingerprint change (SC_R05_STALE_APPROVAL)", () => {
  test("request.inputHash mismatching the current action fingerprint invalidates as stale", () => {
    const originalFp = sha256("original-action");
    const changedFp = sha256("changed-action");
    const request = makeRequest(originalFp);
    const result = makeApprovedResult(originalFp);
    const check = checkApproval({
      request,
      result,
      currentFingerprint: changedFp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: true,
      consumed: false,
    });
    expect(check).toEqual({ kind: "invalid", reason: "stale" });
  });

  test("a result explicitly recorded as invalidated is also treated as stale", () => {
    const fp = sha256("invalidated-action");
    const request = makeRequest(fp);
    const result = makeDeniedResult(fp, "invalidated", "tool schema changed after grant");
    const check = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: true,
      consumed: false,
    });
    expect(check).toEqual({ kind: "invalid", reason: "stale" });
  });

  test("a stale approval remains immutable: re-checking it never flips to valid", () => {
    const originalFp = sha256("immutable-original-action");
    const changedFp = sha256("immutable-changed-action");
    const request = makeRequest(originalFp);
    const result = makeApprovedResult(originalFp);
    const first = checkApproval({
      request,
      result,
      currentFingerprint: changedFp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: true,
      consumed: false,
    });
    const second = checkApproval({
      request,
      result,
      currentFingerprint: changedFp,
      now: "2026-01-01T00:03:00.000Z",
      interactive: true,
      consumed: false,
    });
    expect(first).toEqual({ kind: "invalid", reason: "stale" });
    expect(second).toEqual({ kind: "invalid", reason: "stale" });
  });
});

// ---------------------------------------------------------------------------
// 5. checkApproval — expired.
// ---------------------------------------------------------------------------

describe("checkApproval — expired", () => {
  test("now >= request.expiresAt invalidates as expired, even with an approved, fingerprint-matching result", () => {
    const fp = sha256("expiring-action");
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

  test("a result explicitly recorded as expired is also treated as expired", () => {
    const fp = sha256("recorded-expired-action");
    const request = makeRequest(fp);
    const result = makeDeniedResult(fp, "expired", "approval window elapsed before use");
    const check = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: true,
      consumed: false,
    });
    expect(check).toEqual({ kind: "invalid", reason: "expired" });
  });
});

// ---------------------------------------------------------------------------
// 6. checkApproval — denied / missing result (fail-closed).
// ---------------------------------------------------------------------------

describe("checkApproval — denied / missing result fails closed", () => {
  test("a rejected decision invalidates as denied", () => {
    const fp = sha256("rejected-action");
    const request = makeRequest(fp);
    const result = makeDeniedResult(fp, "rejected", "operator declined");
    const check = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: true,
      consumed: false,
    });
    expect(check).toEqual({ kind: "invalid", reason: "denied" });
  });

  test("a missing approval result (no decision recorded yet) fails closed as denied, never a silent allow", () => {
    const fp = sha256("no-result-action");
    const request = makeRequest(fp);
    const check = checkApproval({
      request,
      result: undefined,
      currentFingerprint: fp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: true,
      consumed: false,
    });
    expect(check).toEqual({ kind: "invalid", reason: "denied" });
    expect(check.kind).not.toBe("valid");
  });
});

// ---------------------------------------------------------------------------
// 7. checkApproval — headless fails closed (SC_R05_HEADLESS_ASK).
// ---------------------------------------------------------------------------

describe("checkApproval — headless fails closed (SC_R05_HEADLESS_ASK)", () => {
  test("an otherwise-valid approval (approved, matching, unexpired, unconsumed) is invalid when non-interactive", () => {
    const fp = sha256("headless-action");
    const request = makeRequest(fp);
    const result = makeApprovedResult(fp);
    const check = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: false,
      consumed: false,
    });
    expect(check).toEqual({ kind: "invalid", reason: "headless" });
  });

  test("headless fail-closed never auto-approves or silently executes (kind is never 'valid')", () => {
    const fp = sha256("headless-never-valid-action");
    const request = makeRequest(fp);
    const result = makeApprovedResult(fp);
    const check = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "2026-01-01T00:02:00.000Z",
      interactive: false,
      consumed: false,
    });
    expect(check.kind).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// 8. checkApproval — valid happy path (so the negatives above are meaningful).
// ---------------------------------------------------------------------------

describe("checkApproval — valid happy path", () => {
  test("decision=approved + fingerprint match + not expired + not consumed + interactive => valid", () => {
    const fp = sha256("happy-path-action");
    const request = makeRequest(fp);
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

  test("valid is exactly at the boundary just before expiresAt (now < expiresAt)", () => {
    const fp = sha256("boundary-action");
    const request = makeRequest(fp, { expiresAt: "2026-01-01T00:05:00.000Z" });
    const result = makeApprovedResult(fp);
    const check = checkApproval({
      request,
      result,
      currentFingerprint: fp,
      now: "2026-01-01T00:04:59.999Z",
      interactive: true,
      consumed: false,
    });
    expect(check).toEqual({ kind: "valid" });
  });
});
