import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPathInside, pathExists, toPosix } from "../lib/fs";
import type { HarnessSkillRuntime, SkillRuntime } from "./export";

export type SyncRuntimeSkillsOptions = {
  runtime: SkillRuntime;
  target: string;
  dryRun?: boolean;
};

export type SyncMode = "explicit-target" | "global-mapping";

export type SyncRuntimeSkillsResult = {
  runtime: SkillRuntime;
  mode: SyncMode;
  sourceRoot: string;
  targetRoot: string;
  syncedSkills: string[];
  files: string[];
  manifestPath: string;
  dryRun: boolean;
};

/**
 * The global sync mapping described by
 * `src/gdskills/bundled/rules/core/skills-storage-workflow.mdc` ("Global Sync
 * Mapping"), which documented these destinations long before any code wrote to
 * them.
 *
 * `home` is the directory the harness itself owns and must already exist — we
 * refuse rather than create `~/.cursor` or `~/.config/zed` for someone.
 * `skills` is the subdirectory beneath it that we may create, because it lives
 * inside a tree the user has already opted into.
 *
 * `claude` is deliberately absent: the rule names no global destination for it,
 * and the Claude build is installed through the project's own `.metaproject`
 * tree, not a home-directory drop.
 */
export type GlobalSyncTargetSpec = {
  /** Env var that overrides the harness home, when the harness defines one. */
  homeEnv?: string;
  /** Path segments under `$HOME` used when the override is absent. */
  homeSegments: string[];
  /** Documented destination, for error and help text. */
  documented: string;
};

export const GLOBAL_SKILL_SYNC_TARGETS = {
  cursor: { homeSegments: [".cursor"], documented: "~/.cursor/skills/" },
  codex: { homeEnv: "CODEX_HOME", homeSegments: [".codex"], documented: "${CODEX_HOME:-~/.codex}/skills/" },
  zed: { homeSegments: [".config", "zed"], documented: "~/.config/zed/skills/" },
  opencode: { homeSegments: [".config", "opencode"], documented: "~/.config/opencode/skills/" },
} as const satisfies Partial<Record<HarnessSkillRuntime, GlobalSyncTargetSpec>>;

export type GlobalSyncRuntime = keyof typeof GLOBAL_SKILL_SYNC_TARGETS;

export const GLOBAL_SYNC_RUNTIMES = Object.keys(GLOBAL_SKILL_SYNC_TARGETS).sort() as GlobalSyncRuntime[];

export function isGlobalSyncRuntime(runtime: SkillRuntime): runtime is GlobalSyncRuntime {
  return Object.hasOwn(GLOBAL_SKILL_SYNC_TARGETS, runtime);
}

export type ResolvedGlobalSyncTarget = {
  runtime: GlobalSyncRuntime;
  /** Harness-owned directory that must already exist. */
  harnessHome: string;
  /** `<harnessHome>/skills` — where skill packages land. */
  skillsRoot: string;
  documented: string;
};

/**
 * Resolve where a runtime's skills belong in the user's home. Pure: it reads
 * `env` and computes paths, and touches no filesystem, so tests can point it at
 * a temp HOME.
 */
export function resolveGlobalSyncTarget(
  runtime: SkillRuntime,
  env: Record<string, string | undefined> = process.env,
): ResolvedGlobalSyncTarget {
  if (!isGlobalSyncRuntime(runtime)) {
    throw new Error(
      `No global sync destination is defined for runtime "${runtime}". ` +
        `Global sync covers: ${GLOBAL_SYNC_RUNTIMES.join(", ")}. ` +
        "Use --target <dir> for an explicit destination.",
    );
  }

  const spec: GlobalSyncTargetSpec = GLOBAL_SKILL_SYNC_TARGETS[runtime];
  const override = spec.homeEnv ? env[spec.homeEnv] : undefined;
  let harnessHome: string;
  if (override && override.trim().length > 0) {
    harnessHome = path.resolve(override);
  } else {
    const home = env.HOME;
    if (!home || home.trim().length === 0) {
      throw new Error(`Cannot resolve the global sync destination for ${runtime}: HOME is not set.`);
    }
    harnessHome = path.resolve(home, ...spec.homeSegments);
  }

  return {
    runtime,
    harnessHome,
    skillsRoot: path.join(harnessHome, "skills"),
    documented: spec.documented,
  };
}

export type SyncRuntimeSkillsToGlobalOptions = {
  runtime: SkillRuntime;
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
};

/**
 * Opt-in global sync. Never called by `keryx update` or any other implicit
 * path: writing into `~/.cursor/` and `~/.config/zed/` reaches outside the
 * project, so it only ever happens because someone typed
 * `keryx skills sync --runtime <harness> --global`.
 */
export async function syncRuntimeSkillsToGlobal(
  projectRoot: string,
  options: SyncRuntimeSkillsToGlobalOptions,
): Promise<SyncRuntimeSkillsResult> {
  const resolved = resolveGlobalSyncTarget(options.runtime, options.env ?? process.env);
  if (!(await pathExists(resolved.harnessHome))) {
    throw new Error(
      `Refusing to create ${resolved.harnessHome}: the ${resolved.runtime} home directory does not exist. ` +
        `Install ${resolved.runtime} (or create ${resolved.documented.replace(/skills\/$/, "")} yourself) and re-run.`,
    );
  }

  return syncRuntimeSkillsToRoot(projectRoot, {
    runtime: options.runtime,
    targetRoot: resolved.skillsRoot,
    dryRun: options.dryRun === true,
    mode: "global-mapping",
  });
}

