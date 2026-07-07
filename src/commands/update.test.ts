import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { updateCommand } from "./update";

test("refreshes service files without touching data artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-update-"));
  const previousCwd = process.cwd();
  const graphSummaryPath = path.join(root, ".metaproject", "data", "gdgraph", "artifacts", "summary.md");
  const testingContextPath = path.join(root, ".metaproject", "data", "testing", "context.md");
  const graphSummary = "# sentinel graph summary\n";
  const testingContext = "# sentinel testing context\n";

  try {
    await mkdir(path.dirname(graphSummaryPath), { recursive: true });
    await mkdir(path.dirname(testingContextPath), { recursive: true });
    await writeFile(graphSummaryPath, graphSummary, "utf8");
    await writeFile(testingContextPath, testingContext, "utf8");
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          gdgraph: { enabled: true },
          gdctx: { enabled: true },
          gdwiki: { enabled: true },
          gdskills: { enabled: true },
          testing: { enabled: true },
          memory: { enabled: true },
          tasks: { enabled: true },
        },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    process.chdir(root);
    await updateCommand(["--skip-runtime"]);

    expect(await readFile(path.join(root, ".metaproject", "gd-metapro-dashboard.html"), "utf8")).toContain("Metaproject");
    expect(await readFile(path.join(root, ".metaproject", "core", "gdgraph", "build.ts"), "utf8")).toContain("buildGraph");
    expect(await readFile(path.join(root, ".metaproject", "flows", "README.md"), "utf8")).toContain("Flow");
    expect(await fileExists(path.join(root, ".metaproject", "data", "gdskills"))).toBe(false);
    expect(await fileExists(path.join(root, ".metaproject", "data", "tasks"))).toBe(false);
    expect(await readFile(graphSummaryPath, "utf8")).toBe(graphSummary);
    expect(await readFile(testingContextPath, "utf8")).toBe(testingContext);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers manifest and dashboard for existing metaprojects without metaproject.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-update-legacy-"));
  const previousCwd = process.cwd();
  const graphStoragePath = path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl");
  const graphEdgesPath = path.join(root, ".metaproject", "data", "gdgraph", "storage", "edges.jsonl");
  const healthReportPath = path.join(root, ".metaproject", "data", "health", "artifacts", "latest.md");
  const healthJsonPath = path.join(root, ".metaproject", "data", "health", "artifacts", "latest.json");
  const graphStorage = "{\"id\":\"src/a.ts\",\"kind\":\"file\",\"path\":\"src/a.ts\"}\n{\"id\":\"src/b.ts\",\"kind\":\"file\",\"path\":\"src/b.ts\"}\n";
  const graphEdges = "{\"id\":\"edge:1\",\"from\":\"src/a.ts\",\"to\":\"src/b.ts\",\"kind\":\"imports\"}\n";
  const healthReport = "# Code Health: PASS\n";
  const healthJson = JSON.stringify({
    gate: { status: "pass" },
    sources: [{ source: "typescript", status: "available", findings: 0, required: true }],
    metrics: [
      {
        key: "project",
        kind: "project",
        name: "project",
        health_score: 97,
        risk_score: 3,
        findingCounts: { total: 1, byPriority: { P0: 0, P1: 1, P2: 0 } },
      },
      {
        key: "module:src",
        kind: "module",
        name: "src",
        health_score: 91,
        risk_score: 3,
        findingCounts: { total: 1 },
        complexity: { max: 8 },
      },
    ],
  });

  try {
    await mkdir(path.dirname(graphStoragePath), { recursive: true });
    await mkdir(path.dirname(healthReportPath), { recursive: true });
    await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    await mkdir(path.join(root, ".metaproject", "data", "testing"), { recursive: true });
    await mkdir(path.join(root, ".metaproject", "data", "gdctx"), { recursive: true });
    await writeFile(graphStoragePath, graphStorage, "utf8");
    await writeFile(graphEdgesPath, graphEdges, "utf8");
    await writeFile(healthReportPath, healthReport, "utf8");
    await writeFile(healthJsonPath, healthJson, "utf8");
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await writeFile(
      path.join(root, ".git", "hooks", "post-commit"),
      "#!/usr/bin/env sh\n\n# gd-metapro:gdgraph-post-commit:begin\ntrue\n# gd-metapro:gdgraph-post-commit:end\n",
      "utf8",
    );

    process.chdir(root);
    await updateCommand(["--skip-runtime", "--no-tasks"]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean }>;
    };
    const dashboard = await readFile(path.join(root, ".metaproject", "gd-metapro-dashboard.html"), "utf8");
    const index = await readFile(path.join(root, ".metaproject", "index.md"), "utf8");

    expect(manifest.modules.gdgraph?.enabled).toBe(true);
    expect(manifest.modules.gdctx?.enabled).toBe(true);
    expect(manifest.modules.health?.enabled).toBe(true);
    expect(manifest.modules.testing?.enabled).toBe(true);
    expect(manifest.modules.tasks?.enabled).toBe(false);
    expect(dashboard).toContain("<span class=\"module-name\">gdgraph</span>");
    expect(dashboard).toContain("<span class=\"module-name\">health</span>");
    expect(dashboard).toContain("<h2>Health</h2>");
    expect(dashboard).toContain("<strong>97</strong><span>health score</span>");
    expect(dashboard).toContain("<h2>Graph</h2>");
    expect(dashboard).toContain("<strong>2</strong><span>files</span>");
    expect(dashboard).not.toContain("No modules enabled.");
    await expectDashboardLinksToExist(root, dashboard);
    expect(await readFile(path.join(root, ".git", "hooks", "post-commit"), "utf8")).toContain(
      "# gd-metapro:metaproject-dashboard-post-commit:begin",
    );
    expect(index).toContain("| gdgraph |");
    expect(index).not.toContain("| _none_ | No modules enabled yet | - |");
    expect(await readFile(graphStoragePath, "utf8")).toBe(graphStorage);
    expect(await readFile(healthReportPath, "utf8")).toBe(healthReport);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates legacy wiki manifest key to gdwiki", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-update-wiki-migrate-"));
  const previousCwd = process.cwd();

  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          wiki: { enabled: true },
          gdgraph: { enabled: false },
          tasks: { enabled: false },
        },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    process.chdir(root);
    await updateCommand(["--skip-runtime", "--no-tasks"]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean } | undefined>;
    };
    const dashboard = await readFile(path.join(root, ".metaproject", "gd-metapro-dashboard.html"), "utf8");

    expect(manifest.modules.gdwiki?.enabled).toBe(true);
    expect(manifest.modules.wiki).toBeUndefined();
    expect(dashboard).toContain("<span class=\"module-name\">gdwiki</span>");
    expect(dashboard).not.toContain("<div class=\"disabled\"><span>gdwiki</span>");
    expect(await fileExists(path.join(root, ".metaproject", "skills", "gdwiki", "SKILL.md"))).toBe(true);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("backfills the Task Manager for projects initialized before it existed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-update-backfill-"));
  const previousCwd = process.cwd();
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    // Pre-tasks manifest: tasks present but disabled, no flow scaffold.
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: { gdgraph: { enabled: true }, tasks: { enabled: false } },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    process.chdir(root);
    await updateCommand(["--skip-runtime"]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean }>;
    };
    expect(manifest.modules.tasks?.enabled).toBe(true);
    expect(await fileExists(path.join(root, ".metaproject", "skills", "flow", "SKILL.md"))).toBe(true);
    expect(await fileExists(path.join(root, ".metaproject", "modules", "tasks.md"))).toBe(true);
    expect(await readFile(path.join(root, ".metaproject", "flows", "README.md"), "utf8")).toContain("Flow");
    // The flow discovery policy is migrated into the entrypoint.
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain("Metaproject flow skill");
    // Backfill does not create runtime data dirs.
    expect(await fileExists(path.join(root, ".metaproject", "data", "tasks"))).toBe(false);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("respects --no-tasks and does not backfill", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-update-notasks-"));
  const previousCwd = process.cwd();
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: { gdgraph: { enabled: true }, tasks: { enabled: false } },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    process.chdir(root);
    await updateCommand(["--skip-runtime", "--no-tasks"]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean }>;
    };
    expect(manifest.modules.tasks?.enabled).toBe(false);
    expect(await fileExists(path.join(root, ".metaproject", "skills", "flow", "SKILL.md"))).toBe(false);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).not.toContain("Metaproject flow skill");
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function expectDashboardLinksToExist(projectRoot: string, dashboard: string): Promise<void> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  const hrefs = [...dashboard.matchAll(/href="([^"]+)"/g)].flatMap((match) => match[1] ? [match[1]] : []);
  const missing: string[] = [];
  for (const href of hrefs) {
    if (href.startsWith("http://") || href.startsWith("https://")) {
      continue;
    }
    if (!(await fileExists(path.join(metaprojectRoot, href)))) {
      missing.push(href);
    }
  }
  expect(missing).toEqual([]);
}
