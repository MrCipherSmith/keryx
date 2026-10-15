import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { evaluatePlans, parseGroundTruth, renderPlanEval } from "./plan-eval";

const DATA = path.resolve(import.meta.dir, "..", "..", ".metaproject", "data", "review-418");
/** The roster `keryx review required` selected for review-418 (required.json in the data directory). */
const ROLES_418 = (JSON.parse(readFileSync(path.join(DATA, "required.json"), "utf8")) as { required: string[] }).required;

describe("review-418 (PR #940): old plan vs new plan", () => {
  const result = evaluatePlans({
    diff: readFileSync(path.join(DATA, "pr940.diff"), "utf8"),
    roles: ROLES_418,
    findings: parseGroundTruth(readFileSync(path.join(DATA, "canonical-findings.json"), "utf8")),
    // The slice sizes that round ran with (slices/manifest.json).
    maxBytes: 30_000,
    waveBytes: 90_000,
    head: "489d410f",
  });

  test("every ground-truth blocker/major lands in a slice its reviewer owns or a deep slice", () => {
    const serious = result.findings.filter((finding) => ["blocker", "major"].includes(finding.severity));
    expect(serious.length).toBe(3);
    for (const finding of serious) expect({ id: finding.id, landed: finding.landed }).toEqual({ id: finding.id, landed: true });
    expect(result.serious).toEqual({ total: 3, landed: 3, oldLanded: 3 });
  });

  test("the new plan needs fewer dispatches for the same slices", () => {
    expect(result.new.slices).toBe(result.old.slices);
    expect(result.new.dispatches).toBeLessThan(result.old.dispatches);
    expect(result.new.assignments).toBeLessThan(result.old.assignments);
    expect(result.old.deep + result.old.light).toBe(0);
    expect(result.new.deep + result.new.light).toBe(result.new.slices);
    expect(renderPlanEval(result)).toContain("blocker/major landed: new 3/3, old 3/3");
  });
});

function gitFile(filePath: string, lines: readonly string[]): string {
  return [`diff --git a/${filePath} b/${filePath}`, `--- a/${filePath}`, `+++ b/${filePath}`, `@@ -1,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), ""].join("\n");
}

/** A large PR: many modules of plain code, their tests and docs, plus one auth change and one process spawn. */
function largeDiff(): string {
  const parts: string[] = [];
  for (let i = 0; i < 40; i++) {
    const lines = Array.from({ length: 12 }, (_, n) => `const value${n} = compute${n % 3}(${n}) + ${i};`);
    parts.push(gitFile(`src/mod${i}/logic.ts`, lines));
    parts.push(gitFile(`src/mod${i}/logic.test.ts`, [`test("mod${i}", () => expect(value(${i})).toBe(${i}));`, ...lines.slice(0, 4).map((l) => `// ${l}`)]));
    parts.push(gitFile(`docs/mod${i}.md`, [`# Module ${i}`, "Describes what the module does.", ...lines.slice(0, 6).map((l) => `    ${l}`)]));
  }
  parts.push(gitFile("src/auth/session-token.ts", ["const ttl = 30;", "const refresh = ttl * 2;"]));
  parts.push(gitFile("src/exec/run.ts", ["const child = Bun.spawn(['git', 'status']);", "await child.exited;"]));
  return parts.join("");
}

