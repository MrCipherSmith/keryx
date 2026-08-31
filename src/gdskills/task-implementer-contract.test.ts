// Flow 210 — `task-implementer`'s claims, and the guards that notice each one
// coming back undone.
//
// THE BASELINE THIS EXISTS AGAINST
//
// The 2026-08-31 measurement scored `task-implementer` **2 wired of 88**, the
// worst of the four orchestrators, and both wired rows were the same mechanism:
// the `STATUS: <TOKEN>` first line `parseChildResult` throws without
// (`src/harness/child/contract.ts`). `src/gdskills/status-contract.test.ts`
// already guards that one and is deliberately not duplicated here.
//
// What this file guards is everything the skill said was checked and nothing
// checked. Three shapes recur:
//
//   1. A contract that no code could load. `input-contract.schema.json` and
//      `output-contract.schema.json` shipped beside the skill and were absent
//      from the `CONTRACTS` registry, so `keryx skills contracts validate` could
//      not name either — while Phase 1.4 listed five `ASSERT … → ABORT(…)`
//      refusals and `task-request.template.md` said "Валидация:
//      input-contract.schema.json".
//   2. A schema that refused its own skill's output. The output contract is
//      `additionalProperties: false` and had no `skill_drift`, which SKILL.md
//      has required emitting since project-skill verification was added.
//   3. A document naming something that does not exist. `wave-executor` —
//      denied in `job-orchestrator`, still described as real in four places in
//      `task-implementer/orchestrator-prompt.md`, and named as an OPEN hole in
//      `agent-catalogue-xref.test.ts`'s own header because that guard matches
//      dispatch positions and not prose. This file closes it for the one name
//      that has recurred three times, by reading the prose.
//
// WHY STRING CHECKS OVER MARKDOWN ARE THE RIGHT INSTRUMENT HERE
//
// The same argument `enforcement-claims.test.ts` makes: in each case the defect
// IS a sentence. A skill that claims a validation nobody registered is a false
// statement about the code, and only something that reads the statement can
// catch it returning. Where a claim has a code-side counterpart — the registry,
// the validator keywords — the assertion is made against the code and the prose
// is checked for agreement, so neither side can drift alone.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CONTRACTS, contractPath, validateJson } from "./contracts";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");

/** Both trees. An edit that lands in one of them has diverged. */
const SKILL_DIRS = [
  path.join(REPO_ROOT, "src", "gdskills", "bundled", "skills", "orchestration", "task-implementer"),
  path.join(REPO_ROOT, ".metaproject", "skills", "gdskills", "orchestration", "task-implementer"),
];

function skillBuilds(): string[] {
  const out: string[] = [];
  for (const dir of SKILL_DIRS) {
    for (const name of readdirSync(dir)) {
      if (name.startsWith("SKILL") && name.endsWith(".md")) out.push(path.join(dir, name));
    }
  }
  return out;
}

