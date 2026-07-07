import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { dashboardCommand } from "./dashboard";

test("build refreshes dashboard from existing data without touching data artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-dashboard-"));
  const previousCwd = process.cwd();
  const healthJsonPath = path.join(root, ".metaproject", "data", "health", "artifacts", "latest.json");
  const graphNodesPath = path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl");
  const graphEdgesPath = path.join(root, ".metaproject", "data", "gdgraph", "storage", "edges.jsonl");
  const testingContextPath = path.join(root, ".metaproject", "data", "testing", "context.md");
  const testingContext = "# sentinel testing context\n";

  try {
    await mkdir(path.dirname(healthJsonPath), { recursive: true });
    await mkdir(path.dirname(graphNodesPath), { recursive: true });
    await mkdir(path.dirname(testingContextPath), { recursive: true });
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          gdgraph: { enabled: true },
          gdctx: { enabled: true },
          gdwiki: { enabled: true },
          health: { enabled: true },
          testing: { enabled: true },
          memory: { enabled: true },
          tasks: { enabled: true },
        },
      }),
      "utf8",
    );
    await writeFile(
      healthJsonPath,
      JSON.stringify({
        gate: { status: "pass" },
        sources: [{ source: "typescript", status: "available", findings: 0, required: true }],
        metrics: [{ key: "project", health_score: 98, findingCounts: { total: 0, byPriority: {} } }],
      }),
      "utf8",
    );
    await writeFile(graphNodesPath, "{\"id\":\"src/a.ts\",\"kind\":\"file\",\"path\":\"src/a.ts\"}\n", "utf8");
    await writeFile(graphEdgesPath, "", "utf8");
    await writeFile(testingContextPath, testingContext, "utf8");

    process.chdir(root);
    await dashboardCommand(["build"]);

    const dashboard = await readFile(path.join(root, ".metaproject", "gd-metapro-dashboard.html"), "utf8");
    await dashboardCommand(["build"]);
    const rebuiltDashboard = await readFile(path.join(root, ".metaproject", "gd-metapro-dashboard.html"), "utf8");
    expect(dashboard).toContain("<h2>Code Health</h2>");
    expect(dashboard).toContain("<b>98</b><span>score</span>");
    expect(dashboard).toContain("<h2>Graph</h2>");
    expect(dashboard).toContain("<b>1</b><span>files</span>");
    expect(rebuiltDashboard).toBe(dashboard);
    expect(await readFile(testingContextPath, "utf8")).toBe(testingContext);
    await access(path.join(root, ".metaproject", "gd-metapro-dashboard.html"));
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
