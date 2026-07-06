import {
  copyFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "../lib/fs";
import { confirm } from "../lib/prompt";
import {
  renderAgentEntrypoint,
  renderGdgraphCoreCli,
  renderGdgraphManifest,
  renderGdgraphPostCommitHook,
  renderGdgraphCoreReadme,
  renderGdgraphSkillReadme,
  renderHooksReadme,
  renderImportedAgentRules,
  renderMetaprojectCoreReadme,
  renderMetaprojectGitignoreBlock,
  renderIndexMarkdown,
  renderMetaprojectReadme,
  renderProjectRulesReadme,
  renderProjectRulesSkillReadme,
} from "../lib/templates";

type InitOptions = {
  yes: boolean;
  noGdgraph: boolean;
  noGdgraphHook: boolean;
};

type ModuleConfig =
  | {
      enabled: true;
      core: string;
      data: string;
      manifest: string;
      commands: string[];
      hooks?: {
        gitPostCommit?: string;
        postUpdate?: string;
      };
    }
  | {
      enabled: false;
    };

type MetaprojectManifest = {
  schemaVersion: 1;
  name: string;
  createdBy: "gd-metapro";
  paths: {
    root: string;
    core: string;
    data: string;
    rules: string;
    skills: string;
    modules: string;
  };
  modules: Record<string, ModuleConfig>;
  agentEntrypoints: {
    index: string;
    readme: string;
    root: string[];
  };
};

export async function initCommand(args: string[]): Promise<void> {
  const options = parseInitArgs(args);
  const projectRoot = process.cwd();
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  const alreadyExists = await pathExists(metaprojectRoot);

  let enableGdgraph = true;
  let enableGdgraphHook = false;
  if (options.noGdgraph) {
    enableGdgraph = false;
  } else if (!options.yes) {
    enableGdgraph = await confirm("Enable gdgraph module? Recommended", true);
  }

  if (enableGdgraph) {
    if (options.noGdgraphHook) {
      enableGdgraphHook = false;
    } else if (options.yes) {
      enableGdgraphHook = true;
    } else {
      enableGdgraphHook = await confirm(
        "Install git post-commit hook to refresh gdgraph only after relevant file changes? Recommended",
        true,
      );
    }
  }

  await createBaseStructure(metaprojectRoot);
  await syncGitignore(projectRoot);
  const agentRuleSources = await syncAgentRules(projectRoot, metaprojectRoot);

  if (enableGdgraph) {
    await createGdgraphStructure(metaprojectRoot);
    await installGdgraphCoreScripts(metaprojectRoot);
    if (enableGdgraphHook) {
      await installGdgraphPostCommitHook(projectRoot);
    }
  }

  const manifest = buildManifest({
    projectName: path.basename(projectRoot),
    enableGdgraph,
    enableGdgraphHook,
    agentRuleSources,
  });

  await writeJsonIfChanged(
    path.join(metaprojectRoot, "metaproject.json"),
    manifest,
  );

  await writeTextIfMissing(
    path.join(metaprojectRoot, "README.md"),
    renderMetaprojectReadme({ enableGdgraph }),
  );
  await writeTextIfMissing(
    path.join(metaprojectRoot, "core", "README.md"),
    renderMetaprojectCoreReadme(),
  );
  await writeTextIfChanged(
    path.join(metaprojectRoot, "hooks", "README.md"),
    renderHooksReadme(),
  );
  await writeTextIfMissing(
    path.join(metaprojectRoot, "rules", "README.md"),
    renderProjectRulesReadme(),
  );
  await writeTextIfChanged(
    path.join(metaprojectRoot, "skills", "project-rules", "README.md"),
    renderProjectRulesSkillReadme({ sources: agentRuleSources }),
  );

  await writeTextIfChanged(
    path.join(metaprojectRoot, "index.md"),
    renderIndexMarkdown({ enableGdgraph, ruleSources: agentRuleSources }),
  );

  if (enableGdgraph) {
    await writeTextIfMissing(
      path.join(metaprojectRoot, "modules", "gdgraph.md"),
      renderGdgraphManifest(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "core", "gdgraph", "README.md"),
      renderGdgraphCoreReadme(),
    );
    await writeTextIfChanged(
      path.join(metaprojectRoot, "skills", "gdgraph", "SKILL.md"),
      renderGdgraphSkillReadme(),
    );
    await removeLegacyGdgraphSkillReadme(metaprojectRoot);
  }

  console.log(
    alreadyExists
      ? "Updated .metaproject structure."
      : "Created .metaproject structure.",
  );
  console.log(`gdgraph: ${enableGdgraph ? "enabled" : "disabled"}`);
  if (enableGdgraph) {
    console.log(`gdgraph post-commit hook: ${enableGdgraphHook ? "enabled" : "disabled"}`);
  }
}

function parseInitArgs(args: string[]): InitOptions {
  return {
    yes: args.includes("--yes") || args.includes("-y"),
    noGdgraph: args.includes("--no-gdgraph"),
    noGdgraphHook: args.includes("--no-gdgraph-hook"),
  };
}

async function createBaseStructure(root: string): Promise<void> {
  const dirs = [
    root,
    path.join(root, "core"),
    path.join(root, "data"),
    path.join(root, "rules"),
    path.join(root, "skills"),
    path.join(root, "skills", "project-rules"),
    path.join(root, "modules"),
    path.join(root, "reports"),
    path.join(root, "templates"),
    path.join(root, "hooks"),
    path.join(root, "hooks", "post-update.d"),
  ];

  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
}

async function createGdgraphStructure(root: string): Promise<void> {
  const dirs = [
    path.join(root, "core", "gdgraph"),
    path.join(root, "data", "gdgraph", "storage"),
    path.join(root, "data", "gdgraph", "artifacts"),
    path.join(root, "data", "gdgraph", "summaries"),
    path.join(root, "data", "gdgraph", "queries"),
    path.join(root, "skills", "gdgraph"),
  ];

  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
}

async function installGdgraphCoreScripts(root: string): Promise<void> {
  const gdgraphCoreRoot = path.join(root, "core", "gdgraph");
  await mkdir(gdgraphCoreRoot, { recursive: true });

  await copyFileIfMissing(
    runtimeSourcePath("../gdgraph/build.ts"),
    path.join(gdgraphCoreRoot, "build.ts"),
  );
  await copyFileIfMissing(
    runtimeSourcePath("../gdgraph/query.ts"),
    path.join(gdgraphCoreRoot, "query.ts"),
  );
  await copyFileIfMissing(
    runtimeSourcePath("../gdgraph/types.ts"),
    path.join(gdgraphCoreRoot, "types.ts"),
  );
  await writeTextIfMissing(
    path.join(gdgraphCoreRoot, "cli.ts"),
    renderGdgraphCoreCli(),
  );
}

async function installGdgraphPostCommitHook(projectRoot: string): Promise<void> {
  const gitRoot = path.join(projectRoot, ".git");
  if (!(await pathExists(gitRoot))) {
    return;
  }

  const hooksRoot = path.join(gitRoot, "hooks");
  await mkdir(hooksRoot, { recursive: true });

  const hookPath = path.join(hooksRoot, "post-commit");
  const blockStart = "# gd-metapro:gdgraph-post-commit:begin";
  const blockEnd = "# gd-metapro:gdgraph-post-commit:end";
  const managedBlock = `${blockStart}\n${renderGdgraphPostCommitHook().trim()}\n${blockEnd}`;
  const existing = (await pathExists(hookPath))
    ? await readFile(hookPath, "utf8")
    : "#!/usr/bin/env sh\n";
  const blockPattern = new RegExp(
    `${escapeRegExp(blockStart)}[\\s\\S]*?${escapeRegExp(blockEnd)}`,
  );
  const next = blockPattern.test(existing)
    ? existing.replace(blockPattern, managedBlock)
    : `${existing.trimEnd()}\n\n${managedBlock}\n`;

  await writeFile(hookPath, next, "utf8");
  await chmod(hookPath, 0o755);
}

async function removeLegacyGdgraphSkillReadme(root: string): Promise<void> {
  const legacyReadmePath = path.join(root, "skills", "gdgraph", "README.md");
  if (!(await pathExists(legacyReadmePath))) {
    return;
  }

  const legacyContent = `# gdgraph Skill

Use this skill when a task requires code graph context, dependency impact analysis, module explanation, or affected-file discovery.

## Workflow

1. Check \`.metaproject/modules/gdgraph.md\`.
2. Prefer curated artifacts in \`.metaproject/data/gdgraph/artifacts\`.
3. Run \`gd-metapro gdgraph build\` when graph data is stale.
4. Use \`gd-metapro gdgraph affected <target>\` before implementation or review.
`;

  if ((await readFile(legacyReadmePath, "utf8")) === legacyContent) {
    await unlink(legacyReadmePath);
  }
}

function runtimeSourcePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

function buildManifest({
  projectName,
  enableGdgraph,
  enableGdgraphHook,
  agentRuleSources,
}: {
  projectName: string;
  enableGdgraph: boolean;
  enableGdgraphHook: boolean;
  agentRuleSources: string[];
}): MetaprojectManifest {
  return {
    schemaVersion: 1,
    name: `${projectName}-metaproject`,
    createdBy: "gd-metapro",
    paths: {
      root: ".metaproject",
      core: ".metaproject/core",
      data: ".metaproject/data",
      rules: ".metaproject/rules",
      skills: ".metaproject/skills",
      modules: ".metaproject/modules",
    },
    modules: {
      gdgraph: enableGdgraph
        ? {
            enabled: true,
            core: ".metaproject/core/gdgraph",
            data: ".metaproject/data/gdgraph",
            manifest: ".metaproject/modules/gdgraph.md",
            commands: ["build", "query", "affected", "explain", "path"],
            hooks: {
              ...(enableGdgraphHook
                ? { gitPostCommit: ".git/hooks/post-commit" }
                : {}),
              postUpdate: ".metaproject/hooks/post-update.d",
            },
          }
        : {
            enabled: false,
          },
      wiki: { enabled: false },
      memory: { enabled: false },
      tasks: { enabled: false },
      health: { enabled: false },
      testing: { enabled: false },
      "domain-skills": { enabled: false },
    },
    agentEntrypoints: {
      index: ".metaproject/index.md",
      readme: ".metaproject/README.md",
      root: agentRuleSources,
    },
  };
}

async function syncAgentRules(
  projectRoot: string,
  metaprojectRoot: string,
): Promise<string[]> {
  const entrypoints = await findAgentEntrypoints(projectRoot);
  const sources =
    entrypoints.length > 0
      ? entrypoints
      : [await createDefaultAgentEntrypoint(projectRoot)];

  await mkdir(path.join(metaprojectRoot, "rules"), { recursive: true });
  await mkdir(path.join(metaprojectRoot, "skills", "project-rules"), {
    recursive: true,
  });

  for (const source of sources) {
    await ensureMetaprojectReference(path.join(projectRoot, source));
    const sourceContent = await readFile(path.join(projectRoot, source), "utf8");
    await writeTextIfChanged(
      path.join(metaprojectRoot, "rules", ruleFileNameFor(source)),
      renderImportedAgentRules({ source, content: sourceContent }),
    );
  }

  return sources;
}

async function findAgentEntrypoints(projectRoot: string): Promise<string[]> {
  const candidates = ["AGENTS.md", "agents.md", "CLAUDE.md", "claude.md"];
  const files = new Set(await readdir(projectRoot));
  return candidates.filter((candidate) => files.has(candidate));
}

async function createDefaultAgentEntrypoint(projectRoot: string): Promise<string> {
  const source = "AGENTS.md";
  await writeTextIfMissing(
    path.join(projectRoot, source),
    renderAgentEntrypoint({ source }),
  );
  return source;
}

async function ensureMetaprojectReference(filePath: string): Promise<void> {
  const content = await readFile(filePath, "utf8");
  const marker = "<!-- gd-metapro:index -->";
  const oldGraphPolicy =
    "For code-related tasks, use the Metaproject gdgraph skill by default before broad raw file search.";
  const graphPolicy =
    "For project navigation, file discovery, and code-related tasks, use the Metaproject gdgraph skill by default before broad raw file search.";

  if (content.includes(marker)) {
    if (content.includes(oldGraphPolicy)) {
      await writeFile(
        filePath,
        content.replaceAll(oldGraphPolicy, graphPolicy),
        "utf8",
      );
      return;
    }

    if (!content.includes(graphPolicy)) {
      const suffix = content.endsWith("\n") ? "" : "\n";
      await writeFile(filePath, `${content}${suffix}\n${graphPolicy}\n`, "utf8");
    }
    return;
  }

  const suffix = content.endsWith("\n") ? "" : "\n";
  await writeFile(
    filePath,
    `${content}${suffix}\n${marker}\n## Metaproject\n\nRead [.metaproject/index.md](.metaproject/index.md) before planning, implementing, or reviewing this repository.\n\n${graphPolicy}\n`,
    "utf8",
  );
}

function ruleFileNameFor(source: string): string {
  return `${source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
}

async function syncGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const blockStart = "# gd-metapro:begin";
  const blockEnd = "# gd-metapro:end";
  const metaprojectIgnoreBlock = renderMetaprojectGitignoreBlock().trim();
  const managedBlock = `${blockStart}\n${metaprojectIgnoreBlock}\n${blockEnd}`;
  const existing = (await pathExists(gitignorePath))
    ? await readFile(gitignorePath, "utf8")
    : "";

  const blockPattern = new RegExp(
    `${escapeRegExp(blockStart)}[\\s\\S]*?${escapeRegExp(blockEnd)}`,
  );
  const metaprojectIgnoreLines = new Set(metaprojectIgnoreBlock.split("\n"));
  const withoutExistingManagedBlock = existing.replace(blockPattern, "");
  const withoutLegacyMetaprojectIgnore = withoutExistingManagedBlock
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed !== ".metaproject/" &&
        !metaprojectIgnoreLines.has(trimmed)
      );
    })
    .join("\n");

  const next = `${withoutLegacyMetaprojectIgnore.trimEnd()}\n\n${managedBlock}\n`;

  if (existing === next) {
    return;
  }

  await writeFile(gitignorePath, next, "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeJsonIfChanged(
  filePath: string,
  value: unknown,
): Promise<void> {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if ((await pathExists(filePath)) && (await readFile(filePath, "utf8")) === next) {
    return;
  }
  await writeFile(filePath, next, "utf8");
}

async function writeTextIfChanged(
  filePath: string,
  content: string,
): Promise<void> {
  if ((await pathExists(filePath)) && (await readFile(filePath, "utf8")) === content) {
    return;
  }
  await writeFile(filePath, content, "utf8");
}

async function writeTextIfMissing(
  filePath: string,
  content: string,
): Promise<void> {
  if (await pathExists(filePath)) {
    return;
  }
  await writeFile(filePath, content, "utf8");
}

async function copyFileIfMissing(from: string, to: string): Promise<void> {
  if (await pathExists(to)) {
    return;
  }
  await copyFile(from, to);
}
