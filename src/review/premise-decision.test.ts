// The operator's answer to a held finding (flow 459, AC2/AC3 core).
//
// `challenged` and `owner-decision` do not dismiss anything: they hold the finding, and only an operator decision ends
// the hold. These tests cover the pure apply function, the decision store the CLI command and the shell card write,
// the answer command that writes both files, and the readers that must agree once an answer exists (verdict,
// readiness, the round-to-round carry).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPERATOR_DECISIONS_FILE,
  OPERATOR_DECISION_KINDS,
  PREMISE_DECISION_KIND,
  decisionWriters,
  readOperatorDecisions,
  readPremiseDecisions,
  recordOperatorDecision,
  recordPremiseDecision,
} from "./operator-decisions";
import { applyPremiseDecision, applyPremiseDecisions, awaitingOperator, latestPremiseDecision, premiseHoldState } from "./premise";
import { heldFinding, premiseAnswer, premiseAnswerInput } from "./premise-fixtures";
import { answerPremiseQuestion, carryPremiseDecisions, findHeldFinding } from "./premise-question";
import { computeReadiness } from "./readiness";
import { findingStatus } from "./round-record";
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

describe("carryPremiseDecisions (a delta round does not ask again)", () => {
  async function previousWith(finding: Record<string, unknown>, answer: "uphold" | "dismiss" = "uphold"): Promise<string> {
    const previous = await pkg();
    await writeFile(path.join(previous, "findings.json"), JSON.stringify([finding]));
    await recordPremiseDecision(previous, premiseAnswerInput(finding, { answer, reason: "keep it" }));
    return previous;
  }

  test("an upheld answer lands in the new package as carried from the previous one, and the finding is not awaiting", async () => {
    const finding = heldFinding();
    const previous = await previousWith(finding);
    const next = await pkg();
    expect(await carryPremiseDecisions(next, previous, ["LY-003"], "reviews/r1")).toEqual(["r1#LY-003"]);
    const [carried] = await readPremiseDecisions(next);
    expect(carried).toMatchObject({ answer: "uphold", carriedFrom: "reviews/r1", actor: "operator", confirmedVia: "terminal" });
    expect(premiseHoldState(finding, await readPremiseDecisions(next))).toBe("upheld");
    expect(await carryPremiseDecisions(next, previous, ["LY-003"], "reviews/r1")).toEqual([]);
    expect(await readPremiseDecisions(next)).toHaveLength(1);
  });

  test("a finding the round did not carry carries no answer", async () => {
    const previous = await previousWith(heldFinding());
    const next = await pkg();
    expect(await carryPremiseDecisions(next, previous, ["LY-999"], "reviews/r1")).toEqual([]);
    expect(await readPremiseDecisions(next)).toEqual([]);
  });

  test("a changed subject does not carry: the answer was given for another problem, and the new finding asks again", async () => {
    const finding = heldFinding();
    const previous = await pkg();
    // The package holds an answer bound to a problem the finding no longer states.
    await writeFile(path.join(previous, "findings.json"), JSON.stringify([{ ...finding, problem: "a different problem" }]));
    await recordPremiseDecision(previous, premiseAnswerInput(finding, { answer: "uphold", reason: "keep it" }));
    const next = await pkg();
    expect(await carryPremiseDecisions(next, previous, ["LY-003"], "reviews/r1")).toEqual([]);
    // And a carried answer never answers a finding whose problem changed in the new round.
    const upheld = await previousWith(finding);
    const copied = await pkg();
    await carryPremiseDecisions(copied, upheld, ["LY-003"], "reviews/r1");
    expect(premiseHoldState({ ...finding, problem: "rewritten in round 2" }, await readPremiseDecisions(copied))).toBe("awaiting");
  });
});

type Disposition = { state: string; evidence: string } | undefined;
const disposition = (finding: unknown): Disposition => (finding as { disposition?: Disposition }).disposition;

