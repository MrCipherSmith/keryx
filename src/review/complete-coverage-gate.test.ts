// Flow 431 AC10: `keryx review complete` refuses while an in-scope file is uncovered, names the count, the first files and
// the command that runs the missing chunks, and lets the operator past only in their own words.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { operatorDecisionSubject, requiredReviewers } from "./coverage";
import { coverageGateErrors, recordCoverageWaiver } from "./coverage-complete";
import { commitFiles, git, initRepo } from "./git-fixture.test-helpers";
import { recordOperatorDecision, type OperatorDecisionSubject } from "./operator-decisions";
import { buildRunProfile, writeRunProfile } from "./run-profile";
import { READY_DISPATCH } from "./dispatch.test-helpers";
import { readReviewRounds } from "../flow/review-gate";
import { packageResearchErrors } from "./research";

let pkg: string;
const artifacts = { research: "research.json", reviewerDispatch: "research.json" };
const FAR = Array.from({ length: 8 }, (_, index) => `src/far-${index}.ts`);

const writeResearch = (extra: object = {}): void =>
  writeFileSync(path.join(pkg, "research.json"), JSON.stringify({ version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: { ...structuredClone(READY_DISPATCH), ...extra } }));

beforeEach(() => {
  pkg = mkdtempSync(path.join(tmpdir(), "keryx-gate-"));
  writeFileSync(path.join(pkg, "scope-files.json"), JSON.stringify({ files: ["src/a.ts"] }));
  writeFileSync(
    path.join(pkg, "blast-radius.json"),
    JSON.stringify({ schemaVersion: 1, changedFiles: ["src/a.ts"], files: [], dropped: FAR.map((file) => ({ file, hop: 1, fanIn: 1, via: "src/a.ts", source: "graph", reason: "cap", detail: "over the cap" })) }),
  );
  mkdirSync(path.join(pkg, "slices"), { recursive: true });
  writeResearch();
});
afterEach(() => rmSync(pkg, { recursive: true, force: true }));

test("the gate refuses and names the count, the first files and the command that runs the missing chunks", async () => {
  const errors = await packageResearchErrors(pkg, artifacts, []);
  expect(errors).toHaveLength(1);
  const message = errors[0] as string;
  expect(message).toContain("8 in-scope file(s) are uncovered");
  expect(message).toContain("src/far-0.ts, src/far-1.ts, src/far-2.ts, src/far-3.ts, src/far-4.ts");
  expect(message).toContain("(+3)");
  expect(message).not.toContain("src/far-5.ts,");
  expect(message).toContain("keryx review chunks next --package");
  expect(message).toContain('--waive-coverage "<operator quote>"');
});

test("the only way past is the operator's own words, recorded with the time and the waived files", async () => {
  await expect(recordCoverageWaiver(pkg, "   ")).rejects.toThrow("operator's own words");
  const waiver = await recordCoverageWaiver(pkg, "  skip the far files, they are generated  ", new Date("2026-10-13T10:00:00Z"));
  expect(waiver).toEqual({ operatorQuote: "skip the far files, they are generated", time: "2026-10-13T10:00:00.000Z", files: FAR });
  const saved = JSON.parse(readFileSync(path.join(pkg, "research.json"), "utf8"));
  expect(saved.dispatch.coverageWaiver).toEqual(waiver);
  expect(await packageResearchErrors(pkg, artifacts, [])).toEqual([]);
});

test("R2-18: the quote has a boundary of 8 characters of the operator's own text, and needs letters or digits", async () => {
  await expect(recordCoverageWaiver(pkg, "skip it")).rejects.toThrow("at least 8 characters");
  await expect(recordCoverageWaiver(pkg, "--waive-coverage")).rejects.toThrow("operator's own words");
  await expect(recordCoverageWaiver(pkg, "........")).rejects.toThrow("letters or digits");
  await expect(recordCoverageWaiver(pkg, "--waive-coverage skip it")).rejects.toThrow("at least 8 characters");
  expect(JSON.parse(readFileSync(path.join(pkg, "research.json"), "utf8")).dispatch.coverageWaiver).toBeUndefined();
  expect((await recordCoverageWaiver(pkg, "skip it!"))?.operatorQuote).toBe("skip it!");
});

