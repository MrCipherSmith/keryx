import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import {
  renderIndexMarkdown,
  renderProjectRulesReadme,
} from "../lib/templates";
import { syncAgentRules } from "../rules/agent-entrypoints";
import {
  distillAgentEntrypoints,
  hasDistilledEntrypoints,
} from "../rules/distill";

type RulesOptions = {
  help: boolean;
};

type ManifestModule = {
  enabled?: boolean;
};

type MetaprojectManifest = {
  modules?: Record<string, ManifestModule>;
  agentEntrypoints?: {
    root?: string[];
    metaproject?: string;
  };
};

export async function rulesCommand(args: string[] = [], projectRoot: string = process.cwd()): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  if (subcommand !== "sync" && subcommand !== "distill") {
    console.error(`Unknown rules command: ${subcommand}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const options = parseRulesOptions(args.slice(1));
  if (options.help) {
    printHelp();
    return;
  }

  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  if (!(await pathExists(metaprojectRoot))) {
    throw new Error("Metaproject is not initialized. Run `gd-metapro init` first.");
  }

  const manifestPath = path.join(metaprojectRoot, "metaproject.json");
  const manifest = await readManifest(manifestPath);
  const enableTasks = moduleEnabled(manifest, "tasks");
  if (subcommand === "distill") {
    const result = await distillAgentEntrypoints(projectRoot, metaprojectRoot, {
      enableTasks,
      manifestSources: manifest.agentEntrypoints?.root ?? [],
    });
    await refreshRulesIndex(metaprojectRoot, manifest, result.sources, true);
    await persistManifestEntrypoints(manifestPath, manifest, result.sources);

    console.log(`# rules distill`);
    console.log("");
    console.log(`sources: ${result.sources.join(", ") || "none"}`);
    console.log(`rules: ${result.rules.length}`);
    console.log(`skills: ${result.skills.length}`);
    console.log(`kept_root_sections: ${result.keptRootSections.length}`);
    console.log(`index: .metaproject/rules/entrypoints/index.md`);
    return;
  }

  const syncedRules = await syncAgentRules(projectRoot, metaprojectRoot, {
    enableTasks,
    manifestSources: manifest.agentEntrypoints?.root ?? [],
    createDefault: true,
  });
  const ruleSources = syncedRules.map((rule) => rule.source);

  await mkdir(path.join(metaprojectRoot, "rules"), { recursive: true });
  await writeTextIfChanged(path.join(metaprojectRoot, "rules", "README.md"), renderProjectRulesReadme());

  await persistManifestEntrypoints(manifestPath, manifest, ruleSources);
  await refreshRulesIndex(metaprojectRoot, manifest, ruleSources, await hasDistilledEntrypoints(metaprojectRoot));

  console.log(`# rules sync`);
  console.log("");
  console.log(`synced: ${syncedRules.length}`);
  for (const rule of syncedRules) {
    console.log(`- ${rule.source} -> .metaproject/rules/${rule.ruleFile} (${rule.priority})`);
  }
}

function parseRulesOptions(args: string[]): RulesOptions {
  return {
    help: args.includes("--help") || args.includes("-h"),
  };
}

async function readManifest(manifestPath: string): Promise<MetaprojectManifest> {
  if (!(await pathExists(manifestPath))) {
    return { modules: {}, agentEntrypoints: {} };
  }
  return JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
}

function moduleEnabled(manifest: MetaprojectManifest, moduleName: string): boolean {
  return manifest.modules?.[moduleName]?.enabled === true;
}

async function writeTextIfChanged(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) {
    const existing = await readFile(filePath, "utf8");
    if (existing === content) {
      return;
    }
  }
  await writeFile(filePath, content, "utf8");
}

async function writeJsonIfChanged(filePath: string, value: unknown): Promise<void> {
  await writeTextIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function persistManifestEntrypoints(
  manifestPath: string,
  manifest: MetaprojectManifest,
  ruleSources: string[],
): Promise<void> {
  manifest.agentEntrypoints = {
    ...manifest.agentEntrypoints,
    root: ruleSources,
    metaproject: ".metaproject/index.md",
  };
  await writeJsonIfChanged(manifestPath, manifest);
}

async function refreshRulesIndex(
  metaprojectRoot: string,
  manifest: MetaprojectManifest,
  ruleSources: string[],
  hasDistilled: boolean,
): Promise<void> {
  await writeTextIfChanged(
    path.join(metaprojectRoot, "index.md"),
    renderIndexMarkdown({
      enableGdgraph: moduleEnabled(manifest, "gdgraph"),
      enableGdctx: moduleEnabled(manifest, "gdctx"),
      enableGdwiki: moduleEnabled(manifest, "gdwiki"),
      enableGdskills: moduleEnabled(manifest, "gdskills"),
      enableHealth: moduleEnabled(manifest, "health"),
      enableTesting: moduleEnabled(manifest, "testing"),
      enableMemory: moduleEnabled(manifest, "memory"),
      enableTasks: moduleEnabled(manifest, "tasks"),
      ruleSources,
      hasDistilledEntrypoints: hasDistilled,
    }),
  );
}

function printHelp(): void {
  console.log(`Usage:
  gd-metapro rules sync
  gd-metapro rules distill

Commands:
  sync     Import root AGENTS.md/CLAUDE.md into .metaproject/rules and refresh index
  distill  Split large AGENTS.md/CLAUDE.md into high-priority rules and project skills`);
}
