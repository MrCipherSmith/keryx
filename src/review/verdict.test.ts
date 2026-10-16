import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VERDICT_FILE, computeVerdict, renderVerdict, writeVerdict } from "./verdict";
import { recordPremiseDecision } from "./operator-decisions";
import { PREMISES_FILE } from "./premise";
import { downgradedPremise, heldFinding, heldPremise, premiseAnswerInput } from "./premise-fixtures";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function pkg(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "verdict-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "raw"), { recursive: true });
  return dir;
}

const finding = (id: string, severity: string, problem: string, extra: Record<string, unknown> = {}) => ({ id, severity, problem, ...extra });

function reply(reviewer: string, findings: unknown[]): string {
  return `done\n\`\`\`REVIEW_RESULT\n${JSON.stringify({ reviewer, status: "DONE", findings })}\n\`\`\`\n`;
}

describe("held findings (flow 459, AC2)", () => {
  // The shared held finding, renamed per test: its premise carries the evidence mergePremises requires.
  const held = (id: string, severity: string, verdict = "challenged") =>
    heldFinding({ id, global_id: undefined, severity, problem: `${id} timeline pinned LTR`, premise: heldPremise({ verdict, ...(verdict === "owner-decision" ? { options: ["a", "b"] } : {}) }) });
  const decision = (record: Record<string, unknown>, answer: "uphold" | "dismiss") => premiseAnswerInput(record, { answer, reason: "platforms do not mirror it" });

  test("a held blocker or major is not an open blocker or major: it is listed as awaiting the operator", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([held("LY-1", "blocker"), held("LY-2", "major", "owner-decision"), finding("F-3", "major", "real", { reviewer: "review-logic" })]));
    const verdict = await computeVerdict(dir);
    expect(verdict.counts).toEqual({ blocker: 0, major: 1, minor: 0, info: 0 });
    expect(verdict.open.map((f) => f.id)).toEqual(["F-3"]);
    expect(verdict.held.map((f) => f.id)).toEqual(["LY-1", "LY-2"]);
    expect(verdict.headline).toBe("1 open major(s): resolve or justify before merge; awaiting operator: LY-1, LY-2");
    const markdown = (await writeVerdict(dir, "r1")).markdown;
    expect(markdown).toContain("awaiting operator: LY-1, LY-2");
    expect(markdown).toContain("## Awaiting operator (premise)");
  });

  test("a round with only held findings has no open blockers or majors, and says what it waits for", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([held("LY-1", "blocker")]));
    const verdict = await computeVerdict(dir);
    expect(verdict.headline).toBe("no open blockers or majors; awaiting operator: LY-1");
    expect(renderVerdict(verdict, "r1")).not.toContain("findings: none");
  });

  test("a premise-question uphold returns the finding to an open one at its original severity", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([held("LY-1", "major")]));
    await recordPremiseDecision(dir, decision(held("LY-1", "major"), "uphold"));
    const verdict = await computeVerdict(dir);
    expect(verdict.held).toEqual([]);
    expect(verdict.open.map((f) => [f.id, f.severity])).toEqual([["LY-1", "major"]]);
  });

  test("a premise-question dismiss takes it out of the counts as dismissed", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([held("LY-1", "major")]));
    await recordPremiseDecision(dir, decision(held("LY-1", "major"), "dismiss"));
    const verdict = await computeVerdict(dir);
    expect(verdict.held).toEqual([]);
    expect(verdict.open).toEqual([]);
    expect(verdict.dismissed).toBe(1);
  });

  test("a downgraded finding counts at the judge's severity, from the record", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([finding("LY-1", "minor", "timeline", { reviewer: "review-layout", premise: downgradedPremise("major", "minor") })]));
    const verdict = await computeVerdict(dir);
    expect(verdict.counts).toEqual({ blocker: 0, major: 0, minor: 1, info: 0 });
    expect(verdict.open).toEqual([]);
    expect(verdict.minors.map((f) => f.id)).toEqual(["LY-1"]);
    expect(verdict.held).toEqual([]);
  });

  test("premise results in the package are applied before anything is counted: a downgrade lowers, a hold holds, nothing is removed", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "raw", "review-layout.txt"), reply("review-layout", [finding("LY-1", "major", "timeline pinned LTR"), finding("LY-2", "blocker", "label pinned LTR")]));
    await mkdir(path.join(dir, "research-evidence"), { recursive: true });
    await writeFile(
      path.join(dir, PREMISES_FILE),
      JSON.stringify({
        judge: "review-premise",
        premises: [
          { finding_id: "LY-1", verdict: "downgraded", severity: "minor", intent_signals: [{ ref: "src/t.tsx:1", says: "legacy path, read-only" }] },
          { finding_id: "LY-2", verdict: "challenged", practice_sources: [{ name: "Material", says: "x" }], question: "q" },
          { finding_id: "LY-1", verdict: "upheld" },
        ],
      }),
    );
    const verdict = await computeVerdict(dir);
    // LY-1 was claimed twice: neither claim applies, so it stays at its reported severity.
    expect(verdict.counts).toEqual({ blocker: 0, major: 1, minor: 0, info: 0 });
    expect(verdict.held.map((f) => f.id)).toEqual(["LY-2"]);
    expect(verdict.premisedFindings).toBe(1);
    expect(renderVerdict(verdict, "r1")).toContain(`premise results: 1 finding(s) carry a premise judgement (${PREMISES_FILE})`);
  });

  test("on an ingested round findings.json is the record: premises.json is not re-applied, and the count is the records' own", async () => {
    const dir = await pkg();
    // LY-1 carries the premise ingest applied; LY-2 carries none because ingest REJECTED its claim (self-judgement),
    // which premises.json keeps as received. Re-applying the file must not hold LY-2 now.
    await writeFile(
      path.join(dir, "findings.json"),
      JSON.stringify([
        finding("LY-1", "minor", "timeline", { reviewer: "review-layout", premise: downgradedPremise("major", "minor") }),
        finding("LY-2", "major", "label pinned LTR", { reviewer: "review-layout" }),
      ]),
    );
    await mkdir(path.join(dir, "research-evidence"), { recursive: true });
    await writeFile(
      path.join(dir, PREMISES_FILE),
      JSON.stringify({
        judge: "review-premise",
        premises: [
          { finding_id: "LY-1", verdict: "downgraded", severity: "minor", intent_signals: [{ ref: "src/t.tsx:1", says: "legacy" }] },
          { finding_id: "LY-2", verdict: "challenged", practice_sources: [{ name: "Material", says: "x" }], question: "q" },
        ],
      }),
    );
    const verdict = await computeVerdict(dir);
    expect(verdict.held).toEqual([]);
    expect(verdict.open.map((f) => f.id)).toEqual(["LY-2"]);
    expect(verdict.premisedFindings).toBe(1);
  });

  test("a premise file the shape check refuses is not applied", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([finding("LY-1", "major", "x", { reviewer: "review-layout" })]));
    await mkdir(path.join(dir, "research-evidence"), { recursive: true });
    await writeFile(path.join(dir, PREMISES_FILE), JSON.stringify([{ finding_id: "LY-1", verdict: "challenged" }]));
    const verdict = await computeVerdict(dir);
    expect(verdict.premisedFindings).toBeUndefined();
    expect(verdict.counts.major).toBe(1);
  });
});

