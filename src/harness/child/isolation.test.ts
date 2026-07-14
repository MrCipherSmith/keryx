// RED tests for CA-02 (flow 015, W12 / T7): child context/session isolation
// and fail-closed budget + policy inheritance.
//
// Pins the frozen spec (implementation-plan.md CA-02): "Add child isolation,
// context budget, provenance, NEEDS_CONTEXT, blocked/failed dispositions."
// Negatives: "child negatives." Evidence: "parent owns status and
// completion; prior attempts immutable."
//
// This file covers AC3 (`acceptance-criteria.md`):
//   - a child gets an isolated context/session: child events are append-only
//     into the parent session and the child cannot mutate parent state or
//     delete parent evidence;
//   - budget inheritance is fail-closed (child budgetReservation subset of
//     parent remaining; exceeding, or an aggregate of child reservations
//     exceeding the parent, is DENIED, never silently exceeded);
//   - policy inheritance is fail-closed (child trust/profile is never
//     broader/weaker than the parent — escalation is DENIED; reuses W7
//     `PolicyProfile`/`PolicyTrustMode`);
//   - provenance/parent-links are recorded.
//
// CA-02 impl (next dispatch, T8) implements `src/harness/child/isolation.ts`:
//   - `inheritBudget(parentRemaining, childRequest)` — fail-closed budget
//     reservation: `{ ok: true; reservation: BudgetReservation }` when the
//     child request fits within `parentRemaining` (both `maxRuntimeMs` and,
//     when present, `maxToolCalls`); `{ ok: false; reason: string }` when
//     either exceeds the parent's remaining budget. NEVER clamps up or
//     silently grants more than requested/available — a denial is a denial.
//     Aggregate accounting across multiple children is the CALLER's
//     responsibility: it decrements `parentRemaining` by each granted
//     reservation before requesting the next, so a later call against the
//     already-decremented remaining fails closed once the parent's original
//     budget would be breached in aggregate (see test 2.4 below).
//   - `inheritPolicy(parent, childRequest)` — fail-closed policy inheritance
//     over two full `PolicyProfile` values (reusing W7 `PolicyProfile`,
//     `PolicyTrustMode`, `PolicyProfileDefaults`): `{ ok: true; policy:
//     PolicyProfile }` (the child's own profile, unchanged) when the child's
//     `trustMode` is NOT broader than the parent's
//     (`read-only < trusted-local < untrusted` capability ordering) AND no
//     per-capability default in `childRequest.defaults` is more permissive
//     than the parent's for the same key (`deny < ask < allow` ordering);
//     `{ ok: false; reason: string }` on either escalation. A NARROWER or
//     EQUAL child profile is always ok.
//   - `childProvenance(parent, deps)` — derives a child `Provenance` (W7
//     `../session/types` shape) from the parent's: `trustLevel: "derived"`,
//     a fresh `provenanceId` from `deps.idSeq()`, and `taintIds` carrying the
//     parent's own `provenanceId` (plus anything already in
//     `parent.taintIds`) so the child->parent link is inspectable. Pure
//     aside from `deps.idSeq()` — no `Date.now`/`Math.random`.
//
// Until `src/harness/child/isolation.ts` exists, the missing-module import is
// the expected RED failure ("Cannot find module './isolation'") — NOT a bug
// in this test file. Do NOT create isolation.ts here (T8's job).
//
// Deterministic: all ids/hashes/timestamps are fixture constants or come from
// injected `deps` (no `Date.now()`, `Math.random()`, network, or real fs
// mutation).
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { PolicyProfile } from "../policy/types";
import { AppendOnlySession } from "../session/session";
import type { Provenance, SessionEntry, SessionSeed } from "../session/types";

// PINNED API (see dispatch) — CA-02 impl (T8) exports these; imports fail
// until then (expected RED: "Cannot find module './isolation'").
import { childProvenance, inheritBudget, inheritPolicy } from "./isolation";
import type {
  BudgetReservation,
  ChildProvenanceDeps,
  InheritBudgetResult,
  InheritPolicyResult,
  ParentRemainingBudget,
} from "./isolation";

