// Flow 461 — the sentences that make a project's own rules and skills reach the
// implementer and the test writer. Each one is a behaviour claim that no code can
// enforce on a model, so the only guard is that the sentence stays. Both trees
// are read: an edit in the bundled copy that never reaches the installed one has
// diverged.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");

function trees(relative: string): Array<{ tree: string; text: string }> {
  return [
    ["bundled", path.join(REPO_ROOT, "src", "gdskills", "bundled", "skills", relative)],
    ["installed", path.join(REPO_ROOT, ".metaproject", "skills", "gdskills", relative)],
  ].map(([tree, file]) => ({ tree: tree!, text: readFileSync(file!, "utf8") }));
}

const IMPLEMENTER = "orchestration/task-implementer/SKILL.md";
const TESTS_CREATOR = "quality/tests-creator/SKILL.md";

describe("AC2: task-implementer reads the project first", () => {
  for (const { tree, text } of trees(IMPLEMENTER)) {
    test(`${tree}: Phase 2.4 resolves a rule from rules/project before rules/core`, () => {
      const phase24 = text.slice(text.indexOf("**2.4 Load relevant rules"), text.indexOf("### Phase 3"));
      expect(phase24).toContain("project first, bundled second");
      const project = phase24.indexOf(".metaproject/rules/project/<rule>.mdc");
      const core = phase24.indexOf(".metaproject/rules/core/<rule>.mdc");
      expect(project).toBeGreaterThan(-1);
      expect(core).toBeGreaterThan(project);
      expect(phase24).toContain("replaces the bundled one");
    });

    test(`${tree}: Phase 2.0b applies a fresh project skill, not only reports it`, () => {
      const phase20b = text.slice(text.indexOf("**2.0b"), text.indexOf("**2.0c"));
      expect(phase20b).toContain("**`fresh`**: apply it");
      expect(phase20b).toContain("a project skill never replaces a phase");
    });
  }
});

describe("AC3: tests-creator reads the project's test conventions first", () => {
  for (const { tree, text } of trees(TESTS_CREATOR)) {
    test(`${tree}: Phase 1 has a rules step, project first`, () => {
      const phase1 = text.slice(text.indexOf("### Phase 1: DETECT"), text.indexOf("### Phase 2: ANALYZE"));
      expect(phase1).toContain("**1.2b Load test-convention rules, project first.**");
      expect(phase1.indexOf(".metaproject/rules/project/<rule>.mdc")).toBeGreaterThan(-1);
      expect(phase1.indexOf(".metaproject/rules/core/<rule>.mdc")).toBeGreaterThan(
        phase1.indexOf(".metaproject/rules/project/<rule>.mdc"),
      );
    });

    test(`${tree}: the TEST_CASE_SPECS template names the rules read`, () => {
      const phase4 = text.slice(text.indexOf("### Phase 4: REPORT"), text.indexOf("**STATUS reporting:**"));
      expect(phase4).toContain("project_context_applied:");
    });
  }
});

describe("AC14: both skills call the resolver and write the field", () => {
  for (const { tree, text } of trees(IMPLEMENTER)) {
    test(`${tree}: task-implementer resolves in Phase 2 and writes project_context_applied`, () => {
      const phase2 = text.slice(text.indexOf("### Phase 2: RESEARCH"), text.indexOf("### Phase 3"));
      expect(phase2).toContain("keryx skills resolve-context --for implement");
      expect(phase2).toContain("workspace.resolved_context_file");
      expect(phase2.indexOf("**2.0c")).toBeLessThan(phase2.indexOf("**2.1 "));
      expect(phase2).toContain("project_context_applied");
      const phase6 = text.slice(text.indexOf("**6.1 Write result file"));
      expect(phase6).toContain('"project_context_applied": [');
    });
  }

  for (const { tree, text } of trees(TESTS_CREATOR)) {
    test(`${tree}: tests-creator resolves in Phase 1, before any test is written`, () => {
      const phase1 = text.slice(text.indexOf("### Phase 1: DETECT"), text.indexOf("### Phase 2: ANALYZE"));
      expect(phase1).toContain("keryx skills resolve-context --for test");
      expect(phase1).toContain("workspace.resolved_context_file");
      expect(phase1).toContain("project_context_applied");
      expect(text.indexOf("keryx skills resolve-context --for test")).toBeLessThan(text.indexOf("### Phase 3: GENERATE"));
    });
  }
});