describe("computeVerdict from raw reviewer results", () => {
  test("counts by severity and lists open blockers and majors with a one-line problem", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "raw", "review-logic.txt"), reply("review-logic", [finding("F-1", "blocker", "null deref\nsecond line"), finding("F-2", "minor", "nit"), finding("F-3", "major", "race")]));
    const verdict = await computeVerdict(dir);
    expect(verdict.source).toBe("raw reviewer results");
    expect(verdict.counts).toEqual({ blocker: 1, major: 1, minor: 1, info: 0 });
    expect(verdict.verified).toBe(0);
    expect(verdict.unverified).toBe(3);
    expect(verdict.open.map((f) => [f.id, f.problem])).toEqual([["F-1", "null deref"], ["F-3", "race"]]);
    expect(verdict.headline).toContain("blocker");
  });

  test("names the expected reviewers that have not reported", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ coverage: [{ reviewer: "review-logic", status: "run" }, { reviewer: "review-style", status: "run" }, { reviewer: "review-x", status: "skipped" }] }));
    await writeFile(path.join(dir, "raw", "review-logic.txt"), reply("review-logic", []));
    const verdict = await computeVerdict(dir);
    expect(verdict.reportedReviewers).toEqual(["review-logic"]);
    expect(verdict.pendingReviewers).toEqual(["review-style"]);
  });

  test("says the pending set is unknown when the package records no expectation", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "raw", "review-logic.txt"), reply("review-logic", []));
    const verdict = await computeVerdict(dir);
    expect(verdict.pendingReviewers).toBeUndefined();
  });
});

