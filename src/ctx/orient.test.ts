import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildOrientation, graphContext, metaprojectIndexContext, wikiContext } from "./orient";

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

const METAPROJECT_INDEX = `# Metaproject Index

## Purpose

Route project work through the installed Metaproject capabilities.

## Enabled Modules

| Module | Purpose |
|---|---|
| gdgraph | Code navigation |

## Agent Operating Model

Use the narrowest relevant capability.

## Intent Router

Use the graph before broad code search.

## Data

This generated-data listing should not be injected.

## Refresh

This maintenance section should not be injected.
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

test("metaprojectIndexContext injects a bounded project-root precedence excerpt", async () => {
  await withProject({ ".metaproject/index.md": METAPROJECT_INDEX }, async (root) => {
    const out = await metaprojectIndexContext(root);
    expect(out).toContain("Metaproject bootstrap — mandatory entrypoint (precedence)");
    expect(out).toContain("read_file");
    expect(out).toContain("Purpose");
    expect(out).toContain("Enabled Modules");
    expect(out).toContain("Agent Operating Model");
    expect(out).toContain("Intent Router");
    expect(out).not.toContain("HARD GATE");
    expect(out).not.toContain("<project-metaproject-index>");
    expect(out).not.toContain("This generated-data listing should not be injected.");
    expect(out).not.toContain("This maintenance section should not be injected.");
  });
});

test("metaprojectIndexContext truncates oversized selected sections", async () => {
  const routes = Array.from({ length: 100 }, (_, index) => `- route-${index} ${"x".repeat(200)}`).join("\n");
  const index = `# Metaproject Index\n\n## Intent Router\n\n${routes}\n`;

  await withProject({ ".metaproject/index.md": index }, async (root) => {
    const out = await metaprojectIndexContext(root);
    expect(out).toContain("route-0");
    expect(out).not.toContain("route-99");
    expect(out).toContain("bounded excerpt");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(4_096);
  });
});

test("metaprojectIndexContext does not search parent directories", async () => {
  await withProject({ ".metaproject/index.md": METAPROJECT_INDEX }, async (root) => {
    const nestedProjectRoot = path.join(root, "nested-project");
    await mkdir(nestedProjectRoot);

    expect(await metaprojectIndexContext(nestedProjectRoot)).toBe("");
  });
});

test("buildOrientation combines both sections under one header", async () => {
  await withProject(
    {
      ".metaproject/data/gdgraph/artifacts/summary.md": SUMMARY,
      ".metaproject/index.md": METAPROJECT_INDEX,
      ".metaproject/wiki/index.md": WIKI_INDEX,
    },
    async (root) => {
      const out = await buildOrientation(root);
      expect(out).toContain("keryx orientation");
      expect(out).toContain("Metaproject bootstrap — mandatory entrypoint (precedence)");
      expect(out).toContain("Code graph");
      expect(out).toContain("Wiki");
      expect(out).toContain("health");
      expect(out).toContain("Project Map");
    },
  );
});

test("buildOrientation without a project-root index preserves the graph + wiki format", async () => {
  await withProject(
    {
      ".metaproject/data/gdgraph/artifacts/summary.md": SUMMARY,
      ".metaproject/wiki/index.md": WIKI_INDEX,
    },
    async (root) => {
      const graph = await graphContext(root);
      const wiki = await wikiContext(root);
      expect(await buildOrientation(root)).toBe(
        ["# keryx orientation — consult before broad search / deep reads", "", graph, "", wiki].join("\n"),
      );
    },
  );
});
