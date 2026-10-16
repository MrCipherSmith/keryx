// The premise judge can only hold or lower (flow 459, AC1).
//
// The case it exists for: a finding ("playback slider pinned LTR") whose FACTS held and whose REQUEST was wrong. The
// verifier cannot see that; `review-premise` can. These tests are the proof that it is constrained in code the way the
// verifier is: whatever a claim says, it cannot add a finding, raise a severity, edit a finding's text, or dismiss one.
// One test per rule, including each rejection.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSchema, validateJson } from "../gdskills/contracts";
import { createManagedReviewPackage } from "./managed";
import { PREMISES_FILE, mergePremises, parsePremiseClaims, renderPremiseMarkdown, type PremiseRejectionReason } from "./premise";
import { PREMISE_VERDICTS, type PremiseClaimInput, type StructuredReviewFinding } from "./types";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true });
});

function finding(over: Partial<StructuredReviewFinding> = {}): StructuredReviewFinding {
  return {
    id: "LY-003",
    global_id: "2026-10-16-round#LY-003",
    reviewer: "review-layout",
    severity: "major",
    problem: "Playback slider pinned LTR: dir=\"ltr\" is hard-coded, so the timeline does not mirror in RTL",
    impact: "an Arabic user sees a left-to-right timeline",
    suggested_fix: "drop the dir override and mirror the track",
    evidence: "MultiLayerPlaybackSlider.tsx:150 sets dir=\"ltr\"",
    confidence: "high",
    file: "src/MultiLayerPlaybackSlider.tsx",
    line: 150,
    ...over,
  };
}

const SIGNAL = { ref: "src/MediaPlaybackControls.tsx:81", says: "a sibling media control also pins dir=ltr" };
const SOURCE = { name: "Material Design - Bidirectionality", says: "media playback controls and progress do not mirror" };

function claim(over: Partial<PremiseClaimInput> = {}): PremiseClaimInput {
  return { finding_id: "2026-10-16-round#LY-003", verdict: "upheld", ...over };
}

/** `judge: null` is a file that names no judge. */
function parsed(claims: PremiseClaimInput[], judge: string | null = "review-premise") {
  return { ...(judge === null ? {} : { judge }), claims };
}

const reasons = (result: { rejections: readonly { reason: PremiseRejectionReason }[] }): string[] => result.rejections.map((rejection) => rejection.reason);

