import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { installGdskills } from "./install";

test("installs real bundled goodai-base skills, contracts, shared assets, and rules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-gdskills-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const result = await installGdskills(metaprojectRoot, "recommended");

    expect(result.installedSkills).toBeGreaterThan(20);

    const jobOrchestrator = await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "orchestration", "job-orchestrator", "SKILL.md"),
      "utf8",
    );
    expect(jobOrchestrator).toContain("Dynamic orchestrator");
    expect(await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "orchestration", "job-orchestrator", "input-contract.schema.json"),
      "utf8",
    )).toContain("\"$schema\"");

    const reviewOrchestrator = await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "review", "review-orchestrator", "review-context.schema.json"),
      "utf8",
    );
    expect(reviewOrchestrator).toContain("\"$schema\"");

    const generatedMetaprojectSkill = await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "core", "entity-skill-creator", "SKILL.md"),
      "utf8",
    );
    expect(generatedMetaprojectSkill).toContain("Agent Command Contract");

    expect(await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "shared", "git-merge-base.md"),
      "utf8",
    )).toContain("merge-base");
    expect(await readFile(
      path.join(metaprojectRoot, "rules", "core", "git-rules.mdc"),
      "utf8",
    )).toContain("Git");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
