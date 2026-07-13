// RED tests for R2-1 extension-execution (flow 023, W12+/W15+ / T5, reviewer
// track: security/contract).
//
// Pins the frozen scope (E-03 §4 AC-R2-1, 3 scenarios):
//   - SC_R08_CHILD_DISPATCH_CANONICAL_RESULT (AC1): a REGISTERED extension +
//     a coordinator's reserved child budget -> `dispatchExtension` builds a
//     canonical child dispatch (validates as `subagent-dispatch`) + extension
//     metadata (validates as the frozen `harness-child-contract-extension`)
//     bounded to the grant; a STATUS-first result is normalized to a
//     canonical `subagent-result` BEFORE persistence.
//   - SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY (AC2, KEY negative):
//     `evaluateExtensionGrant` grants a requested capability set that is
//     subset-of the extension's grant; a BROADER request is an escalation
//     that is DENIED unless policy + provenance + a valid approval are ALL
//     present — each missing piece independently denies, naming the missing
//     piece; a denied escalation grants nothing.
//   - SC_R08_NEEDS_CONTEXT_ADAPTER (AC3): `retryWithContext` handles a
//     NEEDS_CONTEXT child result naming ONE missing bounded artifact by
//     producing a retry dispatch with the SAME dispatch id that adds ONLY
//     that artifact; the prior attempt record is immutable.
//
// The impl module under test, `src/harness/extension/execute.ts`, does NOT
// exist yet (T6's job) — the missing-module import below is the expected RED
// failure ("Cannot find module './execute'"), NOT a bug in this test file.
//
// ---------------------------------------------------------------------------
// PINNED API (T6 impl must match exactly) — composes ONLY already-GREEN
// modules (W15 registry, W12 contract/isolation, W10 approval); no rewrite.
//
//   export interface DispatchExtensionInput {
//     registration: RegisterExtensionResult;      // must be `{ok:true;...}` from `registerExtension`
//     capabilityGrant: CapabilityGrant;            // the registered extension's grant (bounds allowed_actions)
//     reservedBudget: BudgetReservation;           // coordinator's reserved child budget
//     parentRunId: string;
//     sessionId: string;
//     attempt: { attemptId: string; number: number };
//     branchId: string;
//     contextManifestHash: string;                 // sha256
//     policyFingerprint: string;                   // sha256
//     canonicalContractVersion: string;             // e.g. "1.0.0"
//     task: { title: string; description: string };
//     acceptanceCriteria: string[];                 // non-empty (subagent-dispatch minItems:1)
//     dispatchArtifact: { artifactId: string; kind: string; path: string; hash: string };
//     resultArtifact: { artifactId: string; kind: string; path: string; hash: string };
//   }
//   export interface DispatchExtensionDeps { idSeq: () => string; clock: () => string }
//   export type DispatchExtensionResult =
//     | {
//         ok: true;
//         dispatch: Record<string, unknown>;        // canonical subagent-dispatch object
//         extension: ChildContractExtension;         // canonicalContract:"subagent-dispatch"
//         parseResult: (raw: string | ParsedChildResult) => ParsedChildResult;
//       }
//     | { ok: false; reason: string };
//   export function dispatchExtension(input, deps): DispatchExtensionResult;
//     - `registration.ok === false` -> `{ok:false}` immediately, reason names
//       "regist..."; no dispatch/extension is built (fail-closed on an
//       unregistered extension, reusing W15 `registerExtension`).
//     - `dispatch.allowed_actions` === `capabilityGrant.capabilities` exactly
//       (bounded to the grant — no broader authority than what was granted).
//     - `dispatch.dispatch_id` comes from `deps.idSeq()`; the SAME id is
//       threaded into the extension built for the eventual result (so the
//       parser's canonical `subagent-result.dispatch_id` correlates back to
//       this dispatch).
//     - `parseResult` closes over a `subagent-result`-variant
//       `ChildContractExtension` (via `resultArtifact`) and calls the reused
//       `parseChildResult` — the persisted form is the canonical object,
//       never the raw STATUS-first string.
//     - Deterministic: no `Date.now`/`Math.random`; identical `deps` (fresh
//       idSeq/clock with the same sequence) twice yields deep-equal
//       `dispatch`/`extension`.
//
//   export interface EvaluateExtensionGrantInput {
//     grantedCapabilities: string[];               // the extension's capabilityGrant.capabilities
//     requestedCapabilities: string[];
//     policyDecision?: "allow" | "ask" | "deny";
//     provenance?: Provenance;                      // parent-linked (W12 childProvenance shape)
//     approval?: ApprovalCheckInput;                 // W10 checkApproval input
//   }
//   export interface EvaluateExtensionGrantDeps { checkApproval: typeof checkApproval }
//   export type EvaluateExtensionGrantResult = { ok: true } | { ok: false; reason: string };
//   export function evaluateExtensionGrant(input, deps): EvaluateExtensionGrantResult;
//     - `requestedCapabilities` subset-of `grantedCapabilities` (using the
//       fixed capability vocabulary `["read","write","shell","network","delegate"]`,
//       mirroring W12 `inheritPolicy`'s `CAPABILITY_KEYS`) -> `{ok:true}`,
//       regardless of policy/provenance/approval.
//     - A BROADER request (escalation) requires ALL THREE of: `policyDecision
//       === "allow"`, a defined `provenance`, and `deps.checkApproval(approval)`
//       returning `{kind:"valid"}`. Each missing/failing piece independently
//       denies and the `reason` names it ("polic", "provenance", "approval").
//     - `policyDecision === "deny"` (or `"ask"`) always denies an escalation,
//       even with provenance + a valid approval.
//     - Any capability (granted OR requested) outside the fixed vocabulary
//       fails CLOSED regardless of subset relationship.
//     - A denied result carries no capability grant (only `{ok:false;reason}`).
//
//   export interface RetryWithContextInput {
//     priorAttempt: {
//       dispatchId: string;
//       contextRefs: Array<{ path: string; kind: string; exists: boolean }>;
//       childResult: ParsedChildResult;             // the NEEDS_CONTEXT canonical result
//     };
//     missingArtifactRef: { path: string; kind: string; exists: boolean };
//     dispatchId: string;                            // must equal priorAttempt.dispatchId
//   }
//   export interface RetryWithContextDeps {}
//   export type RetryWithContextResult =
//     | {
//         ok: true;
//         retryDispatch: { dispatchId: string; contextRefs: Array<{ path: string; kind: string; exists: boolean }> };
//         addedContext: string[];
//       }
//     | { ok: false; reason: string };
//   export function retryWithContext(input, deps): RetryWithContextResult;
//     - `priorAttempt.childResult.canonical.status !== "NEEDS_CONTEXT"` ->
//       `{ok:false}` (fail-closed: only a NEEDS_CONTEXT result may retry).
//     - `dispatchId !== priorAttempt.dispatchId` -> `{ok:false}` (fail-closed:
//       never silently retries a different dispatch).
//     - Otherwise: `retryDispatch.dispatchId === priorAttempt.dispatchId`
//       (SAME id) and `retryDispatch.contextRefs === [...priorAttempt.contextRefs,
//       missingArtifactRef]` (ADD-ONLY, exactly one new entry);
//       `addedContext` === exactly `[missingArtifactRef.path]`.
//     - Never mutates `priorAttempt` (frozen input; deep-equal before/after).
//
// Deterministic + OFFLINE: all ids/hashes/timestamps are fixture constants or
// injected via `deps` (no `Date.now()`, `Math.random()`, network, or real fs
// mutation — `validateAgainstSchema` reads real schema files, which is a read,
// not a mutation).
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { validateAgainstSchema } from "../../contracts/validator";
import { buildChildDispatchExtension, parseChildResult } from "../child/contract";
import type { ChildContractExtension, ParsedChildResult } from "../child/contract";
import type { BudgetReservation } from "../child/isolation";
import { checkApproval } from "../mutation/approval";
import type { ApprovalCheckInput, ApprovalRequest } from "../mutation/approval";
import { registerExtension } from "./registry";
import type { CapabilityGrant, RegisterExtensionResult } from "./registry";

