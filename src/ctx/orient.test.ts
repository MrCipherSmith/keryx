import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildOrientation, graphContext, wikiContext } from "./orient";

async function withProject(
  files: Record<string, string>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-orient-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const SUMMARY = `# gdgraph Summary

## Stats

- Source files indexed: 260
- Total nodes: 264

## Top Modules

| Module | Source Files |
|---|---:|
| health | 38 |
| security | 35 |
| memory | 28 |

## Something Else

- ignored
`;

const WIKI_INDEX = `# Project Wiki

## Pages

<!-- keryx:wiki-index:begin -->
### Architecture

- [Project Map](architecture/project-map.md) (draft) - graph map

### Domain Model

_No pages yet._

### Component

- [Module src/commands](components/src-commands.md) (draft) - 15 files
<!-- keryx:wiki-index:end -->
`;

test("graphContext emits stats + top modules and stops at the next section", async () => {
  await withProject(
    { ".metaproject/data/gdgraph/artifacts/summary.md": SUMMARY },
    async (root) => {
      const out = await graphContext(root);
      expect(out).toContain("Code graph");
      expect(out).toContain("Source files indexed: 260");
      expect(out).toContain("health");
      expect(out).toContain("keryx gdgraph affected");
      expect(out).not.toContain("ignored"); // stopped at "## Something Else"
    },
  );
});

test("graphContext handles a missing graph gracefully", async () => {
  await withProject({}, async (root) => {
    const out = await graphContext(root);
    expect(out).toContain("not built");
    expect(out).toContain("keryx gdgraph build");
  });
});

test("wikiContext keeps populated sections and drops empty ones", async () => {
  await withProject({ ".metaproject/wiki/index.md": WIKI_INDEX }, async (root) => {
    const out = await wikiContext(root);
    expect(out).toContain("Architecture");
    expect(out).toContain("Project Map");
    expect(out).toContain("Component");
    // empty "Domain Model" section header dropped
    expect(out).not.toContain("Domain Model");
    expect(out).not.toContain("_No pages yet._");
    expect(out).toContain('keryx wiki ask');
  });
});

test("wikiContext handles a missing wiki gracefully", async () => {
  await withProject({}, async (root) => {
    const out = await wikiContext(root);
    expect(out).toContain("no wiki index");
  });
});

test("buildOrientation combines both sections under one header", async () => {
  await withProject(
    {
      ".metaproject/data/gdgraph/artifacts/summary.md": SUMMARY,
      ".metaproject/wiki/index.md": WIKI_INDEX,
    },
    async (root) => {
      const out = await buildOrientation(root);
      expect(out).toContain("keryx orientation");
      expect(out).toContain("Code graph");
      expect(out).toContain("Wiki");
      expect(out).toContain("health");
      expect(out).toContain("Project Map");
    },
  );
});
