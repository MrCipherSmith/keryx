import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rewriteReadmeLinks, truncateMarkdown } from "./readme-links";
import { wikiCheckLinks, wikiCollect } from "./service";

const FILES = [
  "src/a/a1.ts",
  "src/a/a2.ts",
  "src/b/b1.ts",
  "src/b/b2.ts",
  "src/b/b3.ts",
  "src/c/c1.ts",
  "src/c/c2.ts",
  "src/d/d1.ts",
  "src/d/d2.ts",
];
const EDGES: Array<[string, string]> = [
  ["src/a/a1.ts", "src/b/b1.ts"],
  ["src/a/a1.ts", "src/c/c1.ts"],
  ["src/a/a2.ts", "src/d/d1.ts"],
];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-wiki-links-"));
  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    path.join(graphDir, "nodes.jsonl"),
    FILES.map((file) => JSON.stringify({ id: file, kind: "file", path: file })).join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(graphDir, "edges.jsonl"),
    EDGES.map(([from, to]) => JSON.stringify({ from, to, kind: "imports" })).join("\n"),
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function page(slug: string): Promise<string> {
  return readFile(path.join(root, ".metaproject", "wiki", "components", `${slug}.md`), "utf8");
}

function exists(slug: string): Promise<boolean> {
  return readFile(path.join(root, ".metaproject", "wiki", "components", `${slug}.md`), "utf8").then(
    () => true,
    () => false,
  );
}

async function brokenLinks(): Promise<string[]> {
  const result = await wikiCheckLinks(root);
  return result.broken.map((entry) => `${entry.page} -> ${entry.target}`);
}

describe("wiki collect links only to modules that have a page", () => {
  test("neighbours past the page limit are named as code paths, not linked", async () => {
    // 4 modules qualify; limit 2 gives pages to src/b (3 files) and src/a (most edges).
    await wikiCollect({ cwd: root, limit: 2 });
    expect(await exists("src-b")).toBe(true);
    expect(await exists("src-a")).toBe(true);
    expect(await exists("src-c")).toBe(false);

    const a = await page("src-a");
    expect(a).toContain("[Module src/b](src-b.md)");
    expect(a).not.toContain("src-c.md");
    expect(a).not.toContain("src-d.md");
    expect(a).toContain("- `src/c` (no wiki page)");
    expect(a).toContain("- `src/d` (no wiki page)");
    expect(await brokenLinks()).toEqual([]);
  });

  test("a neighbour whose page already exists is linked even when the run does not rewrite it", async () => {
    await wikiCollect({ cwd: root, limit: 4 });
    expect(await exists("src-c")).toBe(true);

    await wikiCollect({ cwd: root, limit: 2, force: true });

    const a = await page("src-a");
    expect(a).toContain("[Module src/c](src-c.md)");
    expect(a).not.toContain("(no wiki page)");
    expect(await brokenLinks()).toEqual([]);
  });

  test("a regeneration drops the plain-path line once the neighbour gets a page", async () => {
    await wikiCollect({ cwd: root, limit: 2 });
    expect(await page("src-a")).toContain("- `src/c` (no wiki page)");

    await wikiCollect({ cwd: root, limit: 4 });
    await wikiCollect({ cwd: root, limit: 4, force: true });

    const a = await page("src-a");
    expect(a).toContain("[Module src/c](src-c.md)");
    expect(a).not.toContain("- `src/c` (no wiki page)");
    expect(await brokenLinks()).toEqual([]);
  });
});

describe("README excerpts on a module page", () => {
  async function collectWithReadme(readme: string, limit: number): Promise<string> {
    await mkdir(path.join(root, "src", "a"), { recursive: true });
    await writeFile(path.join(root, "src", "a", "README.md"), readme, "utf8");
    await wikiCollect({ cwd: root, limit });
    return page("src-a");
  }

  test("relative links resolve against the README directory, not the wiki folder", async () => {
    const readme = [
      "# A",
      "",
      "Grid. See [the slider](../c/), [docs](../b/README.md), [saving](../../other-area/README.md)",
      "and [site](https://example.com/x).",
      "",
    ].join("\n");

    const a = await collectWithReadme(readme, 2);

    expect(a).toContain("[docs](src-b.md)");
    expect(a).toContain("the slider (`src/c`)");
    expect(a).toContain("saving (`other-area/README.md`)");
    expect(a).toContain("[site](https://example.com/x)");
    const excerpt = a.split("\n").find((line) => line.includes("(from module README)")) ?? "";
    expect(excerpt).not.toContain("](..");
    expect(await brokenLinks()).toEqual([]);
  });

  test("a README link to a module that has a page points at that page", async () => {
    const a = await collectWithReadme("# A\n\nSee [the slider](../c/) for more.\n", 4);

    expect(a).toContain("[the slider](src-c.md)");
    expect(await brokenLinks()).toEqual([]);
  });
});

describe("rewriteReadmeLinks", () => {
  const linkable = new Set(["src/b", "src/deep/nested"]);
  const link = (name: string): string | null =>
    linkable.has(name) ? `${name.replace(/\//g, "-")}.md` : null;
  const rewrite = (text: string): string => rewriteReadmeLinks(text, "src/a", link);

  test("leaves external and mail links alone", () => {
    expect(rewrite("[x](https://e.com/a) [m](mailto:a@b.c)")).toBe("[x](https://e.com/a) [m](mailto:a@b.c)");
  });

  test("a directory link maps to its module page", () => {
    expect(rewrite("[b](../b)")).toBe("[b](src-b.md)");
    expect(rewrite("[b](../b/)")).toBe("[b](src-b.md)");
    expect(rewrite("[n](../deep/nested/README.md#usage)")).toBe("[n](src-deep-nested.md)");
  });

  test("a link to a file inside a module is named by its path", () => {
    expect(rewrite("[types](../b/types.ts)")).toBe("types (`src/b/types.ts`)");
  });

  test("a link without a page is named by its path", () => {
    expect(rewrite("[c](../c/)")).toBe("c (`src/c`)");
    expect(rewrite("[](../c/)")).toBe("`src/c`");
  });

  test("repo-absolute links resolve against the project root", () => {
    expect(rewrite("[b](/src/b/)")).toBe("[b](src-b.md)");
  });

  test("a link that leaves the project keeps only its label", () => {
    expect(rewrite("[up](../../../elsewhere/)")).toBe("up");
  });

  test("an in-page anchor keeps only its label", () => {
    expect(rewrite("[install](#install)")).toBe("install");
  });

  test("an image becomes a path reference, never a link", () => {
    expect(rewrite("![logo](./logo.png)")).toBe("logo (`src/a/logo.png`)");
  });

  test("a link title is dropped with the target", () => {
    expect(rewrite('[b](../b "B module")')).toBe("[b](src-b.md)");
  });

  test("truncation never leaves half a link", () => {
    expect(truncateMarkdown("abc [b](src-b.md) tail", 10)).toBe("abc");
    expect(truncateMarkdown("abc [b](src-b.md) tail", 14)).toBe("abc");
    expect(truncateMarkdown("abc [b](src-b.md) tail", 17)).toBe("abc [b](src-b.md)");
    expect(truncateMarkdown("short", 400)).toBe("short");
  });
});
