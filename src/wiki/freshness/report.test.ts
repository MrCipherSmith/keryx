// LWG-10 freshness report (flow 226): AC5, AC7, AC8, AC9, AC10, AC13.

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphData } from "../../gdgraph/types";
import type { ClassifiedChange } from "./classify-change";
import { buildFreshnessReport } from "./report";
import type { GitRunner } from "./page-freshness";

const SHA = "a".repeat(40);
const noGit: GitRunner = async () => null;

/** git that reports two commits touching everything since VerifiedAt. */
const busyGit: GitRunner = async (_cwd, args) => {
  if (args[0] === "cat-file") return "";
  if (args[0] === "log") return "c1\nc2";
  if (args[0] === "diff") return "src/core.ts";
  return null;
};

async function project(options: {
  pages: Record<string, string>;
  files?: Record<string, string>;
  buildGraph?: boolean;
}): Promise<{ cwd: string; graph: GraphData }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lwg-report-"));
  const files = options.files ?? { "src/core.ts": "export const core = 1;\n" };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.join(cwd, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(cwd, rel), content);
  }
  for (const [rel, content] of Object.entries(options.pages)) {
    await mkdir(path.join(cwd, ".metaproject", "wiki", path.dirname(rel)), { recursive: true });
    await writeFile(path.join(cwd, ".metaproject", "wiki", rel), content);
  }

  const nodes = Object.keys(files).map((p) => ({
    id: p,
    kind: "file" as const,
    path: p,
    language: "typescript" as const,
  }));

  if (options.buildGraph !== false) {
    // validModuleNames reads nodes.jsonl straight off disk; write it so the
    // module set is real rather than stubbed.
    const storage = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
    await mkdir(storage, { recursive: true });
    await writeFile(
      path.join(storage, "nodes.jsonl"),
      `${nodes.map((n) => JSON.stringify(n)).join("\n")}\n`,
    );
  }

  return { cwd, graph: { nodes, edges: [], describes: [] } };
}

function change(overrides: Partial<ClassifiedChange> & { path: string }): ClassifiedChange {
  return { changeClass: "body", symbols: [], ...overrides };
}

const CORE_PAGE = [
  "# src/core",
  "Version: 1.0.0",
  "Type: component",
  "Status: accepted",
  `VerifiedAt: ${SHA}`,
  "Describes:",
  "  - src/core.ts",
  "",
  "## Overview",
  "",
  "The core module.",
  "",
].join("\n");

describe("graph-unavailable posture (AC8)", () => {
  test("an unbuilt graph yields no pages, a declared limitation, and no orphan claims", async () => {
    const { cwd, graph } = await project({
      pages: { "components/src-core.md": CORE_PAGE },
      buildGraph: false,
    });

    const report = await buildFreshnessReport({
      cwd,
      graph,
      changes: [change({ path: "src/core.ts", changeClass: "signature" })],
      symbolLayerAvailable: true,
      git: noGit,
      toRev: "HEAD",
    });

    expect(report.pages).toEqual([]);
    expect(report.limitations.map((l) => l.code)).toEqual(["graph-stale"]);
    // The dangerous alternative: accusing every page of describing deleted
    // code because nobody ran `gdgraph build`.
    expect(report.pages.filter((p) => p.category === "orphan")).toEqual([]);
    expect(report.pages.filter((p) => p.category === "undocumented")).toEqual([]);
  });
});

describe("undecidable pages (AC9)", () => {
  test("a page with no describe-set is excluded from scoring and declared", async () => {
    const { cwd, graph } = await project({
      pages: {
        "architecture/overview.md": "# Overview\nVersion: 1.0.0\nStatus: accepted\n\n## Overview\n\nProse.\n",
      },
    });

    const report = await buildFreshnessReport({
      cwd,
      graph,
      changes: [],
      symbolLayerAvailable: true,
      git: noGit,
      toRev: "HEAD",
    });

    expect(report.totals.pagesUndecidable).toBe(1);
    expect(report.pages.map((p) => p.path)).not.toContain("architecture/overview.md");
    const limitation = report.limitations.find((l) => l.code === "page-without-describes");
    expect(limitation?.affectedCount).toBe(1);
  });
});