describe("applyPremiseDecision (pure)", () => {
  test("uphold keeps the finding at its original severity and records the answer on the premise", () => {
    const before = heldFinding();
    const after = applyPremiseDecision(before, premiseAnswer(before, { answer: "uphold", reason: "mirror it" }));
    expect(after.severity).toBe("major");
    expect(after.premise).toMatchObject({ verdict: "challenged", operator: { answer: "uphold", reason: "mirror it", actor: "operator", quote: "yes, dismiss it", confirmedVia: "terminal" } });
    expect(disposition(after)).toBeUndefined();
    expect(before.premise).not.toHaveProperty("operator");
  });

  test("dismiss records dismissed-incorrect with the operator's reason as the evidence", () => {
    const after = applyPremiseDecision(heldFinding(), premiseAnswer());
    expect(disposition(after)).toEqual({
      state: "dismissed-incorrect",
      evidence: "operator (terminal, 2026-10-16T12:00:00Z) on the premise question: platforms do not mirror media controls",
    });
  });

  test("an outcome somebody already recorded is not overwritten by a dismissal", () => {
    const outcome = { state: "acted-on", evidence: "fixed in abc1234" };
    const after = applyPremiseDecision(heldFinding({ disposition: outcome }), premiseAnswer());
    expect(disposition(after)).toEqual(outcome);
  });

  test("a later uphold replaces the dismissal an earlier answer wrote", () => {
    const dismissed = applyPremiseDecision(heldFinding(), premiseAnswer());
    const upheld = applyPremiseDecision(dismissed, premiseAnswer(heldFinding(), { answer: "uphold", at: "2026-10-16T13:00:00Z" }));
    expect(disposition(upheld)).toBeUndefined();
    expect((upheld.premise as { operator: { answer: string } }).operator.answer).toBe("uphold");
  });

  test("a decision names a finding by global_id or by id, and any other decision leaves the finding as it was", () => {
    expect(disposition(applyPremiseDecision(heldFinding(), premiseAnswer(heldFinding(), { finding: "LY-003" })))?.state).toBe("dismissed-incorrect");
    const unrelated = heldFinding();
    expect(applyPremiseDecision(unrelated, premiseAnswer(heldFinding(), { finding: "r1#LY-999" }))).toBe(unrelated);
  });

  test("a decision given for what the finding was before it changed answers nothing", () => {
    const answer = premiseAnswer();
    for (const changed of [heldFinding({ severity: "blocker" }), heldFinding({ problem: "a different defect under the same id" }), heldFinding({ premise: { verdict: "owner-decision", judge: "j", question: "q", options: ["a", "b"] } })]) {
      expect(applyPremiseDecision(changed, answer)).toBe(changed);
      expect(premiseHoldState(changed, [answer])).toBe("awaiting");
    }
  });

  test("a finding that is not held is returned unchanged", () => {
    for (const premise of [undefined, { verdict: "upheld", judge: "j" }, { verdict: "downgraded", judge: "j", severity: "minor" }]) {
      const finding = heldFinding({ premise });
      expect(applyPremiseDecision(finding, premiseAnswer())).toBe(finding);
    }
  });

  test("applyPremiseDecisions takes the LATEST decision per finding", () => {
    const [after] = applyPremiseDecisions([heldFinding()], [premiseAnswer(), premiseAnswer(heldFinding(), { answer: "uphold", reason: "changed my mind", at: "2026-10-16T13:00:00Z" })]);
    expect((after?.premise as { operator: { answer: string } }).operator.answer).toBe("uphold");
    expect(disposition(after)).toBeUndefined();
  });
});

describe("hold state", () => {
  test("held without an answer is awaiting; the decisions store answers it", () => {
    expect(premiseHoldState(heldFinding())).toBe("awaiting");
    expect(premiseHoldState(heldFinding(), [premiseAnswer(heldFinding(), { answer: "uphold" })])).toBe("upheld");
    expect(premiseHoldState(heldFinding(), [premiseAnswer()])).toBe("dismissed");
  });

  test("an answer written onto the record is not an operator decision: only the decisions store is", () => {
    const written = heldFinding({ premise: { verdict: "owner-decision", judge: "j", question: "q", options: ["a", "b"], operator: { answer: "dismiss", reason: "r", at: "t", actor: "a" } } });
    expect(premiseHoldState(written)).toBe("awaiting");
  });

  test("a held finding that already has another outcome waits for nobody, as the verdict classifies it", () => {
    expect(premiseHoldState(heldFinding({ disposition: { state: "dismissed-out-of-scope", evidence: "not this PR" } }))).toBe("none");
    expect(premiseHoldState(heldFinding({ disposition: { state: "acted-on", evidence: "abc1234" } }))).toBe("none");
    expect(premiseHoldState(heldFinding({ verification: { verdict: "refuted" } }))).toBe("none");
  });

  test("a finding with no premise, or an unheld one, is not held", () => {
    expect(premiseHoldState(heldFinding({ premise: undefined }))).toBe("none");
    expect(premiseHoldState(heldFinding({ premise: { verdict: "upheld", judge: "j" } }))).toBe("none");
  });

  test("awaitingOperator names the ids still open", () => {
    const records = [heldFinding(), heldFinding({ id: "LY-004", global_id: "r1#LY-004" }), heldFinding({ id: "LY-005", global_id: "r1#LY-005", premise: undefined })];
    expect(awaitingOperator(records)).toEqual(["r1#LY-003", "r1#LY-004"]);
    expect(awaitingOperator(records, [premiseAnswer()])).toEqual(["r1#LY-004"]);
  });
});

