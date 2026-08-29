// The verifier can only delete (flow 202, AC6-AC11).
//
// `review-strict` used to occupy this slot and re-scored findings by re-reading
// them. That operation is measured to degrade accuracy — GPT-4 on GSM8K
// 95.5 -> 91.5 -> 89.0 across self-correction rounds, GPT-3.5 on CommonSenseQA
// 75.8 -> 38.1 (Huang et al., ICLR 2024, arXiv:2310.01798) — so it was removed,
// and what replaced it is constrained in CODE rather than by instruction. These
// tests are that constraint's proof.
//
// The invariant every test below is an instance of: NO claim, however malformed,
// self-serving or ambitious, can remove a finding except a well-formed evidenced
// `refuted` verdict under `filter`. Everything else costs a verdict at most.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { loadSchema, validateJson } from "../gdskills/contracts";
import { createManagedReviewPackage } from "./managed";
import {
  mergeVerifications,
  renderStageCountsMarkdown,
  verificationClaims,
  type VerificationRejectionReason,
} from "./verification";
import {
  DEFAULT_VERIFICATION_MODE,
  VERIFICATION_METHODS,
  VERIFICATION_MODES,
  VERIFICATION_VERDICTS,
  type StructuredReviewFinding,
  type VerificationClaimInput,
} from "./types";

const ORIGINAL_CWD = process.cwd();

function finding(over: Partial<StructuredReviewFinding> = {}): StructuredReviewFinding {
  return {
    id: "F-001",
    global_id: "2026-08-29-round#F-001",
    reviewer: "review-security-code",
    severity: "minor",
    problem: "the config directory is created group-writable",
    impact: "any member of the operator's group can replace auth.json",
    suggested_fix: "route every writer through ensureKeryxConfigDir",
    evidence: "measured 0775 under umask 002 on a fresh install",
    confidence: "high",
    ...over,
  };
}

function claim(over: Partial<VerificationClaimInput> = {}): VerificationClaimInput {
  return {
    finding: "2026-08-29-round#F-001",
    verdict: "confirmed",
    method: "execution",
    evidence: "bun test src/lib/config-dir.writers.test.ts -t 'umask' -> 1 fail; reproduced 0775",
    verifier: "review-logic",
    ...over,
  };
}

/** Every rejection reason a test asserts, so a renamed reason fails loudly. */
function reasons(result: { rejections: readonly { reason: VerificationRejectionReason }[] }): string[] {
  return result.rejections.map((rejection) => rejection.reason);
}

// ---------------------------------------------------------------------------
// AC7 — the verdict, and the cap on reasoning
// ---------------------------------------------------------------------------

