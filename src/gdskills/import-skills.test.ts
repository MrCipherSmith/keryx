import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  githubBlobToRaw,
  importProjectSkills,
  updateProjectSkills,
} from "./import-skills";

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
