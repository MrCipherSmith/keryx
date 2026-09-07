import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateJson } from "./contracts";

const root = path.resolve(import.meta.dir, "../..");
const schemaPaths = [
  "src/gdskills/bundled/skills/orchestration/task-implementer/input-contract.schema.json",
  ".metaproject/skills/gdskills/orchestration/task-implementer/input-contract.schema.json",
];

function request(workspace: Record<string, unknown> = {}) {
  return {
    task: {
      task_id: "task-1",
      task_name: "Implement a description-based flow task",
      task_type: "fix",
      description: "Fix a local defect without a GitHub issue",
      target_files: ["src/example.ts"],
      acceptance_criteria: ["The local regression passes"],
    },
    workspace: { codebase_path: "/tmp/project", branch: "codex/example", ...workspace },
    automation: { skip_confirmation: true, auto_commit: false },
  };
}

for (const relativePath of schemaPaths) {
  describe(relativePath, () => {
    const schema = JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));

    test("accepts a description-based flow without inventing an issue", async () => {
      expect(await validateJson(request(), schema)).toEqual([]);
    });

    test("retains compatibility with a real positive issue number", async () => {
      expect(await validateJson(request({ issue_number: 4141 }), schema)).toEqual([]);
    });

    test("rejects invalid supplied issue identifiers", async () => {
      for (const issue_number of [0, -1, 1.5, "4141", null]) {
        expect(await validateJson(request({ issue_number }), schema)).not.toEqual([]);
      }
    });

    test("still requires the project path and branch", async () => {
      for (const field of ["codebase_path", "branch"]) {
        const input = request();
        Reflect.deleteProperty(input.workspace, field);
        expect(await validateJson(input, schema)).not.toEqual([]);
      }
    });
  });
}