describe("AC7: verdict, method, evidence", () => {
  test("an executed check records all three on the finding", () => {
    const result = mergeVerifications([finding()], [claim()]);
    expect(result.retained[0]?.verification).toEqual({
      verdict: "confirmed",
      method: "execution",
      evidence: "bun test src/lib/config-dir.writers.test.ts -t 'umask' -> 1 fail; reproduced 0775",
      verifier: "review-logic",
    });
    expect(result.counts.confirmed).toBe(1);
  });

  test("reasoning alone can never reach `confirmed` — it is capped, and the attempt is recorded", () => {
    // The AC7 requirement, verbatim. A "verified" verdict reached by re-reading is
    // the review-strict operation with a new label.
    const result = mergeVerifications(
      [finding()],
      [claim({ verdict: "confirmed", method: "reasoning", evidence: "the call site clearly cannot be reached" })],
    );
    expect(result.retained[0]?.verification?.verdict).toBe("unverifiable");
    expect(result.retained[0]?.verification?.method).toBe("reasoning");
    expect(result.caps).toHaveLength(1);
    expect(result.caps[0]?.claimed).toBe("confirmed");
    expect(result.caps[0]?.recorded).toBe("unverifiable");
    expect(result.counts.confirmed).toBe(0);
    expect(result.counts.unverifiable).toBe(1);
  });

  test("reasoning alone cannot reach `refuted` either, and that is the load-bearing half", () => {
    // A deliberate extension of AC7 in the only direction it is safe to extend
    // it. `refuted` is the ONE verdict that deletes; granting it to the weakest
    // method would reinstate review-strict with the sign flipped — re-reading a
    // finding and changing what happens to it with no new evidence.
    const result = mergeVerifications(
      [finding()],
      [claim({ verdict: "refuted", method: "reasoning", evidence: "on reflection this looks like a false positive" })],
      { mode: "filter" },
    );
    expect(result.refuted).toEqual([]);
    expect(result.retained).toHaveLength(1);
    expect(result.retained[0]?.verification?.verdict).toBe("unverifiable");
    expect(result.counts.findingsRefuted).toBe(0);
  });

  test("reasoning claiming `unverifiable` is applied unchanged — the cap is a ceiling, not a ban", () => {
    const result = mergeVerifications(
      [finding()],
      [claim({ verdict: "unverifiable", method: "reasoning", evidence: "no command distinguishes the two orderings" })],
    );
    expect(result.caps).toEqual([]);
    expect(result.retained[0]?.verification?.verdict).toBe("unverifiable");
  });

  test("a verdict with no evidence is discarded and the finding stays exactly as reported", () => {
    const original = finding();
    const result = mergeVerifications([original], [claim({ evidence: "  " })]);
    expect(reasons(result)).toEqual(["no-evidence"]);
    expect(result.retained[0]).toEqual(original);
    expect(result.retained[0]).not.toHaveProperty("verification");
  });

  test("an unknown verdict or method is discarded rather than coerced", () => {
    expect(reasons(mergeVerifications([finding()], [claim({ verdict: "probably-fine" })]))).toEqual([
      "unknown-verdict",
    ]);
    expect(reasons(mergeVerifications([finding()], [claim({ method: "vibes" })]))).toEqual(["unknown-method"]);
  });
});

// ---------------------------------------------------------------------------
// AC8 — delete-only, enforced in the merge
// ---------------------------------------------------------------------------

