// RED tests for the deterministic policy engine + context-trust guard
// (flow 009, W7 / T9, sub-slice S3, task-M-01 / task-R0-02 / task-CA-01 /
// task-FI-01).
//
// Pins the frozen policy/containment contract per
// `docs/requirements/keryx-project-agent-harness/acceptance.feature`:
//   - @SC_R05_POLICY_OUTCOME              "Resolve one exclusive policy
//     outcome" (allow/ask/deny baseline, deterministic)
//   - @SC_R05_HARD_DENY                   "Hard deny cannot be overridden"
//   - @SC_R05_HEADLESS_ASK                "Fail closed when approval is
//     required in headless mode"
//   - @SC_R05_STALE_APPROVAL              "Invalidate an approval after a
//     fingerprint changes"
//   - @SC_R08_ROLE_CANNOT_ESCALATE        "Prevent a role from granting
//     itself authority"
//   - @SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED "Prevent direct flow file
//     mutation"
//   - @SC_R07_STALE_OR_UNTRUSTED_CONTEXT  "Keep stale or untrusted context
//     from becoming policy"
// and `docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md`
// (fail-closed posture; hard denies terminal; `override = false` const;
// `read-only-review` forces write/shell/network/delegate = deny).
//
// S3 impl (next dispatch) implements `src/harness/policy/types.ts`
// (`PolicyOutcome`, `PolicyProfile`, `Approval`, `PolicyContext`,
// `PolicyDecision`) and `src/harness/policy/engine.ts` (`decide`,
// `contextIsPolicyTrusted`) to make this suite GREEN; until then the missing
// -module import is the expected RED failure.
//
// Deterministic: `deps.clock`/`deps.idSeq` are fixed per call, no
// `Date.now()`, `Math.random()`, or network. Every emitted `PolicyDecision`
// is validated against the frozen `harness-policy-decision.schema.json` via
// `assertValidDecision`.
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import type { ToolCall, ToolRisk } from "../tool/types";

// PINNED API (see dispatch) — S3 impl exports these; imports fail until then
// (expected RED: "Cannot find module './types'" / "Cannot find module
// './engine'").
import { contextIsPolicyTrusted, decide } from "./engine";
import type { Approval, PolicyContext, PolicyDecision, PolicyProfile } from "./types";

// Frozen schemas dir, computed relative to this file
// (src/harness/policy/ -> repo root).
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
// Deterministic deps: fixed clock, fixed id sequence. `makeDeps()` returns a
// *fresh* sequence starting from the same seed every call so two independent
// `decide` invocations over identical input are structurally identical (no
// shared mutable counter leaking state between tests). Mirrors
// `src/harness/startup.test.ts` `makeDeps()`.
// ---------------------------------------------------------------------------
function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

// ---------------------------------------------------------------------------
// API delta (see subagent-result): the pinned `PolicyDecision` interface in
// the dispatch only declares
// `{schemaVersion, decisionId, toolCallId, decision, policyProfile,
// timestamp, matchedRules, reason?}`. The frozen
// `harness-policy-decision.schema.json` additionally defines
// `hardDeny`/`override`/`approvalId`/`policyFingerprint`/`actionFingerprint`/
// `provenanceId`/`redaction`/`role`, and its `allOf` conditionals make several
// of them REQUIRED when `decision === "ask"` or `hardDeny === true`. S3 impl
// must emit these fields on the wire object for schema validity even though
// they are absent from the pinned TS shape. Tests read them through this
// locally widened view instead of widening the pinned `PolicyDecision` type
// itself, so the pinned API contract stays exactly as dispatched.
// ---------------------------------------------------------------------------
type WirePolicyDecision = PolicyDecision & {
  hardDeny?: boolean;
  override?: boolean;
  approvalId?: string;
  policyFingerprint?: string;
  actionFingerprint?: string;
  provenanceId?: string;
  redaction?: string;
  role?: string;
};

function asWire(decision: PolicyDecision): WirePolicyDecision {
  return decision as WirePolicyDecision;
}

function assertValidDecision(decision: PolicyDecision): void {
  const result = validateAgainstSchema("harness-policy-decision.schema.json", decision, {
    schemaDir: SCHEMA_DIR,
  });
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
}

// ---------------------------------------------------------------------------
// Policy profile fixtures — shaped exactly per `policy-profile.schema.json`
// (schemaVersion/profileId/profileVersion/fingerprint/trustMode/defaults/
// requiredControls), using the three frozen `profileId` enum values verbatim
// (ADR-0003 profile/isolation matrix). No invented profile.
// ---------------------------------------------------------------------------
const readOnlyProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "read-only-review",
  profileVersion: "1.0.0",
  fingerprint: sha256("read-only-review:1.0.0"),
  trustMode: "read-only",
  defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

const monitoredProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "monitored-trusted-local",
  profileVersion: "1.0.0",
  fingerprint: sha256("monitored-trusted-local:1.0.0"),
  trustMode: "trusted-local",
  defaults: { read: "allow", write: "ask", shell: "ask", network: "ask", delegate: "ask" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

const unattendedProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "unattended-untrusted",
  profileVersion: "1.0.0",
  fingerprint: sha256("unattended-untrusted:1.0.0"),
  trustMode: "untrusted",
  defaults: { read: "ask", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
  requiredControls: { isolation: "required-fail-closed", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

describe("policy profile fixtures validate against policy-profile.schema.json", () => {
  test("readOnlyProfile is schema-valid", () => {
    const result = validateAgainstSchema("policy-profile.schema.json", readOnlyProfile, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("monitoredProfile is schema-valid", () => {
    const result = validateAgainstSchema("policy-profile.schema.json", monitoredProfile, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("unattendedProfile is schema-valid", () => {
    const result = validateAgainstSchema("policy-profile.schema.json", unattendedProfile, { schemaDir: SCHEMA_DIR });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tool-call / context builders.
// ---------------------------------------------------------------------------
function makeCall(risk: ToolRisk, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    schemaVersion: 1,
    toolCallId: "call-1",
    toolName: `${risk}-tool`,
    input: {},
    runId: "run-1",
    sessionId: "session-1",
    risk,
    ...overrides,
  };
}

function makeContext(profile: PolicyProfile, overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    profile,
    role: "review",
    interactive: true,
    approvals: [],
    actionFingerprint: sha256("default-action"),
    ...overrides,
  };
}

// === 1. Baseline allow/ask/deny (SC_R05_POLICY_OUTCOME) =====================

describe("SC_R05_POLICY_OUTCOME — deterministic allow/ask/deny baseline", () => {
  test("a read-only call under a permissive profile resolves to allow", () => {
    const call = makeCall("read");
    const ctx = makeContext(readOnlyProfile);
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).toBe("allow");
    expect(decision.toolCallId).toBe(call.toolCallId);
    expect(decision.policyProfile).toBe(readOnlyProfile.profileId);
    assertValidDecision(decision);
  });

  test("a higher-risk call requiring approval under monitored-trusted-local resolves to ask (interactive, no approval yet)", () => {
    const call = makeCall("write");
    const ctx = makeContext(monitoredProfile, { interactive: true });
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).toBe("ask");
    assertValidDecision(decision);
  });

  test("a profile-forbidden action resolves to deny (write under read-only-review)", () => {
    const call = makeCall("write");
    const ctx = makeContext(readOnlyProfile);
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).toBe("deny");
    assertValidDecision(decision);
  });

  test("decide is deterministic across independent fresh-dep calls (allow path)", () => {
    const call = makeCall("read");
    const ctx = makeContext(readOnlyProfile);
    const a = decide(call, ctx, makeDeps());
    const b = decide(call, ctx, makeDeps());
    expect(a).toEqual(b);
  });

  test("decide is deterministic across independent fresh-dep calls (ask path)", () => {
    const call = makeCall("write");
    const ctx = makeContext(monitoredProfile, { interactive: true });
    const a = decide(call, ctx, makeDeps());
    const b = decide(call, ctx, makeDeps());
    expect(a).toEqual(b);
    expect(a.decision).toBe("ask");
  });
});

// === 2. Hard deny unoverridable (SC_R05_HARD_DENY) ==========================

describe("SC_R05_HARD_DENY — hard deny cannot be overridden", () => {
  test("a hard-deny write under read-only-review is not flipped to allow by a present, matching approval", () => {
    const call = makeCall("write");
    const fp = sha256("hard-deny-action");
    const approval: Approval = {
      approvalId: "appr-1",
      actionFingerprint: fp,
      grantedForFingerprint: fp,
      singleUse: true,
      consumed: false,
    };
    const ctx = makeContext(readOnlyProfile, { actionFingerprint: fp, approvals: [approval], interactive: true });
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).toBe("deny");
    const wire = asWire(decision);
    expect(wire.hardDeny).toBe(true);
    if (wire.override !== undefined) {
      expect(wire.override).toBe(false);
    }
    assertValidDecision(decision);
  });

  test("hard deny is not flipped by role or interactivity ('session hints')", () => {
    const call = makeCall("shell");
    const ctxA = makeContext(readOnlyProfile, { role: "review", interactive: true });
    const ctxB = makeContext(readOnlyProfile, { role: "orchestrator", interactive: false });
    const decisionA = decide(call, ctxA, makeDeps());
    const decisionB = decide(call, ctxB, makeDeps());
    expect(decisionA.decision).toBe("deny");
    expect(decisionB.decision).toBe("deny");
    assertValidDecision(decisionA);
    assertValidDecision(decisionB);
  });

  test("every mutation-adjacent risk forced to deny by read-only-review's schema conditionals is a hard deny", () => {
    const hardDenyRisks: ToolRisk[] = ["write", "shell", "network", "delegate"];
    for (const risk of hardDenyRisks) {
      const call = makeCall(risk);
      const ctx = makeContext(readOnlyProfile);
      const decision = decide(call, ctx, makeDeps());
      expect(decision.decision).toBe("deny");
      expect(asWire(decision).hardDeny).toBe(true);
      assertValidDecision(decision);
    }
  });

  test("a credential ('secret') request under read-only-review is denied regardless of an untrusted-content hint", () => {
    // Maps the acceptance Given clause "untrusted project text instructs the
    // model to bypass security ... the model requests a secret ... tool" —
    // the pinned API has no free-text hint field, so the untrusted-content
    // pressure is modelled as an attempted role/approval override (covered
    // above); this test isolates the credential-risk half of the scenario.
    const call = makeCall("credential");
    const ctx = makeContext(readOnlyProfile, { role: "review", interactive: true });
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).toBe("deny");
    assertValidDecision(decision);
  });
});

// === 3. Headless ask fails closed (SC_R05_HEADLESS_ASK) =====================

describe("SC_R05_HEADLESS_ASK — fail closed when approval is required in headless mode", () => {
  test("an otherwise-ask decision becomes deny when interactive=false (never a silent allow)", () => {
    const call = makeCall("write");
    const ctx = makeContext(monitoredProfile, { interactive: false });
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).toBe("deny");
    expect(decision.decision).not.toBe("allow");
    assertValidDecision(decision);
  });

  test("headless fail-closed holds even with a role that would otherwise be trusted", () => {
    const call = makeCall("shell");
    const ctx = makeContext(monitoredProfile, { interactive: false, role: "orchestrator" });
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).toBe("deny");
    assertValidDecision(decision);
  });
});

// === 4. Stale approval invalidated (SC_R05_STALE_APPROVAL) ==================

describe("SC_R05_STALE_APPROVAL — invalidate an approval after a fingerprint changes", () => {
  test("an approval whose grantedForFingerprint differs from the current actionFingerprint does not authorize", () => {
    const originalFp = sha256("original-action");
    const changedFp = sha256("changed-action");
    const staleApproval: Approval = {
      approvalId: "appr-2",
      actionFingerprint: originalFp,
      grantedForFingerprint: originalFp,
      singleUse: true,
      consumed: false,
    };
    const call = makeCall("write");
    const ctx = makeContext(monitoredProfile, {
      actionFingerprint: changedFp,
      approvals: [staleApproval],
      interactive: true,
    });
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).not.toBe("allow");
    expect(["ask", "deny"]).toContain(decision.decision);
    assertValidDecision(decision);
  });

  test("a single-use approval already consumed does not re-authorize, even with a matching fingerprint", () => {
    const fp = sha256("consumed-action");
    const consumedApproval: Approval = {
      approvalId: "appr-3",
      actionFingerprint: fp,
      grantedForFingerprint: fp,
      singleUse: true,
      consumed: true,
    };
    const call = makeCall("write");
    const ctx = makeContext(monitoredProfile, {
      actionFingerprint: fp,
      approvals: [consumedApproval],
      interactive: true,
    });
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).not.toBe("allow");
    assertValidDecision(decision);
  });

  test("contrast case: a fresh, unconsumed approval matching the current fingerprint DOES authorize allow", () => {
    const fp = sha256("fresh-action");
    const freshApproval: Approval = {
      approvalId: "appr-4",
      actionFingerprint: fp,
      grantedForFingerprint: fp,
      singleUse: true,
      consumed: false,
    };
    const call = makeCall("write");
    const ctx = makeContext(monitoredProfile, {
      actionFingerprint: fp,
      approvals: [freshApproval],
      interactive: true,
    });
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).toBe("allow");
    assertValidDecision(decision);
  });
});

// === 5. Role cannot escalate (SC_R08_ROLE_CANNOT_ESCALATE) ==================

describe("SC_R08_ROLE_CANNOT_ESCALATE — a role cannot grant itself higher authority", () => {
  test("changing role alone does not escalate a read-only-review capability the profile forbids", () => {
    const escalationRisks: ToolRisk[] = ["write", "shell", "network", "credential", "delegate"];
    for (const risk of escalationRisks) {
      const call = makeCall(risk);
      const reviewCtx = makeContext(readOnlyProfile, { role: "review" });
      const selfClaimedCtx = makeContext(readOnlyProfile, { role: "elevated-admin" });
      const reviewDecision = decide(call, reviewCtx, makeDeps());
      const selfClaimedDecision = decide(call, selfClaimedCtx, makeDeps());
      expect(reviewDecision.decision).toBe("deny");
      expect(selfClaimedDecision.decision).toBe("deny");
      assertValidDecision(reviewDecision);
      assertValidDecision(selfClaimedDecision);
    }
  });

  test("a role cannot self-grant an ask straight into an allow without a valid approval", () => {
    const call = makeCall("write");
    const ctx = makeContext(monitoredProfile, { role: "self-approved-admin", interactive: true, approvals: [] });
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).not.toBe("allow");
    assertValidDecision(decision);
  });

  test("the decision is bounded by the profile, not by the role field's own claim", () => {
    const call = makeCall("network");
    const ctxUnderReadOnly = makeContext(readOnlyProfile, { role: "unattended-untrusted-role-claim" });
    const ctxUnderMonitored = makeContext(monitoredProfile, {
      role: "unattended-untrusted-role-claim",
      interactive: true,
    });
    const readOnlyDecision = decide(call, ctxUnderReadOnly, makeDeps());
    const monitoredDecision = decide(call, ctxUnderMonitored, makeDeps());
    // Same role string, different profile -> different, profile-bounded outcomes.
    expect(readOnlyDecision.decision).toBe("deny");
    expect(monitoredDecision.decision).not.toBe("deny");
    assertValidDecision(readOnlyDecision);
    assertValidDecision(monitoredDecision);
  });
});