const JOB_ORCHESTRATOR = "orchestration/job-orchestrator/SKILL.md";
const JOB_PROMPT = "orchestration/job-orchestrator/orchestrator-prompt.md";
const FLOW_ORCHESTRATOR = "orchestration/flow-orchestrator/SKILL.md";

describe("AC15: orchestrators hand the resolved file to every code-writing dispatch", () => {
  for (const { tree, text } of trees(JOB_ORCHESTRATOR)) {
    test(`${tree}: job-orchestrator Step A and Step B resolve, dispatch and validate`, () => {
      const stepA = text.slice(text.indexOf("# Step A — tests-creator"), text.indexOf("# Step B — task-implementer"));
      expect(stepA).toContain("keryx skills resolve-context --for test");
      expect(stepA).toContain("resolved_context_file");
      expect(stepA).toContain("--schema tests-creator-output --resolved");
      const stepB = text.slice(text.indexOf("# Step B — task-implementer"));
      expect(stepB.slice(0, 1200)).toContain("keryx skills resolve-context --for implement");
      expect(stepB.slice(0, 1200)).toContain("resolved_context_file");
      expect(stepB.slice(0, 1200)).toContain("--schema task-implementer-output --resolved");
    });

    test(`${tree}: both dispatch templates carry resolved_context_file`, () => {
      const lines = text.split("\n").filter((l) => l.includes("- resolved_context_file:"));
      expect(lines.some((l) => l.includes(".test.resolved.json"))).toBe(true);
      expect(lines.some((l) => l.includes(".implement.resolved.json"))).toBe(true);
    });

    test(`${tree}: the fix loop re-resolves and validates`, () => {
      expect(text).toContain("Re-run `keryx skills resolve-context --for implement` on the fix files");
      expect(text).toContain("`contracts validate --resolved` on the result");
    });
  }

  for (const { tree, text } of trees(JOB_PROMPT)) {
    test(`${tree}: the wave checklist resolves and validates both dispatches`, () => {
      const waves = text.slice(text.indexOf("### Step: TESTS-CREATOR + IMPLEMENT"), text.indexOf("### Step: VERIFY"));
      expect(waves).toContain("resolve-context --for test");
      expect(waves).toContain("resolve-context --for implement");
      expect(waves).toContain("--schema tests-creator-output --resolved");
      expect(waves).toContain("--schema task-implementer-output --resolved");
      const fix = text.slice(text.indexOf("### Step: FIX"), text.indexOf("### Step: REPORT"));
      expect(fix).toContain("resolved_context_file");
    });
  }

  for (const { tree, text } of trees(FLOW_ORCHESTRATOR)) {
    test(`${tree}: flow-orchestrator resolves before test, implement and fix dispatches and validates the reply`, () => {
      const flat = text.replace(/\s+/g, " ");
      expect(flat).toContain("Before every `test`, `implement` and fix dispatch, run `keryx skills resolve-context");
      expect(flat).toContain("pass that path as `resolved_context_file`");
      expect(flat).toContain("--schema task-implementer-output|tests-creator-output --resolved");
    });

    test(`${tree}: the dispatch payload lists the resolved file and the constraint`, () => {
      expect(text).toContain('"path": ".metaproject/flows/<dir>/resolved/<Tn>.<for>.json"');
      expect(text).toContain("resolved_context_file: .metaproject/flows/<dir>/resolved/<Tn>.<for>.json");
    });
  }
});

describe("installed copies", () => {
  for (const relative of [IMPLEMENTER, TESTS_CREATOR, JOB_ORCHESTRATOR, JOB_PROMPT, FLOW_ORCHESTRATOR]) {
    test(`${relative}: the installed copy is byte-identical to the bundled skill`, () => {
      const [bundled, installed] = trees(relative);
      expect(installed!.text).toBe(bundled!.text);
    });
  }

  test("tests-creator still says a project skill only supplements it", () => {
    for (const { text } of trees(TESTS_CREATOR)) {
      expect(text.replace(/\s+/g, " ")).toContain("A project skill only supplements these steps; it never replaces this skill");
    }
  });
});
