import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { access, constants, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installGdskills } from "../gdskills/install";
import { moduleCommands } from "./module-commands";
import {
  normalizeGdskillsProfile,
  type GdskillsProfile,
} from "../gdskills/catalog";
import { syncAgentRules } from "../rules/agent-entrypoints";
import { hasDistilledEntrypoints } from "../rules/distill";
import { renderHealthConfig } from "../health/config";
import {
  renderHealthCoreReadme,
  renderHealthManifest,
  renderHealthSkillReadme,
} from "../health/templates";
import { renderMemoryConfig } from "../memory/config";
import {
  renderMemoryCoreReadme,
  renderMemoryEntryTemplate,
  renderMemoryManifest,
  renderMemorySkillReadme,
} from "../memory/templates";
import {
  renderTestingConfig,
  renderTestingCoreReadme,
  renderTestingManifest,
  renderTestingSkillReadme,
  renderTestingWikiConventions,
  renderTestingWikiReadme,
} from "../testing/templates";
import {
  renderGdwikiManifest,
  renderGdwikiSkillReadme,
  renderWikiPageTemplate,
} from "../wiki/templates";
import { pathExists } from "../lib/fs";
import {
  banner,
  heading,
  helpOptions,
  helpTitle,
  helpUsage,
  note,
  statusLine,
  style,
  symbols,
  nextSteps,
} from "../lib/ui";
import {
  renderGdctxCoreReadme,
  renderGdctxConfig,
  renderGdctxManifest,
  renderGdctxSkillReadme,
  renderGdgraphCoreCli,
  renderGdgraphCoreReadme,
  renderGdgraphManifest,
  renderGdgraphPostCommitHook,
  renderGdgraphSkillReadme,
  renderGdskillsPostCommitHook,
  renderHealthPostCommitHook,
  renderHooksReadme,
  renderIndexMarkdown,
  renderMetaprojectCoreReadme,
  renderMetaprojectDashboardHtml,
  renderMetaprojectDashboardPostCommitHook,
  renderMetaprojectReadme,
  renderProjectRulesReadme,
  renderProjectRulesSkillReadme,
  type MetaprojectDashboardData,
} from "../lib/templates";
import {
  renderTestingPostCommitHook,
  renderTestingPrePushHook,
} from "../testing/templates";
import {
  renderFlowCompleteSkill,
  renderFlowInitSkill,
  renderFlowManageSkill,
  renderFlowSkillRouter,
  renderFlowsReadme,
  renderTasksManifest,
} from "../flow/templates";

type ManifestModule = {
  enabled?: boolean;
  profile?: GdskillsProfile;
  hooks?: {
    gitPostCommit?: string;
    prePush?: string;
    postUpdate?: string;
  };
};

type MetaprojectManifest = {
  modules?: Record<string, ManifestModule>;
  agentEntrypoints?: {
    root?: string[];
  };
};

type ManifestReadResult = {
  exists: boolean;
  valid: boolean;
  manifest: MetaprojectManifest;
  migrated: boolean;
};

type UpdateOptions = {
  help: boolean;
  hooks: boolean;
  skipRuntime: boolean;
  noTasks: boolean;
};

export type DashboardBuildResult = {
  path: string;
  data: MetaprojectDashboardData;
};

export async function updateCommand(args: string[] = []): Promise<void> {
  const options = parseUpdateArgs(args);
  if (options.help) {
    printHelp();
    return;
  }

  const projectRoot = process.cwd();
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  banner(
    "gd-metapro update",
    `Refreshing the .metaproject workspace in ${path.basename(projectRoot)}/`,
  );
  if (!(await pathExists(metaprojectRoot))) {
    console.log(`  ${style.red(symbols.cross)} Metaproject is not initialized.`);
    console.log(`  ${style.cyan(symbols.arrow)} Run ${style.cyan("gd-metapro init")} first.`);
    process.exitCode = 1;
    return;
  }

  if (!options.skipRuntime) {
    await updateRuntime(projectRoot);
  }

  const summary = await refreshServiceFiles(projectRoot, options);

  heading("Refreshed service files");
  note("Data artifacts were left untouched.");
  if (summary.recoveredManifest) {
    console.log(`  ${style.yellow(symbols.ok)} Recovered metaproject.json from existing service/data folders.`);
  }
  if (summary.backfilledTasks) {
    console.log(
      `  ${style.yellow(symbols.ok)} Backfilled Task Manager (flows/, skills/flow, modules/tasks.md, manifest entry).`,
    );
  }
  statusLine("gdgraph", summary.modules.gdgraph);
  statusLine("gdctx", summary.modules.gdctx);
  statusLine("gdwiki", summary.modules.gdwiki);
  statusLine(
    "gdskills",
    summary.modules.gdskills,
    summary.modules.gdskills ? `profile: ${summary.gdskillsProfile}` : undefined,
  );
  statusLine("health", summary.modules.health);
  statusLine("testing", summary.modules.testing);
  statusLine("memory", summary.modules.memory);
  statusLine("tasks", summary.modules.tasks);

  const steps: string[] = [];
  if (options.hooks) {
    await runPostUpdateHooks(projectRoot);
  } else {
    steps.push(`Run ${style.cyan("gd-metapro update --hooks")} to run post-update hooks.`);
  }
  steps.push(`Read ${style.cyan(".metaproject/index.md")} for the current module map.`);
  nextSteps(steps);
}

