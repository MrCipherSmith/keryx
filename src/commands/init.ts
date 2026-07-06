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
import { choice, confirm } from "../lib/prompt";
import {
  GDSKILLS_PROFILES,
  type GdskillsProfile,
  normalizeGdskillsProfile,
} from "../gdskills/catalog";
import { installGdskills } from "../gdskills/install";
import {
  renderGdwikiManifest,
  renderGdwikiSkillReadme,
  renderWikiIndexScaffold,
  renderWikiPageTemplate,
} from "../wiki/templates";
import { WIKI_PAGE_TYPES } from "../wiki/types";
import { renderHealthConfig } from "../health/config";
import {
  renderHealthCoreReadme,
  renderHealthManifest,
  renderHealthSkillReadme,
} from "../health/templates";
import {
  renderAgentEntrypoint,
  renderGdctxCoreReadme,
  renderGdctxConfig,
  renderGdctxManifest,
  renderGdctxSkillReadme,
  renderGdgraphCoreCli,
  renderGdgraphManifest,
  renderGdgraphPostCommitHook,
  renderGdskillsPostCommitHook,
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
  help: boolean;
  yes: boolean;
  noGdgraph: boolean;
  noGdctx: boolean;
  noGdwiki: boolean;
  noGdskills: boolean;
  gdskillsProfile: GdskillsProfile;
  noHealth: boolean;
  noGdgraphHook: boolean;
  noGdskillsHook: boolean;
};

