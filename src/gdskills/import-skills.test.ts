import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  githubBlobToRaw,
  importProjectSkills,
  portableOriginRef,
  stampImportHeader,
  updateProjectSkills,
} from "./import-skills";
import { verifyProjectSkill } from "./verify";

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

  test("a rule name keryx ships is never copied from an overlay", async () => {
    await writeOverlaySkill("review-house", "Git: `core/git-rules.mdc`.");
    await mkdir(path.join(source, "rules", "core"), { recursive: true });
    await writeFile(path.join(source, "rules", "core", "git-rules.mdc"), "# overlay git rules\n", "utf8");

    const result = await importProjectSkills({ projectRoot: cwd, from: source, module: "review" });
    // `keryx install` rewrites rules/core/<bundled name> on every run; an
    // overlay copy there would be silently replaced by a different file.
    expect(result.rules[0]).toMatchObject({ ref: "core/git-rules.mdc", status: "unresolved" });
    expect(result.rules[0]?.reason).toContain("keryx install");
  });
});
