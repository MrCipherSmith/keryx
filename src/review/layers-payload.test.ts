import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { PackageGraphError, refreshLayers } from "./layers";
import { shellQuote } from "../lib/shell-quote";
import { buildLayersBlock, layersBlockLines, LAYERS_BLOCK_SECTIONS, MAX_BLOCK_FILES } from "./layers-payload";
import { createLayersFixture, git, writeProjectFile, type LayersFixture } from "./layers.test-helpers";

let fixture: LayersFixture;

const MEMORY_ENTRY = [
  "# Source module lesson",
  "",
  "Version: 0.2.0",
  "Type: lesson",
  "Status: accepted",
  "Confidence: high",
  "",
  "## Summary",
  "",
  "Keep src small.",
  "",
  "## Related Scopes",
  "",
  "- Module: src",
  "- Entity:",
  "- Files:",
  "- Skills:",
  "",
].join("\n");

async function commitMore(extra: (root: string) => Promise<void>): Promise<void> {
  await extra(fixture.root);
  git(fixture.root, ["add", "-A"]);
  git(fixture.root, ["commit", "-q", "-m", "more"]);
}

async function refresh(): Promise<void> {
  await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
}

beforeEach(async () => {
  fixture = await createLayersFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("the layers block of a reviewer payload (AC5)", () => {
  test("carries affected files, related tests, wiki pages and memory entries for the reviewer's files", async () => {
    await commitMore(async (root) => {
      await writeProjectFile(root, "src/a.test.ts", 'import { a } from "./a";\nexport const t = a;\n');
      await writeProjectFile(root, ".metaproject/memory/lessons/src-lesson.md", MEMORY_ENTRY);
    });
    await refresh();

    const block = await buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/a.ts"] });

    expect(block.files).toEqual(["src/a.ts"]);
    expect(block.graphCommit).toBe(block.prHead);
    expect(block.affected.depth).toBe(2);
    expect(block.affected.files).toEqual(["src/a.test.ts", "src/b.ts", "src/c.ts"]);
    expect(block.relatedTests).toContain("src/a.test.ts");
    expect(block.wiki.map((entry) => entry.page)).toEqual(["architecture/alpha.md"]);
    expect(block.memory.map((entry) => entry.path)).toEqual(["lessons/src-lesson.md"]);
    expect(block.truncated).toEqual([]);
  });

  test("is deterministic: the same package and files give the same bytes", async () => {
    await refresh();
    const input = { projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/b.ts", "src/a.ts"] };
    const first = JSON.stringify(await buildLayersBlock(input));
    const second = JSON.stringify(await buildLayersBlock({ ...input, files: ["src/a.ts", "src/b.ts"] }));
    expect(second).toBe(first);
  });

  test("reads the wiki from the working copy, not from the PR head's tree", async () => {
    await refresh();
    await writeProjectFile(
      fixture.root,
      ".metaproject/wiki/architecture/gamma.md",
      "---\ntitle: Gamma\ntype: architecture\n---\n\n# Gamma\n\nDescribes: src/b.ts\n",
    );
    const block = await buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/b.ts"] });
    expect(block.wiki.map((entry) => entry.page)).toContain("architecture/gamma.md");
  });

  test("stays under the byte cap and records every cut with the command that fetches the rest", async () => {
    await commitMore(async (root) => {
      for (let index = 0; index < 60; index += 1) {
        const name = String(index).padStart(2, "0");
        await writeProjectFile(root, `src/dependent-module-number-${name}.ts`, 'import { a } from "./a";\nexport const x = a;\n');
      }
    });
    await refresh();

    const maxBytes = 1500;
    const block = await buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/a.ts"], maxBytes });

    expect(Buffer.byteLength(JSON.stringify(block), "utf8")).toBeLessThanOrEqual(maxBytes);
    const cut = block.truncated.find((entry) => entry.section === "affected");
    expect(cut).toBeDefined();
    expect(cut?.total).toBeGreaterThan(cut?.shown ?? 0);
    expect(cut?.command).toContain("keryx gdgraph affected 'src/a.ts'");
    expect(block.truncated.every((entry) => entry.section === "files" || LAYERS_BLOCK_SECTIONS.includes(entry.section))).toBe(true);
  });

  test("every fetch command quotes the file name as one shell word (R1-09)", async () => {
    await commitMore(async (root) => {
      for (let index = 0; index < 60; index += 1) {
        await writeProjectFile(root, `src/dependent-module-number-${String(index).padStart(2, "0")}.ts`, 'import { a } from "./a";\nexport const x = a;\n');
      }
    });
    await refresh();
    const hostile = "src/a b'$(id)`x`;rm -rf ~.ts";
    const block = await buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: [hostile, "src/a.ts"], maxBytes: 1700 });
    const quoted = shellQuote(hostile);
    expect(quoted).toBe(`'src/a b'\\''$(id)\`x\`;rm -rf ~.ts'`);
    const affected = block.truncated.find((entry) => entry.section === "affected");
    expect(affected?.command.startsWith(`keryx gdgraph affected ${quoted} --depth 2 --data-dir '`)).toBe(true);
    for (const cut of block.truncated) expect(cut.command.replace(quoted, "")).not.toContain("$(id)");
  });

  test("a path with a control character or a newline is refused (R1-09)", async () => {
    await refresh();
    for (const bad of ["src/a.ts\nrm -rf ~", "src/a\u0007.ts", "src/a\u001b[0m.ts"]) {
      await expect(buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: [bad] })).rejects.toThrow("control character");
    }
  });

  test("the file list is capped and the cut recorded; a block whose floor exceeds the cap is an error (R1-19)", async () => {
    await refresh();
    const many = Array.from({ length: MAX_BLOCK_FILES + 5 }, (_, index) => `src/missing-${String(index).padStart(3, "0")}.ts`);
    const block = await buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: many });
    expect(block.files).toHaveLength(MAX_BLOCK_FILES);
    expect(block.truncated[0]).toMatchObject({ section: "files", shown: MAX_BLOCK_FILES, total: MAX_BLOCK_FILES + 5 });
    await expect(buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/a.ts"], maxBytes: 40 })).rejects.toThrow("maxBytes is 40");
  });

  test("drops back to depth 1 when depth 2 would not fit", async () => {
    await commitMore(async (root) => {
      for (let index = 0; index < 20; index += 1) {
        await writeProjectFile(root, `src/leaf-${index}.ts`, 'import { c } from "./c";\nexport const l = c;\n');
      }
    });
    await refresh();
    const input = { projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/b.ts"] };
    const roomy = await buildLayersBlock(input);
    expect(roomy.affected.depth).toBe(2);
    const tight = await buildLayersBlock({ ...input, maxBytes: Buffer.byteLength(JSON.stringify({ ...roomy, affected: { depth: 1, files: ["src/c.ts"] } }), "utf8") });
    expect(tight.affected.depth).toBe(1);
    expect(tight.affected.files).toEqual(["src/c.ts"]);
  });

  test("the reviewer-input schema accepts the block's sections and fields", async () => {
    const schema = JSON.parse(
      await readFile(path.join(import.meta.dir, "../gdskills/bundled/skills/review/review-orchestrator/reviewer-input.schema.json"), "utf8"),
    ) as { properties: { layers: { properties: Record<string, unknown> & { truncated: { items: { properties: { section: { enum: string[] } } } } } } } };
    const layers = schema.properties.layers.properties;
    expect(layers.truncated.items.properties.section.enum).toEqual(["files", ...LAYERS_BLOCK_SECTIONS]);
    await refresh();
    const block = await buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/a.ts"] });
    for (const key of Object.keys(block)) expect(Object.keys(layers)).toContain(key);
  });

  test("a package with no usable graph is a refusal, not an empty block", async () => {
    await expect(buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/a.ts"] })).rejects.toBeInstanceOf(PackageGraphError);
  });
});