type RefreshSummary = {
  modules: {
    gdgraph: boolean;
    gdctx: boolean;
    gdwiki: boolean;
    gdskills: boolean;
    health: boolean;
    testing: boolean;
    memory: boolean;
    tasks: boolean;
  };
  gdskillsProfile: GdskillsProfile;
  backfilledTasks: boolean;
  recoveredManifest: boolean;
};

async function refreshServiceFiles(projectRoot: string, options: UpdateOptions): Promise<RefreshSummary> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  const manifestState = await readManifest(metaprojectRoot);
  const manifest = manifestState.manifest;
  const recoveredManifest = !manifestState.exists || !manifestState.valid;
  if (manifestState.migrated) {
    await writeFile(path.join(metaprojectRoot, "metaproject.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  const enableGdgraph = moduleEnabled(manifest, "gdgraph");
  const enableGdctx = moduleEnabled(manifest, "gdctx");
  const enableGdwiki = moduleEnabled(manifest, "gdwiki");
  const enableGdskills = moduleEnabled(manifest, "gdskills");
  const enableHealth = moduleEnabled(manifest, "health");
  const enableTesting = moduleEnabled(manifest, "testing");
  const enableMemory = moduleEnabled(manifest, "memory");

  // Task Manager backfill: projects initialized before the tasks module have a
  // bare `tasks: { enabled: false }` stub. `update` enables and scaffolds it
  // (skip with --no-tasks).
  let enableTasks = moduleEnabled(manifest, "tasks");
  const backfillTasks = !enableTasks && !options.noTasks;
  if (backfillTasks) {
    enableTasks = true;
  }

  const gdskillsProfile = normalizeGdskillsProfile(manifest.modules?.gdskills?.profile);
  const syncedRules = await syncAgentRules(projectRoot, metaprojectRoot, {
    enableTasks,
    manifestSources: manifest.agentEntrypoints?.root ?? [],
    createDefault: true,
  });
  const ruleSources = syncedRules.map((rule) => rule.source);
  const dashboardData = await collectDashboardData(metaprojectRoot);

  await createServiceDirs(metaprojectRoot, {
    enableGdgraph,
    enableGdctx,
    enableGdwiki,
    enableGdskills,
    enableHealth,
    enableTesting,
    enableMemory,
    enableTasks,
  });

  await writeTextIfChanged(path.join(metaprojectRoot, "core", "README.md"), renderMetaprojectCoreReadme());
  await writeTextIfChanged(path.join(metaprojectRoot, "hooks", "README.md"), renderHooksReadme());
  await writeTextIfChanged(path.join(metaprojectRoot, "rules", "README.md"), renderProjectRulesReadme());
  await writeTextIfChanged(
    path.join(metaprojectRoot, "skills", "project-rules", "README.md"),
    renderProjectRulesSkillReadme({ sources: ruleSources }),
  );
  await writeTextIfChanged(
    path.join(metaprojectRoot, "index.md"),
    renderIndexMarkdown({
      enableGdgraph,
      enableGdctx,
      enableGdwiki,
      enableGdskills,
      enableHealth,
      enableTesting,
      enableMemory,
      enableTasks,
      ruleSources,
      hasDistilledEntrypoints: await hasDistilledEntrypoints(metaprojectRoot),
    }),
  );
  await writeTextIfChanged(
    path.join(metaprojectRoot, "gd-metapro-dashboard.html"),
    renderMetaprojectDashboardHtml({
      enableGdgraph,
      enableGdctx,
      enableGdwiki,
      enableGdskills,
      enableHealth,
      enableTesting,
      enableMemory,
      enableTasks,
      data: dashboardData,
    }),
  );
  await writeTextIfMissing(
    path.join(metaprojectRoot, "README.md"),
    renderMetaprojectReadme({
      enableGdgraph,
      enableGdctx,
      enableGdwiki,
      enableGdskills,
      enableHealth,
      enableTesting,
      enableMemory,
      enableTasks,
    }),
  );

  if (enableGdgraph) {
    await installGdgraphCoreScripts(metaprojectRoot);
    await writeTextIfChanged(path.join(metaprojectRoot, "modules", "gdgraph.md"), renderGdgraphManifest());
    await writeTextIfChanged(path.join(metaprojectRoot, "core", "gdgraph", "README.md"), renderGdgraphCoreReadme());
    await writeTextIfChanged(path.join(metaprojectRoot, "skills", "gdgraph", "SKILL.md"), renderGdgraphSkillReadme());
    if (manifest.modules?.gdgraph?.hooks?.gitPostCommit) {
      await installManagedHook(projectRoot, "post-commit", "gdgraph-post-commit", renderGdgraphPostCommitHook());
    }
  }

  if (enableGdctx) {
    await writeTextIfMissing(path.join(metaprojectRoot, "gdctx.config.json"), renderGdctxConfig());
    await writeTextIfChanged(path.join(metaprojectRoot, "modules", "gdctx.md"), renderGdctxManifest());
    await writeTextIfChanged(path.join(metaprojectRoot, "core", "gdctx", "README.md"), renderGdctxCoreReadme());
    await writeTextIfChanged(path.join(metaprojectRoot, "skills", "gdctx", "SKILL.md"), renderGdctxSkillReadme());
  }

  if (enableGdwiki) {
    await writeTextIfMissing(path.join(metaprojectRoot, "wiki", "templates", "page.md"), renderWikiPageTemplate());
    await writeTextIfChanged(path.join(metaprojectRoot, "modules", "gdwiki.md"), renderGdwikiManifest());
    await writeTextIfChanged(path.join(metaprojectRoot, "skills", "gdwiki", "SKILL.md"), renderGdwikiSkillReadme());
  }

  if (enableGdskills) {
    await installGdskills(metaprojectRoot, gdskillsProfile, { createDataDirs: false });
    if (manifest.modules?.gdskills?.hooks?.gitPostCommit) {
      await installManagedHook(projectRoot, "post-commit", "gdskills-post-commit", renderGdskillsPostCommitHook());
    }
  }

  if (enableHealth) {
    await writeTextIfMissing(path.join(metaprojectRoot, "health.config.json"), renderHealthConfig());
    await writeTextIfChanged(path.join(metaprojectRoot, "modules", "health.md"), renderHealthManifest());
    await writeTextIfChanged(path.join(metaprojectRoot, "core", "health", "README.md"), renderHealthCoreReadme());
    await writeTextIfChanged(path.join(metaprojectRoot, "skills", "health", "SKILL.md"), renderHealthSkillReadme());
    if (manifest.modules?.health?.hooks?.gitPostCommit) {
      await installManagedHook(projectRoot, "post-commit", "health-post-commit", renderHealthPostCommitHook());
    }
  }

  if (enableTesting) {
    await writeTextIfMissing(
      path.join(metaprojectRoot, "testing.config.json"),
      renderTestingConfig({
        postCommitRefresh: Boolean(manifest.modules?.testing?.hooks?.gitPostCommit),
        prePushGate: Boolean(manifest.modules?.testing?.hooks?.prePush),
      }),
    );
    await writeTextIfChanged(path.join(metaprojectRoot, "modules", "testing.md"), renderTestingManifest());
    await writeTextIfChanged(path.join(metaprojectRoot, "core", "testing", "README.md"), renderTestingCoreReadme());
    await writeTextIfChanged(path.join(metaprojectRoot, "skills", "testing", "SKILL.md"), renderTestingSkillReadme());
    if (enableGdwiki) {
      await writeTextIfMissing(path.join(metaprojectRoot, "wiki", "testing", "README.md"), renderTestingWikiReadme());
      await writeTextIfMissing(path.join(metaprojectRoot, "wiki", "testing", "conventions.md"), renderTestingWikiConventions());
    }
    if (manifest.modules?.testing?.hooks?.gitPostCommit) {
      await installManagedHook(projectRoot, "post-commit", "testing-post-commit", renderTestingPostCommitHook());
    }
    if (manifest.modules?.testing?.hooks?.prePush) {
      await installManagedHook(projectRoot, "pre-push", "testing-pre-push", renderTestingPrePushHook());
    }
  }

  if (await shouldInstallDashboardPostCommitHook(projectRoot, manifest)) {
    await installManagedHook(
      projectRoot,
      "post-commit",
      "metaproject-dashboard-post-commit",
      renderMetaprojectDashboardPostCommitHook(),
    );
  }

  if (enableMemory) {
    await writeTextIfMissing(path.join(metaprojectRoot, "memory.config.json"), renderMemoryConfig());
    await writeTextIfMissing(path.join(metaprojectRoot, "memory", "templates", "entry.md"), renderMemoryEntryTemplate());
    await writeTextIfChanged(path.join(metaprojectRoot, "modules", "memory.md"), renderMemoryManifest());
    await writeTextIfChanged(path.join(metaprojectRoot, "core", "memory", "README.md"), renderMemoryCoreReadme());
    await writeTextIfChanged(path.join(metaprojectRoot, "skills", "memory", "SKILL.md"), renderMemorySkillReadme());
  }

  if (enableTasks) {
    await writeTextIfChanged(path.join(metaprojectRoot, "flows", "README.md"), renderFlowsReadme());
    await writeTextIfChanged(path.join(metaprojectRoot, "modules", "tasks.md"), renderTasksManifest());
    await writeTextIfChanged(path.join(metaprojectRoot, "skills", "flow", "SKILL.md"), renderFlowSkillRouter());
    await writeTextIfChanged(path.join(metaprojectRoot, "skills", "flow", "init.md"), renderFlowInitSkill());
    await writeTextIfChanged(path.join(metaprojectRoot, "skills", "flow", "manage.md"), renderFlowManageSkill());
    await writeTextIfChanged(path.join(metaprojectRoot, "skills", "flow", "complete.md"), renderFlowCompleteSkill());
  }

  if (!manifestState.exists || !manifestState.valid) {
    await writeRecoveredManifest(metaprojectRoot, {
      enableGdgraph,
      enableGdctx,
      enableGdwiki,
      enableGdskills,
      enableHealth,
      enableTesting,
      enableMemory,
      enableTasks,
    });
  } else if (backfillTasks) {
    await enableTasksInManifest(metaprojectRoot);
  }

  await updateManifestAgentEntrypoints(metaprojectRoot, ruleSources);

  return {
    modules: {
      gdgraph: enableGdgraph,
      gdctx: enableGdctx,
      gdwiki: enableGdwiki,
      gdskills: enableGdskills,
      health: enableHealth,
      testing: enableTesting,
      memory: enableMemory,
      tasks: enableTasks,
    },
    gdskillsProfile,
    backfilledTasks: backfillTasks,
    recoveredManifest,
  };
}

export async function buildDashboard(projectRoot: string = process.cwd()): Promise<DashboardBuildResult> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  if (!(await pathExists(metaprojectRoot))) {
    throw new Error("Metaproject is not initialized. Run: gd-metapro init");
  }

  const manifest = (await readManifest(metaprojectRoot)).manifest;
  const data = await collectDashboardData(metaprojectRoot);
  const dashboardPath = path.join(metaprojectRoot, "gd-metapro-dashboard.html");
  await writeTextIfChanged(
    dashboardPath,
    renderMetaprojectDashboardHtml({
      enableGdgraph: moduleEnabled(manifest, "gdgraph"),
      enableGdctx: moduleEnabled(manifest, "gdctx"),
      enableGdwiki: moduleEnabled(manifest, "gdwiki"),
      enableGdskills: moduleEnabled(manifest, "gdskills"),
      enableHealth: moduleEnabled(manifest, "health"),
      enableTesting: moduleEnabled(manifest, "testing"),
      enableMemory: moduleEnabled(manifest, "memory"),
      enableTasks: moduleEnabled(manifest, "tasks"),
      data,
    }),
  );

  return { path: dashboardPath, data };
}

async function shouldInstallDashboardPostCommitHook(projectRoot: string, manifest: MetaprojectManifest): Promise<boolean> {
  const modules = manifest.modules ?? {};
  if (Object.values(modules).some((module) => Boolean(module.hooks?.gitPostCommit))) {
    return true;
  }
  const hookPath = path.join(projectRoot, ".git", "hooks", "post-commit");
  if (!(await pathExists(hookPath))) {
    return false;
  }
  return (await readFile(hookPath, "utf8")).includes("# gd-metapro:");
}

async function collectDashboardData(metaprojectRoot: string): Promise<MetaprojectDashboardData> {
  const data: MetaprojectDashboardData = {};
  const health = await collectHealthDashboardData(metaprojectRoot);
  if (health) {
    data.health = health;
  }
  const graph = await collectGraphDashboardData(metaprojectRoot);
  if (graph) {
    data.graph = graph;
  }
  const testing = await collectTestingDashboardData(metaprojectRoot);
  if (testing) {
    data.testing = testing;
  }
  const wiki = await collectMarkdownPages(path.join(metaprojectRoot, "wiki"), "wiki");
  if (wiki.length > 0) {
    data.wiki = { pages: wiki };
  }
  const memory = await collectMarkdownPages(path.join(metaprojectRoot, "memory"), "memory");
  if (memory.length > 0) {
    data.memory = { entries: memory };
  }
  return data;
}

async function collectHealthDashboardData(
  metaprojectRoot: string,
): Promise<MetaprojectDashboardData["health"] | undefined> {
  const reportPath = path.join(metaprojectRoot, "data", "health", "artifacts", "latest.json");
  if (!(await pathExists(reportPath))) {
    return undefined;
  }
  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    gate?: { status?: unknown };
    sources?: Array<Record<string, unknown>>;
    metrics?: Array<Record<string, unknown>>;
  };
  const metrics = Array.isArray(report.metrics) ? report.metrics : [];
  const project = metrics.find((metric) => metric.key === "project") ?? {};
  const counts = (project.findingCounts ?? {}) as {
    total?: unknown;
    byPriority?: Record<string, unknown>;
  };
  const byPriority = counts.byPriority ?? {};
  const sortedMetrics = metrics
    .filter((metric) => metric.key !== "project")
    .sort((a, b) => numberValue(b.risk_score) - numberValue(a.risk_score));
  const scopes = sortedMetrics
    .filter((metric) => String(metric.kind ?? "") !== "file" && numberValue((metric.findingCounts as { total?: unknown } | undefined)?.total) > 0)
    .slice(0, 12)
    .map((metric) => metricToScope(metric));
  const files = sortedMetrics
    .filter((metric) => String(metric.kind ?? "") === "file" && numberValue((metric.findingCounts as { total?: unknown } | undefined)?.total) > 0)
    .slice(0, 15)
    .map((metric) => ({
      name: String(metric.name ?? metric.key ?? "unknown"),
      score: numberOrDash(metric.health_score),
      findings: numberValue((metric.findingCounts as { total?: unknown } | undefined)?.total),
      risk: numberValue(metric.risk_score),
      complexity: numberOrDash((metric.complexity as { max?: unknown } | undefined)?.max),
    }));

  return {
    status: String(report.gate?.status ?? "unknown"),
    score: numberOrDash(project.health_score),
    ...(typeof project.trend === "string" ? { trend: project.trend } : {}),
    findings: numberValue(counts.total),
    p0: numberValue(byPriority.P0),
    p1: numberValue(byPriority.P1),
    p2: numberValue(byPriority.P2),
    sources: (report.sources ?? []).map((source) => ({
      source: String(source.source ?? "unknown"),
      status: String(source.status ?? "unknown"),
      findings: numberValue(source.findings),
      required: source.required === true,
    })),
    scopes,
    files,
    reportHref: "data/health/artifacts/latest.md",
  };
}