// ---------------------------------------------------------------------------
// Deterministic fixtures.
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function makeSessionDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-07-13T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

const seed: SessionSeed = {
  sessionId: "parent-session-1",
  runId: "parent-run-1",
  createdAt: "2026-07-13T00:00:00.000Z",
  policyFingerprint: "a".repeat(64),
  contextManifestHash: "b".repeat(64),
};

// Policy profile fixtures — shaped exactly per `policy-profile.schema.json`,
// mirroring `src/harness/policy/engine.test.ts`'s frozen fixtures (no
// invented profile).
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

// ============================================================================
// 1. Context/session isolation (AC3)
// ============================================================================

describe("AC3 — child events append into the parent session, append-only", () => {
  test("a child dispatch entry links into the parent session via parentEventId/attemptId/branchId", () => {
    const parentSession = new AppendOnlySession(seed, makeSessionDeps());
    const parentEntry = parentSession.append({ type: "assistant_message", text: "parent turn" });

    const childEntry = parentSession.append(
      { type: "branch_metadata", artifactRef: { artifactId: "child-dispatch-1", kind: "child-dispatch", hash: sha256("child-dispatch-1") } },
      { parentEntryId: parentEntry.entryId, attemptId: "child-attempt-1", branchId: "child-branch-1" },
    );

    expect(childEntry.causal.parentEventId).toBe(parentEntry.entryId);
    expect(childEntry.causal.attemptId).toBe("child-attempt-1");
    expect(childEntry.causal.branchId).toBe("child-branch-1");
    // The child entry lives in the SAME session — there is no separate store.
    expect(parentSession.entries()).toHaveLength(2);
    expect(parentSession.entries().map((entry: SessionEntry) => entry.entryId)).toContain(childEntry.entryId);
  });

  test("a child cannot mutate an existing parent entry: writing to a returned (frozen) entry throws", () => {
    const parentSession = new AppendOnlySession(seed, makeSessionDeps());
    parentSession.append({ type: "assistant_message", text: "parent evidence" });

    const entries = parentSession.entries();
    const target = entries[0];
    if (!target) throw new Error("expected at least one entry after append");

    expect(() => {
      // A child attempting to rewrite prior parent evidence in place.
      (target.entry as { type: string; text: string }).text = "child overwrote parent evidence";
    }).toThrow();

    const after = parentSession.entries();
    const afterFirst = after[0];
    if (!afterFirst) throw new Error("expected at least one entry after append");
    expect(afterFirst.entry).toEqual({ type: "assistant_message", text: "parent evidence" });
  });

  test("a child cannot delete parent evidence: mutating a returned entries() snapshot never affects the parent session", () => {
    const parentSession = new AppendOnlySession(seed, makeSessionDeps());
    parentSession.append({ type: "assistant_message", text: "evidence-1" });
    parentSession.append({ type: "assistant_message", text: "evidence-2" });

    const snapshot = parentSession.entries();
    expect(snapshot).toHaveLength(2);
    // A child attempting to wipe all parent evidence via the returned array.
    snapshot.length = 0;
    snapshot.splice(0, snapshot.length);

    expect(parentSession.entries()).toHaveLength(2);
  });

  test("the session exposes no delete/remove capability for a prior entry", () => {
    const parentSession = new AppendOnlySession(seed, makeSessionDeps()) as unknown as Record<string, unknown>;
    expect(parentSession.delete).toBeUndefined();
    expect(parentSession.remove).toBeUndefined();
    expect(parentSession.clear).toBeUndefined();
  });
});

// ============================================================================
// 2. Budget inheritance fail-closed (AC3, KEY negative)
// ============================================================================