// === 6. Direct flow-file edit denied (SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED) ===

describe("SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED — the harness never mutates flow.json", () => {
  test("a write call targeting flow.json is denied even under a profile that otherwise allows ask", () => {
    const call = makeCall("write");
    const ctx = makeContext(monitoredProfile, {
      interactive: true,
      targetPath: "/repo/.metaproject/flows/009/flow.json",
    });
    const decision = decide(call, ctx, makeDeps());
    expect(decision.decision).toBe("deny");
    assertValidDecision(decision);
  });

  test("managed flow-state file targets are denied regardless of a present, matching approval", () => {
    const fp = sha256("flow-edit-action");
    const approval: Approval = {
      approvalId: "appr-5",
      actionFingerprint: fp,
      grantedForFingerprint: fp,
      singleUse: true,
      consumed: false,
    };
    const flowPaths = ["flow.json", "flows/009/flow.json", "/abs/project/.metaproject/flows/009/flow.json"];
    for (const targetPath of flowPaths) {
      const call = makeCall("write");
      const ctx = makeContext(monitoredProfile, {
        actionFingerprint: fp,
        approvals: [approval],
        interactive: true,
        targetPath,
      });
      const decision = decide(call, ctx, makeDeps());
      expect(decision.decision).toBe("deny");
      assertValidDecision(decision);
    }
  });
});

