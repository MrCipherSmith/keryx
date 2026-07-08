import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { applyLearningProposal, type LearningProposal } from "./learn";

test("concurrent learning proposal apply succeeds once and rejects the duplicate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-learn-"));
  try {
    const skillRoot = path.join(root, ".metaproject", "project-skills", "alpha", "module");
    const proposalRoot = path.join(root, ".metaproject", "data", "gdskills", "proposals");
    await mkdir(skillRoot, { recursive: true });
    await mkdir(proposalRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, "SKILL.md"),
      [
        "# Alpha Skill",
        "",
        "Version: 0.1.0",
        "Module: alpha",
        "Target: src/alpha",
        "",
        "## Evidence",
        "- Existing evidence",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(skillRoot, "skill-changelog.md"), "# Changelog\n", "utf8");

    const proposal: LearningProposal = {
      schemaVersion: 1,
      proposalId: "alpha-module-test",
      sourceType: "test",
      sourcePath: "reports/test.md",
      skill: {
        module: "alpha",
        name: "module",
        path: ".metaproject/project-skills/alpha/module",
        target: "src/alpha",
      },
      confidence: "high",
      lessons: ["Prefer atomic writes for generated files."],
      suggestedSections: ["Evidence"],
      proposalPath: ".metaproject/data/gdskills/proposals/alpha-module-test.json",
      createdAt: "2026-07-08T00:00:00.000Z",
      dryRun: false,
    };
    await writeFile(
      path.join(proposalRoot, "alpha-module-test.json"),
      `${JSON.stringify(proposal, null, 2)}\n`,
      "utf8",
    );

    const settled = await Promise.allSettled([
      applyLearningProposal(root, proposal.proposalPath),
      applyLearningProposal(root, proposal.proposalPath),
    ]);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain("already applied");
    expect(await readFile(path.join(proposalRoot, "alpha-module-test.applied.json"), "utf8")).toContain("alpha-module-test");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
