import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  githubBlobToRaw,
  importProjectSkills,
  onlyOption,
  PATHS_NONE_WARNING,
  portableOriginRef,
  renderImportProjectSkillsMarkdown,
  stampImportHeader,
  updateProjectSkills,
} from "./import-skills";
import { verifyProjectSkill } from "./verify";
import { collectReviewers } from "../review/reviewers";

let cwd: string;
let source: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-import-skills-"));
  source = await mkdtemp(path.join(tmpdir(), "keryx-skill-src-"));
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

async function writeSkill(dir: string, name: string, body: string, category = "quality"): Promise<string> {
  const packageDir = path.join(dir, name);
  await mkdir(packageDir, { recursive: true });
  const file = path.join(packageDir, "SKILL.md");
  await writeFile(file, `---\nname: ${name}\nmetadata:\n  category: ${category}\n---\n\n# ${name}\n\n${body}\n`, "utf8");
  return file;
}

describe("githubBlobToRaw", () => {
  test("rewrites a github.com blob URL to raw.githubusercontent.com", () => {
    expect(githubBlobToRaw("https://github.com/org/repo/blob/main/skills/verifier/SKILL.md")).toBe(
      "https://raw.githubusercontent.com/org/repo/main/skills/verifier/SKILL.md",
    );
  });

  test("leaves an already-raw URL alone", () => {
    const raw = "https://raw.githubusercontent.com/org/repo/main/SKILL.md";
    expect(githubBlobToRaw(raw)).toBe(raw);
  });
});

describe("importProjectSkills", () => {
  test("imports a quality verifier from a SKILL.md file into project-skills/quality", async () => {
    const file = path.join(source, "skill-supper.md");
    await writeFile(
      file,
      "---\nname: verifier\nmetadata:\n  category: quality\n---\n\n# Verifier\n\nfrom file\n",
      "utf8",
    );
    const result = await importProjectSkills({
      projectRoot: cwd,
      from: file,
      module: "quality",
      name: "verifier",
    });
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({ name: "verifier", module: "quality", status: "imported" });
    expect(result.imported[0]?.wired).toContain("not auto-injected into flow-orchestrator");
    const written = await readFile(path.join(cwd, ".metaproject", "project-skills", "quality", "verifier", "SKILL.md"), "utf8");
    expect(written).toContain("from file");
    expect(written).toContain("Origin:");
  });

  test("skips a bundled name unless --force", async () => {
    await writeSkill(source, "review-logic", "shadow", "review");
    const skipped = await importProjectSkills({
      projectRoot: cwd,
      from: path.join(source, "review-logic"),
      module: "review",
    });
    expect(skipped.imported[0]?.status).toBe("skipped");
    expect(skipped.imported[0]?.reason).toMatch(/bundled keryx skill/);
  });

  test("fetches a GitHub SKILL.md through the injected fetcher", async () => {
    const result = await importProjectSkills({
      projectRoot: cwd,
      from: "https://github.com/org/repo/blob/main/skills/verifier/SKILL.md",
      module: "quality",
      name: "verifier",
      fetcher: async (url) => {
        expect(url).toBe("https://raw.githubusercontent.com/org/repo/main/skills/verifier/SKILL.md");
        return {
          ok: true,
          status: 200,
          text: "---\nname: verifier\n---\n\n# Verifier\n\nfrom github\n",
        };
      },
    });
    expect(result.imported[0]?.status).toBe("imported");
    const written = await readFile(path.join(cwd, ".metaproject", "project-skills", "quality", "verifier", "SKILL.md"), "utf8");
    expect(written).toContain("from github");
    expect(written).toContain("https://github.com/org/repo/blob/main/skills/verifier/SKILL.md");
  });

  test("refuses a GitHub tree URL and a non-GitHub host", async () => {
    await expect(
      importProjectSkills({
        projectRoot: cwd,
        from: "https://github.com/org/repo/tree/main/skills",
        module: "quality",
        fetcher: async () => ({ ok: true, status: 200, text: "" }),
      }),
    ).rejects.toThrow(/tree URL cannot be listed/);
    await expect(
      importProjectSkills({
        projectRoot: cwd,
        from: "https://example.com/SKILL.md",
        module: "quality",
        fetcher: async () => ({ ok: true, status: 200, text: "" }),
      }),
    ).rejects.toThrow(/https GitHub URL/);
  });
});