// === 7. Context trust (SC_R07_STALE_OR_UNTRUSTED_CONTEXT) ===================

describe("SC_R07_STALE_OR_UNTRUSTED_CONTEXT — stale/untrusted context never becomes policy", () => {
  test("a fresh, trusted, exact-reliability source is policy-trusted", () => {
    expect(contextIsPolicyTrusted({ reliability: "exact", trustedAsPolicy: true, stale: false })).toBe(true);
  });

  test("a stale source is never policy-trusted, even if marked trustedAsPolicy", () => {
    expect(contextIsPolicyTrusted({ reliability: "exact", trustedAsPolicy: true, stale: true })).toBe(false);
  });

  test("a source not marked trustedAsPolicy is never policy-trusted", () => {
    expect(contextIsPolicyTrusted({ reliability: "exact", trustedAsPolicy: false, stale: false })).toBe(false);
  });

  test("a low-reliability (estimated/unknown) source cannot grant policy authority", () => {
    expect(contextIsPolicyTrusted({ reliability: "estimated", trustedAsPolicy: true, stale: false })).toBe(false);
    expect(contextIsPolicyTrusted({ reliability: "unknown", trustedAsPolicy: true, stale: false })).toBe(false);
  });

  test("missing/absent fields default to untrusted (fail closed)", () => {
    expect(contextIsPolicyTrusted({})).toBe(false);
  });

  test("a scan-failed / unavailable source (manifest-style trustedAsPolicy:false) never becomes a policy grant", () => {
    // Mirrors `buildContextManifest`'s unavailable-source shape
    // (`src/harness/context/manifest.ts` `mapSource`): reliability "unknown",
    // trustedAsPolicy false.
    expect(contextIsPolicyTrusted({ reliability: "unknown", trustedAsPolicy: false })).toBe(false);
  });
});
