// The operator's answer to a held finding (flow 459, AC2/AC3 core).
//
// `challenged` and `owner-decision` do not dismiss anything: they hold the finding, and only an operator decision ends
// the hold. These tests cover the pure apply function, the decision store the CLI command and the shell card will write,
// and the readers that must agree once an answer exists (verdict, readiness).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPERATOR_DECISIONS_FILE,
  OPERATOR_DECISION_KINDS,
  decisionWriters,
  hasPremiseDecision,
  premiseDecisionFor,
  readOperatorDecisions,
  readPremiseDecisions,
  recordOperatorDecision,
  recordPremiseDecision,
  type PremiseQuestionDecision,
} from "./operator-decisions";
import { applyPremiseDecision, applyPremiseDecisions, awaitingOperator, premiseHoldState } from "./premise";
import { computeReadiness } from "./readiness";
import { computeVerdict } from "./verdict";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function pkg(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "premise-decision-"));
  dirs.push(dir);
  return dir;
}

const heldFinding = (over: Record<string, unknown> = {}) => ({
  id: "LY-003",
  global_id: "r1#LY-003",
  reviewer: "review-layout",
  severity: "major",
  problem: "timeline pinned LTR",
  impact: "i",
  suggested_fix: "f",
  evidence: "e",
  confidence: "high",
  premise: { verdict: "challenged", judge: "review-premise", question: "mirror it?" },
  ...over,
});

const answer = (over: Partial<PremiseQuestionDecision> = {}): PremiseQuestionDecision => ({
  kind: "premise-question",
  finding: "r1#LY-003",
  answer: "dismiss",
  reason: "platforms do not mirror media controls",
  at: "2026-10-16T12:00:00Z",
  actor: "owner",
  ...over,
});

describe("applyPremiseDecision (pure)", () => {
  test("uphold keeps the finding at its original severity and records the answer on the premise", () => {
    const before = heldFinding();
    const after = applyPremiseDecision(before, answer({ answer: "uphold", reason: "mirror it" }));
    expect(after.severity).toBe("major");
    expect(after.premise).toMatchObject({ verdict: "challenged", operator: { answer: "uphold", reason: "mirror it", actor: "owner" } });
    expect((after as { disposition?: unknown }).disposition).toBeUndefined();
    expect(before.premise).not.toHaveProperty("operator");
    expect(premiseHoldState(after)).toBe("upheld");
  });

  test("dismiss records dismissed-incorrect with the operator's reason as the evidence", () => {
    const after = applyPremiseDecision(heldFinding(), answer());
    expect((after as { disposition?: { state: string; evidence: string } }).disposition).toEqual({
      state: "dismissed-incorrect",
      evidence: "operator owner (2026-10-16T12:00:00Z) on the premise question: platforms do not mirror media controls",
    });
    expect(premiseHoldState(after)).toBe("dismissed");
  });

  test("an outcome somebody already recorded is not overwritten by a dismissal", () => {
    const disposition = { state: "acted-on", evidence: "fixed in abc1234" };
    const after = applyPremiseDecision(heldFinding({ disposition }), answer());
    expect((after as { disposition?: unknown }).disposition).toEqual(disposition);
  });

  test("a decision names a finding by global_id or by id, and any other decision leaves the finding as it was", () => {
    expect(premiseHoldState(applyPremiseDecision(heldFinding(), answer({ finding: "LY-003" })))).toBe("dismissed");
    const unrelated = heldFinding();
    expect(applyPremiseDecision(unrelated, answer({ finding: "r1#LY-999" }))).toBe(unrelated);
  });

  test("a finding that is not held is returned unchanged", () => {
    for (const premise of [undefined, { verdict: "upheld", judge: "j" }, { verdict: "downgraded", judge: "j", severity: "minor" }]) {
      const finding = heldFinding({ premise });
      expect(applyPremiseDecision(finding, answer())).toBe(finding);
    }
  });

  test("applyPremiseDecisions takes the LATEST decision per finding", () => {
    const [after] = applyPremiseDecisions([heldFinding()], [answer({ answer: "dismiss" }), answer({ answer: "uphold", reason: "changed my mind", at: "2026-10-16T13:00:00Z" })]);
    expect(premiseHoldState(after as Record<string, unknown>)).toBe("upheld");
    expect((after as { disposition?: unknown }).disposition).toBeUndefined();
  });
});

describe("hold state", () => {
  test("held without an answer is awaiting, whichever store holds the answer once it exists", () => {
    expect(premiseHoldState(heldFinding())).toBe("awaiting");
    expect(premiseHoldState(heldFinding(), [answer({ answer: "uphold" })])).toBe("upheld");
    expect(premiseHoldState(heldFinding({ premise: { verdict: "owner-decision", judge: "j", question: "q", options: ["a", "b"], operator: { answer: "dismiss", reason: "r", at: "t", actor: "a" } } }))).toBe("dismissed");
  });

  test("a finding with no premise, or an unheld one, is not held", () => {
    expect(premiseHoldState(heldFinding({ premise: undefined }))).toBe("none");
    expect(premiseHoldState(heldFinding({ premise: { verdict: "upheld", judge: "j" } }))).toBe("none");
  });

  test("awaitingOperator names the ids still open", () => {
    const records = [heldFinding(), heldFinding({ id: "LY-004", global_id: "r1#LY-004" }), heldFinding({ id: "LY-005", global_id: "r1#LY-005", premise: undefined })];
    expect(awaitingOperator(records)).toEqual(["r1#LY-003", "r1#LY-004"]);
    expect(awaitingOperator(records, [answer()])).toEqual(["r1#LY-004"]);
  });
});

