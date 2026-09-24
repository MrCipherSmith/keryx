import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CatalogEntry } from "./catalog-index";
import { loadSkillCatalog } from "./catalog-index";
import {
  checkStablePackGate,
  computeCatalogTriggerDigest,
  computeSkillEvalDigest,
  EvalContractError,
  EvalSpecError,
  gradeExpectations,
  PACK_MIN_TRIALS,
  regradeRecordedReport,
  scoreTriggerScenarios,
  type EvalReport,
  type EvalScenarioResult,
  type EvalScenarioSpec,
  type EvalSpecFile,
  type TrialRecord,
  evalSkill,
  validateEvalReport,
} from "./eval";
import { buildGateReadyReport } from "./eval-fixtures";
import { JUDGE_PROMPT_VERSION, type Judge, type JudgeRequest, type JudgeVerdict } from "./judge";

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
      triggerAccuracy: { truePositive: 1, falsePositive: 0, positives: 1, negatives: 1 },
      evidence: "authored",
      scenarios: [
        { id: "trigger-positive-1", kind: "trigger-positive", prompt: "p", strictness: "high", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
        { id: "trigger-negative-1", kind: "trigger-negative", prompt: "n", strictness: "high", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
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

  // R2-6 (flow 309 review round 2): a hand-edited/malformed eval.json
  // missing `triggerAccuracy` used to log "triggerAccuracy is required" and
  // then immediately dereference `report.triggerAccuracy.positives` anyway,
  // throwing a TypeError instead of returning it as one more error.
  test("a report missing triggerAccuracy is flagged, not thrown", () => {
    const malformed = {
      schemaVersion: "1.0.0",
      skillId: "x/y",
      strictness: "low",
      trials: 3,
      evidence: "authored",
      scenarios: [],
      verdict: "fail",
    } as unknown as EvalReport;
    let errors: string[] = [];
    expect(() => {
      errors = validateEvalReport(malformed);
    }).not.toThrow();
    expect(errors.some((e) => e.includes("triggerAccuracy is required"))).toBe(true);
  });

  test("a report with non-array scenarios is flagged, not thrown", () => {
    const malformed = {
      schemaVersion: "1.0.0",
      skillId: "x/y",
      strictness: "low",
      trials: 3,
      triggerAccuracy: { truePositive: 0, falsePositive: 0, positives: 0, negatives: 0 },
      evidence: "authored",
      scenarios: undefined,
      verdict: "fail",
    } as unknown as EvalReport;
    let errors: string[] = [];
    expect(() => {
      errors = validateEvalReport(malformed);
    }).not.toThrow();
    expect(errors.some((e) => e.includes("scenarios must be an array"))).toBe(true);
  });

  // R2-4 (flow 309 review round 2): a `"pass"` verdict must be backed by at
  // least one ACTUALLY RAN trigger-positive and one ran trigger-negative
  // scenario, and no scenario left "skipped"/"not-run" — a hand-declared
  // "pass" over an empty (or all-not-run) scenario list must be refused.
  test("flags a 'pass' verdict with zero trigger scenarios", () => {
    const errors = validateEvalReport({
      schemaVersion: "1.0.0",
      skillId: "x/y",
      strictness: "low",
      trials: 3,
      triggerAccuracy: { truePositive: 0, falsePositive: 0, positives: 0, negatives: 0 },
      evidence: "authored",
      scenarios: [],
      verdict: "pass",
    });
    expect(errors.some((e) => e.includes("requires at least one ran trigger-positive"))).toBe(true);
  });

  test("flags a 'pass' verdict when a scenario is 'skipped'", () => {
    const errors = validateEvalReport({
      schemaVersion: "1.0.0",
      skillId: "x/y",
      strictness: "low",
      trials: 3,
      triggerAccuracy: { truePositive: 1, falsePositive: 0, positives: 1, negatives: 1 },
      evidence: "authored",
      scenarios: [
        { id: "trigger-positive-1", kind: "trigger-positive", prompt: "p", strictness: "low", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
        { id: "trigger-negative-1", kind: "trigger-negative", prompt: "n", strictness: "low", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
        { id: "b1", kind: "behavior", prompt: "p2", strictness: "low", trials: 3, passes: 0, passRate: 0, passAtK: 0, grader: "model", status: "skipped", reason: "no model grader" },
      ],
      verdict: "pass",
    });
    expect(errors.some((e) => e.includes("'skipped' or 'not-run'"))).toBe(true);
  });
});

describe("R2-4 (flow 309 review round 2): eval cannot 'pass' with nothing checked", () => {
  test("an authored evals.json with EMPTY trigger arrays falls back to synthesized rather than checking nothing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-empty-authored-"));
    try {
      const skillDir = path.join(root, "skill");
      mkdirSync(skillDir, { recursive: true });
      const skillMd = path.join(skillDir, "SKILL.md");
      writeFileSync(
        skillMd,
        `---\nname: sample-skill\ndescription: Use when sample fixtures need evaluating.\ntriggers:\n  - sample fixture\nmetadata:\n  origin: authored\n---\n\nBody.\n`,
        "utf8",
      );
      writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify({ triggers: { positive: [], negative: [] } }), "utf8");
      const localCatalog: CatalogEntry[] = [
        {
          id: "widget/sample-skill",
          category: "widget",
          name: "sample-skill",
          description: "Use when sample fixtures need evaluating.",
          triggers: ["sample fixture"],
          body: "",
          bodyLines: 5,
          sha256: "x".repeat(64),
          path: skillMd,
        },
        ...catalog,
      ];
      const report = await evalSkill("widget/sample-skill", localCatalog, { trials: 3 });
      // An empty authored array must not count as "checked nothing and
      // passed" — evidence falls back to synthesized (which can itself
      // never report verdict "pass"), and at least one trigger scenario
      // actually ran.
      expect(report.evidence).toBe("synthesized");
      expect(report.verdict).not.toBe("pass");
      expect(report.scenarios.filter((s) => s.kind === "trigger-positive").length).toBeGreaterThan(0);
      expect(report.scenarios.filter((s) => s.kind === "trigger-negative").length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a behavior scenario that is entirely model-graded with no grader (status 'skipped') keeps the verdict from 'pass'", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-skipped-not-pass-"));
    try {
      const skillDir = path.join(root, "skill");
      mkdirSync(skillDir, { recursive: true });
      const skillMd = path.join(skillDir, "SKILL.md");
      writeFileSync(
        skillMd,
        `---\nname: sample-skill\ndescription: Use when sample fixtures need evaluating.\ntriggers:\n  - sample fixture\nmetadata:\n  origin: authored\n---\n\nBody.\n`,
        "utf8",
      );
      writeFileSync(
        path.join(skillDir, "evals.json"),
        JSON.stringify({
          triggers: { positive: ["sample fixture"], negative: ["unrelated other thing"] },
          scenarios: [
            {
              id: "s1",
              prompt: "do the thing",
              strictness: "low",
              expected_behavior: [{ grader: "model", value: "does it well" }],
            },
          ],
        }),
        "utf8",
      );
      const localCatalog: CatalogEntry[] = [
        {
          id: "widget/sample-skill",
          category: "widget",
          name: "sample-skill",
          description: "Use when sample fixtures need evaluating.",
          triggers: ["sample fixture"],
          body: "",
          bodyLines: 5,
          sha256: "x".repeat(64),
          path: skillMd,
        },
        ...catalog,
      ];
      // A runner IS supplied (so the scenario is not "not-run"), but no
      // modelGraderFn — the whole scenario is "skipped", never a fabricated
      // pass. Before R2-4, `hasNotRun` only looked at "not-run", so this
      // shape could still report verdict "pass".
      const report = await evalSkill("widget/sample-skill", localCatalog, {
        trials: 3,
        runner: async () => ({ output: "anything" }),
        modelGrader: true,
      });
      const behavior = report.scenarios.find((s) => s.kind === "behavior");
      expect(behavior?.status).toBe("skipped");
      expect(report.verdict).not.toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R2-5 (flow 309 review round 2): leave-one-out trigger scoring", () => {
  // The prior fix (F5, round 1) used `field: "description-only"` for EVERY
  // caller, including authored prompts — that made `triggers` invisible to
  // trigger scoring entirely, so editing/fixing/removing a trigger could
  // never change the outcome. Leave-one-out restores `field: "full"`
  // (triggers included) while still excluding the ONE trigger a synthesized
  // positive was built from.
  // R3-5 (flow 309 review round 3): the original fixture named the skill
  // "sample-widget-skill" — the NAME ALONE supplied the "widget" token the
  // query needed, so this test passed even against the PRE-R2-5 code (which
  // scored every prompt with `field: "description-only"`, no triggers at
  // all, ever — see `selectsSkill` at eval.ts@dd4f9318:208-210, quoted in
  // this describe block's own header) — the fixture never actually
  // exercised leave-one-out's inclusion of the SIBLING trigger. Renamed to
  // "helper" (name/description share no vocabulary with the query at all)
  // and widened to a 7-token trigger phrase so a single shared word's IDF
  // share sits BELOW `SCOUT_FORK_THRESHOLD` (0.3) but still clears
  // `DESCRIPTION_SUPPORT_THRESHOLD` (0.12) — verified empirically against
  // the real scorer: description-only (pre-fix) score 0.127 (not selected),
  // leave-one-out (post-fix, sibling trigger included) score 0.839
  // (selected). Confirmed by running both `checkSkillSelected(...,
  // {field: "description-only"})` (the pre-R2-5 code path, quoted above)
  // and `checkSkillSelectedLeaveOneOut` directly against this exact fixture
  // in a scratch script — the pre-fix path returns `selected: false` here.
  test("a skill's own triggers now affect its trigger-eval outcome (not fully ignored) (R3-5: discriminating fixture)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-loo-triggers-matter-"));
    try {
      const skillDir = path.join(root, "skill");
      mkdirSync(skillDir, { recursive: true });
      const skillMd = path.join(skillDir, "SKILL.md");
      const description = "Use when the user needs help from the wizard for routine tasks.";
      const sourceTrigger = "acme corp global widget dashboard configuration wizard";
      const siblingTrigger = "acme corp global widget dashboard settings wizard";
      writeFileSync(
        skillMd,
        `---\nname: helper\ndescription: ${description}\ntriggers:\n  - ${sourceTrigger}\n  - ${siblingTrigger}\nmetadata:\n  origin: authored\n---\n\nBody.\n`,
        "utf8",
      );
      const entry: CatalogEntry = {
        id: "misc/helper",
        category: "misc",
        name: "helper",
        description,
        triggers: [sourceTrigger, siblingTrigger],
        body: "",
        bodyLines: 5,
        sha256: "y".repeat(64),
        path: skillMd,
      };
      const localCatalog: CatalogEntry[] = [entry, ...catalog];
      const report = await evalSkill(entry.id, localCatalog, { trials: 1 });
      const positive = report.scenarios.find((s) => s.id === "trigger-positive-1");
      expect(positive?.prompt).toBe(sourceTrigger);
      expect(positive?.passRate).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The reviewer's bogus-trigger case, re-verified under leave-one-out: a
  // skill that borrows an ENTIRE trigger LIST from a real skill (not just
  // one phrase) still has every OTHER borrowed trigger left in its own
  // haystack after leave-one-out excludes just the one under test — so
  // leave-one-out ALONE would still let it "find itself" through a
  // different borrowed phrase. `DESCRIPTION_SUPPORT_THRESHOLD` closes this:
  // none of the borrowed positives clear it, because the bogus skill's own
  // (unrelated) description shares nothing with any of them.
  test("a bogus skill with a fully borrowed trigger list is not selected by any of its borrowed positives", async () => {
    const donor = catalog.find((entry) => entry.id === "review/review-frontend");
    expect(donor).toBeDefined();
    if (donor === undefined) return;

    const bogus: CatalogEntry = {
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
    const report = await evalSkill(bogus.id, localCatalog, { strictness: "low", trials: 1 });
    expect(report.verdict).not.toBe("pass");
    expect(report.evidence).toBe("synthesized");
    const positives = report.scenarios.filter((s) => s.kind === "trigger-positive");
    expect(positives.length).toBeGreaterThan(0);
    // None of the borrowed trigger phrases select the bogus skill — not
    // just "not all", genuinely none, since its description supports none
    // of them.
    for (const positive of positives) {
      expect(positive.passRate).toBe(0);
    }
  });

  // Authored prompts are scored with `field: "full"` directly (no
  // leave-one-out needed — an authored, human-written prompt is not built
  // FROM the skill's own triggers list, so there is no verbatim-match
  // circularity to guard against). A paraphrase that never appears in
  // `triggers` verbatim, but IS covered by the skill's full definition,
  // must still select it.
  // R3-5: same name-collision problem as the leave-one-out test above —
  // "sample-widget-skill" supplied "widget" from the NAME alone, so this
  // passed under the pre-R2-5 `field: "description-only"` path too.
  // Renamed to "helper" (no shared vocabulary in name/description) —
  // verified empirically: pre-fix `field: "description-only"` score 0.000
  // (not selected), post-fix `field: "full"` score 0.635 (selected).
  test("an authored positive prompt is scored against the skill's FULL definition (triggers included), not description-only (R3-5: discriminating fixture)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-authored-full-field-"));
    try {
      const skillDir = path.join(root, "skill");
      mkdirSync(skillDir, { recursive: true });
      const skillMd = path.join(skillDir, "SKILL.md");
      writeFileSync(
        skillMd,
        `---\nname: helper\ndescription: Use when the user needs help.\ntriggers:\n  - widget dashboard configuration\nmetadata:\n  origin: authored\n---\n\nBody.\n`,
        "utf8",
      );
      const entry: CatalogEntry = {
        id: "misc/helper",
        category: "misc",
        name: "helper",
        description: "Use when the user needs help.",
        triggers: ["widget dashboard configuration"],
        body: "",
        bodyLines: 5,
        sha256: "z".repeat(64),
        path: skillMd,
      };
      const localCatalog: CatalogEntry[] = [entry, ...catalog];
      writeFileSync(
        path.join(skillDir, "evals.json"),
        JSON.stringify({ triggers: { positive: ["configure the widget dashboard"], negative: ["unrelated other thing"] } }),
        "utf8",
      );
      const report = await evalSkill(entry.id, localCatalog, { trials: 1 });
      expect(report.evidence).toBe("authored");
      const positive = report.scenarios.find((s) => s.id === "trigger-positive-1");
      expect(positive?.passRate).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R2-6 (flow 309 review round 2): checkStablePackGate recomputes, does not just trust", () => {
  test("a malformed eval.json (missing triggerAccuracy) fails the gate instead of throwing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stable-pack-gate-malformed-"));
    try {
      const governanceDir = path.join(root, "governance");
      mkdirSync(governanceDir, { recursive: true });
      writeFileSync(
        path.join(governanceDir, "eval.json"),
        JSON.stringify({ schemaVersion: "1.0.0", skillId: "x/y", strictness: "low", trials: 3, evidence: "authored", scenarios: [], verdict: "pass" }),
        "utf8",
      );
      let result: ReturnType<typeof checkStablePackGate> | undefined;
      expect(() => {
        result = checkStablePackGate(root, "stable");
      }).not.toThrow();
      expect(result?.status).toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a forged eval.json declaring 'pass' with zero ran scenarios fails the gate", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stable-pack-gate-forged-"));
    try {
      const governanceDir = path.join(root, "governance");
      mkdirSync(governanceDir, { recursive: true });
      const forged: EvalReport = {
        schemaVersion: "1.0.0",
        skillId: "x/y",
        strictness: "low",
        trials: 3,
        triggerAccuracy: { truePositive: 0, falsePositive: 0, positives: 0, negatives: 0 },
        evidence: "authored",
        scenarios: [],
        verdict: "pass",
      };
      writeFileSync(path.join(governanceDir, "eval.json"), JSON.stringify(forged), "utf8");
      const result = checkStablePackGate(root, "stable");
      expect(result.status).toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("evidence 'synthesized' fails the gate even if every other field looks clean", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stable-pack-gate-synthesized-"));
    try {
      const governanceDir = path.join(root, "governance");
      mkdirSync(governanceDir, { recursive: true });
      const forged: EvalReport = {
        schemaVersion: "1.0.0",
        skillId: "x/y",
        strictness: "low",
        trials: 3,
        triggerAccuracy: { truePositive: 1, falsePositive: 0, positives: 1, negatives: 1 },
        evidence: "synthesized",
        scenarios: [
          { id: "trigger-positive-1", kind: "trigger-positive", prompt: "p", strictness: "low", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
          { id: "trigger-negative-1", kind: "trigger-negative", prompt: "n", strictness: "low", trials: 1, passes: 1, passRate: 1, passAtK: 1, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
        ],
        // Not a shape `evalSkill` itself would ever produce (synthesized +
        // pass is already forbidden by `validateEvalReport`) — this
        // exercises the gate's own belt-and-suspenders check directly
        // against a hand-forged file.
        verdict: "fail",
      };
      writeFileSync(path.join(governanceDir, "eval.json"), JSON.stringify(forged), "utf8");
      const result = checkStablePackGate(root, "stable");
      expect(result.status).toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R3-2 (flow 309 review round 3): validateEvalReport/checkStablePackGate recompute the verdict, not just trust it", () => {
  test("a forged report (TP0/FP1, every scenario passRate 0, verdict 'pass') is rejected by validateEvalReport", () => {
    const forged: EvalReport = {
      schemaVersion: "1.0.0",
      skillId: "x/y",
      strictness: "low",
      trials: 1,
      triggerAccuracy: { truePositive: 0, falsePositive: 1, positives: 1, negatives: 1 },
      evidence: "authored",
      scenarios: [
        { id: "trigger-positive-1", kind: "trigger-positive", prompt: "p", strictness: "low", trials: 1, passes: 0, passRate: 0, passAtK: 0, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
        { id: "trigger-negative-1", kind: "trigger-negative", prompt: "n", strictness: "low", trials: 1, passes: 0, passRate: 0, passAtK: 0, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
      ],
      verdict: "pass",
    };
    const errors = validateEvalReport(forged);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("disagrees with its own"))).toBe(true);
  });

  test("the same forged report also fails checkStablePackGate (not just {status: 'pass'})", () => {
    const root = mkdtempSync(path.join(tmpdir(), "stable-pack-gate-forged-tp0fp1-"));
    try {
      const governanceDir = path.join(root, "governance");
      mkdirSync(governanceDir, { recursive: true });
      const forged: EvalReport = {
        schemaVersion: "1.0.0",
        skillId: "x/y",
        strictness: "low",
        trials: 1,
        triggerAccuracy: { truePositive: 0, falsePositive: 1, positives: 1, negatives: 1 },
        evidence: "authored",
        scenarios: [
          { id: "trigger-positive-1", kind: "trigger-positive", prompt: "p", strictness: "low", trials: 1, passes: 0, passRate: 0, passAtK: 0, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
          { id: "trigger-negative-1", kind: "trigger-negative", prompt: "n", strictness: "low", trials: 1, passes: 0, passRate: 0, passAtK: 0, grader: "trigger-rank-fork-family", status: "ran", deterministic: true },
        ],
        verdict: "pass",
      };
      writeFileSync(path.join(governanceDir, "eval.json"), JSON.stringify(forged), "utf8");
      const result = checkStablePackGate(root, "stable");
      expect(result.status).toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R3-1 (flow 309 review round 3): evals.json is validated on load, never silently vacuous", () => {
  function writeSkill(skillDir: string, evalsJsonBody: string): string {
    mkdirSync(skillDir, { recursive: true });
    const skillMd = path.join(skillDir, "SKILL.md");
    writeFileSync(
      skillMd,
      `---\nname: sample-skill\ndescription: Use when sample fixtures need evaluating.\ntriggers:\n  - sample fixture\nmetadata:\n  origin: authored\n---\n\nBody.\n`,
      "utf8",
    );
    writeFileSync(path.join(skillDir, "evals.json"), evalsJsonBody, "utf8");
    return skillMd;
  }

  function localCatalogFor(skillMd: string): CatalogEntry[] {
    return [
      {
        id: "widget/sample-skill",
        category: "widget",
        name: "sample-skill",
        description: "Use when sample fixtures need evaluating.",
        triggers: ["sample fixture"],
        body: "",
        bodyLines: 5,
        sha256: "x".repeat(64),
        path: skillMd,
      },
      ...catalog,
    ];
  }

  test("a typo'd grader (e.g. 'regexp') never yields passRate 1 or verdict 'pass' — evalSkill rejects it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-spec-typo-grader-"));
    try {
      const skillMd = writeSkill(
        path.join(root, "skill"),
        JSON.stringify({
          scenarios: [
            {
              id: "s1",
              prompt: "do the thing",
              strictness: "low",
              expected_behavior: [{ grader: "regexp", value: "MUST_APPEAR" }],
            },
          ],
        }),
      );
      await expect(
        evalSkill("widget/sample-skill", localCatalogFor(skillMd), {
          trials: 1,
          runner: async () => ({ output: "garbage that never contains the expected value" }),
        }),
      ).rejects.toBeInstanceOf(EvalSpecError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an empty expected_behavior array never yields passRate 1 or verdict 'pass' — evalSkill rejects it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-spec-empty-expectation-"));
    try {
      const skillMd = writeSkill(
        path.join(root, "skill"),
        JSON.stringify({
          scenarios: [{ id: "s1", prompt: "do the thing", strictness: "low", expected_behavior: [] }],
        }),
      );
      await expect(
        evalSkill("widget/sample-skill", localCatalogFor(skillMd), {
          trials: 1,
          runner: async () => ({ output: "anything" }),
        }),
      ).rejects.toBeInstanceOf(EvalSpecError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an invalid regex value is rejected at load, not at grading time", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-spec-bad-regex-"));
    try {
      const skillMd = writeSkill(
        path.join(root, "skill"),
        JSON.stringify({
          scenarios: [
            {
              id: "s1",
              prompt: "do the thing",
              strictness: "low",
              expected_behavior: [{ grader: "regex", value: "(unclosed" }],
            },
          ],
        }),
      );
      await expect(evalSkill("widget/sample-skill", localCatalogFor(skillMd), { trials: 1 })).rejects.toBeInstanceOf(EvalSpecError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed JSON in evals.json throws a typed error naming the file, not a raw SyntaxError (R3-6)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-spec-bad-json-"));
    try {
      const skillMd = writeSkill(path.join(root, "skill"), "{ not valid json");
      let caught: unknown;
      try {
        await evalSkill("widget/sample-skill", localCatalogFor(skillMd), { trials: 1 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EvalSpecError);
      expect((caught as Error).message).toContain("evals.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("triggers.positive given as a string (wrong type) throws a typed error naming the file, not a raw TypeError (R3-6)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "eval-spec-wrong-type-"));
    try {
      const skillMd = writeSkill(path.join(root, "skill"), JSON.stringify({ triggers: { positive: "not an array", negative: [] } }));
      let caught: unknown;
      try {
        await evalSkill("widget/sample-skill", localCatalogFor(skillMd), { trials: 1 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EvalSpecError);
      expect((caught as Error).message).toContain("triggers.positive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Flow 314 review round 1 (R1-3/R1-4/R1-5): the pack-level branch of
// `checkStablePackGate` now checks the report against what was actually
// evaluated (`gate.ts`'s probe evidence), never trusts a self-declared shape
// blindly, and never throws on a malformed `pack.json`. One fixture per
// mutation named in the review's evidence table.
describe("R1-3/R1-4/R1-5 (flow 314 review round 1): pack-level gate fixtures", () => {
  const PACK_ID = "widgetpack";
  const SKILL_NAME = "widget-skill";

  interface PackFixture {
    readonly root: string;
    readonly packDir: string;
    readonly skillDir: string;
    readonly skillMdPath: string;
    readonly evalsJsonPath: string;
    readonly packJsonPath: string;
    readonly governanceEvalPath: string;
  }

  /**
   * Builds a minimal, fully PASSING pack-level fixture on disk: one skill,
   * one authored trigger pair, one authored behavior scenario at
   * trials=PACK_MIN_TRIALS/strictness high, and a `governance/eval.json`
   * pack-level document whose report matches it exactly (right digest,
   * right scenario ids/prompts, scope "bundled", non-empty runner/model).
   * Every test below mutates exactly ONE thing away from this baseline.
   */
  function buildPassingFixture(): PackFixture {
    const root = mkdtempSync(path.join(tmpdir(), "pack-gate-fixture-"));
    const packDir = path.join(root, PACK_ID);
    const skillDir = path.join(packDir, "skills", SKILL_NAME);
    mkdirSync(skillDir, { recursive: true });

    const skillMdPath = path.join(skillDir, "SKILL.md");
    writeFileSync(
      skillMdPath,
      `---\nname: ${SKILL_NAME}\ndescription: Use when widget tasks need help.\ntriggers:\n  - widget task help\n---\n\nBody.\n`,
      "utf8",
    );

    const evalSpec: EvalSpecFile = {
      triggers: { positive: ["help with a widget task"], negative: ["unrelated other thing"] },
      scenarios: [
        { id: "s1", prompt: "do the widget thing", strictness: "high", expected_behavior: [{ grader: "contains", value: "done" }] },
      ],
    };
    const evalsJsonPath = path.join(skillDir, "evals.json");
    writeFileSync(evalsJsonPath, JSON.stringify(evalSpec), "utf8");

    const packJsonPath = path.join(packDir, "pack.json");
    writeFileSync(packJsonPath, JSON.stringify({ id: PACK_ID, skills: { implement: [SKILL_NAME] } }), "utf8");

    const governanceDir = path.join(packDir, "governance");
    mkdirSync(governanceDir, { recursive: true });
    const governanceEvalPath = path.join(governanceDir, "eval.json");
    // Flow 316: an allowlisted runner, per-trial `trialRecords` that
    // regrade clean, and a `catalogDigest` matching the real bundled
    // catalog — everything the hardened gate now requires, on top of the
    // provenance this fixture already carried.
    const report: EvalReport = buildGateReadyReport({ packId: PACK_ID, skillName: SKILL_NAME, skillDir, evalSpec });
    writeFileSync(governanceEvalPath, JSON.stringify({ schemaVersion: "1.0.0", reports: [report] }), "utf8");

    return { root, packDir, skillDir, skillMdPath, evalsJsonPath, packJsonPath, governanceEvalPath };
  }

  function readJson(filePath: string): any {
    return JSON.parse(readFileSync(filePath, "utf8"));
  }

  function writeJson(filePath: string, value: unknown): void {
    writeFileSync(filePath, JSON.stringify(value), "utf8");
  }

  test("baseline: a correctly-shaped pack-level fixture passes", () => {
    const fx = buildPassingFixture();
    try {
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result).toEqual({ status: "pass" });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  // Editing evals.json also changes `computeSkillEvalDigest` (it hashes
  // evals.json's own bytes), so that edit is caught by the digest check
  // first (see the "digest mismatch" fixture below) — a STRONGER signal
  // that subsumes "the scenario ids drifted". To isolate the
  // scenario-id-vs-evals.json comparison itself, this fixture instead forges
  // the RECORDED report's own scenario id while leaving every on-disk file
  // (and therefore the digest) untouched — the shape a hand-edited eval.json
  // could take without also touching evals.json.
  test("stale scenarios: the recorded report's behavior-scenario id disagrees with the current evals.json -> fail, naming the mismatch", () => {
    const fx = buildPassingFixture();
    try {
      const doc = readJson(fx.governanceEvalPath);
      doc.reports[0].scenarios.find((s: any) => s.kind === "behavior").id = "brand-new-scenario-id";
      writeJson(fx.governanceEvalPath, doc);
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toContain("behavior-scenario ids do not match");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("deleted SKILL.md: fails naming the missing file, not a fabricated pass", () => {
    const fx = buildPassingFixture();
    try {
      rmSync(fx.skillMdPath);
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toContain("SKILL.md is missing");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("strictness downgraded to 'low': fails naming the strictness requirement, not silently accepted", () => {
    const fx = buildPassingFixture();
    try {
      const doc = readJson(fx.governanceEvalPath);
      doc.reports[0].strictness = "low";
      doc.reports[0].scenarios.find((s: any) => s.kind === "behavior").strictness = "low";
      writeJson(fx.governanceEvalPath, doc);
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toContain('not "high"');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("trials below PACK_MIN_TRIALS (3, still >= 3 so validateEvalReport itself is fine): fails naming the pack minimum", () => {
    const fx = buildPassingFixture();
    try {
      const doc = readJson(fx.governanceEvalPath);
      doc.reports[0].trials = 3;
      writeJson(fx.governanceEvalPath, doc);
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toContain(`below the pack minimum ${PACK_MIN_TRIALS}`);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("pack.json id != directory name: fails naming the mismatch, never silently trusts the id", () => {
    const fx = buildPassingFixture();
    try {
      const pack = readJson(fx.packJsonPath);
      pack.id = "someotherpack";
      writeJson(fx.packJsonPath, pack);
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toContain("does not match its directory name");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("empty skills map (skills: {}): fails rather than vacuously passing", () => {
    const fx = buildPassingFixture();
    try {
      const pack = readJson(fx.packJsonPath);
      pack.skills = {};
      writeJson(fx.packJsonPath, pack);
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toContain("lists no skills");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("legacy single-report eval.json (no 'reports' wrapper): fails for a stack pack with the named reason", () => {
    const fx = buildPassingFixture();
    try {
      const doc = readJson(fx.governanceEvalPath);
      writeJson(fx.governanceEvalPath, doc.reports[0]); // the OLD single-report shape
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result).toEqual({ status: "fail", reason: "stack packs must ship a pack-level eval document" });
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a skill bucket that is a number, not a string[]: fails, never throws (R1-5)", () => {
    const fx = buildPassingFixture();
    try {
      const pack = readJson(fx.packJsonPath);
      pack.skills.implement = 5;
      writeJson(fx.packJsonPath, pack);
      let result: ReturnType<typeof checkStablePackGate> | undefined;
      expect(() => {
        result = checkStablePackGate(fx.packDir, "stable");
      }).not.toThrow();
      expect(result?.status).toBe("fail");
      expect(result?.reason).toContain("must be an array of strings");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a skill bucket that is a string, not a string[]: fails, never iterates it character-by-character", () => {
    const fx = buildPassingFixture();
    try {
      const pack = readJson(fx.packJsonPath);
      pack.skills.implement = SKILL_NAME; // a bare string, not [SKILL_NAME]
      writeJson(fx.packJsonPath, pack);
      let result: ReturnType<typeof checkStablePackGate> | undefined;
      expect(() => {
        result = checkStablePackGate(fx.packDir, "stable");
      }).not.toThrow();
      expect(result?.status).toBe("fail");
      expect(result?.reason).toContain("must be an array of strings");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("digest mismatch: SKILL.md edited after the report was recorded -> fails as stale, not a silent pass", () => {
    const fx = buildPassingFixture();
    try {
      writeFileSync(fx.skillMdPath, `${readFileSync(fx.skillMdPath, "utf8")}\nAn extra paragraph added after recording.\n`, "utf8");
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toContain("skillDigest is stale");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("scope 'all' instead of 'bundled': fails, since a repo-local skill outside the shipped bundle may have tipped a trigger score (R1-11)", () => {
    const fx = buildPassingFixture();
    try {
      const doc = readJson(fx.governanceEvalPath);
      doc.reports[0].scope = "all";
      writeJson(fx.governanceEvalPath, doc);
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toContain('not "bundled"');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("missing runner: fails naming the missing provenance field (R1-15)", () => {
    const fx = buildPassingFixture();
    try {
      const doc = readJson(fx.governanceEvalPath);
      delete doc.reports[0].runner;
      writeJson(fx.governanceEvalPath, doc);
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toContain('missing a non-empty "runner"');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("missing model: fails naming the missing provenance field (R1-15)", () => {
    const fx = buildPassingFixture();
    try {
      const doc = readJson(fx.governanceEvalPath);
      delete doc.reports[0].model;
      writeJson(fx.governanceEvalPath, doc);
      const result = checkStablePackGate(fx.packDir, "stable");
      expect(result.status).toBe("fail");
      expect(result.reason).toContain('missing a non-empty "model"');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe("computeSkillEvalDigest (R1-3/R1-15)", () => {
  test("changes when SKILL.md content changes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "digest-skillmd-"));
    try {
      writeFileSync(path.join(root, "SKILL.md"), "one", "utf8");
      const before = computeSkillEvalDigest(root);
      writeFileSync(path.join(root, "SKILL.md"), "two", "utf8");
      const after = computeSkillEvalDigest(root);
      expect(before).not.toBe(after);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("changes when evals.json content changes, SKILL.md untouched", () => {
    const root = mkdtempSync(path.join(tmpdir(), "digest-evalsjson-"));
    try {
      writeFileSync(path.join(root, "SKILL.md"), "same body", "utf8");
      writeFileSync(path.join(root, "evals.json"), JSON.stringify({ scenarios: [] }), "utf8");
      const before = computeSkillEvalDigest(root);
      writeFileSync(path.join(root, "evals.json"), JSON.stringify({ scenarios: [{ id: "x" }] }), "utf8");
      const after = computeSkillEvalDigest(root);
      expect(before).not.toBe(after);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is stable (same digest) for the same content computed twice, and tolerates a missing evals.json", () => {
    const root = mkdtempSync(path.join(tmpdir(), "digest-stable-"));
    try {
      writeFileSync(path.join(root, "SKILL.md"), "stable body", "utf8");
      expect(computeSkillEvalDigest(root)).toBe(computeSkillEvalDigest(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws when SKILL.md itself is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "digest-missing-skillmd-"));
    try {
      expect(() => computeSkillEvalDigest(root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("gradeExpectations (shared grading semantics for the eval-integrity guard test)", () => {
  test("fails when the expectation list is empty", () => {
    expect(gradeExpectations("anything", [])).toBe(false);
  });

  test("passes only when EVERY expectation passes", () => {
    const expected = [
      { grader: "contains" as const, value: "done" },
      { grader: "not-contains" as const, value: "nolint" },
    ];
    expect(gradeExpectations("the task is done", expected)).toBe(true);
    expect(gradeExpectations("the task is done, //nolint", expected)).toBe(false);
    expect(gradeExpectations("", expected)).toBe(false);
  });

  test("a 'model' grader with no runner-supplied verdict counts as failing (this helper is deterministic-only)", () => {
    expect(gradeExpectations("anything", [{ grader: "model", value: "judged well" }])).toBe(false);
  });
});

// Flow 316 (T5): the "judge" grader — schema acceptance/refusal, evalSkill's
// judge-scenario handling (empty answer, missing judge capability,
// trialRecords), regradeRecordedReport's tamper detection, and the
// hardened stable-pack gate (allowlisted runner/judge, trialRecords
// required, catalog-drift re-score).
describe("flow 316: the judge grader", () => {
  const KNOWN_RIGHT = "Run git branch -d feature-x; it refuses when there is unmerged work, which is your cue to double-check.";
  const KNOWN_WRONG = "Just always run git branch -D feature-x, it always works.";

  function judgeEvalSpec(overrides: Partial<EvalScenarioSpec> = {}): EvalSpecFile {
    return {
      triggers: { positive: ["sample fixture"], negative: ["something entirely unrelated"] },
      scenarios: [
        {
          id: "s1",
          prompt: "How do I delete a git branch safely?",
          strictness: "low",
          expected_behavior: [
            {
              grader: "judge",
              rubric: "A correct answer warns about unmerged work before force-deleting.",
              pass_criteria: ["Warns about unmerged work", "Uses a safe delete"],
              fail_criteria: ["Force-deletes without warning"],
            },
          ],
          calibration: { known_right: KNOWN_RIGHT, known_wrong: KNOWN_WRONG },
          anti_patterns: ["git branch -D"],
          ...overrides,
        },
      ],
    };
  }

  function writeJudgeSkill(evalSpec: EvalSpecFile): { readonly skillMd: string; readonly localCatalog: CatalogEntry[]; readonly cleanup: () => void } {
    const root = mkdtempSync(path.join(tmpdir(), "eval-judge-"));
    const skillDir = path.join(root, "skill");
    mkdirSync(skillDir, { recursive: true });
    const skillMd = path.join(skillDir, "SKILL.md");
    writeFileSync(
      skillMd,
      `---\nname: sample-skill\ndescription: Use when sample fixtures need evaluating.\ntriggers:\n  - sample fixture\nmetadata:\n  origin: authored\n---\n\nBody.\n`,
      "utf8",
    );
    writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify(evalSpec), "utf8");
    const localCatalog: CatalogEntry[] = [
      {
        id: "widget/sample-skill",
        category: "widget",
        name: "sample-skill",
        description: "Use when sample fixtures need evaluating.",
        triggers: ["sample fixture"],
        body: "",
        bodyLines: 5,
        sha256: "x".repeat(64),
        path: skillMd,
      },
      ...catalog,
    ];
    return { skillMd, localCatalog, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  /** A stub `Judge`: pass for `KNOWN_RIGHT`, fail for everything else — enough to exercise the plumbing without a real model. */
  function stubJudge(): Judge {
    return async (request: JudgeRequest): Promise<JudgeVerdict> =>
      request.answer === KNOWN_RIGHT ? { verdict: "pass", reason: "matches known_right" } : { verdict: "fail", reason: "does not match known_right" };
  }

  describe("schema acceptance/refusal (AC1)", () => {
    test("accepts a well-formed judge scenario", async () => {
      const { localCatalog, cleanup } = writeJudgeSkill(judgeEvalSpec());
      try {
        await expect(
          evalSkill("widget/sample-skill", localCatalog, { trials: 1, runner: async () => ({ output: KNOWN_RIGHT }), judge: stubJudge() }),
        ).resolves.toBeDefined();
      } finally {
        cleanup();
      }
    });

    test("refuses a judge expectation missing rubric", async () => {
      const spec = judgeEvalSpec();
      (spec.scenarios![0]!.expected_behavior[0] as any).rubric = "";
      const { localCatalog, cleanup } = writeJudgeSkill(spec);
      try {
        await expect(evalSkill("widget/sample-skill", localCatalog, { trials: 1 })).rejects.toBeInstanceOf(EvalSpecError);
      } finally {
        cleanup();
      }
    });

    test("refuses a judge expectation with an empty pass_criteria array", async () => {
      const spec = judgeEvalSpec();
      (spec.scenarios![0]!.expected_behavior[0] as any).pass_criteria = [];
      const { localCatalog, cleanup } = writeJudgeSkill(spec);
      try {
        await expect(evalSkill("widget/sample-skill", localCatalog, { trials: 1 })).rejects.toBeInstanceOf(EvalSpecError);
      } finally {
        cleanup();
      }
    });

    test("refuses a judge expectation that also carries a 'value'", async () => {
      const spec = judgeEvalSpec();
      (spec.scenarios![0]!.expected_behavior[0] as any).value = "should not be here";
      const { localCatalog, cleanup } = writeJudgeSkill(spec);
      try {
        await expect(evalSkill("widget/sample-skill", localCatalog, { trials: 1 })).rejects.toBeInstanceOf(EvalSpecError);
      } finally {
        cleanup();
      }
    });

    test("refuses more than one judge expectation on the same scenario", async () => {
      const spec = judgeEvalSpec();
      const judgeExpectation = spec.scenarios![0]!.expected_behavior[0];
      (spec.scenarios![0]! as any).expected_behavior = [judgeExpectation, judgeExpectation];
      const { localCatalog, cleanup } = writeJudgeSkill(spec);
      try {
        await expect(evalSkill("widget/sample-skill", localCatalog, { trials: 1 })).rejects.toBeInstanceOf(EvalSpecError);
      } finally {
        cleanup();
      }
    });

    test("refuses a judge scenario with no calibration", async () => {
      const spec = judgeEvalSpec();
      delete (spec.scenarios![0]! as any).calibration;
      const { localCatalog, cleanup } = writeJudgeSkill(spec);
      try {
        await expect(evalSkill("widget/sample-skill", localCatalog, { trials: 1 })).rejects.toBeInstanceOf(EvalSpecError);
      } finally {
        cleanup();
      }
    });

    test("refuses calibration.known_right === calibration.known_wrong", async () => {
      const spec = judgeEvalSpec();
      (spec.scenarios![0]! as any).calibration = { known_right: "same", known_wrong: "same" };
      const { localCatalog, cleanup } = writeJudgeSkill(spec);
      try {
        await expect(evalSkill("widget/sample-skill", localCatalog, { trials: 1 })).rejects.toBeInstanceOf(EvalSpecError);
      } finally {
        cleanup();
      }
    });

    test("refuses an anti_patterns array with an empty-string entry", async () => {
      const spec = judgeEvalSpec();
      (spec.scenarios![0]! as any).anti_patterns = [""];
      const { localCatalog, cleanup } = writeJudgeSkill(spec);
      try {
        await expect(evalSkill("widget/sample-skill", localCatalog, { trials: 1 })).rejects.toBeInstanceOf(EvalSpecError);
      } finally {
        cleanup();
      }
    });
  });

  describe("evalSkill judge-scenario handling", () => {
    test("an empty answer never calls the judge", async () => {
      const { localCatalog, cleanup } = writeJudgeSkill(judgeEvalSpec());
      let judgeCalled = false;
      const judge: Judge = async () => {
        judgeCalled = true;
        return { verdict: "pass", reason: "should not be reached" };
      };
      try {
        const report = await evalSkill("widget/sample-skill", localCatalog, { trials: 2, runner: async () => ({ output: "" }), judge });
        const behavior = report.scenarios.find((s) => s.kind === "behavior");
        expect(behavior?.status).toBe("ran");
        expect(behavior?.passRate).toBe(0);
        expect(judgeCalled).toBe(false);
        expect(behavior?.trialRecords?.every((record) => record.judge?.reason === "empty answer")).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("a judge scenario with no judge capability is skipped, never counted as passed", async () => {
      const { localCatalog, cleanup } = writeJudgeSkill(judgeEvalSpec());
      try {
        const report = await evalSkill("widget/sample-skill", localCatalog, { trials: 2, runner: async () => ({ output: KNOWN_RIGHT }) });
        const behavior = report.scenarios.find((s) => s.kind === "behavior");
        expect(behavior?.status).toBe("skipped");
        expect(behavior?.reason).toContain("judge capability");
        expect(report.verdict).not.toBe("pass");
        expect(report.judgePromptVersion).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    test("a judge scenario WITH a judge produces trialRecords, one per trial, and stamps judgePromptVersion + catalogDigest", async () => {
      const { localCatalog, cleanup } = writeJudgeSkill(judgeEvalSpec());
      try {
        const report = await evalSkill("widget/sample-skill", localCatalog, { trials: 3, runner: async () => ({ output: KNOWN_RIGHT }), judge: stubJudge() });
        const behavior = report.scenarios.find((s) => s.kind === "behavior");
        expect(behavior?.status).toBe("ran");
        expect(behavior?.trialRecords).toHaveLength(3);
        for (const record of behavior?.trialRecords ?? []) {
          expect(record.judge?.verdict).toBe("pass");
          expect(record.passed).toBe(true);
          expect(record.outputSha256).toMatch(/^[0-9a-f]{64}$/);
        }
        expect(behavior?.passRate).toBe(1);
        expect(report.judgePromptVersion).toBe(JUDGE_PROMPT_VERSION);
        expect(report.catalogDigest).toBe(computeCatalogTriggerDigest(localCatalog));
      } finally {
        cleanup();
      }
    });

    test("a judge scenario that fails under the judge reports passRate 0, not a fabricated pass", async () => {
      const { localCatalog, cleanup } = writeJudgeSkill(judgeEvalSpec());
      try {
        const report = await evalSkill("widget/sample-skill", localCatalog, { trials: 2, runner: async () => ({ output: KNOWN_WRONG }), judge: stubJudge() });
        const behavior = report.scenarios.find((s) => s.kind === "behavior");
        expect(behavior?.passRate).toBe(0);
        expect(behavior?.trialRecords?.every((record) => record.judge?.verdict === "fail")).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("catalogDigest is always stamped, even with no judge scenario at all", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "eval-catalog-digest-"));
      try {
        const report = await evalSkill(sampleSkillId!, catalog, { trials: 1 });
        expect(report.catalogDigest).toBe(computeCatalogTriggerDigest(catalog));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("regradeRecordedReport", () => {
    function reportFor(evalSpec: EvalSpecFile, skillDir: string, packId: string, skillName: string): EvalReport {
      return buildGateReadyReport({ packId, skillName, skillDir, evalSpec });
    }

    test("a clean recorded report regrades with no errors", () => {
      const root = mkdtempSync(path.join(tmpdir(), "regrade-clean-"));
      try {
        const skillDir = path.join(root, "skills", "fixture-skill");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: fixture-skill\ndescription: d\n---\n\nBody.\n", "utf8");
        const evalSpec: EvalSpecFile = {
          triggers: { positive: ["p"], negative: ["n"] },
          scenarios: [{ id: "s1", prompt: "do it", strictness: "high", expected_behavior: [{ grader: "contains", value: "ok" }] }],
        };
        writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify(evalSpec), "utf8");
        const report = reportFor(evalSpec, skillDir, "pk", "fixture-skill");
        expect(regradeRecordedReport(report, evalSpec)).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("catches a tampered output (hash mismatch)", () => {
      const root = mkdtempSync(path.join(tmpdir(), "regrade-tamper-output-"));
      try {
        const skillDir = path.join(root, "skills", "fixture-skill");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: fixture-skill\ndescription: d\n---\n\nBody.\n", "utf8");
        const evalSpec: EvalSpecFile = {
          triggers: { positive: ["p"], negative: ["n"] },
          scenarios: [{ id: "s1", prompt: "do it", strictness: "high", expected_behavior: [{ grader: "contains", value: "ok" }] }],
        };
        writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify(evalSpec), "utf8");
        const report = reportFor(evalSpec, skillDir, "pk", "fixture-skill");
        const tampered = tamperFirstTrialRecord(report, (record) => ({ ...record, output: "tampered output that still says ok" }));
        const errors = regradeRecordedReport(tampered, evalSpec);
        expect(errors.some((e) => e.includes("outputSha256"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("catches a tampered 'passed'", () => {
      const root = mkdtempSync(path.join(tmpdir(), "regrade-tamper-passed-"));
      try {
        const skillDir = path.join(root, "skills", "fixture-skill");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: fixture-skill\ndescription: d\n---\n\nBody.\n", "utf8");
        const evalSpec: EvalSpecFile = {
          triggers: { positive: ["p"], negative: ["n"] },
          scenarios: [{ id: "s1", prompt: "do it", strictness: "high", expected_behavior: [{ grader: "contains", value: "ok" }] }],
        };
        writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify(evalSpec), "utf8");
        const report = reportFor(evalSpec, skillDir, "pk", "fixture-skill");
        const tampered = tamperFirstTrialRecord(report, (record) => ({ ...record, passed: !record.passed }));
        const errors = regradeRecordedReport(tampered, evalSpec);
        expect(errors.some((e) => e.includes('"passed"'))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("catches a tampered judge verdict vs 'passed'", () => {
      const { localCatalog, cleanup } = writeJudgeSkill(judgeEvalSpec());
      try {
        const skillDir = path.dirname(localCatalog[0]!.path);
        const evalSpec = judgeEvalSpec();
        const report = reportFor(evalSpec, skillDir, "pk", "sample-skill");
        const tampered = tamperFirstTrialRecord(report, (record) => ({ ...record, judge: { verdict: "fail", reason: "flipped" } }));
        const errors = regradeRecordedReport(tampered, evalSpec);
        expect(errors.some((e) => e.includes('"passed"'))).toBe(true);
      } finally {
        cleanup();
      }
    });

    test("catches a deterministic result that disagrees with recomputation", () => {
      const root = mkdtempSync(path.join(tmpdir(), "regrade-tamper-deterministic-"));
      try {
        const skillDir = path.join(root, "skills", "fixture-skill");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: fixture-skill\ndescription: d\n---\n\nBody.\n", "utf8");
        const evalSpec: EvalSpecFile = {
          triggers: { positive: ["p"], negative: ["n"] },
          scenarios: [{ id: "s1", prompt: "do it", strictness: "high", expected_behavior: [{ grader: "contains", value: "ok" }] }],
        };
        writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify(evalSpec), "utf8");
        const report = reportFor(evalSpec, skillDir, "pk", "fixture-skill");
        const tampered = tamperFirstTrialRecord(report, (record) => ({ ...record, deterministic: [false] }));
        const errors = regradeRecordedReport(tampered, evalSpec);
        expect(errors.some((e) => e.includes("recomputed deterministic"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("missing trialRecords on a ran behavior scenario is caught", () => {
      const root = mkdtempSync(path.join(tmpdir(), "regrade-missing-trialrecords-"));
      try {
        const skillDir = path.join(root, "skills", "fixture-skill");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: fixture-skill\ndescription: d\n---\n\nBody.\n", "utf8");
        const evalSpec: EvalSpecFile = {
          triggers: { positive: ["p"], negative: ["n"] },
          scenarios: [{ id: "s1", prompt: "do it", strictness: "high", expected_behavior: [{ grader: "contains", value: "ok" }] }],
        };
        writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify(evalSpec), "utf8");
        const report = reportFor(evalSpec, skillDir, "pk", "fixture-skill");
        const scenarios = report.scenarios.map((s): EvalScenarioResult => {
          if (s.kind !== "behavior") return s;
          const { trialRecords: _drop, ...rest } = s;
          return rest;
        });
        const errors = regradeRecordedReport({ ...report, scenarios }, evalSpec);
        expect(errors.some((e) => e.includes("missing trialRecords"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("scoreTriggerScenarios (exported, shared with the gate's re-score)", () => {
    test("agrees with evalSkill's own trigger scoring for the same skill/catalog/spec", async () => {
      const evalSpec: EvalSpecFile = { triggers: { positive: ["sample fixture"], negative: ["something unrelated"] } };
      const { localCatalog, cleanup } = writeJudgeSkill(evalSpec);
      try {
        const skill = localCatalog[0]!;
        const direct = scoreTriggerScenarios(skill, localCatalog, evalSpec, "low");
        const report = await evalSkill("widget/sample-skill", localCatalog, { trials: 1 });
        const triggerScenarios = report.scenarios.filter((s) => s.kind === "trigger-positive" || s.kind === "trigger-negative");
        expect(direct.scenarios.map((s) => s.passRate)).toEqual(triggerScenarios.map((s) => s.passRate));
        expect(direct.triggerAccuracy).toEqual(report.triggerAccuracy);
      } finally {
        cleanup();
      }
    });
  });

  describe("the hardened stable-pack gate", () => {
    function writeGateFixture(evalSpec: EvalSpecFile, packId = "gate-pack", skillName = "gate-skill"): { readonly packDir: string; readonly skillDir: string; readonly cleanup: () => void } {
      const root = mkdtempSync(path.join(tmpdir(), "gate-fixture-"));
      const packDir = path.join(root, packId);
      const skillDir = path.join(packDir, "skills", skillName);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${skillName}\ndescription: fixture skill\n---\n\nBody.\n`, "utf8");
      writeFileSync(path.join(skillDir, "evals.json"), JSON.stringify(evalSpec), "utf8");
      mkdirSync(path.join(packDir, "governance"), { recursive: true });
      writeFileSync(path.join(packDir, "pack.json"), JSON.stringify({ id: packId, family: "language", modules: [], stability: "stable", skills: { review: [skillName] } }), "utf8");
      return { packDir, skillDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    }

    const DETERMINISTIC_SPEC: EvalSpecFile = {
      triggers: { positive: ["p"], negative: ["n"] },
      scenarios: [{ id: "s1", prompt: "do it", strictness: "high", expected_behavior: [{ grader: "contains", value: "ok" }] }],
    };

    test("happy path: a buildGateReadyReport fixture passes", () => {
      const { packDir, skillDir, cleanup } = writeGateFixture(DETERMINISTIC_SPEC);
      try {
        const report = buildGateReadyReport({ packId: "gate-pack", skillName: "gate-skill", skillDir, evalSpec: DETERMINISTIC_SPEC });
        writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify({ schemaVersion: "1.0.0", reports: [report] }), "utf8");
        expect(checkStablePackGate(packDir, "stable")).toEqual({ status: "pass" });
      } finally {
        cleanup();
      }
    });

    test("a forged runner/model not on the allowlist fails", () => {
      const { packDir, skillDir, cleanup } = writeGateFixture(DETERMINISTIC_SPEC);
      try {
        const report = { ...buildGateReadyReport({ packId: "gate-pack", skillName: "gate-skill", skillDir, evalSpec: DETERMINISTIC_SPEC }), runner: "x", model: "y" };
        writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify({ schemaVersion: "1.0.0", reports: [report] }), "utf8");
        const result = checkStablePackGate(packDir, "stable");
        expect(result.status).toBe("fail");
        expect(result.reason).toContain("not an allowlisted gate runner");
      } finally {
        cleanup();
      }
    });

    test("a forged judge/judgeModel not on the allowlist fails (when the spec has a judge scenario)", () => {
      const evalSpec = judgeEvalSpec();
      const { packDir, skillDir, cleanup } = writeGateFixture(evalSpec, "widget", "sample-skill");
      try {
        const report = { ...buildGateReadyReport({ packId: "widget", skillName: "sample-skill", skillDir, evalSpec }), judge: "not-deepseek", judgeModel: "not-deepseek-chat" };
        writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify({ schemaVersion: "1.0.0", reports: [report] }), "utf8");
        const result = checkStablePackGate(packDir, "stable");
        expect(result.status).toBe("fail");
        expect(result.reason).toContain("not an allowlisted gate judge");
      } finally {
        cleanup();
      }
    });

    test("a stale judgePromptVersion fails (when the spec has a judge scenario)", () => {
      const evalSpec = judgeEvalSpec();
      const { packDir, skillDir, cleanup } = writeGateFixture(evalSpec, "widget", "sample-skill");
      try {
        const report = { ...buildGateReadyReport({ packId: "widget", skillName: "sample-skill", skillDir, evalSpec }), judgePromptVersion: "0.0.0-stale" };
        writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify({ schemaVersion: "1.0.0", reports: [report] }), "utf8");
        const result = checkStablePackGate(packDir, "stable");
        expect(result.status).toBe("fail");
        expect(result.reason).toContain("judgePromptVersion");
      } finally {
        cleanup();
      }
    });

    test("missing trialRecords on the recorded report fails", () => {
      const { packDir, skillDir, cleanup } = writeGateFixture(DETERMINISTIC_SPEC);
      try {
        const base = buildGateReadyReport({ packId: "gate-pack", skillName: "gate-skill", skillDir, evalSpec: DETERMINISTIC_SPEC });
        const scenarios = base.scenarios.map((s): EvalScenarioResult => {
          if (s.kind !== "behavior") return s;
          const { trialRecords: _drop, ...rest } = s;
          return rest;
        });
        const report = { ...base, scenarios };
        writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify({ schemaVersion: "1.0.0", reports: [report] }), "utf8");
        const result = checkStablePackGate(packDir, "stable");
        expect(result.status).toBe("fail");
        expect(result.reason).toContain("trialRecords");
      } finally {
        cleanup();
      }
    });

    // Empirically-verified fixture (recorded via `scoreTriggerScenarios`
    // directly against the real bundled catalog): under `field: "full"`
    // scoring, "configure the widget dashboard" selects a skill described
    // "Use when the user needs help." with trigger "widget dashboard
    // configuration" — and stops selecting it once that skill's own
    // description is replaced with unrelated text, while the negative
    // prompt's result is unaffected either way. This is what lets the two
    // tests below assert a REAL, not assumed, before/after difference.
    const DRIFT_SPEC: EvalSpecFile = {
      triggers: { positive: ["configure the widget dashboard"], negative: ["unrelated other thing"] },
      scenarios: [{ id: "s1", prompt: "do it", strictness: "high", expected_behavior: [{ grader: "contains", value: "ok" }] }],
    };

    function driftCatalogEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
      return {
        id: "gate-pack/gate-skill",
        category: "gate-pack",
        name: "gate-skill",
        description: "Use when the user needs help.",
        triggers: ["widget dashboard configuration"],
        body: "",
        bodyLines: 1,
        sha256: "a".repeat(64),
        path: "/dev/null/SKILL.md",
        ...overrides,
      };
    }

    test("a catalog drift that changes a trigger result fails", () => {
      const { packDir, skillDir, cleanup } = writeGateFixture(DRIFT_SPEC);
      try {
        const recordedEntry = driftCatalogEntry({ path: path.join(skillDir, "SKILL.md") });
        const recordedCatalog = [recordedEntry, ...catalog];
        const recordedScore = scoreTriggerScenarios(recordedEntry, recordedCatalog, DRIFT_SPEC, "high");
        expect(recordedScore.scenarios.find((s) => s.id === "trigger-positive-1")?.passRate).toBe(1);

        const report = buildGateReadyReport({ packId: "gate-pack", skillName: "gate-skill", skillDir, evalSpec: DRIFT_SPEC, catalog: recordedCatalog });
        writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify({ schemaVersion: "1.0.0", reports: [report] }), "utf8");

        // A DIFFERENT catalog at gate time: the skill's OWN entry now has an
        // unrelated description — the digest disagrees (sha256 changed too),
        // forcing a re-score, and the positive prompt no longer selects it.
        const driftedEntry = driftCatalogEntry({
          description: "Use when baking sourdough bread at home, covering starter maintenance and oven timing.",
          triggers: [],
          sha256: "b".repeat(64),
          path: path.join(skillDir, "SKILL.md"),
        });
        const driftedCatalog = [driftedEntry, ...catalog];
        const driftedScore = scoreTriggerScenarios(driftedEntry, driftedCatalog, DRIFT_SPEC, "high");
        expect(driftedScore.scenarios.find((s) => s.id === "trigger-positive-1")?.passRate).toBe(0);

        const result = checkStablePackGate(packDir, "stable", { catalog: driftedCatalog });
        expect(result.status).toBe("fail");
        expect(result.reason).toContain("trigger results changed since recording");
      } finally {
        cleanup();
      }
    });

    test("a catalog drift that changes nothing still passes (only content, not scoring, drifted)", () => {
      const { packDir, skillDir, cleanup } = writeGateFixture(DRIFT_SPEC);
      try {
        const recordedEntry = driftCatalogEntry({ path: path.join(skillDir, "SKILL.md") });
        const recordedCatalog = [recordedEntry, ...catalog];
        const report = buildGateReadyReport({ packId: "gate-pack", skillName: "gate-skill", skillDir, evalSpec: DRIFT_SPEC, catalog: recordedCatalog });
        writeFileSync(path.join(packDir, "governance", "eval.json"), JSON.stringify({ schemaVersion: "1.0.0", reports: [report] }), "utf8");

        // Same description/triggers (same scoring), only the sha256 changed
        // (e.g. a whitespace-only SKILL.md edit) — the digest still drifts
        // (it is keyed on sha256), but re-scoring finds no changed trigger
        // result, so the gate does not fail on the drift alone.
        const driftedEntry = driftCatalogEntry({ sha256: "c".repeat(64), path: path.join(skillDir, "SKILL.md") });
        const driftedCatalog = [driftedEntry, ...catalog];
        const result = checkStablePackGate(packDir, "stable", { catalog: driftedCatalog });
        expect(result.status).toBe("pass");
      } finally {
        cleanup();
      }
    });
  });
});

function tamperFirstTrialRecord(report: EvalReport, mutate: (record: TrialRecord) => TrialRecord): EvalReport {
  const scenarios = report.scenarios.map((scenario): EvalScenarioResult => {
    if (scenario.kind !== "behavior" || scenario.trialRecords === undefined || scenario.trialRecords.length === 0) return scenario;
    const [first, ...rest] = scenario.trialRecords;
    return { ...scenario, trialRecords: [mutate(first!), ...rest] };
  });
  return { ...report, scenarios };
}