describe("verdicts", () => {
  test("upheld changes nothing about the finding but records the judgement", () => {
    const original = finding();
    const result = mergePremises([original], parsed([claim({ reasoning: "the request stands" })]));
    expect(result.rejections).toEqual([]);
    const merged = result.findings[0] as StructuredReviewFinding;
    expect({ ...merged, premise: undefined }).toEqual({ ...original, premise: undefined });
    expect(merged.premise).toEqual({ verdict: "upheld", judge: "review-premise", reasoning: "the request stands" });
    expect(result.counts).toMatchObject({ claims: 1, applied: 1, rejected: 0, upheld: 1, held: 0 });
  });

  test("downgraded lowers the severity, keeps what the reviewer reported, and edits no text", () => {
    const original = finding();
    const result = mergePremises([original], parsed([claim({ verdict: "downgraded", severity: "minor", practice_sources: [SOURCE] })]));
    const merged = result.findings[0] as StructuredReviewFinding;
    expect(merged.severity).toBe("minor");
    expect(merged.premise).toMatchObject({ verdict: "downgraded", severity: "minor", practice_sources: [SOURCE], original_severity: "major" });
    expect({ ...merged, severity: original.severity, premise: undefined }).toEqual({ ...original, premise: undefined });
    expect(result.counts.downgraded).toBe(1);
  });

  test("challenged holds the finding, carrying the cited signals, the sources and the question", () => {
    const result = mergePremises(
      [finding()],
      parsed([claim({ verdict: "challenged", intent_signals: [SIGNAL], practice_sources: [SOURCE], question: "Should the timeline mirror?" })]),
    );
    const merged = result.findings[0] as StructuredReviewFinding;
    expect(merged.severity).toBe("major");
    expect(merged.premise).toMatchObject({ verdict: "challenged", intent_signals: [SIGNAL], practice_sources: [SOURCE], question: "Should the timeline mirror?" });
    expect(result.counts).toMatchObject({ challenged: 1, held: 1 });
  });

  test("owner-decision holds the finding with its options", () => {
    const options = ["uphold - mirror the timeline", "dismiss - keep LTR, as platforms do"];
    const result = mergePremises([finding()], parsed([claim({ verdict: "owner-decision", question: "Which?", options })]));
    expect((result.findings[0] as StructuredReviewFinding).premise).toMatchObject({ verdict: "owner-decision", options });
    expect(result.counts).toMatchObject({ ownerDecision: 1, held: 1 });
  });

  test("a finding with no claim is returned untouched, and nothing is added or removed", () => {
    const first = finding();
    const second = finding({ id: "LY-004", global_id: "2026-10-16-round#LY-004" });
    const result = mergePremises([first, second], parsed([claim({ verdict: "downgraded", severity: "minor", practice_sources: [SOURCE] })]));
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]).toBe(second);
    expect(first.severity).toBe("major");
    expect(first.premise).toBeUndefined();
  });

  test("the vocabulary in the schema and in the code is the same set", async () => {
    const schema = (await loadSchema("review-finding")) as unknown as { properties: { premise: { properties: { verdict: { enum: string[] } } } } };
    expect(schema.properties.premise.properties.verdict.enum).toEqual([...PREMISE_VERDICTS]);
  });

  test("every premise the merge can produce satisfies the schema, and one with a stray property does not", async () => {
    const schema = await loadSchema("review-finding");
    const scoped = { class_scope: { sites: ["src/MultiLayerPlaybackSlider.tsx:150"], enumeration_method: "grep dir=" } };
    const result = mergePremises(
      [finding(scoped)],
      parsed([claim({ verdict: "owner-decision", question: "q", options: ["a", "b"], intent_signals: [SIGNAL], practice_sources: [SOURCE], reasoning: "r" })]),
    );
    expect(await validateJson(result.findings[0], schema)).toEqual([]);
    expect((await validateJson({ ...finding(scoped), premise: { verdict: "upheld", judge: "j", problem: "edited" } }, schema)).length).toBeGreaterThan(0);
  });
});