describe("AC3 — inheritBudget: fail-closed budget inheritance", () => {
  test("a child request strictly within the parent's remaining budget is granted", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 60_000, maxToolCalls: 20 };
    const childRequest: BudgetReservation = { reservationId: "res-ok", maxRuntimeMs: 30_000, maxToolCalls: 10 };

    const result: InheritBudgetResult = inheritBudget(parentRemaining, childRequest);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the in-budget child request to be granted");
    expect(result.reservation).toEqual(childRequest);
  });

  test("a child request exactly equal to the parent's remaining budget is granted (boundary, not exceeding)", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 60_000, maxToolCalls: 20 };
    const childRequest: BudgetReservation = { reservationId: "res-eq", maxRuntimeMs: 60_000, maxToolCalls: 20 };

    const result = inheritBudget(parentRemaining, childRequest);
    expect(result.ok).toBe(true);
  });

  test("a child maxRuntimeMs exceeding the parent's remaining is DENIED, never silently clamped", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 60_000, maxToolCalls: 20 };
    const childRequest: BudgetReservation = { reservationId: "res-over-runtime", maxRuntimeMs: 60_001, maxToolCalls: 10 };

    const result = inheritBudget(parentRemaining, childRequest);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the over-runtime child request to be denied");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("a child maxToolCalls exceeding the parent's remaining is DENIED", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 60_000, maxToolCalls: 20 };
    const childRequest: BudgetReservation = { reservationId: "res-over-calls", maxRuntimeMs: 10_000, maxToolCalls: 21 };

    const result = inheritBudget(parentRemaining, childRequest);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the over-tool-calls child request to be denied");
  });

  test("aggregate of multiple child reservations exceeding the parent's original budget denies the breaching one", () => {
    let remaining: ParentRemainingBudget = { maxRuntimeMs: 100_000, maxToolCalls: 30 };

    const first = inheritBudget(remaining, { reservationId: "res-1", maxRuntimeMs: 40_000, maxToolCalls: 10 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected the first reservation to be granted");
    remaining = {
      maxRuntimeMs: remaining.maxRuntimeMs - first.reservation.maxRuntimeMs,
      maxToolCalls: (remaining.maxToolCalls ?? 0) - (first.reservation.maxToolCalls ?? 0),
    };

    const second = inheritBudget(remaining, { reservationId: "res-2", maxRuntimeMs: 50_000, maxToolCalls: 15 });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected the second reservation to be granted");
    remaining = {
      maxRuntimeMs: remaining.maxRuntimeMs - second.reservation.maxRuntimeMs,
      maxToolCalls: (remaining.maxToolCalls ?? 0) - (second.reservation.maxToolCalls ?? 0),
    };
    // remaining is now { maxRuntimeMs: 10_000, maxToolCalls: 5 }.

    const third = inheritBudget(remaining, { reservationId: "res-3", maxRuntimeMs: 20_000, maxToolCalls: 5 });
    expect(third.ok).toBe(false);
    if (third.ok) throw new Error("expected the third (aggregate-breaching) reservation to be denied");

    // A child can NEVER end up holding more budget than the parent originally had.
    const totalGrantedRuntimeMs = first.reservation.maxRuntimeMs + second.reservation.maxRuntimeMs;
    const totalGrantedToolCalls = (first.reservation.maxToolCalls ?? 0) + (second.reservation.maxToolCalls ?? 0);
    expect(totalGrantedRuntimeMs).toBeLessThanOrEqual(100_000);
    expect(totalGrantedToolCalls).toBeLessThanOrEqual(30);
  });

  test("a child request omitting maxToolCalls is judged on maxRuntimeMs alone and never grants an implicit unlimited tool-call budget beyond the parent's", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 60_000, maxToolCalls: 5 };
    const childRequest: BudgetReservation = { reservationId: "res-no-calls", maxRuntimeMs: 10_000 };

    const result = inheritBudget(parentRemaining, childRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the request to be granted");
    expect(result.reservation.maxToolCalls).toBeUndefined();
  });
});

