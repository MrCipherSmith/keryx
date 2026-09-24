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

  // F11 (flow 309 review round 1): trigger scenarios are one deterministic
  // scoring call — never N fabricated trials.
  test("trigger scenarios always report trials: 1, deterministic: true, regardless of --trials", async () => {
    const report = await evalSkill(sampleSkillId!, catalog, { strictness: "low", trials: 7 });
    const triggerScenarios = report.scenarios.filter((s) => s.kind === "trigger-positive" || s.kind === "trigger-negative");
    expect(triggerScenarios.length).toBeGreaterThan(0);
    for (const scenario of triggerScenarios) {
      expect(scenario.trials).toBe(1);
      expect(scenario.deterministic).toBe(true);
    }
  });

  // F10 (flow 309 review round 1): a "model"-graded expectation with no
  // injected model-grader capability must be reported `status: "skipped"`,
  // never silently counted as passed.
  test("a model-graded behavior scenario with no modelGraderFn is skipped, not counted as passed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-model-grader-"));
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
              expected_behavior: [{ grader: "model", value: "does the thing well" }],
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
        runner: async () => ({ output: "anything" }),
        modelGrader: true,
      });
      const behavior = report.scenarios.find((s) => s.kind === "behavior");
      expect(behavior?.status).toBe("skipped");
      expect(behavior?.passes).toBe(0);
      expect(behavior?.reason).toContain("model grader");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a model-graded behavior scenario WITH an injected modelGraderFn is actually invoked", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-model-grader-injected-"));
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
              expected_behavior: [{ grader: "model", value: "does the thing well" }],
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
      let invocations = 0;
      const report = await evalSkill("widget/sample-skill", localCatalog, {
        trials: 2,
        runner: async () => ({ output: "anything" }),
        modelGraderFn: (output, expected) => {
          invocations += 1;
          return output.length > 0 && expected.grader === "model";
        },
      });
      const behavior = report.scenarios.find((s) => s.kind === "behavior");
      expect(behavior?.status).toBe("ran");
      expect(behavior?.passRate).toBe(1);
      expect(invocations).toBe(2); // once per trial
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("F5 (flow 309 review round 1): trigger evaluation is not tautological", () => {
  // The reviewer's repro: a bogus skill whose own `triggers` are simply
  // COPIED from an unrelated, already-shipped skill, with a description
  // that has nothing to do with them. Under the OLD scoring (positives
  // scored against an index that includes the skill's own `triggers` list),
  // this always "passed" trigger accuracy — the borrowed trigger phrase
  // trivially matches itself, verbatim, in the bogus skill's own haystack.
  // `field: "description-only"` scoring means the bogus skill's tokens are
  // ONLY its (unrelated) description — the borrowed trigger no longer finds
  // its way back to it, so this must NOT report verdict "pass".
  test("a bogus skill with borrowed triggers does not pass", async () => {
    const donor = catalog.find((entry) => entry.id === "review/review-frontend");
    expect(donor).toBeDefined();
    if (donor === undefined) return;
    expect(donor.triggers.length).toBeGreaterThan(0);

    const bogus = {
      id: "widget/bogus-borrowed-triggers",
      category: "widget",
      name: "bogus-borrowed-triggers",
      description: "Use when baking sourdough bread at home, covering starter maintenance and oven timing.",
      triggers: [...donor.triggers],
      body: "bogus body",
      bodyLines: 1,
      sha256: "b".repeat(64),
      path: path.join(tmpdir(), "does-not-exist-bogus-skill", "SKILL.md"),
    };
    const localCatalog = [bogus, ...catalog];
    const report = await evalSkill(bogus.id, localCatalog, { strictness: "low", trials: 3 });
    expect(report.verdict).not.toBe("pass");
    expect(report.evidence).toBe("synthesized");
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
      evidence: "authored",
      scenarios: [],
      verdict: "fail",
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
      evidence: "authored",
      scenarios: [
        { id: "a", kind: "behavior", prompt: "p", strictness: "low", trials: 3, passes: 4, passRate: 1.3, passAtK: 1, grader: "contains", status: "ran" },
      ],
      verdict: "fail",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  // F5 (flow 309 review round 1): a report whose ONLY evidence is
  // synthesized trigger prompts must never claim verdict "pass".
  test("flags a synthesized-only report claiming verdict pass", () => {
    const errors = validateEvalReport({
      schemaVersion: "1.0.0",
      skillId: "x/y",
      strictness: "low",
      trials: 3,
      triggerAccuracy: { truePositive: 1, falsePositive: 0, positives: 1, negatives: 0 },
      evidence: "synthesized",
      scenarios: [
        { id: "trigger-positive-1", kind: "trigger-positive", prompt: "p", strictness: "low", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
      ],
      verdict: "pass",
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  // F11 (flow 309 review round 1): the trials>=3-at-high-strictness contract
  // is per-BEHAVIOR-scenario, not against the deterministic trigger kind.
  test("flags a behavior scenario at strictness high with trials < 3", () => {
    const errors = validateEvalReport({
      schemaVersion: "1.0.0",
      skillId: "x/y",
      strictness: "low",
      trials: 3,
      triggerAccuracy: { truePositive: 0, falsePositive: 0, positives: 0, negatives: 0 },
      evidence: "authored",
      scenarios: [
        { id: "b1", kind: "behavior", prompt: "p", strictness: "high", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "contains", status: "ran" },
      ],
      verdict: "pass",
    });
    expect(errors.some((e) => e.includes("b1") && e.includes("trials >= 3"))).toBe(true);
  });

  test("does not flag a trigger scenario at trials: 1 even when top-level strictness is high", () => {
    const errors = validateEvalReport({
      schemaVersion: "1.0.0",
      skillId: "x/y",
      strictness: "high",
      trials: 3,
      triggerAccuracy: { truePositive: 1, falsePositive: 0, positives: 1, negatives: 0 },
      evidence: "authored",
      scenarios: [
        { id: "trigger-positive-1", kind: "trigger-positive", prompt: "p", strictness: "high", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
      ],
      verdict: "pass",
    });
    expect(errors).toEqual([]);
  });

  test("does not flag a synthesized-only report claiming verdict incomplete", () => {
    const errors = validateEvalReport({
      schemaVersion: "1.0.0",
      skillId: "x/y",
      strictness: "low",
      trials: 3,
      triggerAccuracy: { truePositive: 1, falsePositive: 0, positives: 1, negatives: 0 },
      evidence: "synthesized",
      scenarios: [
        { id: "trigger-positive-1", kind: "trigger-positive", prompt: "p", strictness: "low", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
      ],
      verdict: "incomplete",
    });
    expect(errors).toEqual([]);
  });
});
