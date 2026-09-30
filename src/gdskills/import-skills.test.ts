import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  githubBlobToRaw,
  importProjectSkills,
  optionValues,
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

describe("optionValues", () => {
  test("collects every occurrence, in both spellings, and skips one with no value", () => {
    expect(optionValues(["--from", "x", "--only", "review-*", "--only=code-*", "--only", "--json"], "--only")).toEqual([
      "review-*",
      "code-*",
    ]);
    expect(optionValues(["--from", "x"], "--only")).toEqual([]);
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
    expect(result.rules[0]?.reason).toContain("keryx install");
  });

  test("a rule name keryx ships that the overlay provides lands in rules/project, never rules/core", async () => {
    await writeOverlaySkill("review-house", "Git: `core/git-rules.mdc`.");
    await mkdir(path.join(source, "rules", "core"), { recursive: true });
    await writeFile(path.join(source, "rules", "core", "git-rules.mdc"), "# overlay git rules\n", "utf8");
    const projectCopy = path.join(cwd, ".metaproject", "rules", "project", "git-rules.mdc");

    const dry = await importProjectSkills({ projectRoot: cwd, from: source, module: "review", dryRun: true });
    expect(dry.rules[0]).toMatchObject({
      ref: "core/git-rules.mdc",
      status: "would-import-project",
      target: ".metaproject/rules/project/git-rules.mdc",
    });
    await expect(readFile(projectCopy, "utf8")).rejects.toThrow();

    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    // `keryx install` rewrites rules/core/<bundled name> on every run; an
    // overlay copy there would be silently replaced by a different file.
    expect(result.rules[0]).toMatchObject({ ref: "core/git-rules.mdc", status: "imported-project" });
    expect(await readFile(projectCopy, "utf8")).toBe("# overlay git rules\n");
    await expect(readFile(path.join(cwd, ".metaproject", "rules", "core", "git-rules.mdc"), "utf8")).rejects.toThrow();
    expect(renderImportProjectSkillsMarkdown(result)).toContain(".metaproject/rules/project/git-rules.mdc");
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
      projectCopy = path.join(cwd, ".metaproject", "rules", "project", "mobx-store-template.mdc");
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
        target: ".metaproject/rules/project/mobx-store-template.mdc",
        written: true,
      });
      expect(await readFile(projectCopy, "utf8")).toBe(OVERLAY);
      // The file `keryx install` owns is not touched.
      expect(await readFile(coreCopy, "utf8")).toBe(GENERIC);

      const markdown = renderImportProjectSkillsMarkdown(result);
      expect(markdown).toContain("core/mobx-store-template.mdc: differs");
      expect(markdown).toContain(".metaproject/rules/project/mobx-store-template.mdc");
      expect(markdown).toContain(".metaproject/rules/core/mobx-store-template.mdc");

      const [reviewer] = (await collectReviewers(cwd)).project;
      expect(reviewer?.shadowedRules).toEqual([
        { ref: "core/mobx-store-template.mdc", resolved: ".metaproject/rules/project/mobx-store-template.mdc" },
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
        target: ".metaproject/rules/project/mobx-store-template.mdc",
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
        existing: ".metaproject/rules/project/mobx-store-template.mdc",
      });
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