// PINNED API under test — T6 impl exports these; imports fail until then
// (expected RED: "Cannot find module './execute'").
import { dispatchExtension, evaluateExtensionGrant, retryWithContext } from "./execute";
import type {
  DispatchExtensionDeps,
  DispatchExtensionInput,
  EvaluateExtensionGrantDeps,
  EvaluateExtensionGrantInput,
  RetryWithContextInput,
} from "./execute";

// Canonical gdskills contracts dir (subagent-dispatch/subagent-result).
const CANONICAL_CONTRACTS_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".metaproject",
  "core",
  "gdskills",
  "contracts",
);

// Frozen extension schema dir.
const FROZEN_SCHEMA_DIR = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-project-agent-harness",
  "schemas",
);

const DISPATCH_SCHEMA = "subagent-dispatch.schema.json";
const RESULT_SCHEMA = "subagent-result.schema.json";
const EXTENSION_SCHEMA = "harness-child-contract-extension.schema.json";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

// ---------------------------------------------------------------------------
// Deterministic dep factories (no Date.now/Math.random).
// ---------------------------------------------------------------------------

function makeDispatchDeps(): DispatchExtensionDeps {
  let idCounter = 0;
  return {
    idSeq: () => `ext-dispatch-${idCounter++}`,
    clock: () => "2026-07-13T00:00:00.000Z",
  };
}

