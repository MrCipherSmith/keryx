import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectReviewers } from "./reviewers";
import { importOverlayReviewers } from "./import-reviewers";
import { renderImportProjectSkillsMarkdown } from "../gdskills/import-skills";

let cwd: string;
let source: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-import-reviewers-"));
  source = await mkdtemp(path.join(tmpdir(), "keryx-vantage-home-"));
  await mkdir(path.join(cwd, ".metaproject", "data", "gdskills"), { recursive: true });
  await writeFile(
    path.join(cwd, ".metaproject", "metaproject.json"),
    `${JSON.stringify({ modules: { gdskills: {} } }, null, 2)}\n`,
    "utf8",
  );
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(source, { recursive: true, force: true });
});

async function writeOverlay(home: string, name: string, body = "overlay body"): Promise<void> {
  const dir = path.join(home, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\nmetadata:\n  category: review\n---\n\n# ${name}\n\n${body}\n`,
    "utf8",
  );
}

async function writeGeneric(home: string, name: string): Promise<void> {
  const dir = path.join(home, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
}

describe("importOverlayReviewers", () => {
  test("a tree of several packages is refused without --only, in this command's own spelling", async () => {
    await writeOverlay(source, "review-vantage-frontend");
    await writeOverlay(source, "review-house-api");
    await writeGeneric(source, "review-logic");
    await writeGeneric(source, "vantage-review");

    let message = "";
    try {
      await importOverlayReviewers({ projectRoot: cwd, from: source });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toStartWith(`keryx review import: ${source} holds 4 packages`);
    for (const name of ["review-house-api", "review-logic", "review-vantage-frontend", "vantage-review"]) {
      expect(message).toContain(`  - ${name}`);
    }
    // The module is implied by this spelling, so the example does not pass it.
    expect(message).toContain(`  keryx review import --from ${source} --only 'review-house-api'`);
    expect((await collectReviewers(cwd)).project).toEqual([]);
  });

  test("no package name is special: a tree that uses another naming imports what --only selects", async () => {
    await writeOverlay(source, "review-house-api");
    await writeOverlay(source, "review-vantage-frontend");
    const result = await importOverlayReviewers({ projectRoot: cwd, from: source, only: ["review-house-*"] });
    expect(result.imported.map((row) => `${row.name}:${row.status}`)).toEqual(["review-house-api:imported"]);
  });

  test("the importer source no longer names one overlay's prefix", async () => {
    for (const file of ["import-reviewers.ts", "../gdskills/import-skills.ts", "../gdskills/catalog.ts"]) {
      const text = await readFile(path.join(import.meta.dir, file), "utf8");
      expect(text).not.toContain("review-vantage-");
    }
  });

  test("--only imports the selected overlays and leaves generic copies alone", async () => {
    await writeOverlay(source, "review-vantage-frontend", "frontend overlay");
    await writeOverlay(source, "review-vantage-styling", "styling overlay");
    await writeGeneric(source, "review-logic");
    await writeGeneric(source, "vantage-review");

    const result = await importOverlayReviewers({ projectRoot: cwd, from: source, only: ["review-vantage-*"] });
    expect(result.imported.map((row) => row.name)).toEqual([
      "review-vantage-frontend",
      "review-vantage-styling",
    ]);
    expect(result.imported.every((row) => row.status === "imported")).toBe(true);

    const inventory = await collectReviewers(cwd);
    expect(inventory.project.map((row) => row.name).sort()).toEqual([
      "review-vantage-frontend",
      "review-vantage-styling",
    ]);
    expect(inventory.project.every((row) => row.drift === "clean")).toBe(true);

    const written = await readFile(
      path.join(cwd, ".metaproject", "project-skills", "review", "review-vantage-frontend", "SKILL.md"),
      "utf8",
    );
    expect(written).toContain("frontend overlay");
    expect(written).toContain("Origin:");
    expect(written).toContain("Origin Hash:");
    expect(written).not.toContain("Provide project-local guidance");
  });

  test("dry-run writes nothing", async () => {
    await writeOverlay(source, "review-vantage-frontend");
    const result = await importOverlayReviewers({ projectRoot: cwd, from: source, dryRun: true });
    expect(result.imported[0]?.status).toBe("would-import");
    // No `.metaproject/skills/gdskills/review` was ever installed in `cwd`, so
    // the bundled half falls back to the keryx package's own review skills
    // (flow 347 T9) rather than reading as empty.
    const inventory = await collectReviewers(cwd);
    expect(inventory.bundledSource).toBe("package");
    expect(inventory.project).toEqual([]);
  });

  test("an existing reviewer is skipped unless --force", async () => {
    await writeOverlay(source, "review-vantage-frontend", "v1");
    await importOverlayReviewers({ projectRoot: cwd, from: source });

    await writeOverlay(source, "review-vantage-frontend", "v2");
    const skipped = await importOverlayReviewers({ projectRoot: cwd, from: source });
    expect(skipped.imported[0]?.status).toBe("skipped");
    const stillV1 = await readFile(
      path.join(cwd, ".metaproject", "project-skills", "review", "review-vantage-frontend", "SKILL.md"),
      "utf8",
    );
    expect(stillV1).toContain("v1");
    expect(stillV1).not.toContain("v2");

    const forced = await importOverlayReviewers({ projectRoot: cwd, from: source, force: true });
    expect(forced.imported[0]?.status).toBe("overwritten");
    const nowV2 = await readFile(
      path.join(cwd, ".metaproject", "project-skills", "review", "review-vantage-frontend", "SKILL.md"),
      "utf8",
    );
    expect(nowV2).toContain("v2");
  });

  test("importing a single overlay package does not pull its siblings", async () => {
    await writeOverlay(source, "review-vantage-frontend");
    await writeOverlay(source, "review-vantage-styling");
    const result = await importOverlayReviewers({
      projectRoot: cwd,
      from: path.join(source, "skills", "review-vantage-frontend"),
    });
    expect(result.imported.map((row) => row.name)).toEqual(["review-vantage-frontend"]);
  });

  test("a tree with no packages is refused rather than reported as imported 0", async () => {
    await mkdir(path.join(source, "skills", "not-a-package"), { recursive: true });
    await expect(importOverlayReviewers({ projectRoot: cwd, from: source })).rejects.toThrow(
      /nothing to import/,
    );
  });

  test("a lone generic copy of a bundled reviewer is skipped, not imported", async () => {
    await writeGeneric(source, "review-logic");
    const result = await importOverlayReviewers({ projectRoot: cwd, from: source });
    expect(result.imported.map((row) => `${row.name}:${row.status}`)).toEqual(["review-logic:skipped"]);
    expect(result.imported[0]?.reason).toMatch(/bundled keryx skill/);
  });

  test("the markdown report names every status", async () => {
    await writeOverlay(source, "review-vantage-frontend");
    const result = await importOverlayReviewers({ projectRoot: cwd, from: source, dryRun: true });
    const rendered = renderImportProjectSkillsMarkdown(result);
    expect(rendered).toContain("would-import");
    expect(rendered).toContain("keryx review reviewers");
  });
});