describe("the decision store", () => {
  test("premise-question is a decision kind, with its own writers named for a refusal", () => {
    expect(OPERATOR_DECISION_KINDS).toContain("premise-question");
    expect(decisionWriters("premise-question", "pkg")).toContain("review_decide_premise");
    expect(decisionWriters("premise-question", "pkg")).toContain("keryx review decide-premise --package pkg");
  });

  test("records an answer, reads it back, and finds it by either key", async () => {
    const dir = await pkg();
    expect(await hasPremiseDecision(dir, "r1#LY-003")).toBe(false);
    await recordPremiseDecision(dir, answer());
    expect(await hasPremiseDecision(dir, "r1#LY-003")).toBe(true);
    const decisions = await readPremiseDecisions(dir);
    expect(decisions).toHaveLength(1);
    expect(premiseDecisionFor(decisions, undefined, "r1#LY-003")?.answer).toBe("dismiss");
    expect(premiseDecisionFor(decisions, "other")).toBeUndefined();
  });

  test("refuses a decision without an answer of uphold or dismiss, a reason, a time or an actor", async () => {
    const dir = await pkg();
    for (const bad of [{ answer: "maybe" }, { reason: "  " }, { at: "" }, { actor: "" }, { finding: "" }]) {
      await expect(recordPremiseDecision(dir, answer(bad as Partial<PremiseQuestionDecision>))).rejects.toThrow(/premise decision/);
    }
    expect(await readPremiseDecisions(dir)).toEqual([]);
  });

  test("shares the file with the gate decisions: neither writer drops the other's entries", async () => {
    const dir = await pkg();
    await recordOperatorDecision(dir, { kind: "mutation-waiver", quote: "waive it, I accept", reason: "none runnable", confirmedVia: "terminal", at: "2026-10-16T10:00:00Z" });
    await recordPremiseDecision(dir, answer());
    await recordOperatorDecision(dir, { kind: "reviewer-override", quote: "smaller set", reason: "docs only", confirmedVia: "terminal", at: "2026-10-16T11:00:00Z" });
    const file = JSON.parse(await readFile(path.join(dir, OPERATOR_DECISIONS_FILE), "utf8")) as { decisions: Array<{ kind: string }> };
    expect(file.decisions.map((entry) => entry.kind)).toEqual(["mutation-waiver", "premise-question", "reviewer-override"]);
    expect((await readOperatorDecisions(dir)).map((entry) => entry.kind)).toEqual(["mutation-waiver", "reviewer-override"]);
    expect(await readPremiseDecisions(dir)).toHaveLength(1);
  });

  test("a premise record is never read as a gate decision, even with the fields of one", async () => {
    const dir = await pkg();
    await writeFile(
      path.join(dir, OPERATOR_DECISIONS_FILE),
      JSON.stringify({ schemaVersion: 1, decisions: [{ kind: "premise-question", quote: "q", reason: "r", confirmedVia: "terminal", at: "t" }] }),
    );
    expect(await readOperatorDecisions(dir)).toEqual([]);
  });
});

describe("after the answer, the readers agree", () => {
  async function held(): Promise<string> {
    const dir = await pkg();
    await mkdir(path.join(dir, "raw"), { recursive: true });
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, reviewId: "r1", mode: "ingest", status: "draft", target: { kind: "report", ref: "r.md" }, artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" }, coverage: [] }),
    );
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([heldFinding()]));
    return dir;
  }
  const readiness = async (dir: string) => (await computeReadiness(dir)).items.find((item) => item.id === "premise-decisions");

  test("readiness fails before and passes after, for uphold and for dismiss alike", async () => {
    for (const choice of ["uphold", "dismiss"] as const) {
      const dir = await held();
      expect((await readiness(dir))?.status).toBe("fail");
      await recordPremiseDecision(dir, answer({ answer: choice }));
      expect((await readiness(dir))?.status).toBe("pass");
    }
  });

  test("the verdict lists the finding as awaiting before, as open after an uphold, and as dismissed after a dismiss", async () => {
    const dir = await held();
    expect((await computeVerdict(dir)).held.map((entry) => entry.id)).toEqual(["LY-003"]);
    await recordPremiseDecision(dir, answer({ answer: "uphold", reason: "mirror it" }));
    const upheld = await computeVerdict(dir);
    expect(upheld.held).toEqual([]);
    expect(upheld.open.map((entry) => entry.id)).toEqual(["LY-003"]);

    const other = await held();
    await recordPremiseDecision(other, answer());
    const dismissed = await computeVerdict(other);
    expect(dismissed.open).toEqual([]);
    expect(dismissed.dismissed).toBe(1);
  });
});
