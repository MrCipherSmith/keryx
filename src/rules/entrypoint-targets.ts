// Flow 361: the ONE model of "where does keryx write its managed block and
// its Claude hooks, and is that place shared (tracked, team-owned) or local
// (per developer, gitignored)". Every writer and reader resolves its target
// through this module instead of repeating `AGENTS.md` / `CLAUDE.md` /
// `.claude/settings.json` as literals, and the three command-local
// `agentEntrypoints` types (init.ts, update.ts, rules.ts) collapse onto
// `normalizeEntrypointTargets`.
//
// Pure: no filesystem, no git. Deciding whether a LEGACY entry migrates as
// shared or local needs `HEAD` and lives in `./entrypoint-migration`.

export type EntrypointScope = "local" | "shared";
export type EntrypointRuntime = "claude" | "codex";
/** `override`: `AGENTS.override.md` is generated from `source`. `skip`: nothing is written for Codex. */
export type CodexLocalMode = "override" | "skip";

export type ClaudeRootEntry = { runtime: "claude"; path: string; scope: EntrypointScope };
export type CodexSharedRootEntry = { runtime: "codex"; path: string; scope: "shared" };
export type CodexLocalRootEntry = {
  runtime: "codex";
  path: string;
  scope: "local";
  mode: CodexLocalMode;
  /** The team file the override is built from. */
  source: string;
};
export type RootEntrypointEntry = ClaudeRootEntry | CodexSharedRootEntry | CodexLocalRootEntry;
export type ClaudeSettingsTarget = { path: string; scope: EntrypointScope };

/** The part of the manifest's `agentEntrypoints` this module owns; serialises as-is. */
export type EntrypointTargets = {
  root: RootEntrypointEntry[];
  claudeSettings: ClaudeSettingsTarget;
};

/** A target the manifest did not state in entry form, so its scope is still to be decided from `HEAD`. */
export type LegacyEntrypoint =
  | { kind: "root"; runtime: EntrypointRuntime; path: string }
  | { kind: "claudeSettings"; path: string };

export type NormalizedEntrypointTargets = {
  /**
   * Always complete: one entry per runtime plus the settings target. Every
   * target listed in `legacy` is provisionally `scope: "shared"` here — what
   * a legacy manifest meant — until `resolveLegacyEntrypointTargets` settles it.
   */
  targets: EntrypointTargets;
  legacy: LegacyEntrypoint[];
  /** `root` items that were dropped: unknown shapes, unknown runtimes, unsafe paths, duplicates. */
  ignored: unknown[];
  /** True when the manifest does not already hold exactly `targets`. */
  needsRewrite: boolean;
};

const RUNTIMES: readonly EntrypointRuntime[] = ["claude", "codex"];
const SHARED_ROOT_PATH: Record<EntrypointRuntime, string> = { claude: "CLAUDE.md", codex: "AGENTS.md" };
const LOCAL_ROOT_PATH: Record<EntrypointRuntime, string> = { claude: "CLAUDE.local.md", codex: "AGENTS.override.md" };
const SHARED_SETTINGS_PATH = ".claude/settings.json";
const LOCAL_SETTINGS_PATH = ".claude/settings.local.json";
const DEFAULT_CODEX_SOURCE = SHARED_ROOT_PATH.codex;

/** The local root entry for `runtime`; a Codex override is built from `source`. */
export function localRootEntry(runtime: EntrypointRuntime, source: string = DEFAULT_CODEX_SOURCE): RootEntrypointEntry {
  return runtime === "claude"
    ? { runtime, path: LOCAL_ROOT_PATH.claude, scope: "local" }
    : { runtime, path: LOCAL_ROOT_PATH.codex, scope: "local", mode: "override", source };
}

/** The shared root entry for `runtime`: the team file itself. */
export function sharedRootEntry(runtime: EntrypointRuntime, entryPath: string = SHARED_ROOT_PATH[runtime]): RootEntrypointEntry {
  return { runtime, path: entryPath, scope: "shared" };
}

export function localClaudeSettingsTarget(): ClaudeSettingsTarget {
  return { path: LOCAL_SETTINGS_PATH, scope: "local" };
}

export function sharedClaudeSettingsTarget(): ClaudeSettingsTarget {
  return { path: SHARED_SETTINGS_PATH, scope: "shared" };
}

/** What a fresh `keryx init` records: every target local. */
export function defaultEntrypointTargets(): EntrypointTargets {
  return { root: RUNTIMES.map((runtime) => localRootEntry(runtime)), claudeSettings: localClaudeSettingsTarget() };
}

/** The explicit opt-in: every target in the tracked team files. */
export function sharedEntrypointTargets(): EntrypointTargets {
  return { root: RUNTIMES.map((runtime) => sharedRootEntry(runtime)), claudeSettings: sharedClaudeSettingsTarget() };
}

/**
 * Reads whatever `agentEntrypoints` holds — the legacy `root: string[]`, the
 * entry form, a mix, entries with missing fields, junk, or nothing at all —
 * into the typed model. Never throws. A runtime (or the settings file) with
 * no usable entry-form statement becomes a legacy candidate at its team file
 * rather than silently defaulting to local: only `HEAD` can say whether the
 * team committed the block there.
 */