test("R2-17: what is recorded is the operator's text with the flag's own name taken out", async () => {
  const waiver = await recordCoverageWaiver(pkg, "please waive coverage of the generated files");
  expect(waiver?.operatorQuote).toBe("please  of the generated files");
  expect(waiver?.operatorQuote).not.toMatch(/waive/i);
});

test("a waiver does not cover a file that became uncovered afterwards", async () => {
  await recordCoverageWaiver(pkg, "skip them");
  writeFileSync(
    path.join(pkg, "blast-radius.json"),
    JSON.stringify({ schemaVersion: 1, changedFiles: ["src/a.ts"], files: [], dropped: [...FAR, "src/late.ts"].map((file) => ({ file, hop: 1, fanIn: 1, via: "src/a.ts", source: "graph", reason: "cap", detail: "over the cap" })) }),
  );
  const errors = await coverageGateErrors(pkg);
  expect(errors.join(" ")).toContain("9 in-scope file(s) are uncovered");
  expect(errors.join(" ")).toContain("does not name every uncovered file");
});

test("there is no unchecked-remainder outcome: a package with nothing waived and nothing covered stays blocked", async () => {
  const errors = await packageResearchErrors(pkg, artifacts, []);
  expect(errors.join(" ")).not.toMatch(/unchecked remainder/i);
  expect(errors.length).toBeGreaterThan(0);
});

test("a package that tracks nothing is not gated, and an empty uncovered set needs no waiver", async () => {
  writeFileSync(path.join(pkg, "blast-radius.json"), JSON.stringify({ schemaVersion: 1, changedFiles: ["src/a.ts"], files: [], dropped: [] }));
  expect(await packageResearchErrors(pkg, artifacts, [])).toEqual([]);
  expect(await recordCoverageWaiver(pkg, "nothing to waive")).toBeUndefined();
});

