import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { access, constants, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installGdskills } from "../gdskills/install";
import {
  normalizeGdskillsProfile,
  type GdskillsProfile,
} from "../gdskills/catalog";
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
  renderImportedAgentRules,
  renderIndexMarkdown,
  renderMetaprojectCoreReadme,
  renderMetaprojectDashboardHtml,
  renderMetaprojectReadme,
  renderProjectRulesReadme,
  renderProjectRulesSkillReadme,
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

type UpdateOptions = {
  help: boolean;
  hooks: boolean;
  skipRuntime: boolean;
};

export async function updateCommand(args: string[] = []): Promise<void> {
  const options = parseUpdateArgs(args);
  if (options.help) {
    printHelp();
    return;
  }

  const projectRoot = process.cwd();
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  if (!(await pathExists(metaprojectRoot))) {
    console.error("Metaproject is not initialized. Run: gd-metapro init");
    process.exitCode = 1;
    return;
  }

  if (!options.skipRuntime) {
    await updateRuntime(projectRoot);
  }

  await refreshServiceFiles(projectRoot);
  console.log("Updated .metaproject service files without touching data artifacts.");

  if (options.hooks) {
    await runPostUpdateHooks(projectRoot);
  } else {
    console.log("Post-update hooks skipped. Use `gd-metapro update --hooks` to run them explicitly.");
  }
}

async function refreshServiceFiles(projectRoot: string): Promise<void> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  const manifest = await readManifest(metaprojectRoot);
  const enableGdgraph = moduleEnabled(manifest, "gdgraph");
  const enableGdctx = moduleEnabled(manifest, "gdctx");
  const enableGdwiki = moduleEnabled(manifest, "gdwiki");
  const enableGdskills = moduleEnabled(manifest, "gdskills");
  const enableHealth = moduleEnabled(manifest, "health");
  const enableTesting = moduleEnabled(manifest, "testing");
  const enableMemory = moduleEnabled(manifest, "memory");
  const enableTasks = moduleEnabled(manifest, "tasks");
  const gdskillsProfile = normalizeGdskillsProfile(manifest.modules?.gdskills?.profile);
  const ruleSources = await syncAgentRules(projectRoot, metaprojectRoot, manifest.agentEntrypoints?.root ?? []);

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

async function syncAgentRules(
  projectRoot: string,
  metaprojectRoot: string,
  manifestSources: string[],
): Promise<string[]> {
  const sources = await findAgentEntrypoints(projectRoot, manifestSources);
  for (const source of sources) {
    const sourcePath = path.join(projectRoot, source);
    if (!(await pathExists(sourcePath))) {
      continue;
    }
    const ruleFile = `${source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
    await writeTextIfChanged(
      path.join(metaprojectRoot, "rules", ruleFile),
      renderImportedAgentRules({
        source,
        content: await readFile(sourcePath, "utf8"),
      }),
    );
  }
  return sources;
}

async function findAgentEntrypoints(projectRoot: string, manifestSources: string[]): Promise<string[]> {
  const candidates = [...new Set([...manifestSources, "AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"])];
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(projectRoot, candidate))) {
      existing.push(candidate);
    }
  }
  return existing;
}

async function readManifest(metaprojectRoot: string): Promise<MetaprojectManifest> {
  const manifestPath = path.join(metaprojectRoot, "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return {};
  }
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
  } catch {
    return {};
  }
}

function moduleEnabled(manifest: MetaprojectManifest, name: string): boolean {
  return manifest.modules?.[name]?.enabled === true;
}

function parseUpdateArgs(args: string[]): UpdateOptions {
  return {
    help: args.includes("--help") || args.includes("-h"),
    hooks: args.includes("--hooks"),
    skipRuntime: args.includes("--skip-runtime"),
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
  console.log(`gd-metapro update

Usage:
  gd-metapro update [--skip-runtime] [--hooks]

Default behavior:
  - updates managed runtime when present;
  - refreshes .metaproject service files, core scripts, managed skills, module manifests, dashboard and hooks;
  - does not write .metaproject/data artifacts.

Options:
  --skip-runtime  Refresh local service files without fetching the managed runtime.
  --hooks         Run executable .metaproject/hooks/post-update.d hooks explicitly.
`);
}
