import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import {
  renderIndexMarkdown,
  renderProjectRulesReadme,
} from "../lib/templates";
import { syncAgentRules } from "../rules/agent-entrypoints";

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
  };
};

export async function rulesCommand(args: string[] = []): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  if (subcommand !== "sync") {
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

  const projectRoot = process.cwd();
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  if (!(await pathExists(metaprojectRoot))) {
    throw new Error("Metaproject is not initialized. Run `gd-metapro init` first.");
  }

  const manifestPath = path.join(metaprojectRoot, "metaproject.json");
  const manifest = await readManifest(manifestPath);
  const enableTasks = moduleEnabled(manifest, "tasks");
  const syncedRules = await syncAgentRules(projectRoot, metaprojectRoot, {
    enableTasks,
    manifestSources: manifest.agentEntrypoints?.root ?? [],
    createDefault: true,
  });
  const ruleSources = syncedRules.map((rule) => rule.source);

  await mkdir(path.join(metaprojectRoot, "rules"), { recursive: true });
  await writeTextIfChanged(path.join(metaprojectRoot, "rules", "README.md"), renderProjectRulesReadme());

  manifest.agentEntrypoints = {
    ...manifest.agentEntrypoints,
    root: ruleSources,
  };
  await writeJsonIfChanged(manifestPath, manifest);
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
      enableTasks,
      ruleSources,
    }),
  );

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

function printHelp(): void {
  console.log(`Usage:
  gd-metapro rules sync

Commands:
  sync  Import root AGENTS.md/CLAUDE.md into .metaproject/rules and refresh index`);
}