describe("rejections, each of which leaves the finding as it was", () => {
  function rejectedAlone(claims: PremiseClaimInput[], over: Partial<StructuredReviewFinding> = {}, judge: string | null = "review-premise") {
    const original = finding(over);
    const result = mergePremises([original], parsed(claims, judge));
    expect(result.findings[0]).toBe(original);
    expect(result.counts.applied).toBe(0);
    expect(result.counts.rejected).toBe(result.rejections.length);
    return result;
  }

  test("unknown-finding: a judge cannot introduce a finding", () => {
    expect(reasons(rejectedAlone([claim({ finding_id: "2026-10-16-round#NOPE" })]))).toEqual(["unknown-finding"]);
  });

  test("a claim names a finding by display id as well as by global_id", () => {
    const result = mergePremises([finding()], parsed([claim({ finding_id: "LY-003" })]));
    expect(result.counts.applied).toBe(1);
  });

  test("ambiguous-finding: a display id shared by two findings needs the global_id", () => {
    const result = mergePremises([finding(), finding({ global_id: "other#LY-003" })], parsed([claim({ finding_id: "LY-003" })]));
    expect(reasons(result)).toEqual(["ambiguous-finding"]);
  });

  test("self-judgement: the reviewer that raised the finding cannot judge its premise, however the name is written", () => {
    for (const judge of ["review-layout", " Review-Layout ", "review-layout(sonnet)"]) {
      expect(reasons(rejectedAlone([claim({ verdict: "challenged", question: "q", intent_signals: [SIGNAL] })], {}, judge))).toEqual(["self-judgement"]);
    }
  });

  test("self-judgement also covers a reviewer a duplicate merge folded into the finding", () => {
    expect(reasons(rejectedAlone([claim()], { reported_by: ["review-layout", "review-premise"] }))).toEqual(["self-judgement"]);
  });

  test("no-judge: a file that does not name its judge cannot be checked for self-judgement", () => {
    expect(reasons(rejectedAlone([claim()], {}, null))).toEqual(["no-judge"]);
    expect(reasons(rejectedAlone([claim()], {}, "()"))).toEqual(["no-judge"]);
  });

  test("raise-severity: a downgrade that names a higher severity is rejected, and the severity stays", () => {
    const result = rejectedAlone([claim({ verdict: "downgraded", severity: "blocker" })]);
    expect(reasons(result)).toEqual(["raise-severity"]);
    expect((result.findings[0] as StructuredReviewFinding).severity).toBe("major");
  });

  test("not-a-downgrade: an equal severity, or none, is not a downgrade", () => {
    expect(reasons(rejectedAlone([claim({ verdict: "downgraded", severity: "major" })]))).toEqual(["not-a-downgrade"]);
    expect(reasons(rejectedAlone([claim({ verdict: "downgraded" })]))).toEqual(["not-a-downgrade"]);
    expect(reasons(rejectedAlone([claim({ verdict: "downgraded", severity: "huge" })]))).toEqual(["not-a-downgrade"]);
  });

  test("downgrade-without-evidence: a downgrade with no intent signal or practice source is a rubric re-grade, and the finding keeps its severity", () => {
    // The live eval (flow 459 eval/) had the judge downgrade three real surviving-mutant majors on
    // the severity rubric alone; that is the reviewer's call, not the premise judge's.
    const result = rejectedAlone([claim({ verdict: "downgraded", severity: "minor", reasoning: "names no input that produces a wrong result today" })]);
    expect(reasons(result)).toEqual(["downgrade-without-evidence"]);
    expect((result.findings[0] as StructuredReviewFinding).severity).toBe("major");
  });

  test("severity-without-downgrade: a severity next to any other verdict is a way to smuggle one in", () => {
    expect(reasons(rejectedAlone([claim({ verdict: "upheld", severity: "blocker" })]))).toEqual(["severity-without-downgrade"]);
  });

  test("challenged-without-evidence: no intent signal and no practice source", () => {
    expect(reasons(rejectedAlone([claim({ verdict: "challenged", question: "q" })]))).toEqual(["challenged-without-evidence"]);
    expect(reasons(rejectedAlone([claim({ verdict: "challenged", question: "q", intent_signals: [], practice_sources: [] })]))).toEqual(["challenged-without-evidence"]);
  });

  test("held-without-question: both held verdicts need a question for the operator", () => {
    expect(reasons(rejectedAlone([claim({ verdict: "challenged", practice_sources: [SOURCE] })]))).toEqual(["held-without-question"]);
    expect(reasons(rejectedAlone([claim({ verdict: "owner-decision", options: ["a", "b"] })]))).toEqual(["held-without-question"]);
    expect(reasons(rejectedAlone([claim({ verdict: "owner-decision", question: "  ", options: ["a", "b"] })]))).toEqual(["held-without-question"]);
  });

  test("owner-decision-without-options: fewer than two options is a guess, not a choice", () => {
    expect(reasons(rejectedAlone([claim({ verdict: "owner-decision", question: "q" })]))).toEqual(["owner-decision-without-options"]);
    expect(reasons(rejectedAlone([claim({ verdict: "owner-decision", question: "q", options: ["only one"] })]))).toEqual(["owner-decision-without-options"]);
    expect(reasons(rejectedAlone([claim({ verdict: "owner-decision", question: "q", options: ["a", ""] })]))).toEqual(["owner-decision-without-options"]);
  });

  test("duplicate-claim: two claims for one finding apply neither, so claim order cannot decide whether it is held", () => {
    const original = finding();
    const result = mergePremises(
      [original],
      parsed([claim({ verdict: "downgraded", severity: "minor", practice_sources: [SOURCE] }), claim({ verdict: "challenged", question: "q", practice_sources: [SOURCE] })]),
    );
    expect(result.findings[0]).toBe(original);
    expect(reasons(result)).toEqual(["duplicate-claim", "duplicate-claim"]);
    expect(result.counts).toMatchObject({ claims: 2, applied: 0, rejected: 2 });
  });

  test("unknown-property: a claim that tries to edit the finding is discarded whole, verdict included", () => {
    const attempts: Array<Partial<PremiseClaimInput>> = [{ problem: "rewritten" }, { suggested_fix: "something else" }, { file: "elsewhere.ts" }, { disposition: { state: "dismissed-incorrect" } }];
    for (const attempt of attempts) {
      const result = rejectedAlone([claim({ verdict: "downgraded", severity: "minor", practice_sources: [SOURCE], ...attempt })]);
      expect(reasons(result)).toEqual(["unknown-property"]);
      expect(result.rejections[0]?.detail).toContain(Object.keys(attempt)[0] as string);
    }
  });

  test("unknown-verdict: only the four verdicts exist (a dismissal is the operator's)", () => {
    expect(reasons(rejectedAlone([claim({ verdict: "dismissed" })]))).toEqual(["unknown-verdict"]);
    expect(reasons(rejectedAlone([claim({ verdict: undefined })]))).toEqual(["unknown-verdict"]);
  });

  test("below-minor: an info finding asks for nothing to act on", () => {
    expect(reasons(rejectedAlone([claim()], { severity: "info" }))).toEqual(["below-minor"]);
  });

  test("already-judged: a carried finding keeps the premise it has", () => {
    const carried = finding({ premise: { verdict: "upheld", judge: "review-premise" } });
    const result = mergePremises([carried], parsed([claim({ verdict: "challenged", question: "q", practice_sources: [SOURCE] })]));
    expect(result.findings[0]).toBe(carried);
    expect(reasons(result)).toEqual(["already-judged"]);
    expect(result.counts.upheld).toBe(1);
  });

  test("malformed-field: signals and sources have exactly two non-empty strings each", () => {
    expect(reasons(rejectedAlone([claim({ verdict: "challenged", question: "q", intent_signals: [{ ref: "x" }] })]))).toEqual(["malformed-field"]);
    expect(reasons(rejectedAlone([claim({ verdict: "challenged", question: "q", practice_sources: [{ name: "n", says: "s", extra: 1 }] })]))).toEqual(["malformed-field"]);
    expect(reasons(rejectedAlone([claim({ verdict: "upheld", intent_signals: "nope" })]))).toEqual(["malformed-field"]);
    expect(reasons(rejectedAlone([claim({ verdict: "upheld", reasoning: 7 })]))).toEqual(["malformed-field"]);
  });

  test("external findings: a challenge becomes a question and is never a dismissal; a machine does not re-grade a comment", () => {
    const external = finding({ source: "external", reviewer: "some-human", external_ref: { id: "review-comment:1", author: "some-human", url: "u", submitted_at: "t" } });
    const challenged = mergePremises([external], parsed([claim({ verdict: "challenged", question: "q", practice_sources: [SOURCE] })]));
    expect((challenged.findings[0] as StructuredReviewFinding).premise?.verdict).toBe("challenged");
    expect((challenged.findings[0] as StructuredReviewFinding).disposition).toBeUndefined();
    expect(reasons(rejectedAlone([claim({ verdict: "downgraded", severity: "minor", practice_sources: [SOURCE] })], { source: "external" }))).toEqual(["external-downgrade"]);
  });

  test("a claim that is not an object is rejected by name, not thrown on", () => {
    const file = parsePremiseClaims({ judge: "review-premise", premises: ["LY-003"] });
    const result = mergePremises([finding()], file);
    expect(reasons(result)).toEqual(["unknown-property"]);
  });

  test("the claims the judge made are counted, applied plus rejected", () => {
    const result = mergePremises(
      [finding()],
      parsed([claim({ verdict: "downgraded", severity: "minor", practice_sources: [SOURCE] }), claim({ finding_id: "ghost" })]),
    );
    expect(result.counts).toMatchObject({ claims: 2, applied: 1, rejected: 1 });
  });
});