describe("a large diff", () => {
  const findings = [
    { id: "G-1", severity: "major", file: "src/auth/session-token.ts", reviewer: "review-security-code" },
    { id: "G-2", severity: "major", file: "src/exec/run.ts", line: 1, reviewer: "review-security-code" },
    { id: "G-3", severity: "blocker", file: "src/mod7/logic.ts", reviewer: "review-logic" },
    { id: "G-4", severity: "major", file: "src/mod9/logic.test.ts", category: "testing-practices" },
  ];
  const result = evaluatePlans({ diff: largeDiff(), roles: ROLES_418, findings, maxBytes: 2_000, waveBytes: 4_000, head: "large", oldChunks: 12, newChunks: 0 });

  test("the new plan needs at least 50% fewer dispatches plus chunks", () => {
    expect(result.old.slices).toBeGreaterThan(20);
    expect(result.old.runs).toBe(result.old.dispatches + 12);
    expect(result.reduction).toBeGreaterThanOrEqual(0.5);
    expect(result.new.dispatches * 2).toBeLessThanOrEqual(result.old.dispatches);
  });

  test("risk goes deep, the rest stays light, and an audit sample is drawn from the light slices", () => {
    expect(result.new.deep).toBeGreaterThan(0);
    expect(result.new.light).toBeGreaterThan(result.new.deep);
    expect(result.new.audit).toBeGreaterThan(0);
  });

  test("every serious ground-truth finding lands under the new plan", () => {
    expect(result.serious).toEqual({ total: 4, landed: 4, oldLanded: 4 });
    expect(result.findings.find((f) => f.id === "G-1")!.how).toContain("deep");
    expect(result.findings.find((f) => f.id === "G-4")!.reviewer).toBe("review-testing-practices");
  });
});

describe("eval regressions: findings the old plan routed must land by routing alone", () => {
  // Minimal hunks of PR #424 round 1 and PR #1005 with their ground-truth majors. The audit sample is off, so a finding
  // lands only because routing gave its slice the finding's reviewer (or a risk class made it deep), never by luck.
  const FIXTURES = path.join(import.meta.dir, "fixtures", "plan-eval");
  const truth = parseGroundTruth(readFileSync(path.join(FIXTURES, "truth.json"), "utf8"));

  for (const [name, file] of [["agent instructions change routes review-architecture (PR #424)", "pr424-flow-orchestrator-skill.diff"], ["a git argv built from a provenance value routes review-security-code (PR #1005)", "pr1005-staleness.diff"]] as const) {
    test(name, () => {
      const diff = readFileSync(path.join(FIXTURES, file), "utf8");
      for (const head of ["a", "b", "c"]) {
        const result = evaluatePlans({ diff, roles: ROLES_418, findings: truth, maxBytes: 18_000, waveBytes: 54_000, head, auditRate: 0 });
        const inDiff = result.findings.filter((f) => f.how !== "not-in-diff");
        expect(inDiff.length).toBeGreaterThan(0);
        for (const finding of inDiff) {
          expect({ id: finding.id, landed: finding.landed, how: finding.how.startsWith("owner") }).toEqual({ id: finding.id, landed: true, how: true });
        }
      }
    });
  }
});

describe("ground truth input", () => {
  test("a canonical array, a findings.json object and a report's keryx:findings block all parse; entries without a file are left out", () => {
    const list = [{ id: "A", severity: "major", file: "src/a.ts", line: 3, reviewer: "review-logic" }, { id: "B", severity: "minor" }];
    expect(parseGroundTruth(JSON.stringify(list))).toEqual([{ id: "A", severity: "major", file: "src/a.ts", line: 3, reviewer: "review-logic" }]);
    expect(parseGroundTruth(JSON.stringify({ findings: [{ id: "C", severity: "blocker", location: "src/c.ts:12" }] }))).toEqual([{ id: "C", severity: "blocker", file: "src/c.ts", line: 12 }]);
    const report = ["# Report", "", "```json keryx:findings", JSON.stringify([{ id: "D", severity: "major", file: "src/d.ts", category: "security-code" }]), "```", ""].join("\n");
    expect(parseGroundTruth(report)).toEqual([{ id: "D", severity: "major", file: "src/d.ts", category: "security-code" }]);
    expect(() => parseGroundTruth("no findings here")).toThrow("keryx:findings");
  });

  test("a finding whose file is not in the diff is reported as not in the diff, never as landed", () => {
    const result = evaluatePlans({ diff: gitFile("src/x.ts", ["const a = 1;"]), roles: ["review-logic"], findings: [{ id: "Z", severity: "major", file: "src/elsewhere.ts" }] });
    expect(result.findings[0]).toMatchObject({ landed: false, how: "not-in-diff" });
  });
});
