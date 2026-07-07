import {
  chmod,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { optionValue } from "../lib/args";
import { moduleCommands } from "./module-commands";
import { pathExists } from "../lib/fs";
import { choice, confirm } from "../lib/prompt";
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
import { renderSecurityConfig } from "../security/config";
import {
  renderSecurityCoreReadme,
  renderSecurityManifest,
  securityCapabilities,
} from "../security/templates";
import {
  installSecurityAgentHooks,
  uninstallSecurityAgentHooks,
  agentSettingsPath,
  AGENT_HOOKS_SENTINEL,
  AGENT_SETTINGS_RELATIVE_PATH,
} from "../security/agent-hooks";
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
  renderGdctxCoreReadme,
  renderGdctxConfig,
  renderGdctxManifest,
  renderGdctxSkillReadme,
  renderGdgraphCoreCli,
  renderGdgraphManifest,
  renderGdgraphPostCommitHook,
  renderGdwikiPostCommitHook,
  renderHealthPostCommitHook,
  renderGdskillsPostCommitHook,
  renderMetaprojectDashboardPostCommitHook,
  renderSecurityPrePushHook,
  renderGdgraphCoreReadme,
  renderGdgraphSkillReadme,
  renderHooksReadme,
  renderMetaprojectCoreReadme,
  renderMetaprojectGitignoreBlock,
  renderMetaprojectDashboardHtml,
  renderIndexMarkdown,
  renderMetaprojectReadme,
  renderProjectRulesReadme,
  renderProjectRulesSkillReadme,
} from "../lib/templates";
import { syncAgentRules } from "../rules/agent-entrypoints";
import { hasDistilledEntrypoints } from "../rules/distill";
import { STANDARD_VERSION, computeProfiles } from "../standard/profiles";

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
  noSecurity: boolean;
  noGdgraphHook: boolean;
  noGdskillsHook: boolean;
  noHealthHook: boolean;
  noTestingPostCommitHook: boolean;
  noTestingPrePushHook: boolean;
  noSecurityHook: boolean;
  noSecurityAgentHook: boolean;
};

type ModuleConfig =
  | {
      enabled: true;
      core: string;
      data: string;
      manifest: string;
      commands: string[];
      version?: string;
      config?: string;
      capabilities?: string[];
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
        agent?: string;
        postUpdate?: string;
      };
    }
  | {
      enabled: false;
    };