function makeRegisteredCapabilityGrant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return { grantId: "grant-023-1", capabilities: ["read"], ...overrides };
}

function makeRegistration(capabilityGrant: CapabilityGrant): RegisterExtensionResult {
  return registerExtension({
    extensionId: "ext-023-1",
    manifest: { manifestHash: HASH_A, extensionVersion: "1.0.0" },
    capabilityGrant,
  });
}

function makeDispatchInput(overrides: Partial<DispatchExtensionInput> = {}): DispatchExtensionInput {
  const capabilityGrant = makeRegisteredCapabilityGrant();
  return {
    registration: makeRegistration(capabilityGrant),
    capabilityGrant,
    reservedBudget: { reservationId: "res-023-1", maxRuntimeMs: 60_000, maxToolCalls: 10 },
    parentRunId: "run-023-parent",
    sessionId: "session-023-1",
    attempt: { attemptId: "attempt-023-1", number: 1 },
    branchId: "branch-023-1",
    contextManifestHash: HASH_B,
    policyFingerprint: HASH_C,
    canonicalContractVersion: "1.0.0",
    task: { title: "Run extension X", description: "Bounded extension dispatch for flow 023." },
    acceptanceCriteria: ["extension completes within its granted capabilities"],
    dispatchArtifact: {
      artifactId: "artifact-023-dispatch",
      kind: "child-dispatch",
      path: "artifacts/023-dispatch.json",
      hash: HASH_D,
    },
    resultArtifact: {
      artifactId: "artifact-023-result",
      kind: "final-report",
      path: "artifacts/023-result.json",
      hash: HASH_A,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC1 — dispatchExtension: canonical round-trip + STATUS->canonical.
// ---------------------------------------------------------------------------

describe("AC1 — dispatchExtension produces a schema-valid canonical dispatch bounded to the grant", () => {
  test("a registered extension + reserved budget yields a dispatch that validates as subagent-dispatch.schema.json", () => {
    const result = dispatchExtension(makeDispatchInput(), makeDispatchDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a registered extension to dispatch ok");

    const validation = validateAgainstSchema(DISPATCH_SCHEMA, result.dispatch, { schemaDir: CANONICAL_CONTRACTS_DIR });
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  test("the dispatch's extension metadata validates against the frozen harness-child-contract-extension.schema.json", () => {
    const result = dispatchExtension(makeDispatchInput(), makeDispatchDeps());
    if (!result.ok) throw new Error("expected ok");

    const validation = validateAgainstSchema(EXTENSION_SCHEMA, result.extension, { schemaDir: FROZEN_SCHEMA_DIR });
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(result.extension.canonicalContract).toBe("subagent-dispatch");
  });

  test("the dispatch is bounded to the extension's granted capabilities (allowed_actions === capabilityGrant.capabilities)", () => {
    const input = makeDispatchInput({ capabilityGrant: makeRegisteredCapabilityGrant({ capabilities: ["read"] }) });
    const result = dispatchExtension(input, makeDispatchDeps());
    if (!result.ok) throw new Error("expected ok");

    expect(result.dispatch.allowed_actions).toEqual(["read"]);
  });

  test("an UNREGISTERED extension (registry ok:false) is refused: no dispatch or extension is built", () => {
    const deniedRegistration = registerExtension({ extensionId: "ext-unregistered" }); // no manifest, no grant
    const input = makeDispatchInput({ registration: deniedRegistration });

    const result = dispatchExtension(input, makeDispatchDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an unregistered extension to be refused");
    expect(result.reason).toMatch(/regist/i);
    // Fail-closed: the denied result carries no dispatch/extension/parser.
    expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
  });

  test("a STATUS-first result is normalized to a canonical subagent-result BEFORE persistence, correlated to the dispatch", () => {
    const result = dispatchExtension(makeDispatchInput(), makeDispatchDeps());
    if (!result.ok) throw new Error("expected ok");

    const raw = "STATUS: DONE\n\n## Completed\n- extension finished within its bounded capabilities\n";
    const parsed: ParsedChildResult = result.parseResult(raw);

    const validation = validateAgainstSchema(RESULT_SCHEMA, parsed.canonical, { schemaDir: CANONICAL_CONTRACTS_DIR });
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    expect(parsed.canonical.status).toBe("DONE");
    expect(parsed.canonical.dispatch_id).toBe(result.dispatch.dispatch_id);

    // The persisted form is the canonical OBJECT, never the raw STATUS string.
    expect(typeof parsed.canonical).toBe("object");
    expect(JSON.stringify(parsed.canonical).startsWith('"STATUS:')).toBe(false);
  });

  test("a NEEDS_CONTEXT reply also normalizes to a schema-valid canonical result via the same parser", () => {
    const result = dispatchExtension(makeDispatchInput(), makeDispatchDeps());
    if (!result.ok) throw new Error("expected ok");

    const raw = "STATUS: NEEDS_CONTEXT\n\n## Missing\n- the bounded artifact for extension X\n";
    const parsed = result.parseResult(raw);

    expect(parsed.canonical.status).toBe("NEEDS_CONTEXT");
    const validation = validateAgainstSchema(RESULT_SCHEMA, parsed.canonical, { schemaDir: CANONICAL_CONTRACTS_DIR });
    expect(validation.valid).toBe(true);
  });

  test("the dispatch and result extension variants are identical except canonicalContract (review-hardening fix #5, regression guard)", () => {
    const result = dispatchExtension(makeDispatchInput(), makeDispatchDeps());
    if (!result.ok) throw new Error("expected ok");

    const raw = "STATUS: DONE\n\n## Completed\n- dedup parity check\n";
    const parsed = result.parseResult(raw);

    expect(result.extension.canonicalContract).toBe("subagent-dispatch");
    expect(parsed.extension.canonicalContract).toBe("subagent-result");

    const { canonicalContract: _dispatchContract, ...dispatchRest } = result.extension;
    const { canonicalContract: _resultContract, ...resultRest } = parsed.extension;
    expect(dispatchRest).toEqual(resultRest);
  });

  test("deterministic: identical input + fresh matching deps twice yields deep-equal dispatch and extension", () => {
    const first = dispatchExtension(makeDispatchInput(), makeDispatchDeps());
    const second = dispatchExtension(makeDispatchInput(), makeDispatchDeps());
    if (!first.ok || !second.ok) throw new Error("expected both calls to be ok");

    expect(first.dispatch).toEqual(second.dispatch);
    expect(first.extension).toEqual(second.extension);

    // The parsers must normalize the same raw reply identically too.
    const raw = "STATUS: DONE\n\n## Completed\n- deterministic check\n";
    expect(first.parseResult(raw)).toEqual(second.parseResult(raw));
  });
});

// ---------------------------------------------------------------------------
// AC2 — evaluateExtensionGrant: escalation requires policy+provenance+approval.
// ---------------------------------------------------------------------------

const GRANTED_CAPABILITIES = ["read"];
const BROADER_CAPABILITIES = ["read", "shell"];

function makeApprovalDeps(): EvaluateExtensionGrantDeps {
  return { checkApproval };
}

function makeParentLinkedProvenance() {
  return {
    provenanceId: "prov-023-child-1",
    trustLevel: "derived" as const,
    sourceKind: "harness-run",
    taintIds: ["prov-023-parent-1"],
  };
}

function makeApprovalBinding(actionFp: string) {
  return {
    policyProfileId: "monitored-trusted-local",
    policyFingerprint: HASH_B,
    actionFingerprint: actionFp,
    provenanceId: "prov-023-child-1",
  };
}

function makeApprovalRequest(actionFp: string): ApprovalRequest {
  return {
    schemaVersion: 1,
    approvalId: "appr-023-1",
    toolCallId: "call-023-1",
    causal: { runId: "run-023-parent", sessionId: "session-023-1", correlationId: "corr-023-1" },
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
      approvalResultId: "appr-result-023-1",
      approvalId: "appr-023-1",
      binding: makeApprovalBinding(actionFp),
      decision: "approved",
      actorId: "actor-023-1",
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

describe("AC2 — evaluateExtensionGrant: subset requests are granted regardless of policy/provenance/approval", () => {
  test("requested capabilities that are a subset of granted are ok:true with nothing else supplied", () => {
    const input: EvaluateExtensionGrantInput = {
      grantedCapabilities: GRANTED_CAPABILITIES,
      requestedCapabilities: ["read"],
    };
    const result = evaluateExtensionGrant(input, makeApprovalDeps());
    expect(result).toEqual({ ok: true });
  });
});

describe("AC2 — evaluateExtensionGrant: a BROADER request is an escalation requiring policy+provenance+approval (KEY negative)", () => {
  test("broader request with NO policyDecision is denied, reason names policy", () => {
    const input: EvaluateExtensionGrantInput = {
      grantedCapabilities: GRANTED_CAPABILITIES,
      requestedCapabilities: BROADER_CAPABILITIES,
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const result = evaluateExtensionGrant(input, makeApprovalDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected escalation without policy to be denied");
    expect(result.reason).toMatch(/polic/i);
  });

  test("broader request with policyDecision:'allow' but NO provenance is denied, reason names provenance", () => {
    const input: EvaluateExtensionGrantInput = {
      grantedCapabilities: GRANTED_CAPABILITIES,
      requestedCapabilities: BROADER_CAPABILITIES,
      policyDecision: "allow",
      approval: makeValidApprovalInput(),
    };
    const result = evaluateExtensionGrant(input, makeApprovalDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected escalation without provenance to be denied");
    expect(result.reason).toMatch(/provenance/i);
  });

  test("broader request with policy+provenance but an INVALID (consumed) approval is denied, reason names approval", () => {
    const input: EvaluateExtensionGrantInput = {
      grantedCapabilities: GRANTED_CAPABILITIES,
      requestedCapabilities: BROADER_CAPABILITIES,
      policyDecision: "allow",
      provenance: makeParentLinkedProvenance(),
      approval: makeInvalidApprovalInput(),
    };
    const result = evaluateExtensionGrant(input, makeApprovalDeps());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected escalation with an invalid approval to be denied");
    expect(result.reason).toMatch(/approval/i);
  });

  test("broader request with policyDecision:'deny' is denied regardless of provenance + a valid approval", () => {
    const input: EvaluateExtensionGrantInput = {
      grantedCapabilities: GRANTED_CAPABILITIES,
      requestedCapabilities: BROADER_CAPABILITIES,
      policyDecision: "deny",
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const result = evaluateExtensionGrant(input, makeApprovalDeps());
    expect(result.ok).toBe(false);
  });

  test("broader request with policyDecision:'ask' (not 'allow') is denied even with provenance + a valid approval", () => {
    const input: EvaluateExtensionGrantInput = {
      grantedCapabilities: GRANTED_CAPABILITIES,
      requestedCapabilities: BROADER_CAPABILITIES,
      policyDecision: "ask",
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const result = evaluateExtensionGrant(input, makeApprovalDeps());
    expect(result.ok).toBe(false);
  });

  test("broader request with policy:'allow' + provenance + a VALID approval is granted", () => {
    const input: EvaluateExtensionGrantInput = {
      grantedCapabilities: GRANTED_CAPABILITIES,
      requestedCapabilities: BROADER_CAPABILITIES,
      policyDecision: "allow",
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const result = evaluateExtensionGrant(input, makeApprovalDeps());
    expect(result).toEqual({ ok: true });
  });

  test("an out-of-enum requested capability fails CLOSED even with policy+provenance+valid approval present", () => {
    const input: EvaluateExtensionGrantInput = {
      grantedCapabilities: [...GRANTED_CAPABILITIES, "teleport"],
      requestedCapabilities: ["teleport"],
      policyDecision: "allow",
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const result = evaluateExtensionGrant(input, makeApprovalDeps());
    expect(result.ok).toBe(false);
  });

  test("a denied escalation grants NOTHING: the ok:false result carries no capability list", () => {
    const input: EvaluateExtensionGrantInput = {
      grantedCapabilities: GRANTED_CAPABILITIES,
      requestedCapabilities: BROADER_CAPABILITIES,
    };
    const result = evaluateExtensionGrant(input, makeApprovalDeps());
    expect(result.ok).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["ok", "reason"]);
  });

  test("deterministic: identical input twice yields deep-equal output (no Date.now/Math.random)", () => {
    const input: EvaluateExtensionGrantInput = {
      grantedCapabilities: GRANTED_CAPABILITIES,
      requestedCapabilities: BROADER_CAPABILITIES,
      policyDecision: "allow",
      provenance: makeParentLinkedProvenance(),
      approval: makeValidApprovalInput(),
    };
    const first = evaluateExtensionGrant(input, makeApprovalDeps());
    const second = evaluateExtensionGrant(input, makeApprovalDeps());
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// AC3 — retryWithContext: NEEDS_CONTEXT same-id / add-only-artifact / immutable.
// ---------------------------------------------------------------------------

function makeNeedsContextChildResult(): ParsedChildResult {
  const extension: ChildContractExtension = buildChildDispatchExtension({
    canonicalContract: "subagent-result",
    canonicalContractVersion: "1.0.0",
    parentRunId: "run-023-parent",
    sessionId: "session-023-1",
    attempt: { attemptId: "attempt-023-1", number: 1 },
    branchId: "branch-023-1",
    contextManifestHash: HASH_B,
    policyFingerprint: HASH_C,
    budgetReservation: { reservationId: "res-023-1", maxRuntimeMs: 60_000 },
    durableResultArtifact: { artifactId: "artifact-023-result", kind: "final-report", hash: HASH_A },
  });
  return parseChildResult("STATUS: NEEDS_CONTEXT\n\n## Missing\n- docs/adr/ADR-0099.md\n", {
    extension,
    runId: "run-023-parent",
    dispatchId: "023-T5-dispatch-1",
    timestampUtc: "2026-07-13T00:00:00.000Z",
    contractVersion: "1.0.0",
  });
}

function makeDoneChildResult(): ParsedChildResult {
  const extension: ChildContractExtension = buildChildDispatchExtension({
    canonicalContract: "subagent-result",
    canonicalContractVersion: "1.0.0",
    parentRunId: "run-023-parent",
    sessionId: "session-023-1",
    attempt: { attemptId: "attempt-023-1", number: 1 },
    branchId: "branch-023-1",
    contextManifestHash: HASH_B,
    policyFingerprint: HASH_C,
    budgetReservation: { reservationId: "res-023-1", maxRuntimeMs: 60_000 },
    durableResultArtifact: { artifactId: "artifact-023-result", kind: "final-report", hash: HASH_A },
  });
  return parseChildResult("STATUS: DONE\n\n## Completed\n- nothing missing\n", {
    extension,
    runId: "run-023-parent",
    dispatchId: "023-T5-dispatch-2",
    timestampUtc: "2026-07-13T00:00:00.000Z",
    contractVersion: "1.0.0",
  });
}

function makePriorAttempt(childResult: ParsedChildResult, dispatchId = "023-T5-dispatch-1") {
  const contextRefs = [{ path: "docs/requirements/keryx-project-agent-harness/specification.md", kind: "context", exists: true }];
  return Object.freeze({
    dispatchId,
    contextRefs: Object.freeze(contextRefs) as unknown as typeof contextRefs,
    childResult,
  });
}

const MISSING_ARTIFACT = Object.freeze({ path: "docs/adr/ADR-0099.md", kind: "context", exists: false });

describe("AC3 — retryWithContext: SAME dispatch id, add-only context, prior attempt immutable", () => {
  test("a NEEDS_CONTEXT result naming one missing artifact produces a retry with the SAME dispatch id", () => {
    const priorAttempt = makePriorAttempt(makeNeedsContextChildResult());
    const input: RetryWithContextInput = { priorAttempt, missingArtifactRef: MISSING_ARTIFACT, dispatchId: priorAttempt.dispatchId };

    const result = retryWithContext(input, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected retry to be granted");
    expect(result.retryDispatch.dispatchId).toBe(priorAttempt.dispatchId);
  });

  test("the retry adds ONLY the missing artifact to the bounded context (add-only, exactly one new entry)", () => {
    const priorAttempt = makePriorAttempt(makeNeedsContextChildResult());
    const input: RetryWithContextInput = { priorAttempt, missingArtifactRef: MISSING_ARTIFACT, dispatchId: priorAttempt.dispatchId };

    const result = retryWithContext(input, {});
    if (!result.ok) throw new Error("expected retry to be granted");

    expect(result.retryDispatch.contextRefs).toEqual([...priorAttempt.contextRefs, MISSING_ARTIFACT]);
    expect(result.addedContext).toEqual([MISSING_ARTIFACT.path]);
  });

  test("the prior attempt record is immutable: mutating the frozen fixture throws, and it stays unchanged after retrying", () => {
    const priorAttempt = makePriorAttempt(makeNeedsContextChildResult());
    const before = JSON.parse(JSON.stringify(priorAttempt));

    expect(() => {
      (priorAttempt as unknown as { foo: number }).foo = 1;
    }).toThrow();
    expect(() => {
      (priorAttempt.contextRefs as unknown as { push: (x: unknown) => void }).push({
        path: "sneaky",
        kind: "context",
        exists: true,
      });
    }).toThrow();

    const input: RetryWithContextInput = { priorAttempt, missingArtifactRef: MISSING_ARTIFACT, dispatchId: priorAttempt.dispatchId };
    retryWithContext(input, {});

    expect(JSON.parse(JSON.stringify(priorAttempt))).toEqual(before);
  });

  test("a prior attempt whose child result is NOT NEEDS_CONTEXT (e.g. DONE) is refused, fail-closed", () => {
    const priorAttempt = makePriorAttempt(makeDoneChildResult(), "023-T5-dispatch-2");
    const input: RetryWithContextInput = { priorAttempt, missingArtifactRef: MISSING_ARTIFACT, dispatchId: priorAttempt.dispatchId };

    const result = retryWithContext(input, {});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a non-NEEDS_CONTEXT prior attempt to be refused");
  });

  test("a dispatchId mismatched with the prior attempt's is refused, fail-closed (never silently retries a different dispatch)", () => {
    const priorAttempt = makePriorAttempt(makeNeedsContextChildResult());
    const input: RetryWithContextInput = { priorAttempt, missingArtifactRef: MISSING_ARTIFACT, dispatchId: "some-other-dispatch-id" };

    const result = retryWithContext(input, {});
    expect(result.ok).toBe(false);
  });

  test("deterministic: identical input twice yields deep-equal output", () => {
    const priorAttempt = makePriorAttempt(makeNeedsContextChildResult());
    const input: RetryWithContextInput = { priorAttempt, missingArtifactRef: MISSING_ARTIFACT, dispatchId: priorAttempt.dispatchId };

    const first = retryWithContext(input, {});
    const second = retryWithContext(input, {});
    expect(first).toEqual(second);
  });
});