function companionFiles(name: string): string[] {
  return SKILL_DIRS.map((dir) => path.join(dir, name));
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function schema(name: "task-implementer-input" | "task-implementer-output"): Record<string, unknown> {
  const contract = CONTRACTS.find((entry) => entry.name === name);
  if (!contract) throw new Error(`not registered: ${name}`);
  return JSON.parse(readFileSync(contractPath(contract), "utf8")) as Record<string, unknown>;
}

/** A request the contract must accept, used as the control in every mutation. */
function validRequest(): Record<string, unknown> {
  return {
    task: {
      task_id: "task-1",
      task_name: "Add validation to pipeline step form",
      task_type: "ui_component",
      description: "Validate required fields before save",
      target_files: ["src/pipelines/components/StepForm.tsx"],
      acceptance_criteria: ["Required fields show validation errors when empty on submit"],
    },
    workspace: {
      codebase_path: "/tmp/project",
      branch: "feature/4141-add-pipeline-validation",
      issue_number: 4141,
    },
    automation: { skip_confirmation: true },
  };
}

/** A result the output contract must accept. */
function validResult(): Record<string, unknown> {
  return {
    task_id: "task-1",
    task_name: "Add validation to pipeline step form",
    task_type: "ui_component",
    status: "success",
  };
}

describe("AC1/AC2: the non-vacuity of this file", () => {
  test("both trees are present and every build is read", () => {
    expect(SKILL_DIRS.every((dir) => existsSync(dir))).toBe(true);
    // Five builds per tree; flow 209 reconciled them and build-parity keeps them so.
    expect(skillBuilds().length).toBe(10);
    for (const file of skillBuilds()) {
      expect(read(file).length).toBeGreaterThan(1000);
    }
  });
});

describe("AC5: the two contracts are loadable, so the refusals are the validator's", () => {
  test("both are registered and resolve to the file that ships with the skill", () => {
    const names = CONTRACTS.map((contract) => contract.name);
    expect(names).toContain("task-implementer-input");
    expect(names).toContain("task-implementer-output");

    for (const name of ["task-implementer-input", "task-implementer-output"] as const) {
      const contract = CONTRACTS.find((entry) => entry.name === name);
      expect(contract?.sourcePath).toContain("orchestration/task-implementer/");
      expect(existsSync(contractPath(contract!))).toBe(true);
    }
  });

  test("the skill and its template point at the command instead of at the file", () => {
    for (const file of skillBuilds()) {
      const text = read(file);
      expect(text).toContain(
        "keryx skills contracts validate <request.json> --schema task-implementer-input",
      );
      // The checklist the command replaced must not come back as the authority.
      expect(text).not.toContain('ASSERT task_id IS NOT EMPTY           → otherwise ABORT("Missing task_id")');
    }
    for (const file of companionFiles("task-request.template.md")) {
      expect(read(file)).toContain(
        "keryx skills contracts validate <request.json> --schema task-implementer-input",
      );
    }
    for (const file of companionFiles("orchestrator-prompt.md")) {
      expect(read(file)).toContain(
        "keryx skills contracts validate <request.json> --schema task-implementer-input",
      );
    }
  });

  test("a well-formed request validates", async () => {
    expect(await validateJson(validRequest(), schema("task-implementer-input"))).toEqual([]);
  });

  test("each ASSERT the skill used to list by hand is now a refusal the schema makes", async () => {
    const input = schema("task-implementer-input");

    // ASSERT task_id IS NOT EMPTY / matches task-<n>
    const noId = validRequest();
    delete (noId.task as Record<string, unknown>).task_id;
    expect(await validateJson(noId, input)).not.toEqual([]);

    const badId = validRequest();
    (badId.task as Record<string, unknown>).task_id = "1";
    expect(await validateJson(badId, input)).not.toEqual([]);

    // ASSERT task_type IN valid_types
    const badType = validRequest();
    (badType.task as Record<string, unknown>).task_type = "database";
    expect(await validateJson(badType, input)).not.toEqual([]);

    // ASSERT target_files IS NOT EMPTY — the `minItems` case, which is why the
    // validator had to learn the keyword before this contract was registered.
    const noFiles = validRequest();
    (noFiles.task as Record<string, unknown>).target_files = [];
    expect(await validateJson(noFiles, input)).not.toEqual([]);

    // ASSERT branch IS NOT EMPTY (present-ness, which is what the schema can say)
    const noBranch = validRequest();
    delete (noBranch.workspace as Record<string, unknown>).branch;
    expect(await validateJson(noBranch, input)).not.toEqual([]);

    // skip_confirmation must be true — `const`, and it was already there.
    const notAutonomous = validRequest();
    (notAutonomous.automation as Record<string, unknown>).skip_confirmation = false;
    expect(await validateJson(notAutonomous, input)).not.toEqual([]);

    // A field nobody declared. Before `additionalProperties: false` the request
    // could carry anything and still read as validated.
    const stray = validRequest();
    (stray.task as Record<string, unknown>).wave = "1";
    expect(await validateJson(stray, input)).not.toEqual([]);
  });

  test("the repair bound is three in the contract too, not five", async () => {
    const input = schema("task-implementer-input");

    const three = validRequest();
    (three.automation as Record<string, unknown>).max_self_fix_attempts = 3;
    expect(await validateJson(three, input)).toEqual([]);

    // `maximum` is the second keyword this validator did not implement. With it
    // ignored, `{minimum: 1, maximum: 5}` accepted 4 and 5 while SKILL.md said 3.
    const four = validRequest();
    (four.automation as Record<string, unknown>).max_self_fix_attempts = 4;
    expect(await validateJson(four, input)).not.toEqual([]);
  });

  test("a fix dispatch validates — its `task_id` and its plural `original_task_ids`", async () => {
    const input = schema("task-implementer-input");
    const fix = validRequest();
    (fix.task as Record<string, unknown>).task_id = "fix-1";
    (fix.task as Record<string, unknown>).task_type = "fix";
    fix.fix_context = { original_task_ids: ["task-1", "task-2"], iteration: 3 };
    expect(await validateJson(fix, input)).toEqual([]);

    // The singular name the schema used to carry, which no dispatch ever sent.
    const singular = validRequest();
    singular.fix_context = { original_task_id: "task-1", iteration: 1 };
    expect(await validateJson(singular, input)).not.toEqual([]);

    // A fourth repair bound: `iteration` was capped at 2 against everyone else's 3.
    const fourth = validRequest();
    fourth.fix_context = { original_task_ids: ["task-1"], iteration: 4 };
    expect(await validateJson(fourth, input)).not.toEqual([]);
  });

  test("the output contract accepts the result SKILL.md tells the worker to write", async () => {
    const output = schema("task-implementer-output");
    expect(await validateJson(validResult(), output)).toEqual([]);

    // `skill_drift` is required by Phase 6.1 and the object is
    // `additionalProperties: false`, so its absence from the schema made every
    // compliant result invalid.
    const withDrift = validResult();
    withDrift.skill_drift = "stale: pipelines/step-store — store gained a private API method";
    expect(await validateJson(withDrift, output)).toEqual([]);

    const badStatus = validResult();
    badStatus.status = "SUCCESS";
    expect(await validateJson(badStatus, output)).not.toEqual([]);
  });

  test("the result file is recorded by the command that refuses when it is missing", () => {
    for (const file of skillBuilds()) {
      const text = read(file);
      expect(text).toContain("keryx job document <JOB_NAME> --type implementation-report");
      expect(text).toContain("--schema task-implementer-output");
      // The reason, kept next to the call so it cannot become a bare incantation.
      expect(text).toContain("refuses when the file does not exist");
    }
  });
});

describe("AC3: claims that were deleted stay deleted", () => {
  test("no file in the skill package describes `wave-executor` as real", () => {
    // The name has been removed three times and returned three times. Denials
    // are allowed — that is what job-orchestrator's SKILL.md:733 carries — so
    // the rule is per line: any line naming it must be denying it.
    const offenders: string[] = [];
    for (const dir of SKILL_DIRS) {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        read(file)
          .split("\n")
          .forEach((line, index) => {
            if (!line.includes("wave-executor")) return;
            if (/there is no |existed in no|named in no/i.test(line)) return;
            offenders.push(`${path.relative(REPO_ROOT, file)}:${index + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the denial is present, so the removal is stated rather than merely silent", () => {
    for (const file of companionFiles("orchestrator-prompt.md")) {
      expect(read(file)).toContain("There is no `wave-executor` agent.");
    }
  });

  test("the skill is loaded from the path the tree actually has", () => {
    // `skills/<name>/SKILL.md` has not existed since the tree was namespaced.
    for (const file of companionFiles("orchestrator-prompt.md")) {
      const text = read(file);
      expect(text).toContain("skills/gdskills/orchestration/task-implementer/SKILL.md");
      expect(text).not.toContain("from skills/task-implementer/SKILL.md");
    }
  });

  test("the contradiction about the final message is gone in both directions", () => {
    for (const file of skillBuilds()) {
      const text = read(file);
      // Rule 10 said "Return the JSON result object as your final message" while
      // 6.2 and `## Reporting Results` said no JSON in the body — and
      // `parseChildResult` throws on a first line that is not a STATUS token.
      expect(text).not.toContain("Return the JSON result object as your **final message**");
      expect(text).toContain("No JSON in the response body");
    }
    for (const file of companionFiles("orchestrator-prompt.md")) {
      expect(read(file)).not.toContain("return JSON result");
    }
  });

  test("the automation settings are declared once, in the contract", () => {
    for (const file of skillBuilds()) {
      const text = read(file);
      // The second copy, which disagreed with Phase 5.4 about the bound.
      expect(text).not.toContain("| `max_self_fix_attempts` | `3` | 1-5 |");
      expect(text).toContain("keryx skills contracts list");
    }
  });

  test("`existing_tests` and `existing_stories` are arrays, as the contract types them", () => {
    for (const file of skillBuilds()) {
      const text = read(file);
      expect(text).not.toContain('If `existing_tests` is not "none"');
      expect(text).toContain("the string `\"none\"` is not a");
    }
  });

  test("Phase 5 calls the commands that detect the toolchain instead of hard-coding npm", () => {
    for (const file of skillBuilds()) {
      const text = read(file);
      expect(text).toContain("keryx health run --changed --source eslint,typescript");
      expect(text).toContain("keryx test run --changed --strict");
      expect(text).not.toContain("npm run type-check");
      expect(text).not.toContain("npm run lint:fix:changed");
    }
  });
});

describe("AC4: the one thing that was already wired is still wired", () => {
  test("every build asks for the STATUS first line and names the reporting section", () => {
    // status-contract.test.ts owns the general form of this. Repeated here
    // because AC4 makes it a precondition of this flow rather than a
    // consequence: whatever else changed, these builds must still be parseable.
    for (const file of skillBuilds()) {
      const text = read(file);
      expect(text).toContain("## Reporting Results");
      expect(text).toContain(
        "Every final response to the orchestrator MUST begin with `STATUS: <STATUS>`",
      );
      expect(text).toContain("STATUS LINE IS MANDATORY");
    }
  });

  test("all five builds carry it, in both trees", () => {
    expect(skillBuilds().filter((file) => read(file).includes("STATUS: DONE")).length).toBe(10);
  });
});

describe("the frontmatter says what is true about the builds", () => {
  test("`compatible_harnesses` names claude, the harness that loads the primary build", () => {
    for (const file of skillBuilds()) {
      expect(read(file)).toContain('compatible_harnesses: "claude,cursor,codex,zed,opencode"');
    }
  });
});