function metricToScope(metric: Record<string, unknown>): {
  name: string;
  kind: string;
  score: number | string;
  findings: number;
  risk: number;
  complexity?: number | string;
} {
  return {
    name: String(metric.name ?? metric.key ?? "unknown"),
    kind: String(metric.kind ?? "scope"),
    score: numberOrDash(metric.health_score),
    findings: numberValue((metric.findingCounts as { total?: unknown } | undefined)?.total),
    risk: numberValue(metric.risk_score),
    complexity: numberOrDash((metric.complexity as { max?: unknown } | undefined)?.max),
  };
}

async function collectGraphDashboardData(
  metaprojectRoot: string,
): Promise<MetaprojectDashboardData["graph"] | undefined> {
  const nodesPath = path.join(metaprojectRoot, "data", "gdgraph", "storage", "nodes.jsonl");
  const edgesPath = path.join(metaprojectRoot, "data", "gdgraph", "storage", "edges.jsonl");
  if (!(await pathExists(nodesPath)) || !(await pathExists(edgesPath))) {
    return undefined;
  }
  const moduleStats = new Map<string, { files: number; edges: number }>();
  let nodes = 0;
  let files = 0;
  let assets = 0;
  for (const node of parseJsonl(await readFile(nodesPath, "utf8"))) {
    nodes += 1;
    if (node.kind === "asset") {
      assets += 1;
      continue;
    }
    files += 1;
    const moduleName = moduleNameFromPath(String(node.path ?? node.id ?? "unknown"));
    const stats = moduleStats.get(moduleName) ?? { files: 0, edges: 0 };
    stats.files += 1;
    moduleStats.set(moduleName, stats);
  }
  let edges = 0;
  let imports = 0;
  let assetEdges = 0;
  let unresolved = 0;
  for (const edge of parseJsonl(await readFile(edgesPath, "utf8"))) {
    edges += 1;
    if (edge.kind === "imports") {
      imports += 1;
    } else if (edge.kind === "asset") {
      assetEdges += 1;
    } else if (edge.kind === "unresolved") {
      unresolved += 1;
    }
    const moduleName = moduleNameFromPath(String(edge.from ?? "unknown"));
    const stats = moduleStats.get(moduleName) ?? { files: 0, edges: 0 };
    stats.edges += 1;
    moduleStats.set(moduleName, stats);
  }

  return {
    nodes,
    files,
    assets,
    edges,
    imports,
    assetsEdges: assetEdges,
    unresolved,
    topModules: [...moduleStats.entries()]
      .map(([name, stats]) => ({ name, files: stats.files, edges: stats.edges }))
      .sort((a, b) => b.files - a.files || b.edges - a.edges)
      .slice(0, 12),
    storageHref: "data/gdgraph/storage/nodes.jsonl",
  };
}