export async function syncRuntimeSkills(
  projectRoot: string,
  options: SyncRuntimeSkillsOptions,
): Promise<SyncRuntimeSkillsResult> {
  if (!options.target || options.target.trim().length === 0) {
    throw new Error("Sync target is required.");
  }

  const targetRoot = path.resolve(projectRoot, options.target);
  validateSyncTarget(projectRoot, targetRoot);
  return syncRuntimeSkillsToRoot(projectRoot, {
    runtime: options.runtime,
    targetRoot,
    dryRun: options.dryRun === true,
    mode: "explicit-target",
  });
}

type SyncToRootOptions = {
  runtime: SkillRuntime;
  targetRoot: string;
  dryRun: boolean;
  mode: SyncMode;
};

async function syncRuntimeSkillsToRoot(
  projectRoot: string,
  options: SyncToRootOptions,
): Promise<SyncRuntimeSkillsResult> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  if (!(await pathExists(metaprojectRoot))) {
    throw new Error("Metaproject is not initialized. Run: keryx init");
  }

  const sourceRoot = path.join(metaprojectRoot, "runtime", "skills", options.runtime);
  if (!(await pathExists(sourceRoot))) {
    throw new Error(`No exported runtime skills found for ${options.runtime}. Run: keryx skills export <skill> --runtime ${options.runtime}`);
  }

  const targetRoot = options.targetRoot;
  const skillDirs = await listSkillArtifactDirs(sourceRoot);
  if (skillDirs.length === 0) {
    throw new Error(`No runtime skill artifacts found in ${toPosix(path.relative(projectRoot, sourceRoot))}`);
  }

  const files = await plannedSyncFiles(projectRoot, skillDirs, sourceRoot, targetRoot);
  const manifestPath = path.join(targetRoot, "keryx-sync-manifest.json");
  const syncedSkills = skillDirs.map((skillDir) => path.basename(skillDir)).sort();

  if (!options.dryRun) {
    await mkdir(targetRoot, { recursive: true });
    for (const skillDir of skillDirs) {
      const targetSkillDir = path.join(targetRoot, path.basename(skillDir));
      await copyDirectory(skillDir, targetSkillDir);
    }
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        runtime: options.runtime,
        sourceRoot: toPosix(path.relative(projectRoot, sourceRoot)),
        targetRoot,
        syncedSkills,
        syncedAt: new Date().toISOString(),
        mode: options.mode,
      }, null, 2)}\n`,
      "utf8",
    );
  }

  return {
    runtime: options.runtime,
    mode: options.mode,
    sourceRoot: toPosix(path.relative(projectRoot, sourceRoot)),
    targetRoot,
    syncedSkills,
    files: [
      ...files,
      displayPath(projectRoot, manifestPath),
    ],
    manifestPath: displayPath(projectRoot, manifestPath),
    dryRun: options.dryRun === true,
  };
}

/**
 * Project-relative inside the project, absolute outside it. A global sync
 * target sits in the user's home, and `../../../../.cursor/skills/...` names it
 * far worse than the real path does.
 */
function displayPath(projectRoot: string, filePath: string): string {
  return isPathInside(projectRoot, filePath)
    ? toPosix(path.relative(projectRoot, filePath))
    : toPosix(filePath);
}

function validateSyncTarget(projectRoot: string, targetRoot: string): void {
  const home = process.env.HOME ? path.resolve(process.env.HOME) : null;
  const allowed =
    isPathInside(projectRoot, targetRoot) ||
    (home !== null && isPathInside(home, targetRoot));

  if (!allowed) {
    throw new Error("Sync target must be inside the project or the current user's home directory.");
  }

  const normalized = path.resolve(targetRoot);
  if (normalized === path.parse(normalized).root || normalized === home) {
    throw new Error("Refusing to sync runtime skills into a filesystem root or home root.");
  }
}

async function listSkillArtifactDirs(sourceRoot: string): Promise<string[]> {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = path.join(sourceRoot, entry.name);
    if (await pathExists(path.join(skillDir, "SKILL.md"))) {
      dirs.push(skillDir);
    }
  }

  return dirs.sort();
}

async function plannedSyncFiles(
  projectRoot: string,
  skillDirs: string[],
  sourceRoot: string,
  targetRoot: string,
): Promise<string[]> {
  const files: string[] = [];
  for (const skillDir of skillDirs) {
    for (const filePath of await listFiles(skillDir)) {
      files.push(path.join(targetRoot, path.relative(sourceRoot, filePath)));
    }
  }

  return files.map((filePath) => displayPath(projectRoot, filePath));
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
  for (const filePath of await listFiles(sourceDir)) {
    const targetPath = path.join(targetDir, path.relative(sourceDir, filePath));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(filePath, targetPath);
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}