describe("categories", () => {
  test("a signature change whose symbol is NOT in the prose is stale-reference", async () => {
    const { cwd, graph } = await project({ pages: { "components/src-core.md": CORE_PAGE } });
    const withEdge: GraphData = {
      ...graph,
      describes: [
        { id: "d1", from: "wiki:components/src-core.md", to: "src/core.ts", pattern: "src/core.ts", origin: "frontmatter" },
      ],
    };

    const report = await buildFreshnessReport({
      cwd,
      graph: withEdge,
      changes: [change({ path: "src/core.ts", changeClass: "signature", symbols: ["renameMe"] })],
      symbolLayerAvailable: true,
      git: busyGit,
      toRev: "HEAD",
    });

    expect(report.pages[0]?.category).toBe("stale-reference");
    expect(report.pages[0]?.confidence).toBe("must-refresh");
  });

  test("the same change is stale-prose when the prose names the symbol", async () => {
    const page = CORE_PAGE.replace("The core module.", "The core module exposes renameMe for callers.");
    const { cwd, graph } = await project({ pages: { "components/src-core.md": page } });
    const withEdge: GraphData = {
      ...graph,
      describes: [
        { id: "d1", from: "wiki:components/src-core.md", to: "src/core.ts", pattern: "src/core.ts", origin: "frontmatter" },
      ],
    };

    const report = await buildFreshnessReport({
      cwd,
      graph: withEdge,
      changes: [change({ path: "src/core.ts", changeClass: "signature", symbols: ["renameMe"] })],
      symbolLayerAvailable: true,
      git: busyGit,
      toRev: "HEAD",
    });

    // Rewriting sentences is more work than regenerating a Reference block,
    // so the more expensive category wins.
    expect(report.pages[0]?.category).toBe("stale-prose");
  });

  test("a symbol named only inside the Reference block does not make prose stale", async () => {
    const page = `${CORE_PAGE}\n## Reference (from code graph)\n\n### Public API\n\n- renameMe\n`;
    const { cwd, graph } = await project({ pages: { "components/src-core.md": page } });
    const withEdge: GraphData = {
      ...graph,
      describes: [
        { id: "d1", from: "wiki:components/src-core.md", to: "src/core.ts", pattern: "src/core.ts", origin: "frontmatter" },
      ],
    };

    const report = await buildFreshnessReport({
      cwd,
      graph: withEdge,
      changes: [change({ path: "src/core.ts", changeClass: "signature", symbols: ["renameMe"] })],
      symbolLayerAvailable: true,
      git: busyGit,
      toRev: "HEAD",
    });

    expect(report.pages[0]?.category).toBe("stale-reference");
  });

  test("a page whose module left the graph is orphan, from the module set (AC10)", async () => {
    const { cwd, graph } = await project({
      pages: {
        "components/src-gone.md": [
          "# src/gone",
          "Version: 1.0.0",
          "Type: component",
          "Status: accepted",
          "Describes:",
          "  - src/gone/old.ts",
          "",
        ].join("\n"),
      },
      files: { "src/core.ts": "export const core = 1;\n", "src/gone/old.ts": "export const old = 1;\n" },
    });
    // The file exists on disk and in the passed graph, but nodes.jsonl — the
    // source validModuleNames reads — only lists src/core.ts.
    const storage = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
    await writeFile(
      path.join(storage, "nodes.jsonl"),
      `${JSON.stringify({ id: "src/core.ts", kind: "file", path: "src/core.ts", language: "typescript" })}\n`,
    );

    const report = await buildFreshnessReport({
      cwd,
      graph,
      changes: [],
      symbolLayerAvailable: true,
      git: noGit,
      toRev: "HEAD",
    });

    expect(report.pages[0]?.category).toBe("orphan");
  });

  test("a page nobody ever verified is `unknown`, not fresh", async () => {
    const page = CORE_PAGE.replace(`VerifiedAt: ${SHA}\n`, "");
    const { cwd, graph } = await project({ pages: { "components/src-core.md": page } });

    const report = await buildFreshnessReport({
      cwd,
      graph,
      changes: [],
      symbolLayerAvailable: true,
      git: noGit,
      toRev: "HEAD",
    });

    expect(report.pages[0]?.category).toBe("unknown");
    expect(report.totals.pagesFresh).toBe(0);
    expect(report.pages[0]?.verifiedAt).toBeNull();
  });
});

describe("limitations and totals (AC7)", () => {
  test("a missing symbol layer is declared, not silently absorbed", async () => {
    const { cwd, graph } = await project({ pages: { "components/src-core.md": CORE_PAGE } });
    const report = await buildFreshnessReport({
      cwd,
      graph,
      changes: [change({ path: "src/core.ts" })],
      symbolLayerAvailable: false,
      git: noGit,
      toRev: "HEAD",
    });
    expect(report.limitations.map((l) => l.code)).toContain("symbol-layer-unavailable");
  });

  test("cosmetic changes are counted but produce no entries (AC1 at report level)", async () => {
    const { cwd, graph } = await project({ pages: { "components/src-core.md": CORE_PAGE } });
    // A git that resolves VerifiedAt and reports nothing since it, so the page
    // is genuinely fresh. With `noGit` this would assert "no provenance"
    // instead of "cosmetic produced nothing" — a different fact.
    const quietGit: GitRunner = async (_cwd, args) => {
      if (args[0] === "cat-file") return "";
      if (args[0] === "log") return "";
      return null;
    };
    const report = await buildFreshnessReport({
      cwd,
      graph,
      changes: [change({ path: "src/core.ts", changeClass: "cosmetic" })],
      symbolLayerAvailable: true,
      git: quietGit,
      toRev: "HEAD",
    });
    expect(report.totals.filesCosmetic).toBe(1);
    expect(report.pages).toEqual([]);
    expect(report.totals.pagesFresh).toBe(1);
  });
});