async function collectTestingDashboardData(
  metaprojectRoot: string,
): Promise<MetaprojectDashboardData["testing"] | undefined> {
  const reportPath = path.join(metaprojectRoot, "data", "testing", "artifacts", "latest.json");
  const contextPath = path.join(metaprojectRoot, "data", "testing", "context.md");
  if (await pathExists(reportPath)) {
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    const totalTests = numberOrUndefined(report.total);
    const failedTests = Array.isArray(report.failures)
      ? report.failures.length
      : numberOrUndefined(report.failed);
    return {
      status: String(report.status ?? "unknown"),
      ...(typeof report.runner === "string" ? { runner: report.runner } : {}),
      ...(totalTests !== undefined ? { tests: totalTests } : {}),
      ...(failedTests !== undefined ? { failures: failedTests } : {}),
      reportHref: "data/testing/artifacts/latest.md",
      ...(await pathExists(contextPath) ? { contextHref: "data/testing/context.md" } : {}),
    };
  }
  if (await pathExists(contextPath)) {
    return {
      status: "context",
      contextHref: "data/testing/context.md",
    };
  }
  return undefined;
}

async function collectMarkdownPages(root: string, hrefPrefix: string): Promise<Array<{ title: string; href: string; group: string }>> {
  if (!(await pathExists(root))) {
    return [];
  }
  const files = await listMarkdownFiles(root);
  const pages: Array<{ title: string; href: string; group: string }> = [];
  for (const filePath of files.slice(0, 40)) {
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    if (relativePath === "index.md" || relativePath.startsWith("templates/")) {
      continue;
    }
    const content = await readFile(filePath, "utf8");
    pages.push({
      title: firstMarkdownHeading(content) ?? relativePath,
      href: `${hrefPrefix}/${relativePath}`,
      group: relativePath.includes("/") ? relativePath.split("/")[0] ?? "root" : "root",
    });
  }
  return pages;
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function firstMarkdownHeading(content: string): string | undefined {
  const line = content.split("\n").find((item) => item.startsWith("# "));
  return line?.replace(/^#\s+/, "").trim();
}

function parseJsonl(content: string): Array<Record<string, unknown>> {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function moduleNameFromPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  if (parts[0] === "src" && parts[1]) {
    return `src/${parts[1]}`;
  }
  if ((parts[0] === "e2e" || parts[0] === "packages" || parts[0] === "app" || parts[0] === "lib" || parts[0] === "services") && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? "root";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrDash(value: unknown): number | string {
  return typeof value === "number" && Number.isFinite(value) ? value : "-";
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function writeRecoveredManifest(
  metaprojectRoot: string,
  modules: {
    enableGdgraph: boolean;
    enableGdctx: boolean;
    enableGdwiki: boolean;
    enableGdskills: boolean;
    enableHealth: boolean;
    enableTesting: boolean;
    enableMemory: boolean;
    enableTasks: boolean;
  },
): Promise<void> {
  const manifest = {
    version: 1,
    generatedBy: "gd-metapro update",
    modules: {
      gdgraph: modules.enableGdgraph
        ? {
            enabled: true,
            core: ".metaproject/core/gdgraph",
            data: ".metaproject/data/gdgraph",
            manifest: ".metaproject/modules/gdgraph.md",
            commands: moduleCommands("gdgraph"),
          }
        : { enabled: false },
      gdctx: modules.enableGdctx
        ? {
            enabled: true,
            core: ".metaproject/core/gdctx",
            data: ".metaproject/data/gdctx",
            manifest: ".metaproject/modules/gdctx.md",
            commands: moduleCommands("gdctx"),
          }
        : { enabled: false },
      gdwiki: modules.enableGdwiki
        ? {
            enabled: true,
            data: ".metaproject/wiki",
            manifest: ".metaproject/modules/gdwiki.md",
            commands: moduleCommands("gdwiki"),
          }
        : { enabled: false },
      gdskills: modules.enableGdskills
        ? {
            enabled: true,
            data: ".metaproject/project-skills",
            manifest: ".metaproject/modules/gdskills.md",
            commands: moduleCommands("gdskills"),
          }
        : { enabled: false },
      health: modules.enableHealth
        ? {
            enabled: true,
            core: ".metaproject/core/health",
            data: ".metaproject/data/health",
            manifest: ".metaproject/modules/health.md",
            commands: moduleCommands("health"),
          }
        : { enabled: false },
      testing: modules.enableTesting
        ? {
            enabled: true,
            core: ".metaproject/core/testing",
            data: ".metaproject/data/testing",
            manifest: ".metaproject/modules/testing.md",
            commands: moduleCommands("testing"),
          }
        : { enabled: false },
      memory: modules.enableMemory
        ? {
            enabled: true,
            core: ".metaproject/core/memory",
            data: ".metaproject/memory",
            manifest: ".metaproject/modules/memory.md",
            commands: moduleCommands("memory"),
          }
        : { enabled: false },
      tasks: modules.enableTasks
        ? {
            enabled: true,
            core: ".metaproject/flows",
            data: ".metaproject/data/tasks",
            manifest: ".metaproject/modules/tasks.md",
            commands: moduleCommands("tasks"),
          }
        : { enabled: false },
    },
    agentEntrypoints: {
      root: ["AGENTS.md", "CLAUDE.md"],
      metaproject: ".metaproject/index.md",
    },
  };

  await writeFile(path.join(metaprojectRoot, "metaproject.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

// Enables the tasks module in metaproject.json without disturbing other keys.
async function enableTasksInManifest(metaprojectRoot: string): Promise<void> {
  const manifestPath = path.join(metaprojectRoot, "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return;
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const modules = (raw.modules ?? {}) as Record<string, unknown>;
  modules.tasks = {
    enabled: true,
    core: ".metaproject/flows",
    data: ".metaproject/data/tasks",
    manifest: ".metaproject/modules/tasks.md",
    commands: moduleCommands("tasks"),
  };
  raw.modules = modules;
  await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function updateManifestAgentEntrypoints(metaprojectRoot: string, ruleSources: string[]): Promise<void> {
  const manifestPath = path.join(metaprojectRoot, "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return;
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const agentEntrypoints = (raw.agentEntrypoints ?? {}) as Record<string, unknown>;
  agentEntrypoints.root = ruleSources;
  agentEntrypoints.metaproject = ".metaproject/index.md";
  raw.agentEntrypoints = agentEntrypoints;
  await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

async function updateRuntime(projectRoot: string): Promise<void> {
  const runtimeRoot = await findRuntimeRoot(projectRoot);

  if (runtimeRoot) {
    await run("git", ["fetch", "--depth", "1", "origin", "main"], runtimeRoot);
    await run("git", ["checkout", "--force", "FETCH_HEAD"], runtimeRoot);
    console.log(`Updated runtime: ${runtimeRoot}`);
  } else {
    console.log("Runtime update skipped: no managed runtime found.");
  }
}

async function findRuntimeRoot(projectRoot: string): Promise<string | null> {
  const projectRuntime = path.join(projectRoot, ".metaproject", "runtime", "gd-metapro");
  if (await pathExists(path.join(projectRuntime, ".git"))) {
    return projectRuntime;
  }

  const home = process.env.HOME;
  if (!home) {
    return null;
  }

  const globalRuntime = path.join(home, ".gd-metapro", "gd-metapro");
  if (await pathExists(path.join(globalRuntime, ".git"))) {
    return globalRuntime;
  }

  return null;
}

async function createServiceDirs(
  metaprojectRoot: string,
  modules: {
    enableGdgraph: boolean;
    enableGdctx: boolean;
    enableGdwiki: boolean;
    enableGdskills: boolean;
    enableHealth: boolean;
    enableTesting: boolean;
    enableMemory: boolean;
    enableTasks: boolean;
  },
): Promise<void> {
  const dirs = [
    path.join(metaprojectRoot, "core"),
    path.join(metaprojectRoot, "hooks", "post-update.d"),
    path.join(metaprojectRoot, "modules"),
    path.join(metaprojectRoot, "rules"),
    path.join(metaprojectRoot, "skills", "project-rules"),
    ...(modules.enableGdgraph ? [
      path.join(metaprojectRoot, "core", "gdgraph"),
      path.join(metaprojectRoot, "skills", "gdgraph"),
    ] : []),
    ...(modules.enableGdctx ? [
      path.join(metaprojectRoot, "core", "gdctx"),
      path.join(metaprojectRoot, "skills", "gdctx"),
    ] : []),
    ...(modules.enableGdwiki ? [
      path.join(metaprojectRoot, "skills", "gdwiki"),
      path.join(metaprojectRoot, "wiki", "templates"),
    ] : []),
    ...(modules.enableHealth ? [
      path.join(metaprojectRoot, "core", "health"),
      path.join(metaprojectRoot, "skills", "health"),
    ] : []),
    ...(modules.enableTesting ? [
      path.join(metaprojectRoot, "core", "testing"),
      path.join(metaprojectRoot, "skills", "testing"),
    ] : []),
    ...(modules.enableMemory ? [
      path.join(metaprojectRoot, "core", "memory"),
      path.join(metaprojectRoot, "skills", "memory"),
      path.join(metaprojectRoot, "memory", "templates"),
    ] : []),
    ...(modules.enableTasks ? [
      path.join(metaprojectRoot, "flows"),
      path.join(metaprojectRoot, "skills", "flow"),
    ] : []),
  ];

  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
}

async function installGdgraphCoreScripts(metaprojectRoot: string): Promise<void> {
  const gdgraphCoreRoot = path.join(metaprojectRoot, "core", "gdgraph");
  await mkdir(gdgraphCoreRoot, { recursive: true });
  await copyFileIfChanged(runtimeSourcePath("../gdgraph/build.ts"), path.join(gdgraphCoreRoot, "build.ts"));
  await copyFileIfChanged(runtimeSourcePath("../gdgraph/query.ts"), path.join(gdgraphCoreRoot, "query.ts"));
  await copyFileIfChanged(runtimeSourcePath("../gdgraph/types.ts"), path.join(gdgraphCoreRoot, "types.ts"));
  await writeTextIfChanged(path.join(gdgraphCoreRoot, "cli.ts"), renderGdgraphCoreCli());
}

async function installManagedHook(
  projectRoot: string,
  hookName: "post-commit" | "pre-push",
  blockId: string,
  content: string,
): Promise<void> {
  const gitRoot = path.join(projectRoot, ".git");
  if (!(await pathExists(gitRoot))) {
    return;
  }

  const hooksRoot = path.join(gitRoot, "hooks");
  await mkdir(hooksRoot, { recursive: true });

  const hookPath = path.join(hooksRoot, hookName);
  const blockStart = `# gd-metapro:${blockId}:begin`;
  const blockEnd = `# gd-metapro:${blockId}:end`;
  const managedBlock = `${blockStart}\n${content.trim()}\n${blockEnd}`;
  const existing = (await pathExists(hookPath))
    ? await readFile(hookPath, "utf8")
    : "#!/usr/bin/env sh\n";
  const blockPattern = new RegExp(`${escapeRegExp(blockStart)}[\\s\\S]*?${escapeRegExp(blockEnd)}`);
  const next = blockPattern.test(existing)
    ? existing.replace(blockPattern, managedBlock)
    : `${existing.trimEnd()}\n\n${managedBlock}\n`;

  await writeFile(hookPath, next, "utf8");
  await chmod(hookPath, 0o755);
}

async function readManifest(metaprojectRoot: string): Promise<ManifestReadResult> {
  const manifestPath = path.join(metaprojectRoot, "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return {
      exists: false,
      valid: false,
      manifest: await inferManifestFromExistingMetaproject(metaprojectRoot),
      migrated: false,
    };
  }
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
    const normalized = normalizeManifest(manifest);
    return {
      exists: true,
      valid: true,
      manifest: normalized.manifest,
      migrated: normalized.migrated,
    };
  } catch {
    return {
      exists: true,
      valid: false,
      manifest: await inferManifestFromExistingMetaproject(metaprojectRoot),
      migrated: false,
    };
  }
}

function normalizeManifest(manifest: MetaprojectManifest): { manifest: MetaprojectManifest; migrated: boolean } {
  const modules = manifest.modules ?? {};
  const legacyWiki = modules.wiki;
  if (!legacyWiki || modules.gdwiki) {
    return { manifest, migrated: false };
  }
  const restModules = { ...modules };
  delete restModules.wiki;
  return {
    manifest: {
      ...manifest,
      modules: {
        ...restModules,
        gdwiki: legacyWiki,
      },
    },
    migrated: true,
  };
}

async function inferManifestFromExistingMetaproject(metaprojectRoot: string): Promise<MetaprojectManifest> {
  const modules: Record<string, ManifestModule> = {};
  const checks: Record<string, string[]> = {
    gdgraph: ["core/gdgraph", "data/gdgraph", "modules/gdgraph.md", "skills/gdgraph"],
    gdctx: ["core/gdctx", "data/gdctx", "gdctx.config.json", "modules/gdctx.md", "skills/gdctx"],
    gdwiki: ["wiki", "data/gdwiki", "modules/gdwiki.md", "skills/gdwiki"],
    gdskills: ["skills/gdskills", "skills/catalog.md", "project-skills", "data/gdskills"],
    health: ["core/health", "data/health", "health.config.json", "modules/health.md", "skills/health"],
    testing: ["core/testing", "data/testing", "testing.config.json", "modules/testing.md", "skills/testing"],
    memory: ["core/memory", "memory", "data/memory", "memory.config.json", "modules/memory.md", "skills/memory"],
    tasks: ["flows", "data/tasks", "modules/tasks.md", "skills/flow"],
  };

  for (const [moduleName, candidates] of Object.entries(checks)) {
    modules[moduleName] = {
      enabled: await anyPathExists(metaprojectRoot, candidates),
    };
  }

  return { modules };
}

async function anyPathExists(root: string, candidates: string[]): Promise<boolean> {
  for (const candidate of candidates) {
    if (await pathExists(path.join(root, candidate))) {
      return true;
    }
  }
  return false;
}

function moduleEnabled(manifest: MetaprojectManifest, name: string): boolean {
  if (name === "gdwiki") {
    return manifest.modules?.gdwiki?.enabled === true || manifest.modules?.wiki?.enabled === true;
  }
  return manifest.modules?.[name]?.enabled === true;
}

function parseUpdateArgs(args: string[]): UpdateOptions {
  return {
    help: args.includes("--help") || args.includes("-h"),
    hooks: args.includes("--hooks"),
    skipRuntime: args.includes("--skip-runtime"),
    noTasks: args.includes("--no-tasks"),
  };
}

async function runPostUpdateHooks(projectRoot: string): Promise<void> {
  const hooksDir = path.join(projectRoot, ".metaproject", "hooks", "post-update.d");
  if (!(await pathExists(hooksDir))) {
    return;
  }

  const entries = (await readdir(hooksDir)).sort();
  for (const entry of entries) {
    const hookPath = path.join(hooksDir, entry);
    try {
      await accessExecutable(hookPath);
    } catch {
      continue;
    }

    console.log(`Running post-update hook: ${entry}`);
    await run(hookPath, [], projectRoot);
  }
}

async function accessExecutable(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    access(filePath, constants.X_OK, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

async function writeTextIfChanged(filePath: string, content: string): Promise<void> {
  if ((await pathExists(filePath)) && (await readFile(filePath, "utf8")) === content) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function writeTextIfMissing(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function copyFileIfChanged(from: string, to: string): Promise<void> {
  const next = await readFile(from, "utf8");
  if ((await pathExists(to)) && (await readFile(to, "utf8")) === next) {
    return;
  }
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, next, "utf8");
}

function runtimeSourcePath(relativePath: string): string {
  const directPath = fileURLToPath(new URL(relativePath, import.meta.url));
  if (existsSync(directPath)) {
    return directPath;
  }

  if (relativePath.startsWith("../")) {
    const packagedSourcePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      relativePath.slice(3),
    );
    if (existsSync(packagedSourcePath)) {
      return packagedSourcePath;
    }
  }

  return directPath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printHelp(): void {
  helpTitle("gd-metapro update", "refresh .metaproject service files (data left untouched)");
  helpUsage(["gd-metapro update [--skip-runtime] [--hooks] [--no-tasks]"]);
  heading("Default behavior");
  for (const line of [
    "updates managed runtime when present;",
    "refreshes service files, core scripts, managed skills, manifests, dashboard, hooks;",
    "backfills the Task Manager (tasks) module for projects initialized before it existed;",
    "migrates agent entrypoint policies (AGENTS.md/CLAUDE.md);",
    "does not write .metaproject/data artifacts.",
  ]) {
    console.log(`  ${style.dim(symbols.bullet)} ${style.dim(line)}`);
  }
  helpOptions([
    { flag: "--skip-runtime", desc: "Refresh local service files without fetching the managed runtime." },
    { flag: "--hooks", desc: "Run executable .metaproject/hooks/post-update.d hooks explicitly." },
    { flag: "--no-tasks", desc: "Do not backfill/enable the Task Manager module." },
  ]);
}
