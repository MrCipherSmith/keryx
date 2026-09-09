import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import {
  planRoutingEntrypointPair,
  rulesReadmeStep,
  writeRoutingEntrypointPair,
} from "../lib/routing-entrypoint";
import {
  formatInstallPlan,
  isPreviewRequested,
  parseDivergenceResolution,
  type DivergenceResolution,
} from "../lib/install-plan";
import { syncAgentRules } from "../rules/agent-entrypoints";
import {
  distillAgentEntrypoints,
  hasDistilledEntrypoints,
  listRootEntrypoints,
} from "../rules/distill";

type RulesOptions = {
  help: boolean;
  preview: boolean;
  resolution: DivergenceResolution | undefined;
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
    throw new Error("Metaproject is not initialized. Run `keryx init` first.");
  }

  const manifestPath = path.join(metaprojectRoot, "metaproject.json");
  const manifest = await readManifest(manifestPath);
  const enableTasks = moduleEnabled(manifest, "tasks");

  // Preview before either intent writes anything: `listRootEntrypoints` is the
  // read-only twin of the discovery `syncAgentRules`/`distillAgentEntrypoints`
  // do, so no default AGENTS.md is created and no rule file is imported.
  if (options.preview) {
    const plan = await planRoutingEntrypointPair(
      metaprojectRoot,
      {
        enableGdgraph: moduleEnabled(manifest, "gdgraph"),
        enableGdctx: moduleEnabled(manifest, "gdctx"),
        enableGdwiki: moduleEnabled(manifest, "gdwiki"),
        enableGdskills: moduleEnabled(manifest, "gdskills"),
        enableHealth: moduleEnabled(manifest, "health"),
        enableTesting: moduleEnabled(manifest, "testing"),
        enableMemory: moduleEnabled(manifest, "memory"),
        enableTasks,
        enableSecurity: moduleEnabled(manifest, "security"),
        ruleSources: await listRootEntrypoints(projectRoot, manifest.agentEntrypoints?.root ?? []),
        hasDistilledEntrypoints:
          subcommand === "distill" ? true : await hasDistilledEntrypoints(metaprojectRoot),
      },
      { intent: `rules ${subcommand}`, steps: [rulesReadmeStep(metaprojectRoot, "managed")] },
    );
    console.log(
      formatInstallPlan(plan, {
        ...(options.resolution === undefined ? {} : { resolution: options.resolution }),
        relativeTo: projectRoot,
        notes: [
          "Not digest-planned by this release: metaproject.json, the imported " +
            ".metaproject/rules/*.md files, and (for distill) the entrypoint index and project skills.",
        ],
      }),
    );
    return;
  }

  if (subcommand === "distill") {
    const result = await distillAgentEntrypoints(projectRoot, metaprojectRoot, {
      enableTasks,
      manifestSources: manifest.agentEntrypoints?.root ?? [],
    });
    await refreshRoutingEntrypoints(metaprojectRoot, manifest, result.sources, true, {
      intent: "rules distill",
      resolution: options.resolution,
    });
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

  await persistManifestEntrypoints(manifestPath, manifest, ruleSources);
  await refreshRoutingEntrypoints(
    metaprojectRoot,
    manifest,
    ruleSources,
    await hasDistilledEntrypoints(metaprojectRoot),
    { intent: "rules sync", resolution: options.resolution },
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
    preview: isPreviewRequested(args),
    resolution: parseDivergenceResolution(args),
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

async function refreshRoutingEntrypoints(
  metaprojectRoot: string,
  manifest: MetaprojectManifest,
  ruleSources: string[],
  hasDistilled: boolean,
  context: { intent: string; resolution: DivergenceResolution | undefined },
): Promise<void> {
  await writeRoutingEntrypointPair(
    metaprojectRoot,
    {
      enableGdgraph: moduleEnabled(manifest, "gdgraph"),
      enableGdctx: moduleEnabled(manifest, "gdctx"),
      enableGdwiki: moduleEnabled(manifest, "gdwiki"),
      enableGdskills: moduleEnabled(manifest, "gdskills"),
      enableHealth: moduleEnabled(manifest, "health"),
      enableTesting: moduleEnabled(manifest, "testing"),
      enableMemory: moduleEnabled(manifest, "memory"),
      enableTasks: moduleEnabled(manifest, "tasks"),
      enableSecurity: moduleEnabled(manifest, "security"),
      ruleSources,
      hasDistilledEntrypoints: hasDistilled,
    },
    {
      intent: context.intent,
      steps: [rulesReadmeStep(metaprojectRoot, "managed")],
      ...(context.resolution === undefined ? {} : { resolution: context.resolution }),
      onNotice: (line) => {
        if (line.trim().length > 0) {
          console.log(line);
        }
      },
    },
  );
}

function printHelp(): void {
  console.log(`Usage:
  keryx rules sync
  keryx rules distill

Commands:
  sync     Import root AGENTS.md/CLAUDE.md into .metaproject/rules and refresh index
  distill  Split large AGENTS.md/CLAUDE.md into high-priority rules and project skills

Options:
  --preview, --dry-run  Print the lifecycle plan (create/update/skip/conflict + base digests) and write nothing
  --accept-version      Publish this version's content over lifecycle files a different version left divergent
  --keep-existing       Leave divergent lifecycle files alone and record that this run did not publish them`);
}