type ModuleConfig =
  | {
      enabled: true;
      core: string;
      data: string;
      manifest: string;
      commands: string[];
      profile?: GdskillsProfile;
      skills?: string;
      catalog?: string;
      projectSkills?: string;
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
  if (options.help) {
    printInitHelp();
    return;
  }

  const projectRoot = process.cwd();
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  const alreadyExists = await pathExists(metaprojectRoot);

  let enableGdgraph = true;
  let enableGdctx = true;
  let enableGdwiki = true;
  let enableGdskills = true;
  let gdskillsProfile = options.gdskillsProfile;
  let enableHealth = true;
  let enableGdgraphHook = false;
  let enableGdskillsHook = false;
  if (options.noGdgraph) {
    enableGdgraph = false;
  } else if (!options.yes) {
    enableGdgraph = await confirm("Enable gdgraph module? Recommended", true);
  }

  if (options.noGdctx) {
    enableGdctx = false;
  } else if (!options.yes) {
    enableGdctx = await confirm(
      "Enable gdctx module for compact command/search/read output? Recommended",
      true,
    );
  }

  if (options.noGdwiki) {
    enableGdwiki = false;
  } else if (!options.yes) {
    enableGdwiki = await confirm(
      "Enable gdwiki module for a local project knowledge base? Recommended",
      true,
    );
  }

  if (options.noGdskills) {
    enableGdskills = false;
  } else if (!options.yes) {
    enableGdskills = await confirm(
      "Enable gdskills module with project-local bundled working skills? Recommended",
      true,
    );
    if (enableGdskills) {
      gdskillsProfile = await choice(
        "Select gdskills install profile",
        GDSKILLS_PROFILES,
        gdskillsProfile === "custom" ? "recommended" : gdskillsProfile,
      );
    }
  }

  if (options.noHealth) {
    enableHealth = false;
  } else if (!options.yes) {
    enableHealth = await confirm(
      "Enable Code Health reports (lint, type, test, coverage, audit)? Recommended",
      true,
    );
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

  if (enableGdskills) {
    if (options.noGdskillsHook) {
      enableGdskillsHook = false;
    } else if (options.yes) {
      enableGdskillsHook = true;
    } else {
      enableGdskillsHook = await confirm(
        "Install git post-commit hook to verify project-skills after relevant changes? Recommended",
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

  if (enableGdctx) {
    await createGdctxStructure(metaprojectRoot);
  }

  if (enableGdwiki) {
    await createGdwikiStructure(metaprojectRoot);
  }

  if (enableGdskills) {
    await installGdskills(metaprojectRoot, gdskillsProfile);
    if (enableGdskillsHook) {
      await installGdskillsPostCommitHook(projectRoot);
    }
  }

  if (enableHealth) {
    await createHealthStructure(metaprojectRoot);
  }

  const manifest = buildManifest({
    projectName: path.basename(projectRoot),
    enableGdgraph,
    enableGdctx,
    enableGdwiki,
    enableGdskills,
    gdskillsProfile,
    enableHealth,
    enableGdgraphHook,
    enableGdskillsHook,
    agentRuleSources,
  });

  await writeJsonIfChanged(
    path.join(metaprojectRoot, "metaproject.json"),
    manifest,
  );

  await writeTextIfMissing(
    path.join(metaprojectRoot, "README.md"),
    renderMetaprojectReadme({ enableGdgraph, enableGdctx, enableGdwiki, enableGdskills, enableHealth }),
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
    renderIndexMarkdown({
      enableGdgraph,
      enableGdctx,
      enableGdwiki,
      enableGdskills,
      enableHealth,
      ruleSources: agentRuleSources,
    }),
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

  if (enableGdctx) {
    await writeTextIfMissing(
      path.join(metaprojectRoot, "gdctx.config.json"),
      renderGdctxConfig(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "modules", "gdctx.md"),
      renderGdctxManifest(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "core", "gdctx", "README.md"),
      renderGdctxCoreReadme(),
    );
    await writeTextIfChanged(
      path.join(metaprojectRoot, "skills", "gdctx", "SKILL.md"),
      renderGdctxSkillReadme(),
    );
  }

  if (enableGdwiki) {
    await writeTextIfMissing(
      path.join(metaprojectRoot, "wiki", "index.md"),
      renderWikiIndexScaffold(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "wiki", "templates", "page.md"),
      renderWikiPageTemplate(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "modules", "gdwiki.md"),
      renderGdwikiManifest(),
    );
    await writeTextIfChanged(
      path.join(metaprojectRoot, "skills", "gdwiki", "SKILL.md"),
      renderGdwikiSkillReadme(),
    );
  }

  if (enableHealth) {
    await writeTextIfMissing(
      path.join(metaprojectRoot, "health.config.json"),
      renderHealthConfig(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "modules", "health.md"),
      renderHealthManifest(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "core", "health", "README.md"),
      renderHealthCoreReadme(),
    );
    await writeTextIfChanged(
      path.join(metaprojectRoot, "skills", "health", "SKILL.md"),
      renderHealthSkillReadme(),
    );
  }

  console.log(
    alreadyExists
      ? "Updated .metaproject structure."
      : "Created .metaproject structure.",
  );
  console.log(`gdgraph: ${enableGdgraph ? "enabled" : "disabled"}`);
  console.log(`gdctx: ${enableGdctx ? "enabled" : "disabled"}`);
  console.log(`gdwiki: ${enableGdwiki ? "enabled" : "disabled"}`);
  console.log(`gdskills: ${enableGdskills ? `enabled (${gdskillsProfile})` : "disabled"}`);
  console.log(`health: ${enableHealth ? "enabled" : "disabled"}`);
  if (enableGdgraph) {
    console.log(`gdgraph post-commit hook: ${enableGdgraphHook ? "enabled" : "disabled"}`);
  }
  if (enableGdskills) {
    console.log(`gdskills post-commit hook: ${enableGdskillsHook ? "enabled" : "disabled"}`);
  }
}

function parseInitArgs(args: string[]): InitOptions {
  return {
    help: args.includes("--help") || args.includes("-h"),
    yes: args.includes("--yes") || args.includes("-y"),
    noGdgraph: args.includes("--no-gdgraph"),
    noGdctx: args.includes("--no-gdctx"),
    noGdwiki: args.includes("--no-gdwiki"),
    noGdskills: args.includes("--no-gdskills"),
    gdskillsProfile: normalizeGdskillsProfile(getArgValue(args, "--gdskills-profile")),
    noHealth: args.includes("--no-health"),
    noGdgraphHook: args.includes("--no-gdgraph-hook"),
    noGdskillsHook: args.includes("--no-gdskills-hook"),
  };
}

function printInitHelp(): void {
  console.log(`gd-metapro init

Usage:
  gd-metapro init [--yes] [--no-gdgraph] [--no-gdctx] [--no-gdwiki] [--no-gdskills] [--gdskills-profile recommended] [--no-health] [--no-gdgraph-hook] [--no-gdskills-hook]

Options:
  --yes, -y             Use recommended defaults.
  --no-gdgraph          Do not enable gdgraph.
  --no-gdctx            Do not enable gdctx.
  --no-gdwiki           Do not enable gdwiki.
  --no-gdskills         Do not install bundled gdskills.
  --gdskills-profile    Install profile: minimal, recommended, full, custom.
  --no-health           Do not enable Code Health.
  --no-gdgraph-hook     Do not install the gdgraph post-commit hook.
  --no-gdskills-hook    Do not install the gdskills post-commit hook.
`);
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

async function createGdctxStructure(root: string): Promise<void> {
  const dirs = [
    path.join(root, "core", "gdctx"),
    path.join(root, "data", "gdctx", "raw"),
    path.join(root, "data", "gdctx", "artifacts"),
    path.join(root, "data", "gdctx", "queries"),
    path.join(root, "skills", "gdctx"),
  ];

  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
}

async function createGdwikiStructure(root: string): Promise<void> {
  const dirs = [
    path.join(root, "wiki"),
    path.join(root, "wiki", "templates"),
    ...WIKI_PAGE_TYPES.map((entry) => path.join(root, "wiki", entry.folder)),
    path.join(root, "data", "gdwiki", "artifacts"),
    path.join(root, "data", "gdwiki", "link-check"),
    path.join(root, "skills", "gdwiki"),
  ];

  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
}

async function createHealthStructure(root: string): Promise<void> {
  const dirs = [
    path.join(root, "core", "health", "sources"),
    path.join(root, "core", "health", "metrics"),
    path.join(root, "health", "baselines"),
    path.join(root, "data", "health", "artifacts"),
    path.join(root, "data", "health", "history"),
    path.join(root, "data", "health", "raw"),
    path.join(root, "skills", "health"),
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

async function installGdskillsPostCommitHook(projectRoot: string): Promise<void> {
  const gitRoot = path.join(projectRoot, ".git");
  if (!(await pathExists(gitRoot))) {
    return;
  }

  const hooksRoot = path.join(gitRoot, "hooks");
  await mkdir(hooksRoot, { recursive: true });

  const hookPath = path.join(hooksRoot, "post-commit");
  const blockStart = "# gd-metapro:gdskills-post-commit:begin";
  const blockEnd = "# gd-metapro:gdskills-post-commit:end";
  const managedBlock = `${blockStart}\n${renderGdskillsPostCommitHook().trim()}\n${blockEnd}`;
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
  enableGdctx,
  enableGdwiki,
  enableGdskills,
  gdskillsProfile,
  enableHealth,
  enableGdgraphHook,
  enableGdskillsHook,
  agentRuleSources,
}: {
  projectName: string;
  enableGdgraph: boolean;
  enableGdctx: boolean;
  enableGdwiki: boolean;
  enableGdskills: boolean;
  gdskillsProfile: GdskillsProfile;
  enableHealth: boolean;
  enableGdgraphHook: boolean;
  enableGdskillsHook: boolean;
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
      gdctx: enableGdctx
        ? {
            enabled: true,
            core: ".metaproject/core/gdctx",
            data: ".metaproject/data/gdctx",
            manifest: ".metaproject/modules/gdctx.md",
            commands: ["status", "diff", "rg", "read", "run", "show"],
          }
        : {
            enabled: false,
          },
      wiki: enableGdwiki
        ? {
            enabled: true,
            core: ".metaproject/wiki",
            data: ".metaproject/data/gdwiki",
            manifest: ".metaproject/modules/gdwiki.md",
            commands: ["status", "new", "index", "check-links", "validate"],
          }
        : {
            enabled: false,
          },
      gdskills: enableGdskills
        ? {
            enabled: true,
            core: ".metaproject/core/gdskills",
            data: ".metaproject/data/gdskills",
            manifest: ".metaproject/modules/gdskills.md",
            commands: ["status", "catalog", "install", "generate", "verify", "learn", "export", "sync"],
            profile: gdskillsProfile,
            skills: ".metaproject/skills/gdskills",
            catalog: ".metaproject/skills/catalog.md",
            projectSkills: ".metaproject/project-skills",
            hooks: {
              ...(enableGdskillsHook
                ? { gitPostCommit: ".git/hooks/post-commit" }
                : {}),
              postUpdate: ".metaproject/hooks/post-update.d",
            },
          }
        : {
            enabled: false,
          },
      memory: { enabled: false },
      tasks: { enabled: false },
      health: enableHealth
        ? {
            enabled: true,
            core: ".metaproject/core/health",
            data: ".metaproject/data/health",
            manifest: ".metaproject/modules/health.md",
            commands: ["run", "status", "gate", "sources", "explain", "baseline"],
          }
        : {
            enabled: false,
          },
      testing: { enabled: false },
    },
    agentEntrypoints: {
      index: ".metaproject/index.md",
      readme: ".metaproject/README.md",
      root: agentRuleSources,
    },
  };
}

function getArgValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
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
  const wikiPolicy =
    "For architecture, domain models, business rules, user scenarios, auth and other flows, integrations, and known decisions, consult the Metaproject gdwiki skill and read the wiki index before deep code reads; use gdgraph to move from a wiki concept to code.";
  const oldCtxPolicy =
    "When gdctx is enabled, use the Metaproject gdctx skill for commands, search, diff, test logs, and large file reads that can produce long output.";
  const ctxPolicy =
    "For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.";
  const gdskillsPolicy =
    "For implementation, review, refactoring, planning, documentation, or quality tasks, use project-local Metaproject skills first: .metaproject/skills/catalog.md, .metaproject/project-skills/, then .metaproject/skills/gdskills/. External/global skills are fallback only when explicitly needed.";

  if (content.includes(marker)) {
    let next = content;
    if (content.includes(oldGraphPolicy)) {
      next = next.replaceAll(oldGraphPolicy, graphPolicy);
    }
    if (next.includes(oldCtxPolicy)) {
      next = next.replaceAll(oldCtxPolicy, ctxPolicy);
    }
    next = collapseDuplicatePolicy(next, graphPolicy);
    next = collapseDuplicatePolicy(next, wikiPolicy);
    next = collapseDuplicatePolicy(next, ctxPolicy);
    next = collapseDuplicatePolicy(next, gdskillsPolicy);

    const missingPolicies = [
      ...(next.includes(graphPolicy) ? [] : [graphPolicy]),
      ...(next.includes(wikiPolicy) ? [] : [wikiPolicy]),
      ...(next.includes(ctxPolicy) ? [] : [ctxPolicy]),
      ...(next.includes(gdskillsPolicy) ? [] : [gdskillsPolicy]),
    ];
    if (missingPolicies.length > 0) {
      const suffix = next.endsWith("\n") ? "" : "\n";
      next = `${next}${suffix}\n${missingPolicies.join("\n\n")}\n`;
    }

    if (next !== content) {
      await writeFile(filePath, next, "utf8");
    }

    return;
  }

  const suffix = content.endsWith("\n") ? "" : "\n";
  await writeFile(
    filePath,
    `${content}${suffix}\n${marker}\n## Metaproject\n\nRead [.metaproject/index.md](.metaproject/index.md) before planning, implementing, or reviewing this repository.\n\n${graphPolicy}\n\n${wikiPolicy}\n\n${ctxPolicy}\n\n${gdskillsPolicy}\n`,
    "utf8",
  );
}

function ruleFileNameFor(source: string): string {
  return `${source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;
}

function collapseDuplicatePolicy(content: string, policy: string): string {
  const parts = content.split(policy);
  if (parts.length <= 2) {
    return content;
  }

  return `${parts[0]}${policy}${parts.slice(1).join("").replace(/^\s+/, "\n")}`;
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