// ============================================================================
// 2b. Fail-closed tool-call cap inheritance (review-polish item H, flow 028/T5)
// ============================================================================
//
// Today `inheritBudget` grants a child request that OMITS `maxToolCalls` on
// `maxRuntimeMs` alone, EVEN WHEN the parent itself carries a live
// `maxToolCalls` ceiling (see the "child request omitting maxToolCalls..."
// test in section 2 above, which currently pins that as `ok:true` — the
// PRE-EXISTING/documented behavior). Review item H requires the OPPOSITE for
// that same shape: a parent WITH a tool-call cap must DENY a child reservation
// that carries no cap of its own, because an uncapped child could exhaust
// tool-call budget the capped parent can never subsequently enforce against
// it — fail-closed, not an implicit "runtime alone" grant.
//
// DISCOVERED CONFLICT (for T6/review to reconcile, not resolved by this
// dispatch): the new "parent WITH maxToolCalls + child omitting -> DENY" test
// below is the structural mirror of the pre-existing "child request omitting
// maxToolCalls is judged on maxRuntimeMs alone..." test in section 2, which
// asserts `ok:true` for the identical shape (parent carries `maxToolCalls`,
// child omits it). Once `inheritBudget` is changed to satisfy H, that older
// test will itself start failing — the two assertions cannot both stay green
// under one implementation. T6 must update/remove the older assertion as part
// of closing H; this is flagged here rather than silently edited, since this
// dispatch is RED/lock-tests-only and must not resolve the conflict itself.
// Review finding H (cap-less child under a capped parent) was DEFERRED, not
// implemented as a deny. `inheritBudget` is a SHARED primitive: the R2-5
// contained-process executor calls `inheritBudget(cappedParent, runtimeOnlyBudget)`
// for a subprocess that makes ZERO tool calls, so a child OMITTING `maxToolCalls`
// legitimately means "no tool-call sub-budget" (consumes 0 of the parent's pool),
// NOT "unlimited tool calls". A blanket budget-inheritance-level deny would break
// that working consumer. Bounding a child that genuinely makes unbounded tool
// calls is a RUNTIME-enforcement concern (outside this primitive), so H is left as
// a documented known-limitation. These tests LOCK the current, correct behavior.
describe("H (deferred) — inheritBudget tool-call semantics: cap-less child is a 0-cost, not unlimited, tool-call reservation", () => {
  test("parent WITH maxToolCalls + child request OMITTING maxToolCalls is GRANTED (cap-less = 0 tool-call sub-budget; runtime-only children like the subprocess executor rely on this)", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 60_000, maxToolCalls: 10 };
    const childRequest: BudgetReservation = { reservationId: "res-h-no-cap", maxRuntimeMs: 10_000 };

    const result = inheritBudget(parentRemaining, childRequest);

    expect(result.ok).toBe(true);
  });

  test("parent WITHOUT maxToolCalls + child request OMITTING maxToolCalls is still GRANTED (unchanged — lock)", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 60_000 };
    const childRequest: BudgetReservation = {
      reservationId: "res-h-no-cap-uncapped-parent",
      maxRuntimeMs: 10_000,
    };

    const result = inheritBudget(parentRemaining, childRequest);
    expect(result.ok).toBe(true);
  });

  test("child WITH maxToolCalls <= parent's remaining is still GRANTED (unchanged — lock)", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 60_000, maxToolCalls: 10 };
    const childRequest: BudgetReservation = {
      reservationId: "res-h-capped-ok",
      maxRuntimeMs: 10_000,
      maxToolCalls: 5,
    };

    const result = inheritBudget(parentRemaining, childRequest);
    expect(result.ok).toBe(true);
  });

  test("child requesting maxToolCalls > parent's remaining is still DENIED (unchanged — lock)", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 60_000, maxToolCalls: 10 };
    const childRequest: BudgetReservation = {
      reservationId: "res-h-capped-over",
      maxRuntimeMs: 10_000,
      maxToolCalls: 11,
    };

    const result = inheritBudget(parentRemaining, childRequest);
    expect(result.ok).toBe(false);
  });
});

// ============================================================================
// 3. Policy inheritance fail-closed (AC3, KEY negative)
// ============================================================================