describe("the byte cap holds for every list the block carries", () => {
  test("a hundred long file names are cut too, and the cut is recorded", async () => {
    await refresh();
    const files = Array.from({ length: MAX_BLOCK_FILES }, (_, index) => `src/${"deeply-nested-directory/".repeat(4)}file-${String(index).padStart(3, "0")}.ts`);
    const block = await buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files });

    expect(Buffer.byteLength(JSON.stringify(block), "utf8")).toBeLessThanOrEqual(block.maxBytes);
    expect(block.files.length).toBeLessThan(files.length);
    const cut = block.truncated.find((entry) => entry.section === "files");
    expect(cut?.shown).toBe(block.files.length);
    expect(cut?.total).toBe(files.length);
  });

  test("still refuses when the fixed overhead alone is over the cap", async () => {
    await refresh();
    await expect(
      buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/a.ts"], maxBytes: 50 }),
    ).rejects.toThrow(/every list empty/);
  });

  test("a long overflow is cut to the cap and no further", async () => {
    await commitMore(async (root) => {
      for (let index = 0; index < 150; index += 1) {
        await writeProjectFile(root, `src/dependent-module-number-${String(index).padStart(3, "0")}.ts`, 'import { a } from "./a";\nexport const x = a;\n');
      }
    });
    await refresh();
    const maxBytes = 3000;
    const block = await buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/a.ts"], maxBytes });
    const size = Buffer.byteLength(JSON.stringify(block), "utf8");

    expect(size).toBeLessThanOrEqual(maxBytes);
    expect(size).toBeGreaterThan(maxBytes - 120);
    const cut = block.truncated.find((entry) => entry.section === "affected");
    expect(cut?.total).toBeGreaterThanOrEqual(150);
  });
});

