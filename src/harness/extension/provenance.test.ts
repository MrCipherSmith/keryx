// RED tests for R2-2 registered-extension provenance (flow 024, W15+/R2-1+/W12+/
// W7+/W10+ / T5, reviewer track: security/contract).
//
// Pins the frozen scope (E-03 §4 AC-R2-2, 2 scenarios):
//   - SC_R18_REGISTERED_EXTENSION_PROVENANCE (AC1/AC2): a successful
//     `registerExtension` (pinned manifest + non-empty capability grant)
//     persists an `ExtensionProvenanceRecord` carrying the pinned
//     `manifestHash`, the grant's `grantId`, its `capabilities` EXACTLY (never
//     a superset — authority is NOT widened beyond the grant), and a
//     derived-trust `Provenance` (W7 shape, `trustLevel:"derived"`, a fresh
//     `provenanceId` from the injected `idSeq()`, taint-linked to the
//     registration/parent provenance via W12 `childProvenance`). A
//     fail-closed registration (missing pinned manifest / empty grant)
//     propagates the deny and produces NO record.
//   - SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY (AC3, negative, registry
//     side): `evaluateRegisteredExtensionCapability` grants a requested
//     capability that is IN the record's grant; a capability OUTSIDE the
//     grant is an escalation reusing R2-1's `evaluateExtensionGrant` — denied
//     unless policy=allow + provenance + a valid W10 approval are ALL
//     present (or it surfaces an explicit ask/non-grant outcome); an
//     out-of-enum capability fails closed. A denial grants NOTHING.
//
// The impl module under test, `src/harness/extension/provenance.ts`, does NOT
// exist yet (T6's job) — the missing-module import below is the expected RED
// failure ("Cannot find module './provenance'"), NOT a bug in this test file.
//
// ---------------------------------------------------------------------------
// PINNED API (T6 impl must match exactly) — composes ONLY already-GREEN
// modules (W15 registry, R2-1 execute.ts, W12 childProvenance, W7 Provenance,
// W10 approval); no rewrite of prior behavior; NEVER writes flow.json.
//
//   export interface ExtensionProvenanceRecord {
//     extensionId: string;
//     manifestHash: string;        // == input.manifest.manifestHash (pinned)
//     grantId: string;             // == input.capabilityGrant.grantId
//     capabilities: string[];      // EXACTLY a copy of input.capabilityGrant.capabilities
//     provenance: Provenance;      // W7 shape; trustLevel:"derived" (via W12 childProvenance)
//   }
//
//   export interface RegisterExtensionWithProvenanceDeps {
//     idSeq: () => string;
//     clock: () => string;
//     registrationProvenance?: Provenance;  // parent provenance for childProvenance derivation
//   }
//   export function registerExtensionWithProvenance(
//     input: RegisterExtensionInput,
//     deps: RegisterExtensionWithProvenanceDeps,
//   ): { ok: true; record: ExtensionProvenanceRecord } | { ok: false; reason: string };
//     - Calls W15 `registerExtension(input)` first.
//     - `{ok:false}` (missing pinned manifest / empty grant) -> propagate the
//       SAME deny shape `{ok:false;reason}` verbatim (registry's reason);
//       result carries NO `record` key at all.
//     - `{ok:true}` -> build `record` via `childProvenance(deps.registrationProvenance
//       ?? <a deterministic root>, {idSeq: deps.idSeq})` for `record.provenance`
//       (`trustLevel` forced to `"derived"`; `provenanceId` === `deps.idSeq()`'s
//       first value consumed for this call).
//     - `record.capabilities` is a FRESH ARRAY COPY of `input.capabilityGrant.capabilities`
//       (deep-equal, never the same reference, never a superset — mutating the
//       original grant's array AFTER the call must not affect `record.capabilities`).
//     - Deterministic: no `Date.now`/`Math.random`; identical input + identical
//       (fresh, equivalently-seeded) deps twice -> deep-equal `record`.
//
//   export interface EvaluateRegisteredExtensionCapabilityInput {
//     record: ExtensionProvenanceRecord;
//     requestedCapability: string;
//     policyDecision?: "allow" | "ask" | "deny";
//     provenance?: Provenance;
//     approval?: ApprovalCheckInput;
//   }
//   export interface EvaluateRegisteredExtensionCapabilityDeps {
//     checkApproval: typeof checkApproval;
//   }
//   export function evaluateRegisteredExtensionCapability(
//     input: EvaluateRegisteredExtensionCapabilityInput,
//     deps: EvaluateRegisteredExtensionCapabilityDeps,
//   ): { ok: true } | { ok: false; reason: string };
//     - `requestedCapability` IN `record.capabilities` -> `{ok:true}` regardless
//       of policy/provenance/approval (reuses R2-1 `evaluateExtensionGrant`
//       with `grantedCapabilities: record.capabilities`, `requestedCapabilities:
//       [requestedCapability]`).
//     - `requestedCapability` OUTSIDE `record.capabilities` (escalation) ->
//       `evaluateExtensionGrant`'s escalation gate: requires ALL of
//       `policyDecision === "allow"`, a defined `provenance`, and
//       `deps.checkApproval(approval)` returning `{kind:"valid"}`; each
//       missing/failing piece independently denies, its `reason` naming the
//       piece ("polic", "provenance", "approval"). `"deny"`/`"ask"` policy (or
//       no policy) NEVER silently grants an escalation.
//     - An out-of-enum `requestedCapability` (or an out-of-enum granted
//       capability) fails CLOSED regardless of policy/provenance/approval.
//     - A denied result carries NO capability grant — exactly `{ok:false;reason}`.
//
// Deterministic + OFFLINE: all ids/hashes/timestamps are fixture constants or
// injected via `deps` (no `Date.now()`, `Math.random()`, network, or real fs
// mutation).
import { describe, expect, test } from "bun:test";
import { checkApproval } from "../mutation/approval";
import type { ApprovalCheckInput, ApprovalRequest } from "../mutation/approval";
import type { Provenance } from "../session/types";
import type { CapabilityGrant, ExtensionManifest, RegisterExtensionInput } from "./registry";

