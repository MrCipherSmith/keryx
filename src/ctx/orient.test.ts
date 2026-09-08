import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  buildOrientation,
  graphContext,
  metaprojectIndexContext,
  uncommittedCodeCount,
  wikiContext,
} from "./orient";

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

// Flow 235 / T7: the last silent elision left in this layer. The module table
// stopped at MAX_MODULE_ROWS and said nothing, so an orientation block listing
// twelve modules read as the project's whole module list.
test("graphContext says when it cut the module table short", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => `| module-${i} | ${30 - i} |`).join("\n");
  const summary = `# gdgraph Summary\n\n## Stats\n\n- Source files indexed: 260\n\n## Top Modules\n\n| Module | Source Files |\n|---|---:|\n${rows}\n`;
  await withProject(
    { ".metaproject/data/gdgraph/artifacts/summary.md": summary },
    async (root) => {
      const out = await graphContext(root);
      expect(out).toContain("module-0");
      expect(out).toContain("omitted");
      expect(out).toContain("18"); // 30 rows, 12 shown
    },
  );
});

test("graphContext leaves a table it shows in full unremarked", async () => {
  await withProject(
    { ".metaproject/data/gdgraph/artifacts/summary.md": SUMMARY },
    async (root) => {
      expect(await graphContext(root)).not.toContain("omitted");
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

// --- freshness (flow 237 T11, F2) -------------------------------------------
//
// Real git, real breakage: the failure case is induced by moving `.git` away
// (and by never creating one), not by stubbing a spawn. The defect being
// pinned is that BOTH "a new untracked .ts file" and "no git at all" printed
// `freshness: working tree clean`.

async function git(cwd: string, args: string[]): Promise<number> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  return child.exited;
}

async function gitProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-orient-git-"));
  try {
    await mkdir(path.join(root, ".metaproject", "data", "gdgraph", "artifacts"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "data", "gdgraph", "artifacts", "summary.md"), SUMMARY, "utf8");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
    expect(await git(root, ["init", "-q", "."])).toBe(0);
    expect(await git(root, ["add", "-A"])).toBe(0);
    expect(await git(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"])).toBe(0);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("graphContext calls a clean tree clean", async () => {
  await gitProject(async (root) => {
    expect(await uncommittedCodeCount(root)).toEqual({ status: "counted", count: 0 });
    expect(await graphContext(root)).toContain("freshness: working tree clean");
  });
}, 30_000);

// The exact case the project's routing gate names first ("rebuild when you
// added, renamed, deleted or moved files"), and the one `git diff --name-only
// HEAD` structurally cannot see.
test("graphContext counts a NEW untracked code file instead of calling the tree clean", async () => {
  await gitProject(async (root) => {
    await writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n", "utf8");
    expect(await uncommittedCodeCount(root)).toEqual({ status: "counted", count: 1 });
    const out = await graphContext(root);
    expect(out).toContain("1 uncommitted code file(s) may not be reflected");
    expect(out).not.toContain("working tree clean");
  });
}, 30_000);

test("graphContext counts a deleted tracked code file", async () => {
  await gitProject(async (root) => {
    await rm(path.join(root, "src", "a.ts"));
    expect(await uncommittedCodeCount(root)).toEqual({ status: "counted", count: 1 });
    expect(await graphContext(root)).not.toContain("working tree clean");
  });
}, 30_000);

test("graphContext reports unknown — never clean — when git could not be asked", async () => {
  await gitProject(async (root) => {
    // Break git for real: the repository this project sits in is moved away,
    // so `git status` exits 128 exactly as it does outside a repository.
    await rename(path.join(root, ".git"), path.join(root, ".git-off"));
    const changes = await uncommittedCodeCount(root);
    expect(changes.status).toBe("unknown");
    const out = await graphContext(root);
    expect(out).toContain("freshness: unknown");
    expect(out).toContain("do not read this as clean");
    expect(out).not.toContain("working tree clean");
    // And it recovers rather than latching: the note is about this check, not
    // a sticky state.
    await rename(path.join(root, ".git-off"), path.join(root, ".git"));
    expect(await graphContext(root)).toContain("freshness: working tree clean");
  });
}, 30_000);

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