describe("tree import selection", () => {
  /**
   * An overlay tree shaped like a real one: one reviewer worth importing, one
   * deprecated alias, one skill that is not a reviewer at all, and one package
   * whose name a bundled keryx skill already owns.
   */
  async function writeOverlayTree(): Promise<string> {
    const skills = path.join(source, "skills");
    const write = async (name: string, frontmatter: string, body: string): Promise<void> => {
      await mkdir(path.join(skills, name), { recursive: true });
      await writeFile(path.join(skills, name, "SKILL.md"), `---\nname: ${name}\n${frontmatter}---\n\n# ${name}\n\n${body}\n`, "utf8");
    };
    await write(
      "review-house",
      'description: "Use when reviewing house conventions. Dispatched for --house."\nmetadata:\n  category: review\n',
      "house reviewer",
    );
    await write(
      "code-old-review",
      'description: "DEPRECATED alias. Use review-house instead."\ndeprecated: true\nmetadata:\n  category: review\n',
      "old alias",
    );
    await write("house-job", "metadata:\n  category: orchestration\n", "not a reviewer");
    await write("review-logic", "metadata:\n  category: review\n", "a copy of a bundled reviewer");
    return skills;
  }

  const installed = (name: string): string =>
    path.join(cwd, ".metaproject", "project-skills", "review", name, "SKILL.md");

  test("a tree of several packages into module review is refused without --only, naming every candidate", async () => {
    await writeOverlayTree();
    let message = "";
    try {
      await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("holds 4 packages");
    expect(message).toContain("--only <glob>");
    for (const name of ["code-old-review", "house-job", "review-house", "review-logic"]) {
      expect(message).toContain(`  - ${name}`);
    }
    expect(message).toContain("code-old-review (deprecated");
    expect(message).toContain("review-logic (bundled keryx skill name");
    // The example names a package that would actually be imported.
    expect(message).toContain("--only 'review-house'");
    // A refusal writes nothing.
    await expect(readFile(installed("review-house"), "utf8")).rejects.toThrow();
  });

  test("the refusal also covers packages that land in review by their own category", async () => {
    const skills = await writeOverlayTree();
    await rm(path.join(skills, "house-job"), { recursive: true });
    await expect(importProjectSkills({ projectRoot: cwd, from: source })).rejects.toThrow(/holds 3 packages/);
  });

  test("--only imports the matching packages and nothing else", async () => {
    await writeOverlayTree();
    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", only: ["review-house"] });
    expect(result.imported.map((row) => `${row.name}:${row.status}`)).toEqual(["review-house:imported"]);
    expect(result.only).toEqual(["review-house"]);
    await expect(readFile(installed("house-job"), "utf8")).rejects.toThrow();
    await expect(readFile(installed("code-old-review"), "utf8")).rejects.toThrow();
  });

  test("--only is a glob, repeatable; a deprecated match is skipped as `deprecated`, a bundled name as a collision", async () => {
    await writeOverlayTree();
    const result = await importProjectSkills({
      projectRoot: cwd,
      from: source,
      module: "review",
      only: ["review-*", "code-*"],
    });
    const byName = Object.fromEntries(result.imported.map((row) => [row.name, row]));
    expect(Object.keys(byName).sort()).toEqual(["code-old-review", "review-house", "review-logic"]);
    expect(byName["review-house"]?.status).toBe("imported");
    expect(byName["code-old-review"]).toMatchObject({ status: "skipped", reason: "deprecated" });
    expect(byName["review-logic"]?.status).toBe("skipped");
    expect(byName["review-logic"]?.reason).toMatch(/bundled keryx skill/);
    await expect(readFile(installed("code-old-review"), "utf8")).rejects.toThrow();
    expect(renderImportProjectSkillsMarkdown(result)).toContain("- review/code-old-review: skipped — deprecated");
  });

  test("an --only that matches nothing is refused with the candidates", async () => {
    await writeOverlayTree();
    await expect(
      importProjectSkills({ projectRoot: cwd, from: source, module: "review", only: ["review-vantage-*"] }),
    ).rejects.toThrow(/--only review-vantage-\* matches none of the 4 packages[\s\S]*- review-house/);
  });

  test("a tree of one package is still a tree: its deprecated package is skipped, and it needs no --only", async () => {
    const skills = await writeOverlayTree();
    for (const name of ["house-job", "review-house", "review-logic"]) {
      await rm(path.join(skills, name), { recursive: true });
    }
    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({ name: "code-old-review", status: "skipped", reason: "deprecated" });
  });

  test("a deprecated package named by its own path is imported, with a warning", async () => {
    const skills = await writeOverlayTree();
    const result = await importProjectSkills({
      projectRoot: cwd,
      from: path.join(skills, "code-old-review"),
      module: "review",
    });
    expect(result.imported[0]).toMatchObject({ name: "code-old-review", status: "imported" });
    expect(result.imported[0]?.warnings?.some((warning) => warning.startsWith("deprecated: true"))).toBe(true);
    expect(await readFile(installed("code-old-review"), "utf8")).toContain("old alias");
    expect(renderImportProjectSkillsMarkdown(result)).toContain("  - warning: deprecated: true");
  });

  test("a review package with no path gate is reported as dispatched on every round", async () => {
    const skills = await writeOverlayTree();
    const result = await importProjectSkills({ projectRoot: cwd, from: path.join(skills, "review-house"), module: "review" });
    expect(result.imported[0]?.pathsSource).toBe("none");
    expect(result.imported[0]?.warnings).toEqual([PATHS_NONE_WARNING]);
    expect(PATHS_NONE_WARNING).toStartWith("paths: none — dispatched on every round");
    expect(PATHS_NONE_WARNING).toContain("metadata.paths");
    expect(renderImportProjectSkillsMarkdown(result)).toContain(`  - warning: ${PATHS_NONE_WARNING}`);
  });

  test("a package that declares metadata.paths, or names a glob in its description, gets no path warning", async () => {
    const skills = path.join(source, "skills");
    await mkdir(path.join(skills, "review-declared"), { recursive: true });
    await writeFile(
      path.join(skills, "review-declared", "SKILL.md"),
      '---\nname: review-declared\ndescription: "House styles."\nmetadata:\n  category: review\n  paths: "src/**/*.css, src/theme/**"\n---\n\nbody\n',
      "utf8",
    );
    await mkdir(path.join(skills, "review-described"), { recursive: true });
    await writeFile(
      path.join(skills, "review-described", "SKILL.md"),
      '---\nname: review-described\ndescription: "Dispatched for src/core/** changes."\nmetadata:\n  category: review\n---\n\nbody\n',
      "utf8",
    );
    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", only: ["review-*"] });
    const byName = Object.fromEntries(result.imported.map((row) => [row.name, row]));
    expect(byName["review-declared"]?.pathsSource).toBe("metadata");
    expect(byName["review-described"]?.pathsSource).toBe("description");
    expect(result.imported.every((row) => row.warnings === undefined)).toBe(true);
  });

  test("the import warning and the reviewer inventory agree on what gates a package", async () => {
    const skills = path.join(source, "skills");
    const packages: Record<string, string> = {
      // A single literal file is a gate; a cited document is not.
      "review-literal": 'description: "Dispatched for src/utils/column-zone.ts changes."\nmetadata:\n  category: review\n',
      "review-cites-doc": 'description: "Rules from src/core/flow/CLAUDE.md and core/reviewing.mdc."\nmetadata:\n  category: review\n',
      "review-bracketed": 'description: "House styles."\nmetadata:\n  category: review\n  paths: ["src/**/*.css", "src/theme/**"]\n',
    };
    for (const [name, frontmatter] of Object.entries(packages)) {
      await mkdir(path.join(skills, name), { recursive: true });
      await writeFile(path.join(skills, name, "SKILL.md"), `---\nname: ${name}\n${frontmatter}---\n\nbody\n`, "utf8");
    }
    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", only: ["review-*"] });
    const imported = Object.fromEntries(result.imported.map((row) => [row.name, row]));
    expect(imported["review-literal"]?.pathsSource).toBe("description");
    expect(imported["review-literal"]?.warnings).toBeUndefined();
    expect(imported["review-cites-doc"]?.pathsSource).toBe("none");
    expect(imported["review-cites-doc"]?.warnings).toEqual([PATHS_NONE_WARNING]);
    expect(imported["review-bracketed"]?.pathsSource).toBe("metadata");

    // One reader: what import said is what `keryx review reviewers` reports.
    const inventory = await collectReviewers(cwd);
    expect(inventory.project.map((reviewer) => [reviewer.name, reviewer.pathsSource])).toEqual(
      Object.keys(packages)
        .sort()
        .map((name) => [name, imported[name]?.pathsSource ?? "absent"]),
    );
  });

  test("the path warning is a review concern: another module gets none, and a skipped package gets none", async () => {
    const skills = await writeOverlayTree();
    const job = await importProjectSkills({ projectRoot: cwd, from: path.join(skills, "house-job") });
    expect(job.imported[0]).toMatchObject({ module: "orchestration", status: "imported" });
    expect(job.imported[0]?.warnings).toBeUndefined();
    expect(job.imported[0]?.pathsSource).toBeUndefined();

    const bundled = await importProjectSkills({ projectRoot: cwd, from: path.join(skills, "review-logic"), module: "review" });
    expect(bundled.imported[0]?.status).toBe("skipped");
    expect(bundled.imported[0]?.warnings).toBeUndefined();
  });

  test("a dry run lists what it would import before the per-package rows, and warns the same way", async () => {
    await writeOverlayTree();
    const result = await importProjectSkills({
      projectRoot: cwd,
      from: source,
      module: "review",
      only: ["review-*", "code-*"],
      dryRun: true,
    });
    const rendered = renderImportProjectSkillsMarkdown(result);
    expect(rendered).toContain("## would import (1) — dry run, nothing written\n\n- review/review-house\n");
    expect(rendered.indexOf("## would import")).toBeLessThan(rendered.indexOf("- review/review-house: would-import"));
    expect(rendered).toContain(`  - warning: ${PATHS_NONE_WARNING}`);
    await expect(readFile(installed("review-house"), "utf8")).rejects.toThrow();
  });

  test("a real import carries no dry-run section", async () => {
    const skills = await writeOverlayTree();
    const result = await importProjectSkills({ projectRoot: cwd, from: path.join(skills, "review-house"), module: "review" });
    expect(renderImportProjectSkillsMarkdown(result)).not.toContain("## would import");
  });
});

describe("package names that are not already slugs", () => {
  const installed = (name: string): string =>
    path.join(cwd, ".metaproject", "project-skills", "review", name, "SKILL.md");

  async function writePackage(name: string, body: string): Promise<void> {
    const dir = path.join(source, "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\ndescription: "Reviews src/** changes."\n---\n\n${body}\n`, "utf8");
  }

  test("the bundled-name guard and the exists guard test the name the writer uses", async () => {
    // The writer slugs a package name; the guards used to test the raw one. So
    // `review_logic` slipped past the bundled-name guard and was registered as
    // `review-logic`, and `review_house_api` overwrote an existing
    // `review-house-api` without --force.
    await writePackage("review-house-api", "the project's own");
    await importProjectSkills({ projectRoot: cwd, from: path.join(source, "skills", "review-house-api"), module: "review" });
    await rm(path.join(source, "skills", "review-house-api"), { recursive: true });
    const before = await readFile(installed("review-house-api"), "utf8");

    await writePackage("review_logic", "a shadow of a bundled reviewer");
    await writePackage("review_house_api", "another tree's package");

    for (const dryRun of [true, false]) {
      const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", only: ["review*"], dryRun });
      expect(result.imported.map((row) => [row.name, row.status, row.path])).toEqual([
        ["review-house-api", "skipped", ".metaproject/project-skills/review/review-house-api"],
        ["review-logic", "skipped", ".metaproject/project-skills/review/review-logic"],
      ]);
      expect(result.imported[0]?.reason).toBe("already exists; pass --force to overwrite");
      expect(result.imported[1]?.reason).toMatch(/bundled keryx skill/);
    }
    expect(await readFile(installed("review-house-api"), "utf8")).toBe(before);
    await expect(readFile(installed("review-logic"), "utf8")).rejects.toThrow();
    expect((await collectReviewers(cwd)).project.map((reviewer) => reviewer.name)).toEqual(["review-house-api"]);
  });

  test("the reported row names the directory the package was written to", async () => {
    await writePackage("Review_House.API", "body");
    for (const dryRun of [true, false]) {
      const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "Review", dryRun });
      expect(result.imported[0]).toMatchObject({
        name: "review-house-api",
        module: "review",
        status: dryRun ? "would-import" : "imported",
        path: ".metaproject/project-skills/review/review-house-api",
        // A review package by its slugged module, so it is told what gates it.
        pathsSource: "description",
      });
    }
    expect(await readFile(installed("review-house-api"), "utf8")).toContain("body");
  });

  test("--only matches the directory name as it is on disk, and the refusal lists that spelling", async () => {
    await writePackage("review_house_api", "body");
    await writePackage("review_other", "body");
    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", only: ["review_house*"] });
    expect(result.imported.map((row) => row.name)).toEqual(["review-house-api"]);
    // The slug is not what the operator sees in the tree, so it is not what a glob is matched against.
    await expect(
      importProjectSkills({ projectRoot: cwd, from: source, module: "review", only: ["review-house*"] }),
    ).rejects.toThrow(/matches none of the 2 packages[\s\S]* {2}- review_house_api\n {2}- review_other/);
  });

  test("the refusal marks a directory whose slug is a bundled name", async () => {
    await writePackage("review_logic", "body");
    await writePackage("review_other", "body");
    await expect(importProjectSkills({ projectRoot: cwd, from: source, module: "review" })).rejects.toThrow(
      /- review_logic \(bundled keryx skill name[\s\S]*--only 'review_other'/,
    );
  });

  test("two directories that slug to one name are refused, and nothing is written", async () => {
    await writePackage("review_house", "one");
    await writePackage("review.house", "two");
    await expect(
      importProjectSkills({ projectRoot: cwd, from: source, module: "review", only: ["review*"] }),
    ).rejects.toThrow(/review\.house and review_house both import as review\/review-house/);
    await expect(readFile(installed("review-house"), "utf8")).rejects.toThrow();
  });
});

describe("--only globs", () => {
  async function writeTree(names: string[]): Promise<void> {
    for (const name of names) {
      await mkdir(path.join(source, "skills", name), { recursive: true });
      await writeFile(path.join(source, "skills", name, "SKILL.md"), `---\ndescription: "Reviews src/** changes."\n---\n\nbody\n`, "utf8");
    }
  }

  const selectedBy = async (only: string[]): Promise<string[]> =>
    (await importProjectSkills({ projectRoot: cwd, from: source, module: "review", only, dryRun: true })).imported.map(
      (row) => row.name,
    );

  test("a glob is anchored at both ends: a name that only contains it is not selected", async () => {
    await writeTree(["review-house", "review-house-api", "my-review-house"]);
    expect(await selectedBy(["review-house"])).toEqual(["review-house"]);
    expect(await selectedBy(["review-house*"])).toEqual(["review-house", "review-house-api"]);
    expect(await selectedBy(["*review-house"])).toEqual(["my-review-house", "review-house"]);
  });

  test("`?` is exactly one character", async () => {
    await writeTree(["review-a", "review-ab", "review-"]);
    expect(await selectedBy(["review-?"])).toEqual(["review-a"]);
  });

  test("every other character is literal: a dot does not match any character", async () => {
    await writeTree(["review.v2", "reviewXv2", "review+", "revieww"]);
    expect(await selectedBy(["review.v2"])).toEqual(["review-v2"]);
    expect(await selectedBy(["review+"])).toEqual(["review"]);
  });

  test("an empty glob is an error, never `no selection`", async () => {
    // Dropped silently, it left `--module quality --only ""` importing the whole tree.
    await writeTree(["alpha", "beta"]);
    for (const only of [[""], ["alpha", "  "]]) {
      await expect(importProjectSkills({ projectRoot: cwd, from: source, module: "quality", only })).rejects.toThrow(
        /keryx skills import: --only needs a glob; an empty value selects nothing/,
      );
    }
    await expect(readFile(path.join(cwd, ".metaproject", "project-skills", "quality", "alpha", "SKILL.md"), "utf8")).rejects.toThrow();
  });
});

describe("onlyOption", () => {
  test("returns every glob, in both spellings", () => {
    expect(onlyOption(["--from", "x", "--only", "review-*", "--only=code-*"], "keryx skills import")).toEqual(["review-*", "code-*"]);
    expect(onlyOption(["--from", "x"], "keryx skills import")).toEqual([]);
  });

  test("an --only with an empty value, or none, is refused in the command's own spelling", () => {
    for (const args of [["--only", ""], ["--only="], ["--only", "--json"], ["--only", "a", "--only"]]) {
      expect(() => onlyOption(["--from", "x", ...args], "keryx review import")).toThrow(
        /^keryx review import: --only needs a glob/,
      );
    }
  });
});

describe("frontmatter is read from the frontmatter block only", () => {
  test("a `category:` line in the body does not choose the module", async () => {
    // A fenced example in a body made a non-review tree "target module review".
    const body = "Example frontmatter:\n\n```yaml\nmetadata:\n  category: review\n```\n\ncategory: review\n";
    for (const name of ["alpha", "beta"]) {
      await mkdir(path.join(source, "skills", name), { recursive: true });
      await writeFile(
        path.join(source, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ncategory: quality\n---\n\n${body}`,
        "utf8",
      );
    }
    const result = await importProjectSkills({ projectRoot: cwd, from: source });
    expect(result.imported.map((row) => `${row.module}/${row.name}:${row.status}`)).toEqual([
      "quality/alpha:imported",
      "quality/beta:imported",
    ]);
  });

  test("a body-only `category:` leaves the module to be inferred or asked for", async () => {
    const dir = path.join(source, "skills", "helper");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: helper\n---\n\n  category: review\ncategory: review\n", "utf8");
    await expect(importProjectSkills({ projectRoot: cwd, from: dir })).rejects.toThrow(/cannot infer module for helper/);
  });

  test("top-level and metadata `category` both count, metadata first, quotes stripped", async () => {
    const file = path.join(source, "one.md");
    await writeFile(file, '---\nname: one\ncategory: "quality"\n---\n\nbody\n', "utf8");
    expect((await importProjectSkills({ projectRoot: cwd, from: file, dryRun: true })).imported[0]?.module).toBe("quality");
    await writeFile(file, "---\nname: one\ncategory: quality\nmetadata:\n  category: 'planning'\n---\n\nbody\n", "utf8");
    expect((await importProjectSkills({ projectRoot: cwd, from: file, dryRun: true })).imported[0]?.module).toBe("planning");
  });

  test("a `name:` line in the body does not name a SKILL.md imported by file", async () => {
    const dir = path.join(source, "skills", "house-helper");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    await writeFile(file, "---\ndescription: helper\n---\n\nExample:\n\nname: review-logic\n", "utf8");
    const result = await importProjectSkills({ projectRoot: cwd, from: file, module: "quality", dryRun: true });
    expect(result.imported[0]).toMatchObject({ name: "house-helper", status: "would-import" });

    await writeFile(file, '---\nname: "named-in-frontmatter"\n---\n\nname: review-logic\n', "utf8");
    const named = await importProjectSkills({ projectRoot: cwd, from: file, module: "quality", dryRun: true });
    expect(named.imported[0]?.name).toBe("named-in-frontmatter");
  });

  test("a `deprecated: true` line in the body does not skip a package", async () => {
    const dir = path.join(source, "skills", "review-house");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: review-house\n---\n\ndeprecated: true\n  deprecated: true\n", "utf8");
    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", dryRun: true });
    expect(result.imported[0]?.status).toBe("would-import");
  });
});

describe("updateProjectSkills", () => {
  test("overwrites a local-review-skill from a new origin file", async () => {
    const original = path.join(source, "original.md");
    await writeFile(original, "---\nname: local-review-skill\n---\n\nold body\n", "utf8");
    await importProjectSkills({
      projectRoot: cwd,
      from: original,
      module: "review",
      name: "local-review-skill",
    });

    const supper = path.join(source, "skill-supper.md");
    await writeFile(supper, "---\nname: local-review-skill\n---\n\nnew supper body\n", "utf8");
    const updated = await updateProjectSkills({
      projectRoot: cwd,
      skill: "review/local-review-skill",
      from: supper,
    });
    expect(updated.imported[0]?.status).toBe("updated");
    const written = await readFile(
      path.join(cwd, ".metaproject", "project-skills", "review", "local-review-skill", "SKILL.md"),
      "utf8",
    );
    expect(written).toContain("new supper body");
    expect(written).not.toContain("old body");
  });
});

describe("imported skill header", () => {
  test("keeps Version (from metadata.version), Target, Status and Last Verified, and registers the author's version", async () => {
    const dir = path.join(source, "skills", "review-house");
    await mkdir(dir, { recursive: true });
    const body = "# House reviewer\n\nbody stays byte-for-byte\n";
    await writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: review-house\nmetadata:\n  version: "2.0.0"\n  category: review\n---\n\n${body}`,
      "utf8",
    );
    await importProjectSkills({ projectRoot: cwd, from: path.join(source, "skills"), module: "review" });

    const skillMd = path.join(cwd, ".metaproject", "project-skills", "review", "review-house", "SKILL.md");
    const written = await readFile(skillMd, "utf8");
    // `keryx skills verify` reads exactly these labels. Dropping them made every
    // imported skill `stale` and unable to record a verification.
    expect(written).toMatch(/^Version: 2\.0\.0$/m);
    expect(written).toMatch(/^Target: review-house$/m);
    expect(written).toMatch(/^Status: active$/m);
    expect(written).toMatch(/^Last Verified: never$/m);
    expect(written.endsWith(body)).toBe(true);

    const manifest = JSON.parse(await readFile(path.join(cwd, ".metaproject", "metaproject.json"), "utf8"));
    expect(manifest.modules.gdskills.projectSkillRegistry[0].version).toBe("2.0.0");

    const report = await verifyProjectSkill(cwd, { input: "review/review-house" });
    expect(report.signals.filter((signal) => signal.name.startsWith("metadata:") && signal.status === "fail")).toEqual([]);
    expect(await readFile(skillMd, "utf8")).toMatch(/^Last Verified: 20\d\d-/m);
  });

  test("re-stamping replaces an earlier header instead of stacking a second one", () => {
    const once = stampImportHeader("---\nname: x\n---\n# Body\n", "Version: 1.0.0\nStatus: active\n");
    const twice = stampImportHeader(once, "Version: 2.0.0\nStatus: active\n");
    expect(twice).toBe("---\nname: x\n---\nVersion: 2.0.0\nStatus: active\n# Body\n");
  });

  test("a Status: line in the author's body is left alone", () => {
    const stamped = stampImportHeader("---\nname: x\n---\n# Body\nStatus: draft\n", "Version: 1.0.0\n");
    expect(stamped).toContain("# Body\nStatus: draft\n");
  });
});

describe("portableOriginRef", () => {
  test("project-relative inside the project, ~/ under home, absolute otherwise", () => {
    expect(portableOriginRef("/work/proj/docs/rule.md", "/work/proj", "/home/me")).toBe("docs/rule.md");
    expect(portableOriginRef("/home/me/.overlay/skills/a/SKILL.md", "/work/proj", "/home/me")).toBe(
      "~/.overlay/skills/a/SKILL.md",
    );
    expect(portableOriginRef("/opt/skills/a/SKILL.md", "/work/proj", "/home/me")).toBe("/opt/skills/a/SKILL.md");
  });
});

/** What the import prints once, under the rule rows, when a rule went to its project slot. */
const PROJECT_SLOT_PARAGRAPH = [
  "A reviewer that cites `<dir>/<name>.mdc` reads `.metaproject/rules/project/<dir>/<name>.mdc` when that file exists,",
  "and `.metaproject/rules/<dir>/<name>.mdc` otherwise. `keryx init`, `keryx update` and `keryx skills install` overwrite",
  "rules/core with keryx's own rules and leave rules/project alone. `keryx review reviewers` lists each such reference",
  "under `shadowedRules`.",
].join("\n");

describe("rules the imported skills cite", () => {
  async function writeOverlaySkill(name: string, body: string): Promise<void> {
    const dir = path.join(source, "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\nmetadata:\n  category: review\n---\n\n${body}\n`, "utf8");
  }

  test("copies a missing rule from the overlay, keeps a present one, reports one it cannot find", async () => {
    await writeOverlaySkill("review-house", "Round contract: `core/house-round.mdc`. Style: `core/house-style.mdc`. Also `core/nowhere.mdc`.");
    await mkdir(path.join(source, "rules", "core"), { recursive: true });
    await writeFile(path.join(source, "rules", "core", "house-round.mdc"), "# round\n", "utf8");
    await mkdir(path.join(cwd, ".metaproject", "rules", "core"), { recursive: true });
    await writeFile(path.join(cwd, ".metaproject", "rules", "core", "house-style.mdc"), "# local style\n", "utf8");

    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    const byRef = Object.fromEntries(result.rules.map((rule) => [rule.ref, rule]));
    expect(byRef["core/house-round.mdc"]?.status).toBe("imported");
    expect(byRef["core/house-style.mdc"]?.status).toBe("present");
    expect(byRef["core/nowhere.mdc"]?.status).toBe("unresolved");
    expect(byRef["core/house-round.mdc"]?.citedBy).toEqual(["review-house"]);
    expect(await readFile(path.join(cwd, ".metaproject", "rules", "core", "house-round.mdc"), "utf8")).toBe("# round\n");
    // A present rule is the project's; the overlay never overwrites it.
    expect(await readFile(path.join(cwd, ".metaproject", "rules", "core", "house-style.mdc"), "utf8")).toBe("# local style\n");
  });

  test("dry-run copies nothing, and a re-run over skipped skills still fetches their rules", async () => {
    await writeOverlaySkill("review-house", "Round contract: `core/house-round.mdc`.");
    await mkdir(path.join(source, "rules", "core"), { recursive: true });
    await writeFile(path.join(source, "rules", "core", "house-round.mdc"), "# round\n", "utf8");
    const target = path.join(cwd, ".metaproject", "rules", "core", "house-round.mdc");

    const dry = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", dryRun: true });
    expect(dry.rules[0]?.status).toBe("would-import");
    await expect(readFile(target, "utf8")).rejects.toThrow();

    await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    await rm(target);
    const rerun = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    expect(rerun.imported[0]?.status).toBe("skipped");
    expect(rerun.rules[0]?.status).toBe("imported");
  });

  test("a rule name keryx ships that the overlay does not provide stays unresolved", async () => {
    await writeOverlaySkill("review-house", "Git: `core/git-rules.mdc`.");

    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    expect(result.rules[0]).toMatchObject({ ref: "core/git-rules.mdc", status: "unresolved" });
    expect(result.rules[0]?.reason).toContain("run `keryx skills install` to restore it");
  });

  test("a rule name keryx ships that the overlay provides lands in rules/project, never rules/core", async () => {
    await writeOverlaySkill("review-house", "Git: `core/git-rules.mdc`.");
    await mkdir(path.join(source, "rules", "core"), { recursive: true });
    await writeFile(path.join(source, "rules", "core", "git-rules.mdc"), "# overlay git rules\n", "utf8");
    const projectCopy = path.join(cwd, ".metaproject", "rules", "project", "core", "git-rules.mdc");

    const dry = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", dryRun: true });
    expect(dry.rules[0]).toMatchObject({
      ref: "core/git-rules.mdc",
      status: "would-import-project",
      target: ".metaproject/rules/project/core/git-rules.mdc",
    });
    await expect(readFile(projectCopy, "utf8")).rejects.toThrow();

    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    // `keryx init` / `update` / `skills install` rewrite rules/core/<bundled
    // name> on every run; an overlay copy there would be silently replaced by a
    // different file.
    expect(result.rules[0]).toMatchObject({ ref: "core/git-rules.mdc", status: "imported-project" });
    expect(await readFile(projectCopy, "utf8")).toBe("# overlay git rules\n");
    await expect(readFile(path.join(cwd, ".metaproject", "rules", "core", "git-rules.mdc"), "utf8")).rejects.toThrow();
    const markdown = renderImportProjectSkillsMarkdown(result);
    expect(markdown).toContain(
      `- core/git-rules.mdc: imported-project — keryx ships a rule under this name; the overlay's was written to .metaproject/rules/project/core/git-rules.mdc, which is the file the reviewer reads — from ${result.rules[0]?.origin} (cited by review-house)`,
    );
    expect(markdown).toContain(PROJECT_SLOT_PARAGRAPH);
    // Every command the paragraph names exists.
    expect(markdown).not.toContain("`keryx install`");
  });

  test("two cited rules that share a filename each get their own file, and a dry run names the same destinations", async () => {
    // The project slot was keyed on the basename: `core/git-rules.mdc` took
    // `rules/project/git-rules.mdc`, `house/git-rules.mdc` was then reported as
    // differing from that just-written file and installed nowhere — after a dry
    // run had promised it `rules/house/git-rules.mdc`.
    await writeOverlaySkill("review-house", "Git: `core/git-rules.mdc`. House git: `house/git-rules.mdc`.");
    await mkdir(path.join(source, "rules", "core"), { recursive: true });
    await mkdir(path.join(source, "rules", "house"), { recursive: true });
    await writeFile(path.join(source, "rules", "core", "git-rules.mdc"), "# overlay core git\n", "utf8");
    await writeFile(path.join(source, "rules", "house", "git-rules.mdc"), "# overlay house git\n", "utf8");

    const destinations = {
      "core/git-rules.mdc": ".metaproject/rules/project/core/git-rules.mdc",
      "house/git-rules.mdc": ".metaproject/rules/house/git-rules.mdc",
    };
    const targets = (result: Awaited<ReturnType<typeof importProjectSkills>>): Record<string, string | undefined> =>
      Object.fromEntries(result.rules.map((rule) => [rule.ref, rule.target]));

    const dry = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", dryRun: true });
    expect(targets(dry)).toEqual(destinations);
    expect(dry.rules.map((rule) => rule.status)).toEqual(["would-import-project", "would-import"]);

    const real = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    expect(targets(real)).toEqual(destinations);
    expect(real.rules.map((rule) => rule.status)).toEqual(["imported-project", "imported"]);
    expect(await readFile(path.join(cwd, destinations["core/git-rules.mdc"]), "utf8")).toBe("# overlay core git\n");
    expect(await readFile(path.join(cwd, destinations["house/git-rules.mdc"]), "utf8")).toBe("# overlay house git\n");

    const [reviewer] = (await collectReviewers(cwd)).project;
    expect(reviewer?.shadowedRules).toEqual([
      { ref: "core/git-rules.mdc", resolved: ".metaproject/rules/project/core/git-rules.mdc" },
    ]);
    expect(reviewer?.unresolvedRules).toEqual([]);

    const rerun = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    expect(rerun.rules.map((rule) => [rule.status, rule.existing])).toEqual([
      ["present", destinations["core/git-rules.mdc"]],
      ["present", destinations["house/git-rules.mdc"]],
    ]);
  });

  test("a collision under a name keryx does not ship also goes to the project slot, not over the project's file", async () => {
    await writeOverlaySkill("review-house", "Naming: `house/naming.mdc`.");
    await mkdir(path.join(source, "rules", "house"), { recursive: true });
    await writeFile(path.join(source, "rules", "house", "naming.mdc"), "# overlay naming\n", "utf8");
    const own = path.join(cwd, ".metaproject", "rules", "house", "naming.mdc");
    await mkdir(path.dirname(own), { recursive: true });
    await writeFile(own, "# the project's naming\n", "utf8");

    const expected = {
      ref: "house/naming.mdc",
      status: "differs",
      existing: ".metaproject/rules/house/naming.mdc",
      target: ".metaproject/rules/project/house/naming.mdc",
    };
    const dry = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", dryRun: true });
    expect(dry.rules).toHaveLength(1);
    expect(dry.rules[0]).toMatchObject({ ...expected, written: false });

    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    expect(result.rules[0]).toMatchObject({ ...expected, written: true });
    expect(await readFile(own, "utf8")).toBe("# the project's naming\n");
    expect(await readFile(path.join(cwd, expected.target), "utf8")).toBe("# overlay naming\n");
    expect(renderImportProjectSkillsMarkdown(result)).toContain(PROJECT_SLOT_PARAGRAPH);
  });

  test("a package skipped as deprecated or as a bundled name brings no rules; --force brings the bundled-named one's", async () => {
    await writeOverlaySkill("review-house", "Standard: `house/kept.mdc`.");
    await writeOverlaySkill("review_logic", "Standard: `house/of-bundled-name.mdc`.");
    const deprecated = path.join(source, "skills", "code-old", "SKILL.md");
    await mkdir(path.dirname(deprecated), { recursive: true });
    await writeFile(deprecated, "---\nname: code-old\ndeprecated: true\n---\n\nStandard: `house/of-deprecated.mdc`.\n", "utf8");
    await mkdir(path.join(source, "rules", "house"), { recursive: true });
    for (const name of ["kept", "of-bundled-name", "of-deprecated"]) {
      await writeFile(path.join(source, "rules", "house", `${name}.mdc`), `# ${name}\n`, "utf8");
    }
    const only = ["*"];

    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", only, dryRun: true });
    expect(result.rules.map((rule) => rule.ref)).toEqual(["house/kept.mdc"]);

    const forced = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", only, dryRun: true, force: true });
    expect(forced.rules.map((rule) => [rule.ref, rule.citedBy])).toEqual([
      ["house/kept.mdc", ["review-house"]],
      ["house/of-bundled-name.mdc", ["review-logic"]],
    ]);
  });

  describe("the security gate on a rule's text", () => {
    // Assembled at run time so no scanner reads this file as holding a key.
    const SECRET = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    // A number under a credential key has no safe representation: refused outright.
    const UNSAFE = JSON.stringify({ password: 123456789 });

    beforeEach(async () => {
      await writeOverlaySkill("review-house", "Standard: `house/gated.mdc`.");
      await mkdir(path.join(source, "rules", "house"), { recursive: true });
    });

    test("a rule the gate rewrote is `present` on a re-run, not a difference to write again", async () => {
      await writeFile(path.join(source, "rules", "house", "gated.mdc"), `# gated\n\nkey ${SECRET}\n`, "utf8");
      const first = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
      expect(first.rules[0]).toMatchObject({ status: "imported", target: ".metaproject/rules/house/gated.mdc" });
      const written = await readFile(path.join(cwd, ".metaproject", "rules", "house", "gated.mdc"), "utf8");
      expect(written).not.toContain(SECRET);
      expect(written).toContain("# gated");

      const rerun = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
      expect(rerun.rules[0]).toMatchObject({ status: "present", existing: ".metaproject/rules/house/gated.mdc" });
      await expect(readFile(path.join(cwd, ".metaproject", "rules", "project", "house", "gated.mdc"), "utf8")).rejects.toThrow();
    });

    test("a rule the gate refuses is `unresolved`, with the reason, and is not written", async () => {
      await writeFile(path.join(source, "rules", "house", "gated.mdc"), UNSAFE, "utf8");
      const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
      expect(result.rules[0]).toMatchObject({ ref: "house/gated.mdc", status: "unresolved" });
      expect(result.rules[0]?.reason).toStartWith("blocked by the security gate: ");
      expect(result.rules[0]?.target).toBeUndefined();
      await expect(readFile(path.join(cwd, ".metaproject", "rules", "house", "gated.mdc"), "utf8")).rejects.toThrow();
    });

    test("a refused rule that collides stays `differs`, unwritten, and the project's file is the one read", async () => {
      await writeFile(path.join(source, "rules", "house", "gated.mdc"), UNSAFE, "utf8");
      const own = path.join(cwd, ".metaproject", "rules", "house", "gated.mdc");
      await mkdir(path.dirname(own), { recursive: true });
      await writeFile(own, "# the project's\n", "utf8");

      const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
      expect(result.rules[0]).toMatchObject({
        status: "differs",
        existing: ".metaproject/rules/house/gated.mdc",
        target: ".metaproject/rules/project/house/gated.mdc",
        written: false,
      });
      expect(result.rules[0]?.reason).toStartWith("blocked by the security gate: ");
      await expect(readFile(path.join(cwd, ".metaproject", "rules", "project", "house", "gated.mdc"), "utf8")).rejects.toThrow();
      expect(await readFile(own, "utf8")).toBe("# the project's\n");
      expect(renderImportProjectSkillsMarkdown(result)).toContain("the reviewer reads .metaproject/rules/house/gated.mdc");
    });
  });

  describe("a reference that names rules/project itself", () => {
    test("is the literal file: present without a redirect note, and no project-slot paragraph", async () => {
      await writeOverlaySkill("review-house", "Standard: `project/house.mdc`.");
      const own = path.join(cwd, ".metaproject", "rules", "project", "house.mdc");
      await mkdir(path.dirname(own), { recursive: true });
      await writeFile(own, "# the project's\n", "utf8");

      const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
      expect(result.rules[0]).toMatchObject({
        ref: "project/house.mdc",
        status: "present",
        existing: ".metaproject/rules/project/house.mdc",
      });
      const markdown = renderImportProjectSkillsMarkdown(result);
      expect(markdown).toContain("- project/house.mdc: present (cited by review-house)");
      expect(markdown).not.toContain(PROJECT_SLOT_PARAGRAPH);
      expect((await collectReviewers(cwd)).project[0]).toMatchObject({ shadowedRules: [], unresolvedRules: [] });
    });

    test("is imported to the path it names, as a plain `imported`", async () => {
      await writeOverlaySkill("review-house", "Standard: `project/house.mdc`.");
      await mkdir(path.join(source, "rules", "project"), { recursive: true });
      await writeFile(path.join(source, "rules", "project", "house.mdc"), "# overlay\n", "utf8");

      const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
      expect(result.rules[0]).toMatchObject({ status: "imported", target: ".metaproject/rules/project/house.mdc" });
      expect(renderImportProjectSkillsMarkdown(result)).not.toContain(PROJECT_SLOT_PARAGRAPH);
    });
  });

  describe("a cited rule that collides by filename with one the project already has", () => {
    const GENERIC = "# keryx generic store template\n";
    const OVERLAY = "# overlay store template\n";
    let coreCopy: string;
    let projectCopy: string;

    beforeEach(async () => {
      await writeOverlaySkill("review-house", "Stores: `core/mobx-store-template.mdc`.");
      await mkdir(path.join(source, "rules", "core"), { recursive: true });
      await writeFile(path.join(source, "rules", "core", "mobx-store-template.mdc"), OVERLAY, "utf8");
      coreCopy = path.join(cwd, ".metaproject", "rules", "core", "mobx-store-template.mdc");
      projectCopy = path.join(cwd, ".metaproject", "rules", "project", "core", "mobx-store-template.mdc");
      await mkdir(path.dirname(coreCopy), { recursive: true });
      await writeFile(coreCopy, GENERIC, "utf8");
    });

    test("different content is `differs`, and the overlay's version is written to rules/project", async () => {
      const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0]).toMatchObject({
        ref: "core/mobx-store-template.mdc",
        status: "differs",
        existing: ".metaproject/rules/core/mobx-store-template.mdc",
        target: ".metaproject/rules/project/core/mobx-store-template.mdc",
        written: true,
      });
      expect(await readFile(projectCopy, "utf8")).toBe(OVERLAY);
      // The file keryx's own install owns is not touched.
      expect(await readFile(coreCopy, "utf8")).toBe(GENERIC);

      const markdown = renderImportProjectSkillsMarkdown(result);
      expect(markdown).toContain(
        `- core/mobx-store-template.mdc: differs — .metaproject/rules/core/mobx-store-template.mdc is not the overlay's version; the overlay's was written to .metaproject/rules/project/core/mobx-store-template.mdc, which is the file the reviewer reads — from ${result.rules[0]?.origin} (cited by review-house)`,
      );
      expect(markdown).toContain(PROJECT_SLOT_PARAGRAPH);

      const [reviewer] = (await collectReviewers(cwd)).project;
      expect(reviewer?.shadowedRules).toEqual([
        { ref: "core/mobx-store-template.mdc", resolved: ".metaproject/rules/project/core/mobx-store-template.mdc" },
      ]);
      expect(reviewer?.unresolvedRules).toEqual([]);
    });

    test("identical content is `present`, and nothing is written", async () => {
      await writeFile(coreCopy, OVERLAY, "utf8");
      const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
      expect(result.rules[0]).toMatchObject({ ref: "core/mobx-store-template.mdc", status: "present" });
      await expect(readFile(projectCopy, "utf8")).rejects.toThrow();
    });

    test("dry-run reports `differs` without writing", async () => {
      const dry = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", dryRun: true });
      expect(dry.rules[0]).toMatchObject({
        status: "differs",
        target: ".metaproject/rules/project/core/mobx-store-template.mdc",
        written: false,
      });
      await expect(readFile(projectCopy, "utf8")).rejects.toThrow();
      expect(renderImportProjectSkillsMarkdown(dry)).toContain("would be written to");
    });

    test("a re-run finds the rules/project copy and reports `present`", async () => {
      await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
      const rerun = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
      expect(rerun.rules[0]).toMatchObject({
        status: "present",
        existing: ".metaproject/rules/project/core/mobx-store-template.mdc",
      });
      // Nothing was written this time, so the row says which file answers the reference.
      expect(renderImportProjectSkillsMarkdown(rerun)).toContain(
        "- core/mobx-store-template.mdc: present — the reviewer reads .metaproject/rules/project/core/mobx-store-template.mdc — from ",
      );
    });

    test("a rules/project copy that differs from the overlay is kept unless --force", async () => {
      await mkdir(path.dirname(projectCopy), { recursive: true });
      await writeFile(projectCopy, "# hand-edited\n", "utf8");

      const kept = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
      expect(kept.rules[0]).toMatchObject({ status: "differs", written: false });
      expect(kept.rules[0]?.reason).toContain("--force");
      expect(await readFile(projectCopy, "utf8")).toBe("# hand-edited\n");

      const forced = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", force: true });
      expect(forced.rules[0]).toMatchObject({ status: "differs", written: true });
      expect(await readFile(projectCopy, "utf8")).toBe(OVERLAY);
    });
  });
});
