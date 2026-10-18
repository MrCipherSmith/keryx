// Flow 462 AC9 — the `project_context_applied` item of the two worker output
// contracts gains optional `anchor` and `summary` strings, so a worker can prove
// it read the section a conditional reference promoted.
//
// What must NOT change is as much the subject as what does: the `how` enum, the
// `additionalProperties: false` that refuses unknown keys, and the validity of
// every result that was valid under flow 461.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONTRACTS, contractPath, validateJson } from "./contracts";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const SHA = "a".repeat(64);
const STYLING = ".metaproject/rules/project/styling.mdc";

const PRODUCERS = ["task-implementer-output", "tests-creator-output"] as const;
type Producer = (typeof PRODUCERS)[number];

/** The bundled source of each contract, then every copy the project syncs from it. */
const SCHEMA_SOURCES: Record<Producer, { source: string; copies: string[] }> = {
  "task-implementer-output": {
    source: "src/gdskills/bundled/skills/orchestration/task-implementer/output-contract.schema.json",
    copies: [
      ".metaproject/skills/gdskills/orchestration/task-implementer/output-contract.schema.json",
      ".metaproject/core/gdskills/contracts/task-implementer-output-contract.schema.json",
    ],
  },
  "tests-creator-output": {
    source: "src/gdskills/bundled/skills/quality/tests-creator/output-contract.schema.json",
    copies: [
      ".metaproject/skills/gdskills/quality/tests-creator/output-contract.schema.json",
      ".metaproject/core/gdskills/contracts/tests-creator-output-contract.schema.json",
    ],
  },
};

function loadSchema(name: Producer): Record<string, unknown> {
  const contract = CONTRACTS.find((entry) => entry.name === name);
  if (!contract) throw new Error(`not registered: ${name}`);
  return JSON.parse(readFileSync(contractPath(contract), "utf8")) as Record<string, unknown>;
}

/** A minimal valid result for the producer, carrying `applied` when given. */
function result(producer: Producer, applied?: unknown): Record<string, unknown> {
  const applying = applied === undefined ? {} : { project_context_applied: applied };
  if (producer === "task-implementer-output") {
    return { task_id: "task-1", task_name: "Add a thing", task_type: "ui_component", status: "success", ...applying };
  }
  return {
    test_case_specs: { framework: "bun:test", test_files: [], run_command: "bun test a", expected_result: "all failing (RED phase)" },
    status_report: { status: "DONE", tests_written: 1, all_criteria_covered: true },
    ...applying,
  };
}

type ItemSchema = { properties: { how: { enum: string[] } }; additionalProperties: boolean; required: string[] };

function itemSchema(producer: Producer): ItemSchema {
  const root = loadSchema(producer) as { properties: { project_context_applied: { items: ItemSchema } } };
  return root.properties.project_context_applied.items;
}

describe("AC9: anchor and summary on project_context_applied items", () => {
  for (const producer of PRODUCERS) {
    describe(producer, () => {
      test("an item with an anchor and a summary validates", async () => {
        const applied = [{ path: STYLING, sha256: SHA, how: "read", anchor: "## Spacing", summary: "Spacing uses the 4px grid and tokens, never raw values." }];
        expect(await validateJson(result(producer, applied), loadSchema(producer))).toEqual([]);
      });

      test("either new field alone validates", async () => {
        const schema = loadSchema(producer);
        expect(await validateJson(result(producer, [{ path: STYLING, sha256: SHA, how: "read", anchor: "## Spacing" }]), schema)).toEqual([]);
        expect(await validateJson(result(producer, [{ path: STYLING, sha256: SHA, how: "followed", summary: "A summary." }]), schema)).toEqual([]);
      });

      test("the new fields are strings and nothing else", async () => {
        const schema = loadSchema(producer);
        for (const bad of [{ anchor: 3 }, { summary: 3 }, { anchor: null }, { summary: ["a"] }]) {
          expect(await validateJson(result(producer, [{ path: STYLING, sha256: SHA, how: "read", ...bad }]), schema)).not.toEqual([]);
        }
      });

      test("the `how` enum is unchanged", async () => {
        expect(itemSchema(producer).properties.how.enum).toEqual(["read", "followed", "n/a"]);
        const schema = loadSchema(producer);
        expect(await validateJson(result(producer, [{ path: STYLING, sha256: SHA, how: "skimmed", anchor: "## Spacing" }]), schema)).not.toEqual([]);
      });

      test("an unknown property is still rejected, with or without the new fields beside it", async () => {
        const schema = loadSchema(producer);
        expect(itemSchema(producer).additionalProperties).toBe(false);
        expect(await validateJson(result(producer, [{ path: STYLING, sha256: SHA, how: "read", why: "because" }]), schema)).not.toEqual([]);
        expect(await validateJson(result(producer, [{ path: STYLING, sha256: SHA, how: "read", anchor: "## Spacing", sumary: "typo" }]), schema)).not.toEqual([]);
      });

      test("path, sha256 and how stay required; the new fields are not", async () => {
        const required = itemSchema(producer).required;
        expect([...required].sort()).toEqual(["how", "path", "sha256"]);
        const schema = loadSchema(producer);
        expect(await validateJson(result(producer, [{ path: STYLING, how: "read", anchor: "## Spacing", summary: "s" }]), schema)).not.toEqual([]);
      });

      test("a flow 461 result (no anchor, no summary) still validates, and so does one with no citations at all", async () => {
        const schema = loadSchema(producer);
        for (const how of ["read", "followed", "n/a"]) {
          expect(await validateJson(result(producer, [{ path: STYLING, sha256: SHA, how }]), schema)).toEqual([]);
        }
        expect(await validateJson(result(producer, []), schema)).toEqual([]);
        expect(await validateJson(result(producer), schema)).toEqual([]);
      });
    });
  }

  test("the synced copies carry the same schema as the bundled source", () => {
    const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const producer of PRODUCERS) {
      const { source, copies } = SCHEMA_SOURCES[producer];
      for (const file of [source, ...copies]) {
        expect(read(file)).toBe(read(source));
        const parsed = JSON.parse(read(file)) as { properties: { project_context_applied: { items: { properties: Record<string, unknown> } } } };
        const properties = parsed.properties.project_context_applied.items.properties;
        expect(Object.keys(properties).sort()).toEqual(["anchor", "how", "path", "sha256", "summary"]);
      }
    }
  });
});