// PINNED API under test — T6 impl exports these; imports fail until then
// (expected RED: "Cannot find module './provenance'").
import { evaluateRegisteredExtensionCapability, registerExtensionWithProvenance } from "./provenance";
import type {
  EvaluateRegisteredExtensionCapabilityDeps,
  EvaluateRegisteredExtensionCapabilityInput,
  ExtensionProvenanceRecord,
  RegisterExtensionWithProvenanceDeps,
} from "./provenance";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

// ---------------------------------------------------------------------------
// Deterministic fixture factories (no Date.now/Math.random).
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return { manifestHash: HASH_A, extensionVersion: "1.0.0", ...overrides };
}

function makeGrant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return { grantId: "grant-024-1", capabilities: ["read", "write"], ...overrides };
}

function makeInput(overrides: Partial<RegisterExtensionInput> = {}): RegisterExtensionInput {
  return {
    extensionId: "ext-024-1",
    manifest: makeManifest(),
    capabilityGrant: makeGrant(),
    ...overrides,
  };
}

function makeRegistrationProvenance(): Provenance {
  return {
    provenanceId: "prov-024-registry-root",
    trustLevel: "trusted",
    sourceKind: "harness-extension-registry",
  };
}

function makeRegisterDeps(
  overrides: Partial<RegisterExtensionWithProvenanceDeps> = {},
): RegisterExtensionWithProvenanceDeps {
  let idCounter = 0;
  return {
    idSeq: () => `prov-024-derived-${idCounter++}`,
    clock: () => "2026-07-13T00:00:00.000Z",
    registrationProvenance: makeRegistrationProvenance(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1/AC2 — registerExtensionWithProvenance: persisted record, bounded to the grant.
// ---------------------------------------------------------------------------

describe("AC1 — registerExtensionWithProvenance: a successful registration persists a bounded provenance record", () => {
  test("well-formed input yields ok:true with a record carrying the pinned manifest, grantId, capabilities, and a derived provenance", () => {
    const input = makeInput();
    const result = registerExtensionWithProvenance(input, makeRegisterDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true for a well-formed registration");

    const { record } = result;
    expect(record.extensionId).toBe("ext-024-1");
    expect(record.manifestHash).toBe(HASH_A);
    expect(record.grantId).toBe("grant-024-1");
    expect(record.capabilities).toEqual(["read", "write"]);
    expect(record.provenance.trustLevel).toBe("derived");
    expect(record.provenance.provenanceId).toBe("prov-024-derived-0");
  });

  test("the derived provenance is taint-linked to the injected registration provenance (W12 childProvenance chain)", () => {
    const input = makeInput();
    const registrationProvenance = makeRegistrationProvenance();
    const result = registerExtensionWithProvenance(
      input,
      makeRegisterDeps({ registrationProvenance }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.record.provenance.taintIds).toContain(registrationProvenance.provenanceId);
  });

  test("record keys are exactly {ok, record} on success (no extra top-level fields)", () => {
    const result = registerExtensionWithProvenance(makeInput(), makeRegisterDeps());
    expect(Object.keys(result).sort()).toEqual(["ok", "record"]);
  });
});

describe("AC2 — registerExtensionWithProvenance: authority is NOT widened beyond the grant", () => {
  test("record.capabilities is exactly the grant's capabilities — never a superset", () => {
    const input = makeInput({ capabilityGrant: makeGrant({ capabilities: ["read"] }) });
    const result = registerExtensionWithProvenance(input, makeRegisterDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.record.capabilities).toEqual(["read"]);
    expect(result.record.capabilities.length).toBe(1);
    expect(result.record.capabilities).not.toContain("write");
    expect(result.record.capabilities).not.toContain("shell");
    expect(result.record.capabilities).not.toContain("network");
    expect(result.record.capabilities).not.toContain("delegate");
  });

  test("record.capabilities is a fresh copy — mutating the original grant's array after registration does not affect the record", () => {
    const grant = makeGrant({ capabilities: ["read"] });
    const input = makeInput({ capabilityGrant: grant });
    const result = registerExtensionWithProvenance(input, makeRegisterDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");

    // Mutate the ORIGINAL grant's array after the call — the record must be
    // unaffected (proving `record.capabilities` is a copy, not an alias).
    grant.capabilities.push("shell");

    expect(result.record.capabilities).toEqual(["read"]);
    expect(result.record.capabilities).not.toContain("shell");
  });
});

describe("AC1 — registerExtensionWithProvenance: a fail-closed registration propagates the deny with NO record", () => {
  test("a registration missing a pinned manifest denies and produces no record (reason mentions manifest)", () => {
    const input: RegisterExtensionInput = { extensionId: "ext-024-2", capabilityGrant: makeGrant() };
    const result = registerExtensionWithProvenance(input, makeRegisterDeps());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false for a missing pinned manifest");
    expect(result.reason).toMatch(/manifest/i);
    expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
    expect("record" in result).toBe(false);
  });

  test("a registration with an empty capability grant denies and produces no record (reason mentions capability/grant)", () => {
    const input = makeInput({ capabilityGrant: makeGrant({ capabilities: [] }) });
    const result = registerExtensionWithProvenance(input, makeRegisterDeps());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false for an empty capability grant");
    expect(result.reason).toMatch(/capability|grant/i);
    expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
  });

  test("a registration missing both manifest and capability grant denies with no record", () => {
    const result = registerExtensionWithProvenance(
      { extensionId: "ext-024-bare" },
      makeRegisterDeps(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
  });
});

describe("D (review-polish) — registerExtensionWithProvenance default registration-provenance root", () => {
  test("omitting deps.registrationProvenance still derives a 'derived' record taint-linked to the default registry root", () => {
    const input = makeInput();
    // Deliberately OMIT `registrationProvenance` from deps (not just the
    // fixture default) to exercise the module's own fallback root.
    const { registrationProvenance: _unused, ...depsWithoutRoot } = makeRegisterDeps();

    const result = registerExtensionWithProvenance(input, depsWithoutRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true for a well-formed registration");
    expect(result.record.provenance.trustLevel).toBe("derived");
    // Taint-linked to the module's own deterministic default root — mirrors
    // `DEFAULT_REGISTRATION_PROVENANCE.provenanceId` in `provenance.ts`.
    expect(result.record.provenance.taintIds).toContain("harness-extension-registry-root");
  });
});

describe("AC1/AC5 — registerExtensionWithProvenance: determinism", () => {
  test("identical input + identical (fresh, equivalently-seeded) injected deps twice yields a deep-equal record", () => {
    const input = makeInput();
    const first = registerExtensionWithProvenance(input, makeRegisterDeps());
    const second = registerExtensionWithProvenance(input, makeRegisterDeps());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first).toEqual(second);
  });

  test("calling registerExtensionWithProvenance does not mutate its input", () => {
    const input = makeInput();
    const snapshot = JSON.parse(JSON.stringify(input)) as RegisterExtensionInput;
    registerExtensionWithProvenance(input, makeRegisterDeps());
    expect(input).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// AC3 — evaluateRegisteredExtensionCapability: in-grant ok; escalation denied
// unless policy+provenance+valid approval (registry-side re-assertion of
// R2-1's CA-01-side invariant). KEY negative.
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<ExtensionProvenanceRecord> = {}): ExtensionProvenanceRecord {
  return {
    extensionId: "ext-024-1",
    manifestHash: HASH_A,
    grantId: "grant-024-1",
    capabilities: ["read"],
    provenance: {
      provenanceId: "prov-024-derived-0",
      trustLevel: "derived",
      sourceKind: "harness-extension-registry",
      taintIds: ["prov-024-registry-root"],
    },
    ...overrides,
  };
}

function makeEvalDeps(): EvaluateRegisteredExtensionCapabilityDeps {
  return { checkApproval };
}

function makeParentLinkedProvenance(): Provenance {
  return {
    provenanceId: "prov-024-child-1",
    trustLevel: "derived",
    sourceKind: "harness-run",
    taintIds: ["prov-024-parent-1"],
  };
}

function makeApprovalBinding(actionFp: string) {
  return {
    policyProfileId: "monitored-trusted-local",
    policyFingerprint: HASH_B,
    actionFingerprint: actionFp,
    provenanceId: "prov-024-child-1",
  };
}

function makeApprovalRequest(actionFp: string): ApprovalRequest {
  return {
    schemaVersion: 1,
    approvalId: "appr-024-1",
    toolCallId: "call-024-1",
    causal: { runId: "run-024-parent", sessionId: "session-024-1", correlationId: "corr-024-1" },
    binding: makeApprovalBinding(actionFp),
    toolId: "extension.escalate",
    toolVersion: "1.0.0",
    inputHash: actionFp,
    requestedAt: "2026-07-13T00:00:00.000Z",
    expiresAt: "2026-07-13T00:05:00.000Z",
    status: "pending",
  };
}

function makeValidApprovalInput(): ApprovalCheckInput {
  const actionFp = HASH_C;
  return {
    request: makeApprovalRequest(actionFp),
    result: {
      schemaVersion: 1,
      approvalResultId: "appr-result-024-1",
      approvalId: "appr-024-1",
      binding: makeApprovalBinding(actionFp),
      decision: "approved",
      actorId: "actor-024-1",
      decidedAt: "2026-07-13T00:01:00.000Z",
    },
    currentFingerprint: actionFp,
    now: "2026-07-13T00:02:00.000Z",
    interactive: true,
    consumed: false,
  };
}

function makeInvalidApprovalInput(): ApprovalCheckInput {
  // Consumed single-use approval: checkApproval -> {kind:"invalid", reason:"consumed"}.
  return { ...makeValidApprovalInput(), consumed: true };
}

describe("AC3 — evaluateRegisteredExtensionCapability: a requested capability IN the grant is ok regardless of policy/provenance/approval", () => {
  test("requesting a capability already in the record's grant is ok:true with nothing else supplied", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read"] }),
      requestedCapability: "read",
    };
    const result = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    expect(result).toEqual({ ok: true });
  });

  test("requesting a capability in a multi-capability grant is ok:true", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read", "write"] }),
      requestedCapability: "write",
    };
    const result = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    expect(result).toEqual({ ok: true });
  });
});

describe("AC3 — evaluateRegisteredExtensionCapability: a capability OUTSIDE the grant is an escalation requiring policy+provenance+approval (KEY negative)", () => {
  test("out-of-grant request with NO policyDecision is denied, reason names policy", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read"] }),
      requestedCapability: "shell",
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const result = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected escalation without policy to be denied");
    expect(result.reason).toMatch(/polic/i);
  });

  test("out-of-grant request with policyDecision:'allow' but NO provenance is denied, reason names provenance", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read"] }),
      requestedCapability: "shell",
      policyDecision: "allow",
      approval: makeValidApprovalInput(),
    };
    const result = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected escalation without provenance to be denied");
    expect(result.reason).toMatch(/provenance/i);
  });

  test("out-of-grant request with policy+provenance but an INVALID (consumed) approval is denied, reason names approval", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read"] }),
      requestedCapability: "shell",
      policyDecision: "allow",
      provenance: makeParentLinkedProvenance(),
      approval: makeInvalidApprovalInput(),
    };
    const result = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected escalation with an invalid approval to be denied");
    expect(result.reason).toMatch(/approval/i);
  });

  test("out-of-grant request with policyDecision:'deny' is denied regardless of provenance + a valid approval (no silent grant)", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read"] }),
      requestedCapability: "shell",
      policyDecision: "deny",
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const result = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    expect(result.ok).toBe(false);
  });

  test("out-of-grant request with policyDecision:'ask' does NOT silently grant, even with provenance + a valid approval", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read"] }),
      requestedCapability: "shell",
      policyDecision: "ask",
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const result = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    // "ask" must never behave like a silent "allow" — assert it is NOT granted.
    expect(result.ok).toBe(false);
  });

  test("out-of-grant request with policy:'allow' + provenance + a VALID approval is granted", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read"] }),
      requestedCapability: "shell",
      policyDecision: "allow",
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const result = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    expect(result).toEqual({ ok: true });
  });

  test("an out-of-enum requestedCapability fails closed regardless of policy+provenance+approval", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read"] }),
      requestedCapability: "sudo",
      policyDecision: "allow",
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const result = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    expect(result.ok).toBe(false);
  });

  test("a denied escalation grants NOTHING — result is exactly {ok:false, reason}", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read"] }),
      requestedCapability: "shell",
    };
    const result = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    expect(result.ok).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
  });

  test("a granted result is exactly {ok:true} — no extra fields, no capability leakage", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read"] }),
      requestedCapability: "read",
    };
    const result = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    expect(Object.keys(result).sort()).toEqual(["ok"]);
  });
});

describe("AC3/AC5 — evaluateRegisteredExtensionCapability: determinism", () => {
  test("identical input + deps twice yields a deep-equal decision (no hidden state)", () => {
    const input: EvaluateRegisteredExtensionCapabilityInput = {
      record: makeRecord({ capabilities: ["read"] }),
      requestedCapability: "shell",
      policyDecision: "allow",
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const first = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    const second = evaluateRegisteredExtensionCapability(input, makeEvalDeps());
    expect(first).toEqual(second);
  });
});