describe("a reader that failed is reported as unavailable, not as empty", () => {
  const input = () => ({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/a.ts"] });
  const restore: string[] = [];
  afterEach(async () => {
    for (const dir of restore.splice(0)) await chmod(dir, 0o755);
  });
  const lockDown = async (relative: string): Promise<void> => {
    const dir = path.join(fixture.root, relative);
    await chmod(dir, 0o000);
    restore.push(dir);
  };
  const canLock = process.getuid?.() !== 0;

  test("a block that read everything lists nothing as unavailable, and an empty section stays empty", async () => {
    await refresh();
    const block = await buildLayersBlock({ ...input(), files: ["src/c.ts"] });
    expect(block.unavailable).toEqual([]);
    expect(block.memory).toEqual([]);
    expect(layersBlockLines(block).join("\n")).not.toContain("unavailable");
  });

  test("a file name the graph cannot resolve makes affected unavailable with the reason, in the block, the lines and the JSON", async () => {
    await commitMore(async (root) => {
      await writeProjectFile(root, "src/x/util.ts", "export const x = 1;\n");
      await writeProjectFile(root, "src/y/util.ts", "export const y = 1;\n");
    });
    await refresh();
    const block = await buildLayersBlock({ ...input(), files: ["src/a.ts", "util.ts"] });
    expect(block.unavailable).toHaveLength(1);
    expect(block.unavailable[0]).toMatchObject({ section: "affected" });
    expect(block.unavailable[0]?.reason).toContain("1 of 2 file(s)");
    expect(block.unavailable[0]?.reason).toContain("util.ts: Graph target");
    expect(block.affected.files).toContain("src/b.ts");
    expect(layersBlockLines(block).join("\n")).toContain("unavailable affected:");
    expect((JSON.parse(JSON.stringify(block)) as { unavailable: unknown[] }).unavailable).toHaveLength(1);
  });

  test.skipIf(!canLock)("a wiki that cannot be read is unavailable with the reason, not an empty list", async () => {
    await refresh();
    await lockDown(".metaproject/wiki/architecture");
    const block = await buildLayersBlock(input());
    const gap = block.unavailable.find((entry) => entry.section === "wiki");
    expect(gap).toBeDefined();
    expect(gap?.reason.length).toBeGreaterThan(0);
    expect(block.wiki).toEqual([]);
    expect(layersBlockLines(block).join("\n")).toContain("unavailable wiki:");
  });

  test.skipIf(!canLock)("a memory that cannot be read is unavailable with the reason, not an empty list", async () => {
    await writeProjectFile(fixture.root, ".metaproject/memory/lessons/src-lesson.md", MEMORY_ENTRY);
    await refresh();
    await lockDown(".metaproject/memory/lessons");
    const block = await buildLayersBlock(input());
    const gap = block.unavailable.find((entry) => entry.section === "memory");
    expect(gap?.reason).toContain("the memory could not be read");
    expect(block.memory).toEqual([]);
  });
});
