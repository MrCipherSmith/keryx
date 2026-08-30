import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { CONTRACTS, contractPath } from "./contracts";
import { installGdskills } from "./install";

test("installs real bundled gdskills, contracts, shared assets, and rules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-gdskills-"));
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
    expect(flowOrchestrator).toContain("How should this flow end?");
    expect(flowOrchestrator).toContain("Verified handoff without PR");
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

test("bundled gdskills do not embed developer-specific absolute paths", async () => {
  const bundledRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "bundled");
  // Guard against a developer's real home directory or machine-specific paths
  // leaking into the portable, bundled skills. The generic placeholders
  // `/Users/dev` and `/Users/...` used in examples are allowed.
  const forbidden = [
    /\/Users\/(?!dev\b|user\b|\.\.\.)[A-Za-z][\w.-]*/,
    /\/home\/(?!dev\b|user\b|\.\.\.)[A-Za-z][\w.-]*/,
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

// `.metaproject/rules/core/` is a generated install target: `installBundledRules`
// copies `src/gdskills/bundled/rules/core/` over it with `force: true` on every
// `keryx init`, `keryx update` and `keryx skills install`.
//
// So an edit made to the installed copy alone ships nowhere and is reverted by
// the next update — silently, because nothing compared the two. That happened:
// the fix correcting this protocol from four statuses to five was written to the
// install target only, and an `installGdskills` run put the stale text back.
//
// The equivalent drift for skills is caught by review discipline; this makes it
// caught by the build.
test("every bundled rule is byte-identical to its installed copy in this repo", async () => {
  const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const source = path.join(repoRoot, "src", "gdskills", "bundled", "rules", "core");
  const installed = path.join(repoRoot, ".metaproject", "rules", "core");

  const drifted: string[] = [];
  for (const file of await listFiles(source)) {
    const relative = path.relative(source, file);
    const target = path.join(installed, relative);
    let targetText: string;
    try {
      targetText = await readFile(target, "utf8");
    } catch {
      drifted.push(`${relative}: missing from .metaproject/rules/core`);
      continue;
    }
    if (await readFile(file, "utf8") !== targetText) {
      drifted.push(`${relative}: bundled source and installed copy differ`);
    }
  }
  expect(drifted).toEqual([]);
});

// The contract mirror had the same drift the rules mirror had, and worse: the
// installer carried its OWN list of five file names beside a registry of five
// entries, and the job-orchestrator state schema was in neither. It could
// therefore not be validated (`keryx skills contracts validate` could not load
// it) and was not installed. `installContracts` now derives from `CONTRACTS`;
// these two tests are what makes that derivation load-bearing.
test("every registered contract is installed into core/gdskills/contracts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-contracts-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    await installGdskills(metaprojectRoot, "recommended");

    // Non-vacuity: the registry must actually name the contract this closes.
    expect(CONTRACTS.map((contract) => contract.name)).toContain("job-orchestrator-state");

    for (const contract of CONTRACTS) {
      const installed = await readFile(
        path.join(metaprojectRoot, "core", "gdskills", "contracts", contract.fileName),
        "utf8",
      );
      expect(installed).toBe(await readFile(contractPath(contract), "utf8"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("this repo's installed contracts are byte-identical to their sources", async () => {
  const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const drifted: string[] = [];
  for (const contract of CONTRACTS) {
    const target = path.join(repoRoot, ".metaproject", "core", "gdskills", "contracts", contract.fileName);
    try {
      if ((await readFile(target, "utf8")) !== (await readFile(contractPath(contract), "utf8"))) {
        drifted.push(`${contract.fileName}: source and installed copy differ`);
      }
    } catch {
      drifted.push(`${contract.fileName}: missing from .metaproject/core/gdskills/contracts`);
    }
  }
  expect(drifted).toEqual([]);
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