test("R2-06: the flow review gate reads a closed round without the completeness gate and still gates an open one", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "keryx-gate-flow-"));
  try {
    for (const [name, status] of [["closed-round", "closed"], ["open-round", "open"]] as const) {
      const dir = path.join(cwd, ".metaproject", "flows", "f1", "reviews", name);
      cpSync(pkg, dir, { recursive: true });
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ reviewId: name, status, createdAt: name, artifacts, target: { head: "abc" } }));
      writeFileSync(path.join(dir, "findings.json"), "[]");
      writeFileSync(path.join(dir, "coverage.json"), JSON.stringify({ schemaVersion: 1 }));
    }
    const rounds = await readReviewRounds(cwd, "f1");
    const closed = rounds.find((round) => round.reviewId === "closed-round");
    const open = rounds.find((round) => round.reviewId === "open-round");
    expect(closed?.problems.join(" ")).not.toContain("uncovered");
    expect(open?.problems.join(" ")).toContain("8 in-scope file(s) are uncovered");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe("flow 460: the complete gate on a project with reviewers installed", () => {
  const NAMES = ["review-orchestrator", "review-verifier", "review-architecture", "review-style", "review-core-boundaries", "review-clean-code", "review-logic", "review-testing-practices"];
  const LIGHT = ["review-clean-code", "review-logic", "review-testing-practices"];
  const two = ["src/a.ts", "src/b.ts"];
  let root: string;

  const install = (project: string): void => {
    mkdirSync(path.join(project, ".metaproject"), { recursive: true });
    writeFileSync(path.join(project, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { gdskills: {} } }));
    for (const name of NAMES) {
      const dir = path.join(project, ".metaproject", "skills", "gdskills", "review", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n`);
    }
  };
  const runOf = (reviewer: string) => ({ reviewer, executionId: `run-${reviewer}`, status: "complete", scopeComplete: true, rawEvidence: `raw/${reviewer}.txt`, ruleEvidence: ["rule"], executionRequired: false, executionReason: "source-only review" });
  /** A package of `project` with `selected` dispatched and run, no dispatch `override` field. */
  const packageOf = (project: string, target: Record<string, unknown>, selected: readonly string[], extra: object = {}): string => {
    const dir = path.join(project, ".metaproject", "reviews", "r1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ reviewId: "r1", target: { kind: "pr", ref: "https://github.com/o/r/pull/7975", ...target }, artifacts }));
    writeFileSync(path.join(dir, "scope-files.json"), JSON.stringify({ version: 1, files: two, changedLines: 4 }));
    writeFileSync(
      path.join(dir, "research.json"),
      JSON.stringify({ version: 1, scopeReviewed: true, rawReconciled: true, obligations: [], dispatch: { version: 1, mode: "all", selected, unresolvedRules: [], runs: selected.map(runOf), ...extra } }),
    );
    return dir;
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-gate-460-")));
    install(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe("AC1: a light PR round is diffed at the repository top level against the base", () => {
    function repo(): string {
      initRepo(root);
      commitFiles(root, { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" }, "base");
      git(root, "checkout", "-q", "-b", "pr");
      const head = commitFiles(root, { "src/a.ts": "export const a = 2;\n", "src/b.ts": "export const b = 2;\n" }, "pr change");
      git(root, "checkout", "-q", "main");
      return head;
    }

    test("complete accepts the light set of a 2-file PR diff (target.ref is the PR URL, target.base recorded)", async () => {
      const dir = packageOf(root, { base: "main", head: repo() }, LIGHT, { depth: "light" });
      expect(await packageResearchErrors(dir, artifacts, [])).toEqual([]);
    });

    test("and for a package under a subdirectory's .metaproject/reviews", async () => {
      const head = repo();
      const project = path.join(root, "output", "review-pr-7975");
      install(project);
      const dir = packageOf(project, { base: "main", head }, LIGHT, { depth: "light" });
      expect(await packageResearchErrors(dir, artifacts, [])).toEqual([]);
    });

    test("a head git cannot read is refused, naming cwd, base and head", async () => {
      repo();
      const dir = packageOf(root, { base: "main", head: "0123456789abcdef0123456789abcdef01234567" }, LIGHT, { depth: "light" });
      const errors = (await packageResearchErrors(dir, artifacts, [])).join("\n");
      expect(errors).toContain(`cwd ${root}`);
      expect(errors).toContain("base main");
      expect(errors).toContain("head 0123456789abcdef0123456789abcdef01234567");
    });
  });

  describe("AC2: a confirmed reviewer-override decision counts without a dispatch override field", () => {
    const HEAD = "aaaaaaa";
    let selected: string[];
    let dir: string;

    beforeEach(async () => {
      const required = (await requiredReviewers(root, "all", two, { enabledRoles: ["review-clean-code", "review-style"] })).required;
      selected = required.filter((name) => name !== "review-style" && name !== "review-architecture");
      expect(required.length - selected.length).toBe(2);
      dir = packageOf(root, { head: HEAD }, selected);
      writeFileSync(path.join(dir, "round-roles.json"), JSON.stringify({ enabled: ["review-clean-code", "review-style"] }));
      await writeRunProfile(dir, buildRunProfile({ env: {}, now: new Date("2026-10-17T00:00:00Z") }));
    });

    const decide = async (subject: OperatorDecisionSubject): Promise<void> => {
      await recordOperatorDecision(dir, { kind: "reviewer-override", quote: "leave style and architecture out: yes", reason: "two-line fix", confirmedVia: "terminal", at: new Date().toISOString(), subject });
    };

    test("without a decision complete refuses and names the card and the terminal command", async () => {
      const errors = (await packageResearchErrors(dir, artifacts, [])).join("\n");
      expect(errors).toContain("missing: review-architecture, review-style");
      expect(errors).toContain("review_override_reviewers");
    });

    test("a decision for this head and these missing reviewers lets complete pass", async () => {
      await decide(await operatorDecisionSubject(dir, "reviewer-override", selected));
      expect(await packageResearchErrors(dir, artifacts, [])).toEqual([]);
    });

    test("a decision for another head does not count", async () => {
      await decide({ head: "bbbbbbb", items: ["review-architecture", "review-style"] });
      expect((await packageResearchErrors(dir, artifacts, [])).join("\n")).toContain("missing: review-architecture, review-style");
    });

    test("a decision that left out a different reviewer set does not count", async () => {
      await decide({ head: HEAD, items: ["review-style"] });
      expect((await packageResearchErrors(dir, artifacts, [])).join("\n")).toContain("missing: review-architecture, review-style");
    });
  });
});