describe("AC3 — inheritPolicy: fail-closed policy inheritance (no escalation)", () => {
  test("a child requesting the SAME profile as the parent is granted", () => {
    const result: InheritPolicyResult = inheritPolicy(readOnlyProfile, readOnlyProfile);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected same-profile inheritance to be granted");
    expect(result.policy).toEqual(readOnlyProfile);
  });

  test("a child requesting a NARROWER trustMode than the parent is granted (trusted-local parent -> read-only child)", () => {
    const result = inheritPolicy(monitoredProfile, readOnlyProfile);
    expect(result.ok).toBe(true);
  });

  test("a NARROWER-trust child that is MORE PERMISSIVE per-capability than the parent is DENIED (untrusted parent -> trusted-local child that escalates every capability)", () => {
    // The child's trustMode (trusted-local) is narrower than the parent's
    // (untrusted), but on EVERY capability the child is more permissive than the
    // untrusted parent's policy allows (parent read:ask/write:deny/shell:deny/
    // network:deny/delegate:deny vs child read:allow/write:ask/shell:ask/
    // network:ask/delegate:ask). A narrower trust posture must NOT license a
    // per-capability escalation — that would grant the child authority the
    // parent forbids (SC_R08_ROLE_CANNOT_ESCALATE / ADR-0004). Fail-closed:
    // DENIED. (The child also downgrades isolation required-fail-closed ->
    // not-required, an independently sufficient denial.)
    const result = inheritPolicy(unattendedProfile, monitoredProfile);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the per-capability-escalating narrower-trust child to be denied");
    // The reason names the concrete escalated capability (or the isolation
    // downgrade) — never a silent grant.
    expect(result.reason).toMatch(/read|write|shell|network|delegate|isolation/);
  });

  test("a NARROWER-trust child that is genuinely CONTAINED per-capability AND does not downgrade isolation is still GRANTED (untrusted parent -> contained trusted-local child)", () => {
    // Positive guard proving the fail-closed fix is NOT a blanket deny of every
    // narrower-trust child: this trusted-local child is per-capability <= the
    // untrusted parent on every key AND keeps required-fail-closed isolation, so
    // it is a true containment and must be granted.
    const containedChild: PolicyProfile = {
      ...monitoredProfile,
      profileVersion: "1.0.1",
      fingerprint: sha256("monitored-trusted-local:1.0.1-contained-under-untrusted"),
      defaults: { read: "ask", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
      requiredControls: { isolation: "required-fail-closed", redactionFailure: "deny", networkBrokerFailure: "deny" },
    };

    const result = inheritPolicy(unattendedProfile, containedChild);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the genuinely-contained narrower-trust child to be granted");
    expect(result.policy).toEqual(containedChild);
  });

  test("a child requesting a BROADER trustMode than the parent (read-only -> trusted-local) is DENIED", () => {
    const result = inheritPolicy(readOnlyProfile, monitoredProfile);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the trust-escalating child request to be denied");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("a child requesting a BROADER trustMode than the parent (read-only -> untrusted) is DENIED", () => {
    const result = inheritPolicy(readOnlyProfile, unattendedProfile);
    expect(result.ok).toBe(false);
  });

  test("a child requesting a BROADER trustMode than the parent (trusted-local -> untrusted) is DENIED", () => {
    const result = inheritPolicy(monitoredProfile, unattendedProfile);
    expect(result.ok).toBe(false);
  });

  test("a child with the SAME trustMode but a MORE PERMISSIVE per-capability default than the parent is DENIED (capability escalation)", () => {
    const broaderDelegateChild: PolicyProfile = {
      ...monitoredProfile,
      profileVersion: "1.0.1",
      fingerprint: sha256("monitored-trusted-local:1.0.1-broader-delegate"),
      defaults: { ...monitoredProfile.defaults, delegate: "allow" },
    };

    const result = inheritPolicy(monitoredProfile, broaderDelegateChild);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the capability-escalating child request to be denied");
  });

  test("a child with the SAME trustMode and a strictly NARROWER per-capability default than the parent is granted", () => {
    const narrowerWriteChild: PolicyProfile = {
      ...monitoredProfile,
      profileVersion: "1.0.1",
      fingerprint: sha256("monitored-trusted-local:1.0.1-narrower-write"),
      defaults: { ...monitoredProfile.defaults, write: "deny" },
    };

    const result = inheritPolicy(monitoredProfile, narrowerWriteChild);
    expect(result.ok).toBe(true);
  });

  test("role is never consulted to grant an escalation (role is not part of PolicyProfile and cannot bypass inheritPolicy)", () => {
    // inheritPolicy's signature takes only PolicyProfile values — there is no
    // `role` parameter through which a child could claim broader authority.
    const result = inheritPolicy(readOnlyProfile, unattendedProfile);
    expect(result.ok).toBe(false);
  });

  test("an out-of-enum trustMode fails CLOSED (unrecognized value is denied, not silently skipped)", () => {
    // A malformed profile that somehow bypassed schema validation must not fail
    // OPEN: `undefined > n` is `false`, which would skip the trust comparison.
    const malformedChild = {
      ...monitoredProfile,
      trustMode: "superuser",
    } as unknown as PolicyProfile;
    const result = inheritPolicy(readOnlyProfile, malformedChild);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unrecognized trustMode");
    }
  });

  test("an out-of-enum capability outcome fails CLOSED", () => {
    const malformedChild = {
      ...readOnlyProfile,
      defaults: { ...readOnlyProfile.defaults, write: "grant" },
    } as unknown as PolicyProfile;
    const result = inheritPolicy(readOnlyProfile, malformedChild);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unrecognized capability outcome");
    }
  });

  test("an out-of-enum isolation control fails CLOSED", () => {
    const malformedChild = {
      ...readOnlyProfile,
      requiredControls: { ...readOnlyProfile.requiredControls, isolation: "optional" },
    } as unknown as PolicyProfile;
    const result = inheritPolicy(readOnlyProfile, malformedChild);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unrecognized isolation control");
    }
  });
});