export function normalizeEntrypointTargets(agentEntrypoints: unknown): NormalizedEntrypointTargets {
  const raw = isRecord(agentEntrypoints) ? agentEntrypoints : {};
  const rawRoot = Array.isArray(raw.root) ? (raw.root as unknown[]) : [];

  const root: RootEntrypointEntry[] = [];
  const legacy: LegacyEntrypoint[] = [];
  const ignored: unknown[] = [];
  const seen = new Set<EntrypointRuntime>();

  for (const item of rawRoot) {
    const fromString = typeof item === "string" ? rootEntryFromLegacyString(item) : undefined;
    const entry = fromString ?? (isRecord(item) ? rootEntryFromRecord(item) : undefined);
    if (entry === undefined || seen.has(entry.runtime)) {
      ignored.push(item);
      continue;
    }
    seen.add(entry.runtime);
    root.push(entry);
    // A bare string naming a team file says where the block IS, not whether
    // it was committed there.
    if (fromString !== undefined && entry.scope === "shared") {
      legacy.push({ kind: "root", runtime: entry.runtime, path: entry.path });
    }
  }

  for (const runtime of RUNTIMES) {
    if (seen.has(runtime)) continue;
    const entry = sharedRootEntry(runtime);
    root.push(entry);
    legacy.push({ kind: "root", runtime, path: entry.path });
  }

  let claudeSettings = claudeSettingsFromValue(raw.claudeSettings);
  if (claudeSettings === undefined) {
    claudeSettings = sharedClaudeSettingsTarget();
    legacy.push({ kind: "claudeSettings", path: claudeSettings.path });
  }

  const targets: EntrypointTargets = { root, claudeSettings };
  const needsRewrite =
    JSON.stringify(raw.root) !== JSON.stringify(targets.root) ||
    JSON.stringify(raw.claudeSettings) !== JSON.stringify(targets.claudeSettings);
  return { targets, legacy, ignored, needsRewrite };
}

/**
 * The files imported as tracked rules (`.metaproject/rules/<file>.md`): the
 * team files only. A local target is per-developer content and is never
 * mirrored into tracked rules; a Codex override contributes the team file it
 * is built from. Candidates, not an existence check — the caller filters by
 * what is on disk, as `findAgentEntrypoints` already does.
 */
export function ruleImportSources(targets: EntrypointTargets): string[] {
  const sources: string[] = [];
  for (const entry of targets.root) {
    if (entry.scope === "shared") sources.push(entry.path);
    else if (entry.runtime === "codex") sources.push(entry.source);
  }
  sources.push(SHARED_ROOT_PATH.codex, SHARED_ROOT_PATH.claude);
  return [...new Set(sources)];
}

/** Every path keryx writes under `scope: "local"` — the set that must be gitignored. Codex `skip` writes nothing. */
export function localTargetPaths(targets: EntrypointTargets): string[] {
  const paths: string[] = [];
  for (const entry of targets.root) {
    if (entry.scope !== "local") continue;
    if (entry.runtime === "codex" && entry.mode === "skip") continue;
    paths.push(entry.path);
  }
  if (targets.claudeSettings.scope === "local") paths.push(targets.claudeSettings.path);
  return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A project-relative path that stays inside the project: these strings come
 * from a tracked, hand-editable manifest and end up as write destinations.
 */
function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return undefined;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return undefined;
  if (value.split(/[\\/]/).includes("..")) return undefined;
  return value;
}

function scopeOf(value: unknown): EntrypointScope | undefined {
  return value === "local" || value === "shared" ? value : undefined;
}

function runtimeOf(value: unknown): EntrypointRuntime | undefined {
  return value === "claude" || value === "codex" ? value : undefined;
}

/** A legacy `root` string: one of the known root file names, matched case-insensitively and kept as written. */
function rootEntryFromLegacyString(value: string): RootEntrypointEntry | undefined {
  const lower = value.toLowerCase();
  for (const runtime of RUNTIMES) {
    if (lower === SHARED_ROOT_PATH[runtime].toLowerCase()) return sharedRootEntry(runtime, value);
    if (lower === LOCAL_ROOT_PATH[runtime].toLowerCase()) return { ...localRootEntry(runtime), path: value };
  }
  return undefined;
}

function rootEntryFromRecord(value: Record<string, unknown>): RootEntrypointEntry | undefined {
  const runtime = runtimeOf(value.runtime);
  if (runtime === undefined) return undefined;
  const statedPath = safeRelativePath(value.path);
  if (value.path !== undefined && statedPath === undefined) return undefined;
  const statedScope = scopeOf(value.scope);
  if (statedPath === undefined && statedScope === undefined) return undefined;

  const scope =
    statedScope ?? (statedPath?.toLowerCase() === LOCAL_ROOT_PATH[runtime].toLowerCase() ? "local" : "shared");
  const entryPath = statedPath ?? (scope === "local" ? LOCAL_ROOT_PATH[runtime] : SHARED_ROOT_PATH[runtime]);
  if (scope === "shared") return sharedRootEntry(runtime, entryPath);
  if (runtime === "claude") return { runtime, path: entryPath, scope };
  return {
    runtime,
    path: entryPath,
    scope,
    mode: value.mode === "skip" ? "skip" : "override",
    source: safeRelativePath(value.source) ?? DEFAULT_CODEX_SOURCE,
  };
}

function claudeSettingsFromValue(value: unknown): ClaudeSettingsTarget | undefined {
  if (!isRecord(value)) return undefined;
  const statedPath = safeRelativePath(value.path);
  if (value.path !== undefined && statedPath === undefined) return undefined;
  const statedScope = scopeOf(value.scope);
  if (statedPath === undefined && statedScope === undefined) return undefined;
  const scope = statedScope ?? (statedPath === LOCAL_SETTINGS_PATH ? "local" : "shared");
  return { path: statedPath ?? (scope === "local" ? LOCAL_SETTINGS_PATH : SHARED_SETTINGS_PATH), scope };
}