describe("the claims file", () => {
  test("is a bare object naming the judge: an array is refused, nothing merged", () => {
    expect(() => parsePremiseClaims([{ finding_id: "x", verdict: "upheld" }])).toThrow(/object/);
    expect(() => parsePremiseClaims("nope")).toThrow(/object/);
  });

  test("needs a premises array", () => {
    expect(() => parsePremiseClaims({ judge: "review-premise" })).toThrow(/premises/);
  });

  test("carries nothing but judge, model and premises", () => {
    expect(() => parsePremiseClaims({ judge: "review-premise", premises: [], findings: [] })).toThrow(/findings/);
  });

  test("reads the judge and model once", () => {
    expect(parsePremiseClaims({ judge: " review-premise ", model: "opus", premises: [] })).toEqual({ judge: "review-premise", model: "opus", claims: [] });
    expect(parsePremiseClaims(undefined)).toBeUndefined();
  });

  test("the model is recorded on each premise", () => {
    const result = mergePremises([finding()], { ...parsed([claim()]), model: "claude-opus" });
    expect((result.findings[0] as StructuredReviewFinding).premise?.model).toBe("claude-opus");
  });
});

describe("scope.md block", () => {
  test("lists the held findings, the discarded claims and the counts", () => {
    const result = mergePremises(
      [finding(), finding({ id: "LY-004", global_id: "2026-10-16-round#LY-004" })],
      parsed([
        claim({ verdict: "challenged", intent_signals: [SIGNAL], question: "Should the timeline mirror?" }),
        claim({ finding_id: "2026-10-16-round#LY-004", verdict: "downgraded", severity: "blocker" }),
      ]),
    );
    const block = renderPremiseMarkdown({ counts: result.counts, rejections: result.rejections, findings: result.findings });
    expect(block).toContain("## Premise check");
    expect(block).toContain("premise_claims_received: 2");
    expect(block).toContain("premise_claims_applied: 1");
    expect(block).toContain("premise_claims_rejected: 1");
    expect(block).toContain("premise_held: 1");
    expect(block).toContain("### Held for the operator (premise)");
    expect(block).toContain("2026-10-16-round#LY-003");
    expect(block).toContain("Should the timeline mirror?");
    expect(block).toContain("### Premise claims discarded");
    expect(block).toContain("raise-severity");
  });

  test("is empty when no judge ran and no finding carries a premise", () => {
    const result = mergePremises([finding()], undefined);
    expect(renderPremiseMarkdown({ counts: result.counts, rejections: result.rejections, findings: result.findings })).toBe("");
  });
});

