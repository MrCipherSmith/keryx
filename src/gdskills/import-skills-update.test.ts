// `keryx skills update` used to print the import's renderer: `# skills import`,
// `would import (N)`, an `imported: … would-import: …` counts line. And a
// refreshed review package got none of the warnings the same package gets when
// it is imported (no path gate, a dropped metadata.flags entry, a flag
// collision), because only the import computed them.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  importProjectSkills,
  PATHS_NONE_WARNING,
  renderUpdateProjectSkillsMarkdown,
  runSkillsUpdateCommand,
  updateProjectSkills,
} from "./import-skills";

let cwd: string;
let source: string;
const realCwd = process.cwd();
const realLog = console.log;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-update-skills-"));
  source = await mkdtemp(path.join(tmpdir(), "keryx-update-src-"));
  await mkdir(path.join(cwd, ".metaproject", "data", "gdskills"), { recursive: true });
  await writeFile(
    path.join(cwd, ".metaproject", "metaproject.json"),
    `${JSON.stringify({ modules: { gdskills: {} } }, null, 2)}\n`,
    "utf8",
  );
});

afterEach(async () => {
  process.chdir(realCwd);
  console.log = realLog;
  await rm(cwd, { recursive: true, force: true });
  await rm(source, { recursive: true, force: true });
});

/** A review package with no path gate; `extra` is more `metadata:` lines. */
async function writePackage(name: string, extra = "", description = "Use when reviewing house conventions."): Promise<string> {
  const dir = path.join(source, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  category: review\n${extra}---\n\nbody\n`,
    "utf8",
  );
  return dir;
}

async function writeExistingReviewer(name: string, flags: string): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "project-skills", "review", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: "Dispatched for src/${name}/** changes."\nmetadata:\n  flags: "${flags}"\n---\n\nbody\n`,
    "utf8",
  );
}

describe("skills update text output", () => {
  test("a real update has its own heading and counts, not the import's", async () => {
    const dir = await writePackage("review-house");
    await importProjectSkills({ projectRoot: cwd, from: dir });
    const result = await updateProjectSkills({ projectRoot: cwd, skill: "review/review-house" });
    const rendered = renderUpdateProjectSkillsMarkdown(result);
    expect(rendered).toStartWith("# skills update\n");
    expect(rendered).toContain("- review/review-house: updated");
    expect(rendered).toContain("updated: 1 skipped: 0");
    expect(rendered).not.toContain("# skills import");
    expect(rendered).not.toContain("imported:");
    expect(rendered).not.toContain("would-import");
    expect(rendered).not.toContain("force:");
  });

  test("a dry run says would update, never would import", async () => {
    const dir = await writePackage("review-house");
    await importProjectSkills({ projectRoot: cwd, from: dir });
    const result = await updateProjectSkills({ projectRoot: cwd, all: true, dryRun: true });
    const rendered = renderUpdateProjectSkillsMarkdown(result);
    expect(rendered).toContain("## would update (1) — dry run, nothing written\n\n- review/review-house\n");
    expect(rendered).toContain("- review/review-house: would-update");
    expect(rendered).toContain("would-update: 1");
    expect(rendered).not.toMatch(/would[- ]import/);
    expect(rendered).not.toContain("would-overwrite");
  });

  test("--json keeps the shape: statuses and keys are unchanged", async () => {
    const dir = await writePackage("review-house");
    await importProjectSkills({ projectRoot: cwd, from: dir });
    const result = await updateProjectSkills({ projectRoot: cwd, all: true, dryRun: true });
    expect(Object.keys(result).sort()).toEqual(["dryRun", "force", "from", "imported", "only", "rules"]);
    expect(result.imported[0]?.status).toBe("would-overwrite");
  });

  test("runSkillsUpdateCommand prints the update rendering", async () => {
    const dir = await writePackage("review-house");
    await importProjectSkills({ projectRoot: cwd, from: dir });
    const lines: string[] = [];
    console.log = (...parts: unknown[]) => {
      lines.push(parts.join(" "));
    };
    process.chdir(cwd);
    await runSkillsUpdateCommand(["update", "--all", "--dry-run"]);
    expect(lines.join("\n")).toContain("# skills update");
    expect(lines.join("\n")).not.toContain("# skills import");
  });
});

describe("skills update warnings match the import's", () => {
  test("a review package with no path gate gets the dispatched-on-every-round warning, dry run included", async () => {
    const dir = await writePackage("review-house");
    await importProjectSkills({ projectRoot: cwd, from: dir });
    for (const dryRun of [true, false]) {
      const result = await updateProjectSkills({ projectRoot: cwd, all: true, dryRun });
      expect(result.imported[0]?.warnings).toEqual([PATHS_NONE_WARNING]);
      expect(result.imported[0]?.pathsSource).toBe("none");
      expect(renderUpdateProjectSkillsMarkdown(result)).toContain(`  - warning: ${PATHS_NONE_WARNING}`);
    }
  });

  test("a gated package gets no path warning", async () => {
    const dir = await writePackage("review-house", "", "Reviews src/house/** changes.");
    await importProjectSkills({ projectRoot: cwd, from: dir });
    const result = await updateProjectSkills({ projectRoot: cwd, all: true });
    expect(result.imported[0]?.warnings).toBeUndefined();
  });

  test("a metadata.flags entry the inventory drops is a warning on the updated row", async () => {
    const dir = await writePackage("review-house", "  paths: \"src/**\"\n");
    await importProjectSkills({ projectRoot: cwd, from: dir });
    await writePackage("review-house", '  paths: "src/**"\n  flags: "--house, house_ui"\n');
    const result = await updateProjectSkills({ projectRoot: cwd, all: true });
    expect(result.imported[0]?.warnings?.some((warning) => warning.startsWith('metadata.flags: "house_ui" dropped'))).toBe(true);
  });

  test("a flag one other reviewer carries is a collision warning on the update", async () => {
    await writeExistingReviewer("review-house-core", "--house");
    const dir = await writePackage("review-house-ui", '  paths: "src/ui/**"\n');
    await importProjectSkills({ projectRoot: cwd, from: dir });
    await writePackage("review-house-ui", '  paths: "src/ui/**"\n  flags: "--house"\n');
    const result = await updateProjectSkills({ projectRoot: cwd, all: true });
    const row = result.imported.find((entry) => entry.name === "review-house-ui");
    expect(row?.warnings).toEqual([
      "flag --house is carried by one existing project reviewer, review-house-core: it becomes a family flag for both, so --house now selects review-house-core path-gated instead of dispatching it outright.",
    ]);
  });

  test("a non-review package gets no review warnings and no deprecation-by-path warning", async () => {
    const dir = path.join(source, "house-job");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: house-job\nmetadata:\n  category: orchestration\n  deprecated: true\n---\n\nbody\n",
      "utf8",
    );
    await importProjectSkills({ projectRoot: cwd, from: dir });
    const result = await updateProjectSkills({ projectRoot: cwd, all: true });
    expect(result.imported[0]?.warnings).toBeUndefined();
  });
});