describe("ordering (AC13)", () => {
  test("entries are sorted by commits behind, descending", async () => {
    const pages: Record<string, string> = {};
    for (const [slug, file] of [["a", "src/a.ts"], ["b", "src/b.ts"]] as const) {
      pages[`components/src-${slug}.md`] = [
        `# src/${slug}`,
        "Version: 1.0.0",
        "Type: component",
        "Status: accepted",
        `VerifiedAt: ${SHA}`,
        "Describes:",
        `  - ${file}`,
        "",
      ].join("\n");
    }
    const { cwd, graph } = await project({
      pages,
      files: { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" },
    });

    const git: GitRunner = async (_cwd, args) => {
      if (args[0] === "cat-file") return "";
      if (args[0] === "log") return args.includes("src/b.ts") ? "c1\nc2\nc3" : "c1";
      if (args[0] === "diff") return "";
      return null;
    };

    const report = await buildFreshnessReport({
      cwd,
      graph,
      changes: [],
      symbolLayerAvailable: true,
      git,
      toRev: "HEAD",
    });

    expect(report.pages.map((p) => p.commitsBehind)).toEqual([3, 1]);
    expect(report.pages[0]?.path).toBe("components/src-b.md");
  });
});

describe("read-only guarantee (AC5)", () => {
  test("building a report writes nothing into the wiki", async () => {
    const { cwd, graph } = await project({ pages: { "components/src-core.md": CORE_PAGE } });
    const dir = path.join(cwd, ".metaproject", "wiki", "components");
    const before = await readdir(dir);
    const beforeBytes = await Bun.file(path.join(dir, "src-core.md")).text();

    await buildFreshnessReport({
      cwd,
      graph,
      changes: [change({ path: "src/core.ts", changeClass: "signature", symbols: ["x"] })],
      symbolLayerAvailable: true,
      git: busyGit,
      toRev: "HEAD",
    });

    expect(await readdir(dir)).toEqual(before);
    expect(await Bun.file(path.join(dir, "src-core.md")).text()).toBe(beforeBytes);
  });
});

describe("provenance outranks propagation", () => {
  const stampedAtHead: GitRunner = async (_cwd, args) => {
    if (args[0] === "cat-file") return "";
    if (args[0] === "log") return ""; // nothing since VerifiedAt
    return null;
  };

  test("a page verified after the change is fresh, not must-refresh", async () => {
    const { cwd, graph } = await project({ pages: { "components/src-core.md": CORE_PAGE } });
    const withEdge: GraphData = {
      ...graph,
      describes: [
        { id: "d1", from: "wiki:components/src-core.md", to: "src/core.ts", pattern: "src/core.ts", origin: "frontmatter" },
      ],
    };

    const report = await buildFreshnessReport({
      cwd,
      graph: withEdge,
      // The range contains a signature change to the very file this page
      // describes -- but the page has been verified since.
      changes: [change({ path: "src/core.ts", changeClass: "signature", symbols: ["x"] })],
      symbolLayerAvailable: true,
      git: stampedAtHead,
      toRev: "HEAD",
    });

    // Reporting must-refresh here would assert work that was already done.
    expect(report.pages).toEqual([]);
    expect(report.totals.pagesFresh).toBe(1);
  });

  test("a dependency change on a verified page is fyi, never stale-reference", async () => {
    const { cwd, graph } = await project({
      pages: { "components/src-core.md": CORE_PAGE },
      files: { "src/core.ts": "export const core = 1;\n", "src/dep.ts": "export const dep = 1;\n" },
    });
    const withEdges: GraphData = {
      ...graph,
      edges: [{ id: "e1", from: "src/core.ts", to: "src/dep.ts", kind: "imports", specifier: "./dep" }],
      describes: [
        { id: "d1", from: "wiki:components/src-core.md", to: "src/core.ts", pattern: "src/core.ts", origin: "frontmatter" },
      ],
    };

    const report = await buildFreshnessReport({
      cwd,
      graph: withEdges,
      changes: [change({ path: "src/dep.ts", changeClass: "signature", symbols: ["dep"] })],
      symbolLayerAvailable: true,
      git: stampedAtHead,
      toRev: "HEAD",
    });

    // Its own block is current, so a refresh instruction would be false; the
    // dependency news is still worth carrying, at advisory strength.
    expect(report.pages[0]?.category).toBe("stale-prose");
    expect(report.pages[0]?.confidence).toBe("fyi");
    expect(report.pages[0]?.reasons.every((r) => r.edgePath.length > 1)).toBe(true);
  });

  test("a page NOT verified since the change is still must-refresh", async () => {
    const { cwd, graph } = await project({ pages: { "components/src-core.md": CORE_PAGE } });
    const withEdge: GraphData = {
      ...graph,
      describes: [
        { id: "d1", from: "wiki:components/src-core.md", to: "src/core.ts", pattern: "src/core.ts", origin: "frontmatter" },
      ],
    };
    const report = await buildFreshnessReport({
      cwd,
      graph: withEdge,
      changes: [change({ path: "src/core.ts", changeClass: "signature", symbols: ["x"] })],
      symbolLayerAvailable: true,
      git: busyGit,
      toRev: "HEAD",
    });
    expect(report.pages[0]?.category).toBe("stale-reference");
    expect(report.pages[0]?.confidence).toBe("must-refresh");
  });
});
