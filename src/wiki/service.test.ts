import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiCollect } from "./service";

test("collect creates draft wiki pages from graph, health, and testing artifacts without overwriting manual edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-collect-"));
  const graphDir = path.join(root, ".metaproject", "data", "gdgraph", "storage");
  const healthDir = path.join(root, ".metaproject", "data", "health", "artifacts");
  const testingDir = path.join(root, ".metaproject", "data", "testing");

  try {
    await mkdir(graphDir, { recursive: true });
    await mkdir(healthDir, { recursive: true });
    await mkdir(testingDir, { recursive: true });
    await writeFile(
      path.join(graphDir, "nodes.jsonl"),
      [
        JSON.stringify({ id: "src/pipelines/a.ts", kind: "file", path: "src/pipelines/a.ts" }),
        JSON.stringify({ id: "src/pipelines/b.ts", kind: "file", path: "src/pipelines/b.ts" }),
        JSON.stringify({ id: "src/core/x.ts", kind: "file", path: "src/core/x.ts" }),
        JSON.stringify({ id: "public/logo.svg", kind: "asset", path: "public/logo.svg" }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(graphDir, "edges.jsonl"),
      [
        JSON.stringify({ from: "src/pipelines/a.ts", to: "src/core/x.ts", kind: "imports" }),
        JSON.stringify({ from: "src/pipelines/b.ts", to: "missing", kind: "unresolved" }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(healthDir, "latest.json"),
      JSON.stringify({
        gate: { status: "fail", reasons: ["FAIL: 1 finding(s) at P0"] },
        sources: [{ source: "typescript", status: "available", findings: 1 }],
        metrics: [{
          key: "project",
          health_score: 42,
          risk_score: 100,
          findingCounts: {
            total: 2,
            byPriority: { P0: 1, P1: 0, P2: 1, P3: 0 },
            bySource: { typescript: 1, complexity: 1 },
          },
        }],
      }),
      "utf8",
    );
    await writeFile(
      path.join(testingDir, "context.md"),
      "# Testing Context\n\nRunner: bun test\n\n## Patterns\n\n- colocated tests\n",
      "utf8",
    );

    const result = await wikiCollect({ cwd: root, limit: 2 });

    expect(result.created).toBe(5);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.pages.map((page) => page.path).sort()).toEqual([
      ".metaproject/wiki/architecture/project-map.md",
      ".metaproject/wiki/architecture/quality-map.md",
      ".metaproject/wiki/architecture/testing-map.md",
      ".metaproject/wiki/components/src-core.md",
      ".metaproject/wiki/components/src-pipelines.md",
    ]);
    expect(await readFile(path.join(root, ".metaproject", "wiki", "architecture", "project-map.md"), "utf8"))
      .toContain("Generated from gdgraph");
    expect(await readFile(path.join(root, ".metaproject", "wiki", "index.md"), "utf8"))
      .toContain("Module src/pipelines");

    await writeFile(
      path.join(root, ".metaproject", "wiki", "architecture", "project-map.md"),
      "# Manual Project Map\n\nVersion: 9.9.9\nType: architecture\nStatus: accepted\n",
      "utf8",
    );
    const second = await wikiCollect({ cwd: root, limit: 2 });
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(5);
    expect(await readFile(path.join(root, ".metaproject", "wiki", "architecture", "project-map.md"), "utf8"))
      .toContain("Manual Project Map");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