describe("computeVerdict from an ingested round", () => {
  test("excludes refuted findings and splits verified from unverified", async () => {
    const dir = await pkg();
    await writeFile(
      path.join(dir, "findings.json"),
      JSON.stringify([
        finding("F-1", "blocker", "real", { reviewer: "review-logic", verification: { verdict: "confirmed" } }),
        finding("F-2", "major", "noise", { reviewer: "review-logic", verification: { verdict: "refuted" } }),
        finding("F-3", "major", "unchecked", { reviewer: "review-style", verification: { verdict: "unverifiable" } }),
        finding("F-4", "minor", "no check", { reviewer: "review-style" }),
        finding("F-5", "major", "dismissed", { reviewer: "review-style", disposition: { state: "dismissed-incorrect" } }),
      ]),
    );
    const verdict = await computeVerdict(dir);
    expect(verdict.source).toBe("ingested round");
    expect(verdict.counts).toEqual({ blocker: 1, major: 1, minor: 1, info: 0 });
    expect(verdict.verified).toBe(1);
    expect(verdict.unverified).toBe(2);
    expect(verdict.refuted).toBe(1);
    expect(verdict.dismissed).toBe(1);
    expect(verdict.open.map((f) => f.id)).toEqual(["F-1", "F-3"]);
  });
});

describe("empty and partial packages", () => {
  test("a package with no findings says so and does not fail", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "raw", "review-logic.txt"), reply("review-logic", []));
    const { verdict, markdown } = await writeVerdict(dir, "r1");
    expect(verdict.total).toBe(0);
    expect(verdict.headline).toBe("no findings");
    expect(markdown).toContain("findings: none");
  });

  test("a package with no raw directory and no findings reports no results yet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "verdict-"));
    dirs.push(dir);
    const verdict = await computeVerdict(dir);
    expect(verdict.source).toBe("none");
    expect(verdict.headline).toContain("no reviewer results");
  });

  test("writeVerdict writes verdict-interim.md into the package", async () => {
    const dir = await pkg();
    await writeFile(path.join(dir, "raw", "review-logic.txt"), reply("review-logic", [finding("F-1", "major", "race")]));
    const { markdown } = await writeVerdict(dir, "r1");
    expect(existsSync(path.join(dir, VERDICT_FILE))).toBe(true);
    expect(await readFile(path.join(dir, VERDICT_FILE), "utf8")).toBe(markdown);
    expect(markdown).toContain("F-1 [major]");
  });
});

describe("raw directory, verifier results and dispositions", () => {
  test("--raw reads reviewer results from another directory", async () => {
    const dir = await pkg();
    const shellRaw = path.join(dir, "elsewhere");
    await mkdir(shellRaw, { recursive: true });
    await writeFile(path.join(shellRaw, "review-logic.txt"), reply("review-logic", [finding("F-1", "blocker", "bad")]));
    expect((await computeVerdict(dir)).source).toBe("none");
    const verdict = await computeVerdict(dir, { rawDir: shellRaw });
    expect(verdict.source).toBe("raw reviewer results");
    expect(verdict.counts.blocker).toBe(1);
    const { markdown } = await writeVerdict(dir, "r1", { rawDir: shellRaw });
    expect(markdown).toContain(`raw results read from: ${shellRaw}`);
  });

  test("verifier results in research-evidence/verifications.json exclude refuted findings", async () => {
    const dir = await pkg();
    await mkdir(path.join(dir, "research-evidence"), { recursive: true });
    await writeFile(path.join(dir, "raw", "review-logic.txt"), reply("review-logic", [finding("F-1", "blocker", "noise"), finding("F-2", "major", "real")]));
    await writeFile(
      path.join(dir, "research-evidence", "verifications.json"),
      JSON.stringify({
        verifier: "review-verifier",
        verifications: [
          { finding: "F-1", verdict: "refuted", method: "execution", evidence: "ran the test; it passes" },
          { finding: "F-2", verdict: "confirmed", method: "execution", evidence: "ran the test; it fails" },
        ],
      }),
    );
    const verdict = await computeVerdict(dir);
    expect(verdict.refuted).toBe(1);
    expect(verdict.verifierClaims).toBe(2);
    expect(verdict.counts).toEqual({ blocker: 0, major: 1, minor: 0, info: 0 });
    expect(verdict.verified).toBe(1);
    expect(verdict.open.map((f) => f.id)).toEqual(["F-2"]);
  });

  test("a finding whose disposition is acted-on is not an open blocker or major", async () => {
    const dir = await pkg();
    await writeFile(
      path.join(dir, "findings.json"),
      JSON.stringify([
        finding("F-1", "blocker", "fixed already", { reviewer: "review-logic", disposition: { state: "acted-on", evidence: "commit abc" } }),
        finding("F-2", "major", "still open", { reviewer: "review-logic" }),
      ]),
    );
    const verdict = await computeVerdict(dir);
    expect(verdict.resolved).toBe(1);
    expect(verdict.counts).toEqual({ blocker: 0, major: 1, minor: 0, info: 0 });
    expect(verdict.open.map((f) => f.id)).toEqual(["F-2"]);
    expect(verdict.headline).toContain("major");
  });
});