describe("the decision store", () => {
  test("premise-question is its own record family, with its own writers named for a refusal", () => {
    expect(OPERATOR_DECISION_KINDS).not.toContain(PREMISE_DECISION_KIND);
    expect(decisionWriters(PREMISE_DECISION_KIND, "pkg")).toContain("review_decide_premise");
    expect(decisionWriters(PREMISE_DECISION_KIND, "pkg")).toContain("keryx review decide-premise --package pkg");
  });

  test("records an answer with the one actor convention, and finds it by either key", async () => {
    const dir = await pkg();
    const kept = await recordPremiseDecision(dir, premiseAnswerInput());
    expect(kept.actor).toBe("operator");
    const decisions = await readPremiseDecisions(dir);
    expect(decisions).toHaveLength(1);
    expect(latestPremiseDecision(heldFinding({ global_id: undefined }), decisions)).toBeUndefined();
    expect(latestPremiseDecision(heldFinding(), decisions)?.answer).toBe("dismiss");
    expect(latestPremiseDecision(heldFinding({ global_id: "other", id: "other" }), decisions)).toBeUndefined();
  });

  test("refuses a decision without an answer of uphold or dismiss, a reason, the operator's words, a time, how it was confirmed or a subject", async () => {
    const dir = await pkg();
    const bads: Array<Record<string, unknown>> = [{ answer: "maybe" }, { reason: "  " }, { quote: "" }, { at: "" }, { finding: "" }, { confirmedVia: undefined }, { confirmedVia: "agent" }, { subject: undefined }];
    for (const bad of bads) {
      await expect(recordPremiseDecision(dir, { ...premiseAnswerInput(), ...bad } as never)).rejects.toThrow(/premise decision/);
    }
    expect(await readPremiseDecisions(dir)).toEqual([]);
  });

  test("an entry without confirmedVia, the operator's words or a subject is not read as a decision (readiness stays failing)", async () => {
    const dir = await pkg();
    const { confirmedVia: _via, ...noVia } = premiseAnswer();
    const { quote: _quote, ...noQuote } = premiseAnswer();
    const { subject: _subject, ...noSubject } = premiseAnswer();
    await writeFile(path.join(dir, OPERATOR_DECISIONS_FILE), JSON.stringify({ schemaVersion: 1, decisions: [noVia, noQuote, noSubject] }));
    expect(await readPremiseDecisions(dir)).toEqual([]);
  });

  test("shares the file with the gate decisions: neither writer drops the other's entries", async () => {
    const dir = await pkg();
    await recordOperatorDecision(dir, { kind: "mutation-waiver", quote: "waive it, I accept", reason: "none runnable", confirmedVia: "terminal", at: "2026-10-16T10:00:00Z" });
    await recordPremiseDecision(dir, premiseAnswerInput());
    await recordOperatorDecision(dir, { kind: "reviewer-override", quote: "smaller set", reason: "docs only", confirmedVia: "terminal", at: "2026-10-16T11:00:00Z" });
    const file = JSON.parse(await readFile(path.join(dir, OPERATOR_DECISIONS_FILE), "utf8")) as { decisions: Array<{ kind: string }> };
    expect(file.decisions.map((entry) => entry.kind)).toEqual(["mutation-waiver", "premise-question", "reviewer-override"]);
    expect((await readOperatorDecisions(dir)).map((entry) => entry.kind)).toEqual(["mutation-waiver", "reviewer-override"]);
    expect(await readPremiseDecisions(dir)).toHaveLength(1);
  });

  test("concurrent writers all land: the read-modify-write runs under the package lock", async () => {
    const dir = await pkg();
    const answers = Array.from({ length: 8 }, (_, index) => recordPremiseDecision(dir, premiseAnswerInput(heldFinding(), { reason: `answer ${index}` })));
    const waivers = Array.from({ length: 4 }, (_, index) =>
      recordOperatorDecision(dir, { kind: "mutation-waiver", quote: `waive ${index}`, reason: "none runnable", confirmedVia: "terminal", at: "2026-10-16T10:00:00Z" }),
    );
    await Promise.all([...answers, ...waivers]);
    expect((await readPremiseDecisions(dir)).map((entry) => entry.reason).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `answer ${index}`).sort());
    expect(await readOperatorDecisions(dir)).toHaveLength(4);
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

describe("findHeldFinding: the hold is the finding record's, never a raw claim", () => {
  test("a claim the merge rejected, still on file in premises.json, is not a held finding", async () => {
    const dir = await pkg();
    // The record carries no premise: ingest rejected the self-judged claim below, and premises.json keeps it as received.
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([heldFinding({ premise: undefined })]));
    await mkdir(path.join(dir, "research-evidence"), { recursive: true });
    await writeFile(
      path.join(dir, "research-evidence", "premises.json"),
      JSON.stringify({ judge: "review-layout", premises: [{ finding_id: "r1#LY-003", verdict: "challenged", intent_signals: [{ ref: "a:1", says: "x" }], question: "q" }] }),
    );
    const lookup = await findHeldFinding(dir, "r1#LY-003");
    expect(lookup.ok).toBe(false);
    expect(lookup.ok ? "" : lookup.refusal).toContain("is not held");
  });

  test("shows the answered state and a digest that changes with what was shown", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([heldFinding()]));
    const before = await findHeldFinding(dir, "LY-003");
    if (!before.ok) throw new Error(before.refusal);
    expect(before.finding.answered).toBeUndefined();
    await answerPremiseQuestion(dir, { finding: before.finding, answer: "dismiss", reason: "platforms do not mirror it", quote: "dismiss it", at: "2026-10-16T12:00:00Z", confirmedVia: "terminal" });
    const after = await findHeldFinding(dir, "LY-003");
    if (!after.ok) throw new Error(after.refusal);
    expect(after.finding.answered).toBe("dismiss");
    expect(after.finding.digest).not.toBe(before.finding.digest);
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
  async function answer(dir: string, choice: "uphold" | "dismiss"): Promise<void> {
    const lookup = await findHeldFinding(dir, "r1#LY-003");
    if (!lookup.ok) throw new Error(lookup.refusal);
    await answerPremiseQuestion(dir, { finding: lookup.finding, answer: choice, reason: "platforms do not mirror it", quote: `${choice} it`, at: "2026-10-16T12:00:00Z", confirmedVia: "terminal" });
  }
  const records = async (dir: string) => JSON.parse(await readFile(path.join(dir, "findings.json"), "utf8")) as Array<Record<string, unknown>>;

  test("readiness fails before and passes after, for uphold and for dismiss alike", async () => {
    for (const choice of ["uphold", "dismiss"] as const) {
      const dir = await held();
      expect((await readiness(dir))?.status).toBe("fail");
      await answer(dir, choice);
      expect((await readiness(dir))?.status).toBe("pass");
    }
  });

  test("the verdict lists the finding as awaiting before, as open after an uphold, and as dismissed after a dismiss", async () => {
    const dir = await held();
    expect((await computeVerdict(dir)).held.map((entry) => entry.id)).toEqual(["LY-003"]);
    await answer(dir, "uphold");
    const upheld = await computeVerdict(dir);
    expect(upheld.held).toEqual([]);
    expect(upheld.open.map((entry) => entry.id)).toEqual(["LY-003"]);

    const other = await held();
    await answer(other, "dismiss");
    const dismissed = await computeVerdict(other);
    expect(dismissed.open).toEqual([]);
    expect(dismissed.dismissed).toBe(1);
  });

  test("the answer reaches findings.json, so the round-to-round carry and the round block see it (not `open`)", async () => {
    const dir = await held();
    expect(findingStatus((await records(dir))[0])).toBe("open");
    await answer(dir, "dismiss");
    const [dismissed] = await records(dir);
    expect(findingStatus(dismissed)).toBe("dismissed-incorrect");
    expect((dismissed?.premise as { operator: { answer: string; quote: string } }).operator).toMatchObject({ answer: "dismiss", quote: "dismiss it" });

    // Changing the answer to uphold puts the finding back into the next round as open.
    await answer(dir, "uphold");
    expect(findingStatus((await records(dir))[0])).toBe("open");
  });

  test("readiness and the verdict read one view on a raw package too: a held claim in premises.json holds for both", async () => {
    const dir = await pkg();
    await mkdir(path.join(dir, "raw"), { recursive: true });
    await mkdir(path.join(dir, "research-evidence"), { recursive: true });
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, reviewId: "r1", mode: "ingest", status: "draft", target: { kind: "report", ref: "r.md" }, artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" }, coverage: [] }),
    );
    const result = { reviewer: "review-layout", status: "DONE", findings: [{ id: "LY-2", severity: "major", problem: "timeline pinned LTR" }] };
    await writeFile(path.join(dir, "raw", "review-layout.txt"), `done\n\`\`\`REVIEW_RESULT\n${JSON.stringify(result)}\n\`\`\`\n`);
    await writeFile(
      path.join(dir, "research-evidence", "premises.json"),
      JSON.stringify({ judge: "review-premise", premises: [{ finding_id: "LY-2", verdict: "challenged", practice_sources: [{ name: "Material", says: "do not mirror" }], question: "mirror it?" }] }),
    );
    expect((await computeVerdict(dir)).held.map((entry) => entry.id)).toEqual(["LY-2"]);
    expect((await readiness(dir))?.status).toBe("fail");
  });
});
