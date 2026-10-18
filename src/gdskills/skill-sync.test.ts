// Flow 462, AC17: the skills that dispatch or run workers pass the task text to
// the resolver and state what a document promoted by a condition obliges the
// worker to cite; the managed copies under .metaproject carry the same bytes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const BUNDLED = "src/gdskills/bundled/skills";
const MANAGED = ".metaproject/skills/gdskills";
const CONTRACTS = ".metaproject/core/gdskills/contracts";

/** Skill instructions that run or dispatch `keryx skills resolve-context`. */
const instructionFiles = [
  "orchestration/flow-orchestrator/SKILL.md",
  "orchestration/task-implementer/SKILL.md",
  "orchestration/job-orchestrator/SKILL.md",
  "orchestration/job-orchestrator/orchestrator-prompt.md",
  "quality/tests-creator/SKILL.md",
] as const;

const schemaFiles = [
  "orchestration/task-implementer/input-contract.schema.json",
  "orchestration/task-implementer/output-contract.schema.json",
  "quality/tests-creator/input-contract.schema.json",
  "quality/tests-creator/output-contract.schema.json",
] as const;

/** Bundled schema -> its copy under the shared contracts directory (only the ones that have one). */
const contractCopies: ReadonlyArray<readonly [string, string]> = [
  ["orchestration/task-implementer/input-contract.schema.json", "task-implementer-input-contract.schema.json"],
  ["orchestration/task-implementer/output-contract.schema.json", "task-implementer-output-contract.schema.json"],
  ["quality/tests-creator/output-contract.schema.json", "tests-creator-output-contract.schema.json"],
];

const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");
const paragraphs = (text: string): string[] => text.split(/\n\s*\n/);

describe("AC17: instructions pass the task text and name the proof items", () => {
  for (const file of instructionFiles) {
    const text = read(`${BUNDLED}/${file}`);

    test(`${file} passes the task text to resolve-context`, () => {
      expect(text).toMatch(/--task-text/);
    });

    test(`${file} says a promoted entry needs path, sha256, anchor and a summary`, () => {
      const stated = paragraphs(text).some((block) => /condition:/.test(block) && ["path", "sha256", "anchor", "summary"].every((item) => new RegExp(`\\b${item}\\b`).test(block)));
      expect(stated).toBe(true);
    });
  }

  test("the task-implementer and tests-creator output examples carry anchor and summary", () => {
    for (const file of ["orchestration/task-implementer/SKILL.md", "quality/tests-creator/SKILL.md"]) {
      const line = read(`${BUNDLED}/${file}`)
        .split("\n")
        .find((candidate) => candidate.includes("project_context_applied") && candidate.includes("sha256") && candidate.includes("how"));
      expect(line, file).toBeDefined();
      expect(line, file).toMatch(/anchor/);
      expect(line, file).toMatch(/summary/);
    }
  });
});

describe("AC17: managed copies are in sync with the bundled skills", () => {
  for (const file of [...instructionFiles, ...schemaFiles]) {
    test(`${MANAGED}/${file} is byte-identical to the bundled copy`, () => {
      expect(read(`${MANAGED}/${file}`)).toBe(read(`${BUNDLED}/${file}`));
    });
  }

  for (const [bundled, copy] of contractCopies) {
    test(`${CONTRACTS}/${copy} is byte-identical to the bundled ${bundled}`, () => {
      expect(read(`${CONTRACTS}/${copy}`)).toBe(read(`${BUNDLED}/${bundled}`));
    });
  }
});
