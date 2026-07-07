import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { installGdskills } from "./install";

test("installs real bundled gdskills, contracts, shared assets, and rules", async () => {
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

    const flowOrchestrator = await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "orchestration", "flow-orchestrator", "SKILL.md"),
      "utf8",
    );
    expect(flowOrchestrator).toContain("Task Manager-aware implementation orchestrator");
    expect(await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "orchestration", "flow-orchestrator", "input-contract.schema.json"),
      "utf8",
    )).toContain("FlowOrchestratorInput");

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
    await access(path.join(metaprojectRoot, "jobs"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled gdskills do not depend on external goodai-base paths", async () => {
  const bundledRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "bundled");
  const forbidden = [
    /goodai-base/i,
    /GOODAI_/,
    /\/Users\/tsaitler/,
    /Presight\/Vantage/,
    /\.vantage-frontend/,
    /~\/goodai-base/,
  ];
  const violations: string[] = [];

  for (const filePath of await listFiles(bundledRoot)) {
    const content = await readFile(filePath, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(content)) {
        violations.push(`${path.relative(bundledRoot, filePath)}: ${pattern.source}`);
      }
    }
  }

  expect(violations).toEqual([]);
});

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}