describe("the claims reach the review record", () => {
  async function ingest(over: Partial<Parameters<typeof createManagedReviewPackage>[0]> = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "gd-premise-"));
    roots.push(root);
    const result = await createManagedReviewPackage({
      cwd: root,
      mode: "ingest",
      reviewId: "2026-10-16-premise",
      target: { kind: "report", ref: "report.md" },
      reportText: "# Round\n\nno machine-readable block here\n",
      findings: [{ ...finding(), global_id: undefined, class_scope: { sites: ["src/MultiLayerPlaybackSlider.tsx:150"], enumeration_method: "grep dir=" } }],
      now: new Date("2026-10-16T11:00:00Z"),
      ...over,
    });
    return {
      root,
      result,
      findings: JSON.parse(await readFile(path.join(root, result.path, "findings.json"), "utf8")) as StructuredReviewFinding[],
      scope: await readFile(path.join(root, result.path, "scope.md"), "utf8"),
    };
  }
  const ID = "2026-10-16-premise#LY-003";

  test("a held finding is on the record with its premise, in scope.md, in premises.json and in the counts", async () => {
    const premises = { judge: "review-premise", model: "opus", premises: [claim({ finding_id: ID, verdict: "challenged", intent_signals: [SIGNAL], practice_sources: [SOURCE], question: "Should the timeline mirror?" })] };
    const { root, result, findings, scope } = await ingest({ premises });
    expect(findings[0]?.premise).toMatchObject({ verdict: "challenged", judge: "review-premise", model: "opus", question: "Should the timeline mirror?" });
    expect(findings[0]?.severity).toBe("major");
    expect(scope).toContain("premise_claims_received: 1");
    expect(scope).toContain("### Held for the operator (premise)");
    expect(scope).toContain(ID);
    expect(result.premise).toMatchObject({ claims: 1, applied: 1, challenged: 1, held: 1 });
    expect(JSON.parse(await readFile(path.join(root, result.path, PREMISES_FILE), "utf8"))).toEqual(premises);
    expect(PREMISES_FILE).toBe(path.join("research-evidence", "premises.json"));
  });

  test("the persisted record passes review-finding.schema.json (the ingest validates it before writing)", async () => {
    const { findings } = await ingest({ premises: { judge: "review-premise", premises: [claim({ finding_id: ID, verdict: "downgraded", severity: "minor", practice_sources: [SOURCE], reasoning: "r" })] } });
    expect(await validateJson(findings[0], await loadSchema("review-finding"))).toEqual([]);
  });

  test("a downgrade is the severity on the record, and the original is kept beside it", async () => {
    const { findings } = await ingest({ premises: { judge: "review-premise", premises: [claim({ finding_id: ID, verdict: "downgraded", severity: "minor", practice_sources: [SOURCE] })] } });
    expect(findings[0]?.severity).toBe("minor");
    expect(findings[0]?.premise?.original_severity).toBe("major");
    expect(findings[0]?.problem).toBe(finding().problem);
  });

  test("a rejected claim is listed in scope.md and the finding is untouched", async () => {
    const { findings, scope, result } = await ingest({ premises: { judge: "review-layout", premises: [claim({ finding_id: ID, verdict: "downgraded", severity: "minor", practice_sources: [SOURCE] })] } });
    expect(findings[0]?.premise).toBeUndefined();
    expect(findings[0]?.severity).toBe("major");
    expect(scope).toContain("### Premise claims discarded");
    expect(scope).toContain("self-judgement");
    expect(result.premiseRejections.map((rejection) => rejection.reason)).toEqual(["self-judgement"]);
  });

  test("the claim names the canonical finding of a duplicate merge, and runs after it", async () => {
    const second = { ...finding({ reviewer: "review-frontend", id: "FE-001", severity: "minor" }), global_id: undefined, class_scope: undefined };
    const { findings, result } = await ingest({
      findings: [{ ...finding(), global_id: undefined, class_scope: { sites: ["a"], enumeration_method: "grep" } }, second],
      premises: { judge: "review-premise", premises: [claim({ finding_id: ID, verdict: "challenged", practice_sources: [SOURCE], question: "q" })] },
    });
    expect(result.duplicates).toHaveLength(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.premise?.verdict).toBe("challenged");
    expect(result.premise.held).toBe(1);
  });

  test("a finding carried into a delta round keeps the premise it had", async () => {
    const carried = { ...finding(), global_id: ID, class_scope: { sites: ["a"], enumeration_method: "grep" }, premise: { verdict: "challenged" as const, judge: "review-premise", question: "kept?" } };
    const { findings, result } = await ingest({
      findings: [carried],
      premises: { judge: "review-premise", premises: [claim({ finding_id: ID, verdict: "upheld" })] },
    });
    expect(findings[0]?.premise).toMatchObject({ verdict: "challenged", question: "kept?" });
    expect(result.premiseRejections.map((rejection) => rejection.reason)).toEqual(["already-judged"]);
  });

  test("an ingest with no premise file writes no premises.json and no premise block", async () => {
    const { root, result, scope } = await ingest();
    expect(existsSync(path.join(root, result.path, PREMISES_FILE))).toBe(false);
    expect(scope).not.toContain("## Premise check");
    expect(result.premise).toMatchObject({ claims: 0, applied: 0, held: 0 });
  });

  test("a premise file of the wrong shape refuses the ingest before a package is written", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "gd-premise-"));
    roots.push(root);
    await expect(
      createManagedReviewPackage({
        cwd: root,
        mode: "ingest",
        reviewId: "2026-10-16-bad",
        target: { kind: "report", ref: "report.md" },
        reportText: "# Round\n",
        findings: [],
        premises: [claim()] as never,
      }),
    ).rejects.toThrow(/Nothing was merged/);
    expect(existsSync(path.join(root, ".metaproject", "reviews", "2026-10-16-bad"))).toBe(false);
  });
});
