import { test, expect } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { learnProjectSkill } from "../gdskills/learn";
import { uniqueTestRoot } from "../lib/test-tmp";

// End-to-end check of the Code Health -> gdskills feedback loop: a health report
// tagged with scope.skill should auto-resolve the owning skill and scope the
// learned lessons to that skill only.
test("learn --from-health resolves the owning skill and scopes lessons", async () => {
  const root = uniqueTestRoot(path.join(import.meta.dir, "..", ".."), ".tmp-skill-loop-test");
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });

  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({
      modules: {
        gdskills: {
          projectSkillRegistry: [
            {
              module: "wiki",
              name: "service",
              target: "src/wiki/service.ts",
              path: ".metaproject/project-skills/wiki/service",
              version: "0.1.0",
              status: "active",
              updatedAt: "t",
            },
            {
              module: "health",
              name: "run",
              target: "src/health/run.ts",
              path: ".metaproject/project-skills/health/run",
              version: "0.1.0",
              status: "active",
              updatedAt: "t",
            },
          ],
        },
      },
    }),
  );

  await writeFile(
    path.join(root, "health.json"),
    JSON.stringify({
      schemaVersion: 1,
      findings: [
        {
          message: "Replace any with a concrete DTO in the wiki service",
          suggestedAction: "Type the payload",
          scope: { skill: "wiki/service" },
        },
        {
          message: "Reduce cyclomatic complexity in the wiki service loader",
          scope: { skill: "wiki/service" },
        },
        {
          message: "Unrelated finding in the health run pipeline module",
          scope: { skill: "health/run" },
        },
      ],
    }),
  );

  try {
    const proposal = await learnProjectSkill(root, {
      sourceType: "health",
      sourcePath: "health.json",
      dryRun: true,
    });

    // Dominant skill (2 findings) auto-resolved without --skill.
    expect(proposal.skill.module).toBe("wiki");
    expect(proposal.skill.name).toBe("service");

    const lessons = proposal.lessons.join(" | ");
    expect(lessons).toContain("wiki service");
    expect(lessons).not.toContain("Unrelated finding");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
