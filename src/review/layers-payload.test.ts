import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PackageGraphError, refreshLayers } from "./layers";
import { buildLayersBlock, LAYERS_BLOCK_SECTIONS } from "./layers-payload";
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
    expect(cut?.command).toContain("keryx gdgraph affected src/a.ts");
    expect(block.truncated.every((entry) => LAYERS_BLOCK_SECTIONS.includes(entry.section))).toBe(true);
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
    expect(layers.truncated.items.properties.section.enum).toEqual([...LAYERS_BLOCK_SECTIONS]);
    await refresh();
    const block = await buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/a.ts"] });
    for (const key of Object.keys(block)) expect(Object.keys(layers)).toContain(key);
  });

  test("a package with no usable graph is a refusal, not an empty block", async () => {
    await expect(buildLayersBlock({ projectRoot: fixture.root, packageDir: fixture.packageDir, files: ["src/a.ts"] })).rejects.toBeInstanceOf(PackageGraphError);
  });
});
