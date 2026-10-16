// The operator's answer to a held finding (flow 459, AC2/AC3 core).
//
// `challenged` and `owner-decision` do not dismiss anything: they hold the finding, and only an operator decision ends
// the hold. These tests cover the pure apply function, the decision store the CLI command and the shell card write,
// the answer command that writes both files, and the readers that must agree once an answer exists (verdict,
// readiness, the round-to-round carry).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  OPERATOR_DECISIONS_FILE,
  OPERATOR_DECISION_KINDS,
  PREMISE_DECISION_KIND,
  decisionWriters,
  foldFileName,
  readOperatorDecisions,
  readPremiseDecisions,
  recordOperatorDecision,
  recordPremiseDecision,
  recordPremiseDecisionAfter,
} from "./operator-decisions";
import { applyPremiseDecision, applyPremiseDecisions, awaitingOperator, latestPremiseDecision, premiseHoldState } from "./premise";
import { heldFinding, premiseAnswer, premiseAnswerInput } from "./premise-fixtures";
import { isReviewPackageDir } from "./package-location";
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
  /** A checkout with review packages under `.metaproject/reviews/`, where `--prior` and the round search find them. */
  async function checkout(): Promise<{ root: string; review: (id: string, findings?: unknown[]) => Promise<string> }> {
    const root = await pkg();
    const review = async (id: string, findings: unknown[] = []): Promise<string> => {
      const dir = path.join(root, ".metaproject", "reviews", id);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ reviewId: id }));
      await writeFile(path.join(dir, "findings.json"), JSON.stringify(findings));
      return dir;
    };
    return { root, review };
  }
  async function previousWith(finding: Record<string, unknown>, answer: "uphold" | "dismiss" = "uphold"): Promise<{ root: string; previous: string; next: string }> {
    const { root, review } = await checkout();
    const previous = await review("r1", [finding]);
    await recordPremiseDecision(previous, premiseAnswerInput(finding, { answer, reason: "keep it" }));
    return { root, previous, next: await review("r2") };
  }

  test("an upheld answer lands in the new package as carried from the previous one, and the finding is not awaiting", async () => {
    const finding = heldFinding();
    const { root, previous, next } = await previousWith(finding);
    expect(await carryPremiseDecisions(next, previous, ["LY-003"], "reviews/r1", { projectRoot: root })).toEqual(["r1#LY-003"]);
    const [carried] = await readPremiseDecisions(next);
    expect(carried).toMatchObject({ answer: "uphold", carriedFrom: "reviews/r1", actor: "operator", confirmedVia: "terminal" });
    expect(premiseHoldState(finding, await readPremiseDecisions(next))).toBe("upheld");
    expect(await carryPremiseDecisions(next, previous, ["LY-003"], "reviews/r1", { projectRoot: root })).toEqual([]);
    expect(await readPremiseDecisions(next)).toHaveLength(1);
  });

  test("an answer carried into round 2 travels on into round 3 while the finding is unchanged", async () => {
    const finding = heldFinding();
    const { root, previous, next } = await previousWith(finding);
    await writeFile(path.join(next, "findings.json"), JSON.stringify([finding]));
    await carryPremiseDecisions(next, previous, ["LY-003"], "reviews/r1", { projectRoot: root });
    const third = path.join(root, ".metaproject", "reviews", "r3");
    await mkdir(third, { recursive: true });
    expect(await carryPremiseDecisions(third, next, ["LY-003"], "reviews/r2", { projectRoot: root })).toEqual(["r1#LY-003"]);
  });

  test("a finding the round did not carry carries no answer", async () => {
    const { root, previous, next } = await previousWith(heldFinding());
    expect(await carryPremiseDecisions(next, previous, ["LY-999"], "reviews/r1", { projectRoot: root })).toEqual([]);
    expect(await readPremiseDecisions(next)).toEqual([]);
  });

  test("a changed subject does not carry: the answer was given for another problem, and the new finding asks again", async () => {
    const finding = heldFinding();
    const { root, review } = await checkout();
    // The package holds an answer bound to a problem the finding no longer states.
    const previous = await review("r1", [{ ...finding, problem: "a different problem" }]);
    await recordPremiseDecision(previous, premiseAnswerInput(finding, { answer: "uphold", reason: "keep it" }));
    const next = await review("r2");
    expect(await carryPremiseDecisions(next, previous, ["LY-003"], "reviews/r1", { projectRoot: root })).toEqual([]);
    // And a carried answer never answers a finding whose problem changed in the new round.
    const upheld = await previousWith(finding);
    await carryPremiseDecisions(upheld.next, upheld.previous, ["LY-003"], "reviews/r1", { projectRoot: upheld.root });
    expect(premiseHoldState({ ...finding, problem: "rewritten in round 2" }, await readPremiseDecisions(upheld.next))).toBe("awaiting");
  });

  test("a directory nested inside a package is not a decision source, nor a symlink to one, nor a dir outside the reviews roots (review SEC2-001)", async () => {
    const finding = heldFinding();
    const { root, review } = await checkout();
    const next = await review("r2");
    // What an agent can write without asking: a directory inside the bound package, with a manifest and decisions.
    const nested = path.join(next, "x");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "manifest.json"), JSON.stringify({ reviewId: "x" }));
    await writeFile(path.join(nested, "findings.json"), JSON.stringify([finding]));
    await writeFile(path.join(nested, OPERATOR_DECISIONS_FILE), JSON.stringify({ schemaVersion: 1, decisions: [premiseAnswer(finding, { answer: "uphold" })] }));
    expect(isReviewPackageDir(nested, root)).toBe(false);
    expect(await carryPremiseDecisions(next, nested, ["LY-003"], "reviews/r2/x", { projectRoot: root })).toEqual([]);
    const link = path.join(root, ".metaproject", "reviews", "looks-real");
    await symlink(nested, link);
    expect(isReviewPackageDir(link, root)).toBe(false);
    expect(await carryPremiseDecisions(next, link, ["LY-003"], "reviews/looks-real", { projectRoot: root })).toEqual([]);
    const elsewhere = path.join(root, "tmp-pkg");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "manifest.json"), "{}");
    expect(isReviewPackageDir(elsewhere, root)).toBe(false);
    expect(await readPremiseDecisions(next)).toEqual([]);
    // The package itself is never its own previous round.
    expect(await carryPremiseDecisions(next, next, ["LY-003"], "reviews/r2", { projectRoot: root })).toEqual([]);
  });

  test("a package under a flow's reviews root is a real package; one nested in it, one in a flows/reviews dir, or one reached by `..` outside the layout is not (review T4-003)", async () => {
    const root = await pkg();
    const manifestAt = async (...segments: string[]): Promise<string> => {
      const dir = path.join(root, ...segments);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "manifest.json"), "{}");
      return dir;
    };
    const flowPackage = await manifestAt(".metaproject", "flows", "f1", "reviews", "r1");
    expect(isReviewPackageDir(flowPackage, root)).toBe(true);
    expect(isReviewPackageDir(await manifestAt(".metaproject", "flows", "f1", "reviews", "r1", "x"), root)).toBe(false);
    expect(isReviewPackageDir(await manifestAt(".metaproject", "flows", "reviews", "r1"), root)).toBe(false);
    await manifestAt("reviews", "r1");
    expect(isReviewPackageDir(path.join(root, ".metaproject", "flows", "..", "..", "reviews", "r1"), root)).toBe(false);
  });

  test("a forged record in the previous package is re-validated and not carried: incomplete, or for a finding that is not held", async () => {
    const finding = heldFinding();
    const unheld = heldFinding({ id: "LY-004", global_id: "r1#LY-004", premise: { verdict: "upheld", judge: "review-premise" } });
    const { root, review } = await checkout();
    const { confirmedVia: _via, ...unconfirmed } = premiseAnswer(finding, { answer: "uphold", carriedFrom: "reviews/r0" });
    const previous = await review("r1", [finding, unheld]);
    await writeFile(path.join(previous, OPERATOR_DECISIONS_FILE), JSON.stringify({ schemaVersion: 1, decisions: [unconfirmed, premiseAnswer(unheld, { answer: "uphold" })] }));
    const next = await review("r2");
    expect(await carryPremiseDecisions(next, previous, ["LY-003", "LY-004"], "reviews/r1", { projectRoot: root })).toEqual([]);
    expect(await readPremiseDecisions(next)).toEqual([]);
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

  test("a held finding the verifier refuted, or that was acted on, waits for nobody, as the verdict classifies it", () => {
    expect(premiseHoldState(heldFinding({ disposition: { state: "acted-on", evidence: "abc1234" } }))).toBe("none");
    expect(premiseHoldState(heldFinding({ verification: { verdict: "refuted" } }))).toBe("none");
  });

  test("a dismissal written into findings.json does not lift a hold: only the operator's decisions store does (review SEC2-002)", async () => {
    for (const state of ["dismissed-out-of-scope", "dismissed-wont-fix", "dismissed-deprioritised", "dismissed-incorrect"]) {
      const written = heldFinding({ disposition: { state, evidence: "the owner decided: not this PR" } });
      expect(premiseHoldState(written)).toBe("awaiting");
      expect(premiseHoldState(written, [premiseAnswer(written)])).toBe("dismissed");
    }
    // The verdict and readiness read the same rule: held, not dismissed, and item 11 still fails.
    const dir = await pkg();
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, reviewId: "r1", mode: "ingest", status: "draft", target: { kind: "report", ref: "r.md" }, artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" }, coverage: [] }),
    );
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([heldFinding({ disposition: { state: "dismissed-wont-fix", evidence: "the owner decided" } })]));
    const verdict = await computeVerdict(dir);
    expect(verdict.held.map((entry) => entry.id)).toEqual(["LY-003"]);
    expect(verdict.dismissed).toBe(0);
    expect((await computeReadiness(dir)).items.find((item) => item.id === "premise-decisions")?.status).toBe("fail");
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

  test("folds a file name the way a case-insensitive filesystem may compare it (review SEC3-001)", () => {
    for (const name of ["operator-deciſions.json", "operator-decısions.json", "OPERATOR-DECISIONS.JSON", "ｏperator-decisions.json", "operator-decisions.json".normalize("NFD")]) {
      expect(foldFileName(name)).toBe("operator-decisions.json");
    }
    expect(foldFileName(".operator-decisions.locK")).toBe(".operator-decisions.lock");
    expect(foldFileName("operator-décisions.json")).toBe(foldFileName("operator-décisions.json"));
  });

  test("the store is read by its exact name only: a planted look-alike alone is not the store (review SEC3-001)", async () => {
    const dir = await pkg();
    const lookalike = path.join(dir, "operator-deciſions.json");
    await writeFile(lookalike, JSON.stringify({ schemaVersion: 1, decisions: [premiseAnswer()] }));
    // Whether the volume folds the two names or not, the agent's file is never read as the operator's decisions.
    await expect(readPremiseDecisions(dir)).rejects.toThrow(/may read as operator-decisions\.json/);
    await expect(recordPremiseDecision(dir, premiseAnswerInput())).rejects.toThrow(/remove the look-alike/);
    expect(JSON.parse(await readFile(lookalike, "utf8"))).toEqual({ schemaVersion: 1, decisions: [premiseAnswer()] });
  });

  test("a look-alike next to the real store refuses every read and write until it is removed (review SEC3-001)", async () => {
    const dir = await pkg();
    await recordPremiseDecision(dir, premiseAnswerInput());
    // Full-width o: NFKC folds it onto the store's name; no common filesystem treats the two as one file, so both exist.
    const lookalike = path.join(dir, "ｏperator-decisions.json");
    await writeFile(lookalike, JSON.stringify({ schemaVersion: 1, decisions: [premiseAnswer(heldFinding(), { answer: "uphold" })] }));
    await expect(readPremiseDecisions(dir)).rejects.toThrow(/ｏperator-decisions\.json/);
    await expect(readOperatorDecisions(dir)).rejects.toThrow(/look-alike/);
    await expect(recordPremiseDecision(dir, premiseAnswerInput(heldFinding(), { answer: "uphold" }))).rejects.toThrow(/look-alike/);
    await rm(lookalike);
    expect((await readPremiseDecisions(dir)).map((entry) => entry.answer)).toEqual(["dismiss"]);
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

  test("an id two findings share is refused, naming each by its global_id", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([heldFinding(), heldFinding({ global_id: "r1#LY-003-b", reviewer: "review-logic" })]));
    const lookup = await findHeldFinding(dir, "LY-003");
    expect(lookup.ok).toBe(false);
    expect(lookup.ok ? "" : lookup.refusal).toContain("names 2 findings (r1#LY-003, r1#LY-003-b)");
    expect((await findHeldFinding(dir, "r1#LY-003-b")).ok).toBe(true);
  });

  test("a decision write that fails restores findings.json: the two files never disagree (review HL2-003)", async () => {
    const dir = await pkg();
    const original = `${JSON.stringify([heldFinding()], null, 2)}\n`;
    await writeFile(path.join(dir, "findings.json"), original);
    const lookup = await findHeldFinding(dir, "LY-003");
    if (!lookup.ok) throw new Error(lookup.refusal);
    // A directory where the decisions file should be: the append fails after findings.json was rewritten.
    await mkdir(path.join(dir, OPERATOR_DECISIONS_FILE));
    const inodeBefore = (await stat(path.join(dir, "findings.json"))).ino;
    await expect(answerPremiseQuestion(dir, { finding: lookup.finding, answer: "dismiss", reason: "r", quote: "dismiss it", at: "2026-10-16T12:00:00Z", confirmedVia: "terminal" })).rejects.toThrow();
    // The rewrite did happen (an atomic write replaces the file, so the inode is new) and was then undone.
    expect((await stat(path.join(dir, "findings.json"))).ino).not.toBe(inodeBefore);
    expect(await readFile(path.join(dir, "findings.json"), "utf8")).toBe(original);
    // And the decision itself was not recorded: the store still holds no answer, so the finding is still awaiting.
    await rm(path.join(dir, OPERATOR_DECISIONS_FILE), { recursive: true });
    expect(await readPremiseDecisions(dir)).toEqual([]);
    expect(premiseHoldState(heldFinding(), await readPremiseDecisions(dir))).toBe("awaiting");
  });

  test("an append that fails runs the undo of the step before it, and returns no applied value", async () => {
    const dir = await pkg();
    await mkdir(path.join(dir, OPERATOR_DECISIONS_FILE));
    const steps: string[] = [];
    await expect(
      recordPremiseDecisionAfter(dir, premiseAnswerInput(), async () => {
        steps.push("applied");
        return { undo: async () => void steps.push("undone"), value: true };
      }),
    ).rejects.toThrow();
    expect(steps).toEqual(["applied", "undone"]);
    await rm(path.join(dir, OPERATOR_DECISIONS_FILE), { recursive: true });
    const landed = await recordPremiseDecisionAfter(dir, premiseAnswerInput(), async () => ({ undo: async () => void steps.push("wrong"), value: 7 }));
    expect(landed.applied).toBe(7);
    expect(steps).toEqual(["applied", "undone"]);
    expect(await readPremiseDecisions(dir)).toHaveLength(1);
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

  test("with two answers on file, every reader takes the later one (review testing F-001)", async () => {
    const dir = await held();
    const finding = heldFinding();
    await recordPremiseDecision(dir, premiseAnswerInput(finding, { answer: "dismiss", at: "2026-10-16T12:00:00Z" }));
    await recordPremiseDecision(dir, premiseAnswerInput(finding, { answer: "uphold", reason: "changed my mind", at: "2026-10-16T13:00:00Z" }));
    const decisions = await readPremiseDecisions(dir);
    expect(decisions.map((entry) => entry.answer)).toEqual(["dismiss", "uphold"]);
    expect(latestPremiseDecision(finding, decisions)?.answer).toBe("uphold");
    expect(premiseHoldState(finding, decisions)).toBe("upheld");
    const verdict = await computeVerdict(dir);
    expect(verdict.open.map((entry) => entry.id)).toEqual(["LY-003"]);
    expect(verdict.dismissed).toBe(0);
    expect((await readiness(dir))?.status).toBe("pass");
    // And the other way round: a later dismiss ends the finding.
    await recordPremiseDecision(dir, premiseAnswerInput(finding, { answer: "dismiss", reason: "on reflection", at: "2026-10-16T14:00:00Z" }));
    expect(premiseHoldState(finding, await readPremiseDecisions(dir))).toBe("dismissed");
    expect((await computeVerdict(dir)).dismissed).toBe(1);
  });

  test("readiness item 11 before an ingest names the ingest as the repair: no answer can be recorded yet (review F-002)", async () => {
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
    const item = await readiness(dir);
    expect(item?.status).toBe("fail");
    expect(item?.evidence).toContain("not ingested yet");
    expect(item?.repair).toContain("--premises");
    expect(item?.repair).not.toContain("decide-premise");
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