type MetaprojectManifest = {
  schemaVersion: 1;
  standardVersion: string;
  name: string;
  createdBy: "gd-metapro";
  profiles: string[];
  paths: {
    root: string;
    core: string;
    data: string;
    rules: string;
    skills: string;
    modules: string;
  };
  modules: Record<string, ModuleConfig>;
  updatedAt: string;
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

  banner(
    "gd-metapro init",
    alreadyExists
      ? `Updating the .metaproject workspace in ${path.basename(projectRoot)}/`
      : `Setting up a .metaproject workspace in ${path.basename(projectRoot)}/`,
  );
  if (!options.yes) {
    note("Press Enter to accept the Recommended default for each question.");
    heading("Modules");
  }

  let enableGdgraph = true;
  let enableGdctx = true;
  let enableGdwiki = true;
  let enableGdskills = true;
  let gdskillsProfile = options.gdskillsProfile;
  let enableHealth = true;
  let enableTesting = true;
  let enableMemory = true;
  let enableTasks = true;
  let enableSecurity = true;
  let enableGdgraphHook = false;
  let enableGdskillsHook = false;
  let enableHealthHook = false;
  let enableTestingPostCommitHook = false;
  let enableTestingPrePushHook = false;
  let enableSecurityPrePushHook = false;
  let enableSecurityAgentHook = false;
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

  if (options.noSecurity) {
    enableSecurity = false;
  } else if (!options.yes) {
    enableSecurity = await confirm(
      "Enable Metaproject Security (policy-based scanning, redaction, guardrails, audit reports)? Recommended",
      true,
    );
  }

  if (
    !options.yes &&
    (enableGdgraph || enableGdskills || enableHealth || enableTesting || enableSecurity)
  ) {
    heading("Git hooks");
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

  if (enableSecurity) {
    if (options.noSecurityHook) {
      enableSecurityPrePushHook = false;
    } else if (options.yes) {
      enableSecurityPrePushHook = true;
    } else {
      enableSecurityPrePushHook = await confirm(
        "Install git pre-push hook to run the security guard and block pushes on secret/critical findings (enforced/ci mode only)? Recommended",
        true,
      );
    }

    if (options.noSecurityAgentHook) {
      enableSecurityAgentHook = false;
    } else if (options.yes) {
      enableSecurityAgentHook = true;
    } else {
      enableSecurityAgentHook = await confirm(
        "Install project-local .claude/settings.json security hooks (guard agent input/output)? Recommended",
        true,
      );
    }
  }

  await createBaseStructure(metaprojectRoot);
  await syncGitignore(projectRoot);
  const syncedAgentRules = await syncAgentRules(projectRoot, metaprojectRoot, {
    enableTasks,
    createDefault: true,
  });
  const agentRuleSources = syncedAgentRules.map((rule) => rule.source);

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
    if (enableGdgraphHook) {
      await installGdwikiPostCommitHook(projectRoot);
    }
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

  if (enableSecurity) {
    await createSecurityStructure(metaprojectRoot);
    if (enableSecurityPrePushHook) {
      await installSecurityPrePushHook(projectRoot);
    }
    if (enableSecurityAgentHook) {
      await installSecurityAgentHooks(projectRoot);
    }
  }

  // Reconcile disabled security hooks with on-disk reality. When a hook is now
  // off (module disabled via --no-security, or --no-security-agent-hook /
  // --no-security-hook) but was previously installed, remove the managed
  // artifact so the manifest and the filesystem stay in sync. Only
  // security-owned content is touched; other modules and user entries are kept.
  const existingSecurityModule = existingManifest?.modules?.security;
  const existingSecurityHooks =
    existingSecurityModule?.enabled === true ? existingSecurityModule.hooks : undefined;
  const securityAgentHookPreviouslyInstalled =
    Boolean(existingSecurityHooks?.agent) ||
    (await agentSettingsHasSecuritySentinel(projectRoot));
  if (!enableSecurityAgentHook && securityAgentHookPreviouslyInstalled) {
    await uninstallSecurityAgentHooks(projectRoot);
  }
  const securityPrePushPreviouslyInstalled =
    Boolean(existingSecurityHooks?.prePush) ||
    (await prePushHasSecurityBlock(projectRoot));
  if (!enableSecurityPrePushHook && securityPrePushPreviouslyInstalled) {
    await removeManagedHook(projectRoot, "pre-push", "security-pre-push");
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
    enableSecurity,
    enableGdgraphHook,
    enableGdskillsHook,
    enableHealthHook,
    enableTestingPostCommitHook,
    enableTestingPrePushHook,
    enableSecurityPrePushHook,
    enableSecurityAgentHook,
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
      enableSecurity,
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
      enableSecurity,
      ruleSources: agentRuleSources,
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
      enableSecurity,
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

  if (enableSecurity) {
    await writeTextIfMissing(
      path.join(metaprojectRoot, "security.config.json"),
      renderSecurityConfig(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "modules", "security.md"),
      renderSecurityManifest(),
    );
    await writeTextIfMissing(
      path.join(metaprojectRoot, "core", "security", "README.md"),
      renderSecurityCoreReadme(),
    );
  }

  const enabledModuleCount = [
    enableGdgraph,
    enableGdctx,
    enableGdwiki,
    enableGdskills,
    enableHealth,
    enableTesting,
    enableMemory,
    enableTasks,
    enableSecurity,
  ].filter(Boolean).length;

  heading(
    alreadyExists
      ? `${style.green(symbols.ok)} Updated .metaproject`
      : `${style.green(symbols.ok)} Created .metaproject`,
  );
  note(`${enabledModuleCount} of 9 modules enabled`);
  statusLine("gdgraph", enableGdgraph, "code graph, symbols, affected context");
  statusLine("gdctx", enableGdctx, "token-aware command/read output");
  statusLine("gdwiki", enableGdwiki, "project knowledge base");
  statusLine("gdskills", enableGdskills, enableGdskills ? `profile: ${gdskillsProfile}` : "bundled working skills");
  statusLine("health", enableHealth, "quality scoring & gate");
  statusLine("testing", enableTesting, "test context & intelligence");
  statusLine("memory", enableMemory, "lessons, decisions, constraints");
  statusLine("tasks", enableTasks, "agent-first flow lifecycle");
  statusLine("security", enableSecurity, "scanning, redaction, guardrails, audit");

  const hookLines: Array<[string, boolean]> = [];
  if (enableGdgraph) {
    hookLines.push(["gdgraph post-commit", enableGdgraphHook]);
  }
  if (enableGdskills) {
    hookLines.push(["gdskills post-commit", enableGdskillsHook]);
  }
  if (enableHealth) {
    hookLines.push(["health post-commit", enableHealthHook]);
  }
  if (enableTesting) {
    hookLines.push(["testing post-commit", enableTestingPostCommitHook]);
    hookLines.push(["testing pre-push", enableTestingPrePushHook]);
  }
  if (enableSecurity) {
    hookLines.push(["security pre-push", enableSecurityPrePushHook]);
    hookLines.push(["security agent (.claude)", enableSecurityAgentHook]);
  }
  if (hookLines.length > 0) {
    heading("Git hooks");
    for (const [label, on] of hookLines) {
      statusLine(label, on);
    }
  }

  const steps = [
    `Read ${style.cyan(".metaproject/index.md")} - the agent entrypoint and module map.`,
  ];
  if (enableGdgraph) {
    steps.push(`Generate the code graph: ${style.cyan("gd-metapro gdgraph build")}.`);
  }
  if (enableTasks) {
    steps.push(`Start a managed flow: ${style.cyan('gd-metapro flow init --title "..."')}.`);
  }
  steps.push(`Open ${style.cyan(".metaproject/gd-metapro-dashboard.html")} for the human dashboard.`);
  steps.push(`After pulling changes, run ${style.cyan("gd-metapro update")} to refresh service files.`);
  nextSteps(steps);
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
    noSecurity: args.includes("--no-security"),
    noGdgraphHook: args.includes("--no-gdgraph-hook"),
    noGdskillsHook: args.includes("--no-gdskills-hook"),
    noHealthHook: args.includes("--no-health-hook"),
    noTestingPostCommitHook: args.includes("--no-testing-post-commit-hook"),
    noTestingPrePushHook: args.includes("--no-testing-pre-push-hook"),
    noSecurityHook: args.includes("--no-security-hook"),
    noSecurityAgentHook: args.includes("--no-security-agent-hook"),
  };
}

function printInitHelp(): void {
  helpTitle("gd-metapro init", "set up a .metaproject workspace");
  helpUsage(["gd-metapro init [options]"]);
  helpOptions([
    { flag: "--yes, -y", desc: "Use recommended defaults (non-interactive)." },
    { flag: "--no-gdgraph", desc: "Do not enable gdgraph." },
    { flag: "--no-gdctx", desc: "Do not enable gdctx." },
    { flag: "--no-gdwiki", desc: "Do not enable gdwiki." },
    { flag: "--no-gdskills", desc: "Do not install bundled gdskills." },
    { flag: "--gdskills-profile", desc: "Install profile: minimal, recommended, full, custom." },
    { flag: "--no-health", desc: "Do not enable Code Health." },
    { flag: "--no-testing", desc: "Do not enable Testing Module." },
    { flag: "--no-memory", desc: "Do not enable Documentation Memory." },
    { flag: "--no-tasks", desc: "Do not enable Task Manager." },
    { flag: "--no-security", desc: "Do not enable Metaproject Security." },
    { flag: "--no-gdgraph-hook", desc: "Do not install the gdgraph post-commit hook." },
    { flag: "--no-gdskills-hook", desc: "Do not install the gdskills post-commit hook." },
    { flag: "--no-health-hook", desc: "Do not install the health post-commit hook." },
    { flag: "--no-testing-post-commit-hook", desc: "Do not install the testing post-commit refresh hook." },
    { flag: "--no-testing-pre-push-hook", desc: "Do not install the testing pre-push gate hook." },
    { flag: "--no-security-hook", desc: "Do not install the security pre-push gate hook." },
    { flag: "--no-security-agent-hook", desc: "Do not install the .claude/settings.json security agent hooks." },
  ]);
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

async function createSecurityStructure(root: string): Promise<void> {
  const dirs = [
    path.join(root, "core", "security"),
    path.join(root, "data", "security", "artifacts"),
    path.join(root, "data", "security", "incidents"),
    path.join(root, "data", "security", "redactions"),
    path.join(root, "data", "security", "policies"),
    path.join(root, "data", "security", "raw"),
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

async function installGdwikiPostCommitHook(projectRoot: string): Promise<void> {
  await installManagedHook(projectRoot, "post-commit", "gdwiki-post-commit", renderGdwikiPostCommitHook());
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

async function installSecurityPrePushHook(projectRoot: string): Promise<void> {
  await installManagedHook(projectRoot, "pre-push", "security-pre-push", renderSecurityPrePushHook());
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

// Strip a single gd-metapro managed block from a git hook, leaving all other
// managed blocks and user-authored content intact. No-op when the hook or block
// is absent.
async function removeManagedHook(
  projectRoot: string,
  hookName: "post-commit" | "pre-push",
  blockId: string,
): Promise<void> {
  const hookPath = path.join(projectRoot, ".git", "hooks", hookName);
  if (!(await pathExists(hookPath))) {
    return;
  }
  const existing = await readFile(hookPath, "utf8");
  const blockStart = `# gd-metapro:${blockId}:begin`;
  const blockEnd = `# gd-metapro:${blockId}:end`;
  const blockPattern = new RegExp(
    `\\n*${escapeRegExp(blockStart)}[\\s\\S]*?${escapeRegExp(blockEnd)}\\n*`,
  );
  if (!blockPattern.test(existing)) {
    return;
  }
  const next = `${existing.replace(blockPattern, "\n").trimEnd()}\n`;
  await writeFile(hookPath, next, "utf8");
  await chmod(hookPath, 0o755);
}

// True when the git pre-push hook still carries the managed security block.
async function prePushHasSecurityBlock(projectRoot: string): Promise<boolean> {
  const hookPath = path.join(projectRoot, ".git", "hooks", "pre-push");
  if (!(await pathExists(hookPath))) {
    return false;
  }
  return (await readFile(hookPath, "utf8")).includes(
    "# gd-metapro:security-pre-push:begin",
  );
}

// True when .claude/settings.json still carries the managed security agent-hook
// sentinel (i.e. the agent hooks were previously installed there).
async function agentSettingsHasSecuritySentinel(
  projectRoot: string,
): Promise<boolean> {
  const file = agentSettingsPath(projectRoot);
  if (!(await pathExists(file))) {
    return false;
  }
  return (await readFile(file, "utf8")).includes(AGENT_HOOKS_SENTINEL);
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
  enableSecurity,
  enableGdgraphHook,
  enableGdskillsHook,
  enableHealthHook,
  enableTestingPostCommitHook,
  enableTestingPrePushHook,
  enableSecurityPrePushHook,
  enableSecurityAgentHook,
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
  enableSecurity: boolean;
  enableGdgraphHook: boolean;
  enableGdskillsHook: boolean;
  enableHealthHook: boolean;
  enableTestingPostCommitHook: boolean;
  enableTestingPrePushHook: boolean;
  enableSecurityPrePushHook: boolean;
  enableSecurityAgentHook: boolean;
  agentRuleSources: string[];
  existingManifest?: MetaprojectManifest | undefined;
}): MetaprojectManifest {
  const existingProjectSkillRegistry =
    existingManifest?.modules.gdskills?.enabled === true
      ? existingManifest.modules.gdskills.projectSkillRegistry
      : undefined;

  const enabledModuleKeys = [
    enableGdgraph && "gdgraph",
    enableGdctx && "gdctx",
    enableGdwiki && "gdwiki",
    enableGdskills && "gdskills",
    enableMemory && "memory",
    enableTasks && "tasks",
    enableHealth && "health",
    enableTesting && "testing",
    enableSecurity && "security",
  ].filter((key): key is string => typeof key === "string");

  return {
    schemaVersion: 1,
    standardVersion: STANDARD_VERSION,
    name: `${projectName}-metaproject`,
    createdBy: "gd-metapro",
    profiles: computeProfiles(enabledModuleKeys),
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
            commands: moduleCommands("gdgraph"),
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
            commands: moduleCommands("gdctx"),
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
            commands: moduleCommands("gdwiki"),
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
            commands: moduleCommands("gdskills"),
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
            commands: moduleCommands("memory"),
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
            commands: moduleCommands("tasks"),
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
            commands: moduleCommands("health"),
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
            commands: moduleCommands("testing"),
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
      security: enableSecurity
        ? {
            enabled: true,
            version: "0.1.0",
            core: ".metaproject/core/security",
            data: ".metaproject/data/security",
            manifest: ".metaproject/modules/security.md",
            config: ".metaproject/security.config.json",
            commands: moduleCommands("security"),
            capabilities: securityCapabilities(),
            ...(enableSecurityPrePushHook || enableSecurityAgentHook
              ? {
                  hooks: {
                    ...(enableSecurityPrePushHook
                      ? { prePush: ".git/hooks/pre-push" }
                      : {}),
                    ...(enableSecurityAgentHook
                      ? { agent: AGENT_SETTINGS_RELATIVE_PATH }
                      : {}),
                  },
                }
              : {}),
          }
        : {
            enabled: false,
          },
    },
    updatedAt: new Date().toISOString(),
    agentEntrypoints: {
      index: ".metaproject/index.md",
      readme: ".metaproject/README.md",
      root: agentRuleSources,
    },
  };
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
