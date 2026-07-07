import {
  chmod,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { optionValue } from "../lib/args";
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
import { renderMemoryConfig } from "../memory/config";
import { MEMORY_TYPES } from "../memory/types";
import {
  renderMemoryCoreReadme,
  renderMemoryEntryTemplate,
  renderMemoryIndexScaffold,
  renderMemoryManifest,
  renderMemorySkillReadme,
} from "../memory/templates";
import {
  renderFlowCompleteSkill,
  renderFlowInitSkill,
  renderFlowManageSkill,
  renderFlowSkillRouter,
  renderFlowsReadme,
  renderTasksManifest,
} from "../flow/templates";
import { analyzeTestingProject } from "../testing/service";
import {
  renderTestingConfig,
  renderTestingCoreReadme,
  renderTestingManifest,
  renderTestingPostCommitHook,
  renderTestingPrePushHook,
  renderTestingSkillReadme,
  renderTestingWikiConventions,
  renderTestingWikiReadme,
} from "../testing/templates";
import {
  renderAgentEntrypoint,
  renderGdctxCoreReadme,
  renderGdctxConfig,
  renderGdctxManifest,
  renderGdctxSkillReadme,
  renderGdgraphCoreCli,
  renderGdgraphManifest,
  renderGdgraphPostCommitHook,
  renderHealthPostCommitHook,
  renderGdskillsPostCommitHook,
  renderMetaprojectDashboardPostCommitHook,
  renderGdgraphCoreReadme,
  renderGdgraphSkillReadme,
  renderHooksReadme,
  renderImportedAgentRules,
  renderMetaprojectCoreReadme,
  renderMetaprojectGitignoreBlock,
  renderMetaprojectDashboardHtml,
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
  noTesting: boolean;
  noMemory: boolean;
  noTasks: boolean;
  noGdgraphHook: boolean;
  noGdskillsHook: boolean;
  noHealthHook: boolean;
  noTestingPostCommitHook: boolean;
  noTestingPrePushHook: boolean;
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
      projectSkillRegistry?: Array<{
        module: string;
        name: string;
        target: string;
        path: string;
        version: string;
        status: string;
        updatedAt: string;
      }>;
      hooks?: {
        gitPostCommit?: string;
        prePush?: string;
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
  const existingManifest = await readExistingManifest(metaprojectRoot);

  let enableGdgraph = true;
  let enableGdctx = true;
  let enableGdwiki = true;
  let enableGdskills = true;
  let gdskillsProfile = options.gdskillsProfile;
  let enableHealth = true;
  let enableTesting = true;
  let enableMemory = true;
  let enableTasks = true;
  let enableGdgraphHook = false;
  let enableGdskillsHook = false;
  let enableHealthHook = false;
  let enableTestingPostCommitHook = false;
  let enableTestingPrePushHook = false;
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

  if (options.noTesting) {
    enableTesting = false;
  } else if (!options.yes) {
    enableTesting = await confirm(
      "Enable Testing module to analyze test stack and create testing context? Recommended",
      true,
    );
  }

  if (options.noMemory) {
    enableMemory = false;
  } else if (!options.yes) {
    enableMemory = await confirm(
      "Enable Documentation Memory (lessons, decisions, constraints, known mistakes)? Recommended",
      true,
    );
  }

  if (options.noTasks) {
    enableTasks = false;
  } else if (!options.yes) {
    enableTasks = await confirm(
      "Enable Task Manager (agent-first flow lifecycle with frozen acceptance criteria)? Recommended",
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

  if (enableHealth) {
    if (options.noHealthHook) {
      enableHealthHook = false;
    } else if (options.yes) {
      enableHealthHook = true;
    } else {
      enableHealthHook = await confirm(
        "Install git post-commit hook for lightweight changed-scope Code Health checks? Recommended",
        true,
      );
    }
  }

  if (enableTesting) {
    if (options.noTestingPostCommitHook) {
      enableTestingPostCommitHook = false;
    } else if (options.yes) {
      enableTestingPostCommitHook = true;
    } else {
      enableTestingPostCommitHook = await confirm(
        "Install git post-commit hook to refresh testing context after relevant changes? Recommended",
        true,
      );
    }

    if (options.noTestingPrePushHook) {
      enableTestingPrePushHook = false;
    } else if (options.yes) {
      enableTestingPrePushHook = false;
    } else {
      enableTestingPrePushHook = await confirm(
        "Install git pre-push hook to run changed-scope tests and block failing pushes?",
        false,
      );
    }
  }

  await createBaseStructure(metaprojectRoot);
  await syncGitignore(projectRoot);
  const agentRuleSources = await syncAgentRules(projectRoot, metaprojectRoot, {
    enableTasks,
  });

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
    if (enableHealthHook) {
      await installHealthPostCommitHook(projectRoot);
    }
  }

  if (enableTesting) {
    await createTestingStructure(metaprojectRoot, enableGdwiki);
    if (enableTestingPostCommitHook) {
      await installTestingPostCommitHook(projectRoot);
    }
    if (enableGdgraphHook || enableGdskillsHook || enableHealthHook || enableTestingPostCommitHook) {
      await installMetaprojectDashboardPostCommitHook(projectRoot);
    }
    if (enableTestingPrePushHook) {
      await installTestingPrePushHook(projectRoot);
    }
    await analyzeTestingProject(projectRoot);
  }

  if (enableMemory) {
    await createMemoryStructure(metaprojectRoot);
  }

  if (enableTasks) {
    await createTasksStructure(metaprojectRoot);
  }

  const manifest = buildManifest({
    projectName: path.basename(projectRoot),
    enableGdgraph,
    enableGdctx,
    enableGdwiki,
    enableGdskills,
    gdskillsProfile,
    enableHealth,
    enableTesting,
    enableMemory,
    enableTasks,
    enableGdgraphHook,
    enableGdskillsHook,
    enableHealthHook,
    enableTestingPostCommitHook,
    enableTestingPrePushHook,
    agentRuleSources,
    existingManifest,
  });

  await writeJsonIfChanged(
    path.join(metaprojectRoot, "metaproject.json"),
    manifest,
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
      enableTesting,
      enableMemory,
      enableTasks,
      ruleSources: agentRuleSources,
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

  if (enableTesting) {
    await writeTextIfMissing(
      path.join(metaprojectRoot, "testing.config.json"),
      renderTestingConfig({
        postCommitRefresh: enableTestingPostCommitHook,
        prePushGate: enableTestingPrePushHook,
      }),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "modules", "testing.md"),
      renderTestingManifest(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "core", "testing", "README.md"),
      renderTestingCoreReadme(),
    );
    await writeTextIfChanged(
      path.join(metaprojectRoot, "skills", "testing", "SKILL.md"),
      renderTestingSkillReadme(),
    );
    if (enableGdwiki) {
      await writeTextIfMissing(
        path.join(metaprojectRoot, "wiki", "testing", "README.md"),
        renderTestingWikiReadme(),
      );
      await writeTextIfMissing(
        path.join(metaprojectRoot, "wiki", "testing", "conventions.md"),
        renderTestingWikiConventions(),
      );
    }
  }

  if (enableMemory) {
    await writeTextIfMissing(
      path.join(metaprojectRoot, "memory.config.json"),
      renderMemoryConfig(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "memory", "index.md"),
      renderMemoryIndexScaffold(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "memory", "templates", "entry.md"),
      renderMemoryEntryTemplate(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "modules", "memory.md"),
      renderMemoryManifest(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "core", "memory", "README.md"),
      renderMemoryCoreReadme(),
    );
    await writeTextIfChanged(
      path.join(metaprojectRoot, "skills", "memory", "SKILL.md"),
      renderMemorySkillReadme(),
    );
  }

  if (enableTasks) {
    await writeTextIfMissing(
      path.join(metaprojectRoot, "flows", "README.md"),
      renderFlowsReadme(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "modules", "tasks.md"),
      renderTasksManifest(),
    );
    await writeTextIfChanged(
      path.join(metaprojectRoot, "skills", "flow", "SKILL.md"),
      renderFlowSkillRouter(),
    );
    await writeTextIfChanged(
      path.join(metaprojectRoot, "skills", "flow", "init.md"),
      renderFlowInitSkill(),
    );
    await writeTextIfChanged(
      path.join(metaprojectRoot, "skills", "flow", "manage.md"),
      renderFlowManageSkill(),
    );
    await writeTextIfChanged(
      path.join(metaprojectRoot, "skills", "flow", "complete.md"),
      renderFlowCompleteSkill(),
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
  console.log(`testing: ${enableTesting ? "enabled" : "disabled"}`);
  console.log(`memory: ${enableMemory ? "enabled" : "disabled"}`);
  console.log(`tasks: ${enableTasks ? "enabled" : "disabled"}`);
  if (enableGdgraph) {
    console.log(`gdgraph post-commit hook: ${enableGdgraphHook ? "enabled" : "disabled"}`);
  }
  if (enableGdskills) {
    console.log(`gdskills post-commit hook: ${enableGdskillsHook ? "enabled" : "disabled"}`);
  }
  if (enableHealth) {
    console.log(`health post-commit hook: ${enableHealthHook ? "enabled" : "disabled"}`);
  }
  if (enableTesting) {
    console.log(`testing post-commit hook: ${enableTestingPostCommitHook ? "enabled" : "disabled"}`);
    console.log(`testing pre-push hook: ${enableTestingPrePushHook ? "enabled" : "disabled"}`);
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
    gdskillsProfile: normalizeGdskillsProfile(optionValue(args, "--gdskills-profile")),
    noHealth: args.includes("--no-health"),
    noTesting: args.includes("--no-testing"),
    noMemory: args.includes("--no-memory"),
    noTasks: args.includes("--no-tasks"),
    noGdgraphHook: args.includes("--no-gdgraph-hook"),
    noGdskillsHook: args.includes("--no-gdskills-hook"),
    noHealthHook: args.includes("--no-health-hook"),
    noTestingPostCommitHook: args.includes("--no-testing-post-commit-hook"),
    noTestingPrePushHook: args.includes("--no-testing-pre-push-hook"),
  };
}

function printInitHelp(): void {
  console.log(`gd-metapro init

Usage:
  gd-metapro init [--yes] [--no-gdgraph] [--no-gdctx] [--no-gdwiki] [--no-gdskills] [--gdskills-profile recommended] [--no-health] [--no-testing] [--no-memory] [--no-tasks] [--no-gdgraph-hook] [--no-gdskills-hook] [--no-health-hook] [--no-testing-post-commit-hook] [--no-testing-pre-push-hook]

Options:
  --yes, -y             Use recommended defaults.
  --no-gdgraph          Do not enable gdgraph.
  --no-gdctx            Do not enable gdctx.
  --no-gdwiki           Do not enable gdwiki.
  --no-gdskills         Do not install bundled gdskills.
  --gdskills-profile    Install profile: minimal, recommended, full, custom.
  --no-health           Do not enable Code Health.
  --no-testing          Do not enable Testing Module.
  --no-memory           Do not enable Documentation Memory.
  --no-tasks            Do not enable Task Manager.
  --no-gdgraph-hook     Do not install the gdgraph post-commit hook.
  --no-gdskills-hook    Do not install the gdskills post-commit hook.
  --no-health-hook      Do not install the health post-commit hook.
  --no-testing-post-commit-hook Do not install the testing post-commit refresh hook.
  --no-testing-pre-push-hook    Do not install the testing pre-push gate hook.
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

async function createMemoryStructure(root: string): Promise<void> {
  const dirs = [
    path.join(root, "memory", "templates"),
    ...MEMORY_TYPES.map((entry) => path.join(root, "memory", entry.folder)),
    path.join(root, "core", "memory"),
    path.join(root, "data", "memory", "index"),
    path.join(root, "data", "memory", "artifacts"),
    path.join(root, "data", "memory", "queries"),
    path.join(root, "data", "memory", "raw"),
    path.join(root, "skills", "memory"),
  ];

  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
}

async function createTasksStructure(root: string): Promise<void> {
  const dirs = [
    path.join(root, "flows"),
    path.join(root, "skills", "flow"),
    path.join(root, "data", "tasks", "artifacts"),
  ];

  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
}

async function createTestingStructure(root: string, enableGdwiki: boolean): Promise<void> {
  const dirs = [
    path.join(root, "core", "testing"),
    path.join(root, "data", "testing", "artifacts"),
    path.join(root, "data", "testing", "history"),
    path.join(root, "data", "testing", "logs"),
    path.join(root, "skills", "testing"),
    ...(enableGdwiki ? [path.join(root, "wiki", "testing")] : []),
  ];

  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
}

async function installGdgraphCoreScripts(root: string): Promise<void> {
  const gdgraphCoreRoot = path.join(root, "core", "gdgraph");
  await mkdir(gdgraphCoreRoot, { recursive: true });

  await copyFileIfChanged(
    runtimeSourcePath("../gdgraph/build.ts"),
    path.join(gdgraphCoreRoot, "build.ts"),
  );
  await copyFileIfChanged(
    runtimeSourcePath("../gdgraph/query.ts"),
    path.join(gdgraphCoreRoot, "query.ts"),
  );
  await copyFileIfChanged(
    runtimeSourcePath("../gdgraph/types.ts"),
    path.join(gdgraphCoreRoot, "types.ts"),
  );
  await writeTextIfChanged(
    path.join(gdgraphCoreRoot, "cli.ts"),
    renderGdgraphCoreCli(),
  );
}

async function installGdgraphPostCommitHook(projectRoot: string): Promise<void> {
  await installManagedHook(projectRoot, "post-commit", "gdgraph-post-commit", renderGdgraphPostCommitHook());
}

async function installGdskillsPostCommitHook(projectRoot: string): Promise<void> {
  await installManagedHook(projectRoot, "post-commit", "gdskills-post-commit", renderGdskillsPostCommitHook());
}

async function installHealthPostCommitHook(projectRoot: string): Promise<void> {
  await installManagedHook(projectRoot, "post-commit", "health-post-commit", renderHealthPostCommitHook());
}

async function installTestingPostCommitHook(projectRoot: string): Promise<void> {
  await installManagedHook(projectRoot, "post-commit", "testing-post-commit", renderTestingPostCommitHook());
}

async function installMetaprojectDashboardPostCommitHook(projectRoot: string): Promise<void> {
  await installManagedHook(projectRoot, "post-commit", "metaproject-dashboard-post-commit", renderMetaprojectDashboardPostCommitHook());
}

async function installTestingPrePushHook(projectRoot: string): Promise<void> {
  await installManagedHook(projectRoot, "pre-push", "testing-pre-push", renderTestingPrePushHook());
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

async function readExistingManifest(
  metaprojectRoot: string,
): Promise<MetaprojectManifest | undefined> {
  const manifestPath = path.join(metaprojectRoot, "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
  } catch {
    return undefined;
  }
}

function buildManifest({
  projectName,
  enableGdgraph,
  enableGdctx,
  enableGdwiki,
  enableGdskills,
  gdskillsProfile,
  enableHealth,
  enableTesting,
  enableMemory,
  enableTasks,
  enableGdgraphHook,
  enableGdskillsHook,
  enableHealthHook,
  enableTestingPostCommitHook,
  enableTestingPrePushHook,
  agentRuleSources,
  existingManifest,
}: {
  projectName: string;
  enableGdgraph: boolean;
  enableGdctx: boolean;
  enableGdwiki: boolean;
  enableGdskills: boolean;
  gdskillsProfile: GdskillsProfile;
  enableHealth: boolean;
  enableTesting: boolean;
  enableMemory: boolean;
  enableTasks: boolean;
  enableGdgraphHook: boolean;
  enableGdskillsHook: boolean;
  enableHealthHook: boolean;
  enableTestingPostCommitHook: boolean;
  enableTestingPrePushHook: boolean;
  agentRuleSources: string[];
  existingManifest?: MetaprojectManifest | undefined;
}): MetaprojectManifest {
  const existingProjectSkillRegistry =
    existingManifest?.modules.gdskills?.enabled === true
      ? existingManifest.modules.gdskills.projectSkillRegistry
      : undefined;

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
      gdwiki: enableGdwiki
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
            ...(existingProjectSkillRegistry
              ? { projectSkillRegistry: existingProjectSkillRegistry }
              : {}),
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
      memory: enableMemory
        ? {
            enabled: true,
            core: ".metaproject/core/memory",
            data: ".metaproject/data/memory",
            manifest: ".metaproject/modules/memory.md",
            commands: ["new", "index", "search", "ingest", "check", "reflect"],
          }
        : {
            enabled: false,
          },
      tasks: enableTasks
        ? {
            enabled: true,
            core: ".metaproject/flows",
            data: ".metaproject/data/tasks",
            manifest: ".metaproject/modules/tasks.md",
            commands: ["init", "list", "status", "freeze", "start", "task", "ac", "implemented", "complete", "block", "unblock", "check"],
          }
        : {
            enabled: false,
          },
      health: enableHealth
        ? {
            enabled: true,
            core: ".metaproject/core/health",
            data: ".metaproject/data/health",
            manifest: ".metaproject/modules/health.md",
            commands: ["run", "status", "gate", "sources", "explain", "baseline", "trend"],
            hooks: {
              ...(enableHealthHook
                ? { gitPostCommit: ".git/hooks/post-commit" }
                : {}),
              postUpdate: ".metaproject/hooks/post-update.d",
            },
          }
        : {
            enabled: false,
          },
      testing: enableTesting
        ? {
            enabled: true,
            core: ".metaproject/core/testing",
            data: ".metaproject/data/testing",
            manifest: ".metaproject/modules/testing.md",
            commands: ["init", "analyze", "run", "status", "context", "explain", "related", "report"],
            hooks: {
              ...(enableTestingPostCommitHook
                ? { gitPostCommit: ".git/hooks/post-commit" }
                : {}),
              ...(enableTestingPrePushHook
                ? { prePush: ".git/hooks/pre-push" }
                : {}),
              postUpdate: ".metaproject/hooks/post-update.d",
            },
          }
        : {
            enabled: false,
          },
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
  options: { enableTasks: boolean },
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
    await ensureMetaprojectReference(path.join(projectRoot, source), options);
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

export async function ensureMetaprojectReference(
  filePath: string,
  options: { enableTasks?: boolean } = {},
): Promise<void> {
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
  const testingPolicy =
    "For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.";
  const memoryPolicy =
    "For lessons learned, decisions, constraints, repeated mistakes, and historical project context, use the Metaproject memory skill before broad documentation search.";
  const oldFlowPolicy =
    "For starting, tracking, or finishing a managed piece of work (a flow) - e.g. when the user asks to create a flow from a problem description or an issue link, asks for flow status, or asks to finish a story - use the Metaproject flow skill; all flow state changes go through the gd-metapro flow CLI.";
  const flowPolicy =
    "For starting, tracking, or finishing a managed piece of work (a flow), use the Metaproject flow skill for state/status commands. For non-trivial implementation through Task Manager, use the local gdskills flow-orchestrator first: .metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md. All flow state changes go through the gd-metapro flow CLI.";

  if (content.includes(marker)) {
    let next = content;
    if (content.includes(oldGraphPolicy)) {
      next = next.replaceAll(oldGraphPolicy, graphPolicy);
    }
    if (next.includes(oldCtxPolicy)) {
      next = next.replaceAll(oldCtxPolicy, ctxPolicy);
    }
    if (next.includes(oldFlowPolicy)) {
      next = next.replaceAll(oldFlowPolicy, flowPolicy);
    }
    next = collapseDuplicatePolicy(next, graphPolicy);
    next = collapseDuplicatePolicy(next, wikiPolicy);
    next = collapseDuplicatePolicy(next, ctxPolicy);
    next = collapseDuplicatePolicy(next, gdskillsPolicy);
    next = collapseDuplicatePolicy(next, testingPolicy);
    next = collapseDuplicatePolicy(next, memoryPolicy);
    next = collapseDuplicatePolicy(next, flowPolicy);
    if (options.enableTasks === false) {
      next = removePolicy(next, flowPolicy);
    }

    const missingPolicies = [
      ...(next.includes(graphPolicy) ? [] : [graphPolicy]),
      ...(next.includes(wikiPolicy) ? [] : [wikiPolicy]),
      ...(next.includes(ctxPolicy) ? [] : [ctxPolicy]),
      ...(next.includes(gdskillsPolicy) ? [] : [gdskillsPolicy]),
      ...(next.includes(testingPolicy) ? [] : [testingPolicy]),
      ...(next.includes(memoryPolicy) ? [] : [memoryPolicy]),
      ...(options.enableTasks === false || next.includes(flowPolicy) ? [] : [flowPolicy]),
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
  const initialPolicies = [
    graphPolicy,
    wikiPolicy,
    ctxPolicy,
    gdskillsPolicy,
    testingPolicy,
    memoryPolicy,
    ...(options.enableTasks === false ? [] : [flowPolicy]),
  ];
  await writeFile(
    filePath,
    `${content}${suffix}\n${marker}\n## Metaproject\n\nRead [.metaproject/index.md](.metaproject/index.md) before planning, implementing, or reviewing this repository.\n\n${initialPolicies.join("\n\n")}\n`,
    "utf8",
  );
}

function removePolicy(content: string, policy: string): string {
  const escaped = escapeRegExp(policy);
  return content
    .replace(new RegExp(`\\n{0,2}${escaped}\\n?`, "g"), "\n")
    .replace(/\n{3,}/g, "\n\n");
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

async function copyFileIfChanged(from: string, to: string): Promise<void> {
  const next = await readFile(from, "utf8");
  if ((await pathExists(to)) && (await readFile(to, "utf8")) === next) {
    return;
  }
  await writeFile(to, next, "utf8");
}