describe("AC8: the verifier can only delete", () => {
  test("an attempted escalation is discarded — severity, and the verdict with it", () => {
    // The AC8 test, stated in the AC: feed it an attempted escalation, assert the
    // escalation is discarded. The claim is discarded WHOLE: a producer that
    // tried to rewrite the finding has said it believes it may, and keeping the
    // half we happen to allow accepts that belief.
    const original = finding({ severity: "minor" });
    const result = mergeVerifications([original], [
      { ...claim(), severity: "blocker" } as VerificationClaimInput,
    ]);

    expect(result.retained).toHaveLength(1);
    expect(result.retained[0]?.severity).toBe("minor");
    expect(result.retained[0]).toEqual(original);
    expect(reasons(result)).toEqual(["mutation"]);
    expect(result.rejections[0]?.detail).toContain("severity");
    expect(result.rejections[0]?.detail).toContain("can only delete");
    expect(result.counts.applied).toBe(0);
  });

  test("an attempted rewrite of a finding's text is discarded", () => {
    const original = finding();
    const result = mergeVerifications([original], [
      {
        ...claim(),
        problem: "actually the problem is much worse than reported",
        suggested_fix: "rewrite the module",
      } as VerificationClaimInput,
    ]);
    expect(result.retained[0]).toEqual(original);
    expect(result.rejections[0]?.detail).toContain("problem");
    expect(result.rejections[0]?.detail).toContain("suggested_fix");
  });

  test("a verifier cannot ADD a finding: a claim naming nothing reported is discarded", () => {
    const result = mergeVerifications([finding()], [claim({ finding: "2026-08-29-round#F-999" })]);
    expect(result.retained).toHaveLength(1);
    expect(result.retained[0]?.id).toBe("F-001");
    expect(reasons(result)).toEqual(["unknown-finding"]);
    expect(result.rejections[0]?.detail).toContain("cannot introduce one");
  });

  test("the merged record is the original object plus a verification, and nothing else", () => {
    // The structural statement of "can only delete": every key of the output is a
    // key of the input, except `verification`.
    const original = finding();
    const result = mergeVerifications([original], [claim()]);
    const merged = result.retained[0] as Record<string, unknown>;
    const added = Object.keys(merged).filter((key) => !(key in original));
    expect(added).toEqual(["verification"]);
    for (const key of Object.keys(original)) {
      expect(merged[key]).toEqual((original as Record<string, unknown>)[key]);
    }
  });

  test("an ambiguous display id is refused rather than guessed", () => {
    const result = mergeVerifications(
      [finding({ global_id: "a#F-001" }), finding({ global_id: "b#F-001", problem: "a different finding" })],
      [claim({ finding: "F-001" })],
    );
    expect(result.retained).toHaveLength(2);
    expect(reasons(result)).toEqual(["ambiguous-finding"]);
  });

  test("two claims for one finding cancel each other rather than letting order decide", () => {
    // Taking the first would let claim ORDER decide whether a finding survives.
    // The safe resolution of a conflict is the one that cannot delete.
    const result = mergeVerifications(
      [finding()],
      [
        claim({ verdict: "refuted", verifier: "review-logic" }),
        claim({ verdict: "confirmed", verifier: "review-architecture" }),
      ],
      { mode: "filter" },
    );
    expect(result.refuted).toEqual([]);
    expect(result.retained).toHaveLength(1);
    expect(result.retained[0]).not.toHaveProperty("verification");
    expect(reasons(result)).toEqual(["conflicting-claims"]);
  });

  test("every rejection path retains the finding — the property, over every reason", () => {
    // Non-vacuity for the whole rejection surface at once: whatever goes wrong,
    // the finding count never drops. This is the invariant the module header
    // states, checked rather than asserted in prose.
    const original = finding();
    const bad: VerificationClaimInput[] = [
      claim({ finding: "nope" }),
      claim({ verdict: "maybe" }),
      claim({ method: "intuition" }),
      claim({ evidence: "" }),
      claim({ verifier: "" }),
      claim({ verifier: "review-security-code" }),
      { ...claim(), severity: "blocker" } as VerificationClaimInput,
    ];
    for (const entry of bad) {
      for (const mode of VERIFICATION_MODES) {
        const result = mergeVerifications([original], [entry], { mode });
        expect(result.retained).toHaveLength(1);
        expect(result.refuted).toHaveLength(0);
        expect(result.retained[0]?.id).toBe("F-001");
        expect(result.counts.findingsRefuted).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC9 — never self-verify
// ---------------------------------------------------------------------------

describe("AC9: a finding is never verified by the reviewer that raised it", () => {
  test("a self-verification is refused and the finding is retained unverified", () => {
    const original = finding({ reviewer: "review-security-code" });
    const result = mergeVerifications([original], [claim({ verifier: "review-security-code" })]);
    expect(result.retained[0]).toEqual(original);
    expect(result.retained[0]).not.toHaveProperty("verification");
    expect(reasons(result)).toEqual(["self-verification"]);
    expect(result.rejections[0]?.detail).toContain("cannot verify it");
  });

  test("a self-REFUTATION is refused too — the deletion case is the one that matters", () => {
    const result = mergeVerifications(
      [finding({ reviewer: "review-logic" })],
      [claim({ verifier: "review-logic", verdict: "refuted" })],
      { mode: "filter" },
    );
    expect(result.refuted).toEqual([]);
    expect(result.retained).toHaveLength(1);
    expect(reasons(result)).toEqual(["self-verification"]);
  });

  test("a different reviewer verifying the same finding is applied", () => {
    const result = mergeVerifications(
      [finding({ reviewer: "review-security-code" })],
      [claim({ verifier: "review-logic" })],
    );
    expect(result.rejections).toEqual([]);
    expect(result.retained[0]?.verification?.verifier).toBe("review-logic");
  });

  test("an anonymous claim is refused, because AC9 cannot be checked against it", () => {
    const result = mergeVerifications([finding()], [claim({ verifier: undefined })]);
    expect(reasons(result)).toEqual(["no-verifier"]);
    expect(result.retained[0]).not.toHaveProperty("verification");
  });

  test("the verifier's name is written onto the record, so the rule is auditable afterwards", () => {
    // Enforcement at write time leaves no trace. `reviewer` was hardcoded to
    // `review-orchestrator` on all 83 recorded findings, which is exactly the
    // state in which a per-actor rule silently stops being checkable.
    const result = mergeVerifications([finding()], [claim()]);
    expect(result.retained[0]?.verification?.verifier).toBe("review-logic");
    expect(result.retained[0]?.verification?.verifier).not.toBe(result.retained[0]?.reviewer);
  });
});

// ---------------------------------------------------------------------------
// AC10 — verification_mode
// ---------------------------------------------------------------------------

describe("AC10: verification_mode off | annotate | filter, defaulting to annotate", () => {
  test("the default is `annotate`", () => {
    expect(DEFAULT_VERIFICATION_MODE).toBe("annotate");
    expect([...VERIFICATION_MODES]).toEqual(["off", "annotate", "filter"]);
  });

  test("the default is what an unspecified mode actually uses, not only what the constant says", () => {
    // The constant and the behaviour are asserted separately on purpose: a
    // default that is declared and not wired is the decorative-guard shape.
    const result = mergeVerifications([finding()], [claim({ verdict: "refuted" })]);
    expect(result.counts.mode).toBe("annotate");
    expect(result.refuted).toEqual([]);
    expect(result.retained).toHaveLength(1);
  });

  test("annotate records a refuted verdict and removes NOTHING", () => {
    // One release of measuring the drop rate before it costs a real finding.
    // SWE-agent keeps its equivalent opt-in because it sometimes rejects correct
    // patches.
    const result = mergeVerifications([finding()], [claim({ verdict: "refuted" })], { mode: "annotate" });
    expect(result.retained).toHaveLength(1);
    expect(result.retained[0]?.verification?.verdict).toBe("refuted");
    expect(result.counts.refuted).toBe(1);
    expect(result.counts.findingsRefuted).toBe(0);
    expect(result.counts.findingsRetained).toBe(1);
  });

  test("filter removes the refuted finding and only the refuted finding", () => {
    const result = mergeVerifications(
      [finding(), finding({ id: "F-002", global_id: "2026-08-29-round#F-002" })],
      [
        claim({ verdict: "refuted" }),
        claim({ finding: "2026-08-29-round#F-002", verdict: "confirmed" }),
      ],
      { mode: "filter" },
    );
    expect(result.retained.map((entry) => entry.id)).toEqual(["F-002"]);
    expect(result.refuted.map((entry) => entry.id)).toEqual(["F-001"]);
    expect(result.counts.findingsRefuted).toBe(1);
    expect(result.counts.findingsRetained).toBe(1);
  });

  test("off reads no verdict, and says so rather than returning silence", () => {
    const result = mergeVerifications([finding()], [claim({ verdict: "refuted" })], { mode: "off" });
    expect(result.retained).toHaveLength(1);
    expect(result.retained[0]).not.toHaveProperty("verification");
    expect(reasons(result)).toEqual(["mode-off"]);
    expect(result.counts.applied).toBe(0);
  });

  test("a finding nobody checked is retained in every mode — absent is not droppable", () => {
    // The 83 pre-contract findings on disk are all in this state, and so is every
    // finding a verifier ran out of budget before reaching.
    for (const mode of VERIFICATION_MODES) {
      const result = mergeVerifications([finding()], [], { mode });
      expect(result.retained).toHaveLength(1);
      expect(result.retained[0]).not.toHaveProperty("verification");
      expect(result.counts.unverified).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// AC11 — stage counts
// ---------------------------------------------------------------------------

describe("AC11: the review record carries what each stage removed", () => {
  test("dropped by pre-filter, refuted by the verifier, retained", () => {
    const result = mergeVerifications(
      [finding(), finding({ id: "F-002", global_id: "2026-08-29-round#F-002" })],
      [claim({ verdict: "refuted" })],
      { mode: "filter" },
    );
    const markdown = renderStageCountsMarkdown({
      preFilter: {
        filesSeen: 12,
        filesRetained: 9,
        filesDropped: 3,
        blocksSeen: 40,
        blocksRetained: 37,
        blocksDropped: 3,
        changedLinesRetained: 210,
        changedLinesDropped: 3214,
      },
      verification: result.counts,
      rejections: result.rejections,
      caps: result.caps,
    });

    expect(markdown).toContain("files_dropped: 3");
    expect(markdown).toContain("changed_lines_dropped: 3214");
    expect(markdown).toContain("verification_mode: filter");
    expect(markdown).toContain("refuted: 1");
    expect(markdown).toContain("findings_removed_by_verifier: 1");
    expect(markdown).toContain("findings_retained: 1");
  });

  test("no pre-filter reads `not recorded`, never `0`", () => {
    // "Dropped nothing" and "never ran" are different facts. Rendering them
    // identically is the defect that made `dismissed-out-of-scope: 0` mean "not
    // written down".
    const markdown = renderStageCountsMarkdown({
      verification: mergeVerifications([finding()], []).counts,
    });
    expect(markdown).toContain("not recorded");
    expect(markdown).toContain("This is NOT `dropped 0`");
    expect(markdown).not.toContain("files_dropped: 0");
  });

  test("the record forbids stating any of this as a precision improvement (AC15)", () => {
    const markdown = renderStageCountsMarkdown({
      verification: mergeVerifications([finding()], []).counts,
    });
    expect(markdown).toContain("never as a precision figure");
    expect(markdown).toContain("53/53 = 100%");
  });

  test("discarded claims and capped verdicts are in the record, not only in memory", () => {
    const result = mergeVerifications(
      [finding()],
      [
        { ...claim({ finding: "2026-08-29-round#F-404" }), severity: "blocker" } as VerificationClaimInput,
        claim({ verdict: "confirmed", method: "reasoning" }),
      ],
    );
    const markdown = renderStageCountsMarkdown({
      verification: result.counts,
      rejections: result.rejections,
      caps: result.caps,
    });
    expect(markdown).toContain("mutation");
    expect(markdown).toContain("Verdicts capped");
    expect(markdown).toContain("| confirmed | unverifiable |");
    expect(markdown).toContain("a claim can cost a verdict, never a finding");
  });
});

// ---------------------------------------------------------------------------
// The wrapper form, and the schema
// ---------------------------------------------------------------------------

describe("a verifier result is accepted in the shape a verifier returns it", () => {
  test("the wrapper's verifier is pushed onto claims that omit one", () => {
    const claims = verificationClaims({
      verifier: "review-logic",
      verifications: [{ finding: "a#F-001", verdict: "confirmed", method: "execution", evidence: "bun test -> 1 fail" }],
    });
    expect(claims[0]?.verifier).toBe("review-logic");
  });

  test("a per-claim verifier wins over the wrapper's", () => {
    const claims = verificationClaims({
      verifier: "review-logic",
      verifications: [{ finding: "a#F-001", verifier: "review-architecture" }],
    });
    expect(claims[0]?.verifier).toBe("review-architecture");
  });

  test("a payload that is neither an array nor the wrapper is refused, not silently emptied", () => {
    expect(() => verificationClaims({ verifications: null } as never)).toThrow(/Nothing was merged/);
  });
});

describe("the finding contract carries verification, and caps reasoning in the schema too", () => {
  const STRICT = JSON.parse(
    readFileSync(path.join(ORIGINAL_CWD, "src", "gdskills", "contracts", "review-finding.schema.json"), "utf8"),
  ) as Record<string, any>;
  const BUNDLED = JSON.parse(
    readFileSync(
      path.join(
        ORIGINAL_CWD,
        "src",
        "gdskills",
        "bundled",
        "skills",
        "review",
        "review-orchestrator",
        "reviewer-finding.schema.json",
      ),
      "utf8",
    ),
  ) as Record<string, any>;

  test("an executed verification is accepted by the strict contract", async () => {
    const schema = await loadSchema("review-finding");
    expect(
      await validateJson(
        {
          ...finding(),
          verification: { verdict: "confirmed", method: "execution", evidence: "bun test -> 1 fail", verifier: "review-logic" },
        },
        schema,
      ),
    ).toEqual([]);
  });

  test("the schema refuses a reasoning-only `confirmed`, independently of the merge", async () => {
    // Two layers on purpose. `prior_findings[].finding` $refs this schema, so a
    // verification smuggled in from outside the CLI meets the same cap — a rule
    // that lives in one code path is matched against nothing the moment a second
    // path appears.
    const schema = await loadSchema("review-finding");
    for (const verdict of ["confirmed", "refuted"]) {
      const errors = await validateJson(
        { ...finding(), verification: { verdict, method: "reasoning", evidence: "on reflection" } },
        schema,
      );
      expect(errors.map((error) => error.path)).toContain("$.verification.verdict");
    }
    expect(
      await validateJson(
        { ...finding(), verification: { verdict: "unverifiable", method: "reasoning", evidence: "nothing was run" } },
        schema,
      ),
    ).toEqual([]);
  });

  test("a verification with no evidence, or an undeclared property, is refused", async () => {
    const schema = await loadSchema("review-finding");
    const noEvidence = await validateJson(
      { ...finding(), verification: { verdict: "confirmed", method: "execution" } },
      schema,
    );
    expect(noEvidence.map((error) => error.path)).toContain("$.verification.evidence");

    const extra = await validateJson(
      {
        ...finding(),
        verification: { verdict: "confirmed", method: "execution", evidence: "x", severity: "blocker" },
      },
      schema,
    );
    expect(extra.map((error) => error.path)).toContain("$.verification.severity");
  });

  test("verification is declared in the strict contract and DELIBERATELY not in the reviewer's", () => {
    // Same basis as `disposition`, and sharper: the reviewer that raised a
    // finding is the ONE actor forbidden to verify it (AC9). Declaring the
    // property in the shape reviewers emit would put the forbidden field next to
    // `severity` in every reviewer's output.
    expect(STRICT.properties.verification).toBeDefined();
    expect(BUNDLED.properties.findings.items.properties.verification).toBeUndefined();
    // The verifier has its own contract instead, and it cannot express a finding.
    const claimSchema = JSON.parse(
      readFileSync(
        path.join(
          ORIGINAL_CWD,
          "src",
          "gdskills",
          "bundled",
          "skills",
          "review",
          "review-orchestrator",
          "verification-claim.schema.json",
        ),
        "utf8",
      ),
    ) as Record<string, any>;
    const claimItem = claimSchema.properties.verifications.items as Record<string, any>;
    expect(claimItem.additionalProperties).toBe(false);
    expect(Object.keys(claimItem.properties).sort()).toEqual([
      "evidence",
      "finding",
      "method",
      "verdict",
      "verifier",
    ]);
    expect(claimItem.properties.severity).toBeUndefined();
  });

  test("the vocabulary in the schema and in the code is the same set", () => {
    expect(STRICT.properties.verification.properties.verdict.enum).toEqual([...VERIFICATION_VERDICTS]);
    expect(STRICT.properties.verification.properties.method.enum).toEqual([...VERIFICATION_METHODS]);
  });
});

// ---------------------------------------------------------------------------
// End to end: what reaches findings.json
// ---------------------------------------------------------------------------

describe("the verdict reaches the review record", () => {
  async function ingest(
    over: Partial<Parameters<typeof createManagedReviewPackage>[0]> = {},
  ): Promise<{ root: string; findings: StructuredReviewFinding[]; scope: string; result: Awaited<ReturnType<typeof createManagedReviewPackage>> }> {
    const root = await mkdtemp(path.join(tmpdir(), "gd-verify-"));
    await writeFile(path.join(root, "report.md"), "# Round\n", "utf8");
    const result = await createManagedReviewPackage({
      cwd: root,
      mode: "ingest",
      reviewId: "2026-08-29-verify",
      target: { kind: "report", ref: "report.md" },
      reportText: "# Round\n\nno machine-readable block here\n",
      findings: [{ ...finding(), global_id: undefined }],
      now: new Date("2026-08-29T11:00:00Z"),
      ...over,
    });
    return {
      root,
      result,
      findings: JSON.parse(
        await readFile(path.join(root, result.path, "findings.json"), "utf8"),
      ) as StructuredReviewFinding[],
      scope: await readFile(path.join(root, result.path, "scope.md"), "utf8"),
    };
  }

  test("annotate writes the verdict and NO disposition", async () => {
    // The composition rule: `verification` is an observation made during the
    // round, `disposition` is a decision about what the project did. In annotate
    // mode the observation is recorded and no decision follows from it — that is
    // the entire content of the mode.
    const { root, findings, scope } = await ingest({
      verifications: [
        {
          finding: "2026-08-29-verify#F-001",
          verdict: "refuted",
          method: "execution",
          evidence: "bun test -t 'umask' -> 3 pass; measured 0700, the finding read the wrong call site",
          verifier: "review-logic",
        },
      ],
    });
    try {
      expect(findings).toHaveLength(1);
      expect(findings[0]?.verification?.verdict).toBe("refuted");
      expect(findings[0]).not.toHaveProperty("disposition");
      expect(scope).toContain("verification_mode: annotate");
      expect(scope).toContain("findings_removed_by_verifier: 0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("filter removes the finding from the reported set and records dismissed-incorrect with the verification evidence", async () => {
    const { root, findings, scope } = await ingest({
      verificationMode: "filter",
      verifications: [
        {
          finding: "2026-08-29-verify#F-001",
          verdict: "refuted",
          method: "execution",
          evidence: "measured 0700 under umask 002",
          verifier: "review-logic",
        },
      ],
    });
    try {
      // Still ON DISK — a refuted finding is recorded, not erased. The corpus
      // measured 100% precision precisely because refutations were discarded
      // before they were written down.
      expect(findings).toHaveLength(1);
      expect(findings[0]?.disposition?.state).toBe("dismissed-incorrect");
      expect(findings[0]?.disposition?.evidence).toContain("refuted by review-logic (execution)");
      expect(findings[0]?.disposition?.evidence).toContain("measured 0700");
      expect(findings[0]?.verification?.verdict).toBe("refuted");
      expect(scope).toContain("findings_removed_by_verifier: 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a self-verification never reaches the record, and the package still says so", async () => {
    const { root, findings, scope } = await ingest({
      verificationMode: "filter",
      verifications: [
        {
          finding: "2026-08-29-verify#F-001",
          verdict: "refuted",
          method: "execution",
          evidence: "I re-ran my own check",
          verifier: "review-security-code",
        },
      ],
    });
    try {
      expect(findings).toHaveLength(1);
      expect(findings[0]).not.toHaveProperty("verification");
      expect(findings[0]).not.toHaveProperty("disposition");
      expect(scope).toContain("self-verification");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a package with no verifier still carries the stage counts", async () => {
    // AC11 is unconditional. A record that only counts when a verifier ran cannot
    // be compared with one where none did.
    const { root, scope, result } = await ingest();
    try {
      expect(scope).toContain("## Stage counts");
      expect(scope).toContain("verification_mode: annotate");
      expect(scope).toContain("unverified: 1");
      expect(scope).toContain("not recorded");
      expect(result.verification.findingsRetained).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the pre-filter half is carried through when a scope is supplied", async () => {
    const { root, scope } = await ingest({
      scopeCounts: {
        filesSeen: 2388,
        filesRetained: 2364,
        filesDropped: 24,
        blocksSeen: 4575,
        blocksRetained: 4560,
        blocksDropped: 15,
        changedLinesRetained: 900,
        changedLinesDropped: 1200,
      },
    });
    try {
      expect(scope).toContain("files_dropped: 24");
      expect(scope).toContain("blocks_dropped: 15");
      expect(scope).not.toContain("not recorded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
