import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillCatalog } from "./catalog-index";
import { EvalContractError, evalSkill, validateEvalReport } from "./eval";

const catalog = loadSkillCatalog(process.cwd(), { scope: "bundled" });
const sampleSkillId = catalog.find((entry) => entry.triggers.length > 0)?.id;

describe("evalSkill", () => {
  test("throws EvalContractError for --strictness high with trials < 3", async () => {
    expect(sampleSkillId).toBeDefined();
    await expect(evalSkill(sampleSkillId!, catalog, { strictness: "high", trials: 1 })).rejects.toBeInstanceOf(EvalContractError);
  });

  test("reports trigger accuracy and a per-scenario pass rate over >= 3 trials at high strictness", async () => {
    const report = await evalSkill(sampleSkillId!, catalog, { strictness: "high", trials: 3 });
    expect(report.trials).toBeGreaterThanOrEqual(3);
    expect(report.triggerAccuracy).toBeDefined();
    expect(report.scenarios.length).toBeGreaterThan(0);
    for (const scenario of report.scenarios) {
      expect(scenario.passRate).toBeGreaterThanOrEqual(0);
      expect(scenario.passRate).toBeLessThanOrEqual(1);
    }
    expect(validateEvalReport(report)).toEqual([]);
  });

  test("unknown skill id throws", async () => {
    await expect(evalSkill("nope/does-not-exist", catalog)).rejects.toThrow();
  });

  test("no runner: behavior scenarios from evals.json report not-run with a reason, verdict incomplete", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-behavior-"));
    try {
      const skillDir = path.join(root, "skill");
      const fs = await import("node:fs");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillMd = path.join(skillDir, "SKILL.md");
      writeFileSync(
        skillMd,
        `---\nname: sample-skill\ndescription: Use when sample fixtures need evaluating.\ntriggers:\n  - sample fixture\nmetadata:\n  origin: authored\n---\n\nBody.\n`,
        "utf8",
      );
      writeFileSync(
        path.join(skillDir, "evals.json"),
        JSON.stringify({
          scenarios: [
            {
              id: "s1",
              prompt: "do the thing",
              strictness: "low",
              expected_behavior: [{ grader: "contains", value: "done" }],
            },
          ],
        }),
        "utf8",
      );
      const localCatalog = [
        {
          id: "widget/sample-skill",
          category: "widget",
          name: "sample-skill",
          description: "Use when sample fixtures need evaluating.",
          triggers: ["sample fixture"],
          body: fs.readFileSync(skillMd, "utf8"),
          bodyLines: 5,
          sha256: "x".repeat(64),
          path: skillMd,
        },
        ...catalog,
      ];
      const report = await evalSkill("widget/sample-skill", localCatalog, { trials: 3 });
      const behavior = report.scenarios.find((s) => s.kind === "behavior");
      expect(behavior?.status).toBe("not-run");
      expect(behavior?.reason).toContain("no runner capability");
      expect(report.verdict).toBe("incomplete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an injected runner is used and deterministic graders decide pass/fail", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-runner-"));
    try {
      const fs = await import("node:fs");
      const skillDir = path.join(root, "skill");
      fs.mkdirSync(skillDir, { recursive: true });
      const skillMd = path.join(skillDir, "SKILL.md");
      writeFileSync(
        skillMd,
        `---\nname: sample-skill\ndescription: Use when sample fixtures need evaluating.\ntriggers:\n  - sample fixture\nmetadata:\n  origin: authored\n---\n\nBody.\n`,
        "utf8",
      );
      writeFileSync(
        path.join(skillDir, "evals.json"),
        JSON.stringify({
          scenarios: [
            {
              id: "s1",
              prompt: "do the thing",
              strictness: "low",
              expected_behavior: [{ grader: "contains", value: "done" }],
            },
          ],
        }),
        "utf8",
      );
      const localCatalog = [
        {
          id: "widget/sample-skill",
          category: "widget",
          name: "sample-skill",
          description: "Use when sample fixtures need evaluating.",
          triggers: ["sample fixture"],
          body: fs.readFileSync(skillMd, "utf8"),
          bodyLines: 5,
          sha256: "x".repeat(64),
          path: skillMd,
        },
      ];
      const report = await evalSkill("widget/sample-skill", localCatalog, {
        trials: 3,
        runner: async () => ({ output: "done" }),
      });
      const behavior = report.scenarios.find((s) => s.kind === "behavior");
      expect(behavior?.status).toBe("ran");
      expect(behavior?.passRate).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evalSkill against the real bundled catalog — near-duplicate skills", () => {
  test("review/review-frontend's own synthesized triggers all pass trigger accuracy (flow 309 T12 regression)", async () => {
    // review/review-frontend sits beside several near-duplicate review/*
    // skills (review-frontend-conventions, review-orchestrator, ...) whose
    // descriptions share most of their vocabulary. Before flow 309 T12 this
    // reported 0/5 true positives: the old symmetric-Jaccard scorer punished
    // every short trigger phrase against the long description, and the old
    // grader required an outright top-1 match above SCOUT_USE_THRESHOLD —
    // neither of which a 2-3 word trigger phrase could ever clear. This is
    // a catalog-content regression guard, not just a synthetic fixture: it
    // runs against the actual bundled skill, which is what the reported bug
    // exercised.
    const skill = catalog.find((entry) => entry.id === "review/review-frontend");
    expect(skill).toBeDefined();
    if (skill === undefined) return;
    const report = await evalSkill("review/review-frontend", catalog, { strictness: "high", trials: 3 });
    expect(report.triggerAccuracy.truePositive).toBe(report.triggerAccuracy.positives);
    expect(report.triggerAccuracy.falsePositive).toBe(0);
    const failedPositives = report.scenarios.filter((s) => s.kind === "trigger-positive" && s.passRate < 1);
    expect(failedPositives).toEqual([]);
  });
});

describe("validateEvalReport", () => {
  test("flags high strictness with trials < 3", () => {
    const errors = validateEvalReport({
      schemaVersion: "1.0.0",
      skillId: "x/y",
      strictness: "high",
      trials: 1,
      triggerAccuracy: { truePositive: 0, falsePositive: 0, positives: 0, negatives: 0 },
      scenarios: [],
      verdict: "pass",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  test("flags a scenario passRate outside [0, 1]", () => {
    const errors = validateEvalReport({
      schemaVersion: "1.0.0",
      skillId: "x/y",
      strictness: "low",
      trials: 3,
      triggerAccuracy: { truePositive: 0, falsePositive: 0, positives: 0, negatives: 0 },
      scenarios: [
        { id: "a", kind: "behavior", prompt: "p", strictness: "low", trials: 3, passes: 4, passRate: 1.3, passAtK: 1, grader: "contains", status: "ran" },
      ],
      verdict: "fail",
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