// ============================================================================
// 4. Provenance / parent-links (AC3)
// ============================================================================

describe("AC3 — childProvenance: child provenance links back to the parent", () => {
  const parentProvenance: Provenance = {
    provenanceId: "provenance-parent-1",
    trustLevel: "trusted",
    sourceKind: "harness-run",
  };

  function makeProvenanceDeps(): ChildProvenanceDeps {
    let counter = 0;
    return { idSeq: () => `child-provenance-${counter++}` };
  }

  test("the derived child provenance carries the parent's provenanceId in taintIds and is marked derived", () => {
    const derived = childProvenance(parentProvenance, makeProvenanceDeps());

    expect(derived.trustLevel).toBe("derived");
    expect(derived.taintIds).toContain(parentProvenance.provenanceId);
    expect(derived.provenanceId).not.toBe(parentProvenance.provenanceId);
  });

  test("a parent provenance that already carries taintIds has them preserved on the child", () => {
    const parentWithTaint: Provenance = { ...parentProvenance, taintIds: ["upstream-taint-1"] };
    const derived = childProvenance(parentWithTaint, makeProvenanceDeps());

    expect(derived.taintIds).toContain("upstream-taint-1");
    expect(derived.taintIds).toContain(parentWithTaint.provenanceId);
  });
});

// ============================================================================
// 5. Determinism (AC5)
// ============================================================================

describe("Determinism — identical inputs yield identical output (no Date.now/Math.random)", () => {
  test("inheritBudget is pure: identical inputs twice are deep-equal", () => {
    const parentRemaining: ParentRemainingBudget = { maxRuntimeMs: 60_000, maxToolCalls: 20 };
    const childRequest: BudgetReservation = { reservationId: "res-det", maxRuntimeMs: 30_000, maxToolCalls: 10 };

    const first = inheritBudget(parentRemaining, childRequest);
    const second = inheritBudget(parentRemaining, childRequest);
    expect(first).toEqual(second);
  });

  test("inheritPolicy is pure: identical inputs twice are deep-equal", () => {
    const first = inheritPolicy(monitoredProfile, readOnlyProfile);
    const second = inheritPolicy(monitoredProfile, readOnlyProfile);
    expect(first).toEqual(second);
  });

  test("childProvenance with an identical injected idSeq twice yields deep-equal output", () => {
    const parentProvenance: Provenance = {
      provenanceId: "provenance-parent-det",
      trustLevel: "trusted",
      sourceKind: "harness-run",
    };
    const makeDeps = (): ChildProvenanceDeps => {
      let counter = 0;
      return { idSeq: () => `det-${counter++}` };
    };

    const first = childProvenance(parentProvenance, makeDeps());
    const second = childProvenance(parentProvenance, makeDeps());
    expect(first).toEqual(second);
  });
});
