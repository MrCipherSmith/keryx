import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createProjectSkill } from "./project-skills";

test("generated project skills include the direct-user execution metrics gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-project-skill-metrics-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    await mkdir(path.join(metaprojectRoot, "skills"), { recursive: true });
    await writeFile(path.join(metaprojectRoot, "metaproject.json"), "{}\n", "utf8");

    const result = await createProjectSkill(root, {
      target: "ExampleService",
      module: "example",
      name: "service",
      format: "single",
    });
    const skill = await readFile(path.join(root, result.skillPath, "SKILL.md"), "utf8");

    expect(skill).toContain(".metaproject/rules/core/execution-metrics.md");
    expect(skill).toContain("invoked directly by a user");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
