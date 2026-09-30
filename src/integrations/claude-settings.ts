// Flow 361: the ONE resolver for "which file holds this project's
// keryx-managed Claude Code hooks". Every Claude settings surface — ctx guard,
// orient, both security checks, the learning observer, the jev edit guard —
// takes its path from here, so they cannot end up split across
// `.claude/settings.local.json` and `.claude/settings.json`: Claude Code
// merges the two files, and a hook present in both fires twice.
//
// Synchronous on purpose: `SurfaceAdapter.settingsFile(root)` and the three
// view modules built on it (`locate`, `settingsPath`) are synchronous, and the
// answer needs nothing but two small file reads.

import { readFileSync } from "node:fs";
import path from "node:path";
import { settingsTextHasManagedHooks } from "../rules/entrypoint-migration";
import {
  localClaudeSettingsTarget,
  normalizeEntrypointTargets,
  sharedClaudeSettingsTarget,
  type ClaudeSettingsTarget,
} from "../rules/entrypoint-targets";

/** Per developer, gitignored — the default. */
export const CLAUDE_LOCAL_SETTINGS_PATH = localClaudeSettingsTarget().path;
/** Tracked, team-owned — `scope: "shared"`, the explicit opt-in. */
export const CLAUDE_SHARED_SETTINGS_PATH = sharedClaudeSettingsTarget().path;
/** Every file the resolver can name; the registry keeps one `SettingsFileOwner` per entry. */
export const CLAUDE_SETTINGS_PATHS: readonly string[] = [CLAUDE_LOCAL_SETTINGS_PATH, CLAUDE_SHARED_SETTINGS_PATH];

const MANIFEST_REL = ".metaproject/metaproject.json";

function readTextSync(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * What the manifest itself says under `agentEntrypoints.claudeSettings`, or
 * `undefined` when it does not say (no manifest, a legacy manifest, an
 * unreadable one). Only the scope is taken from it: the path is always the
 * standard file of that scope, so a hand-edited entry can neither aim a
 * "local" target at the tracked file nor name a file no owner exists for.
 */
export function statedClaudeSettingsTarget(projectRoot: string): ClaudeSettingsTarget | undefined {
  const text = readTextSync(path.join(projectRoot, ...MANIFEST_REL.split("/")));
  if (text === undefined) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return undefined;
  }
  const agentEntrypoints =
    typeof manifest === "object" && manifest !== null ? (manifest as { agentEntrypoints?: unknown }).agentEntrypoints : undefined;
  const normalized = normalizeEntrypointTargets(agentEntrypoints);
  if (normalized.legacy.some((entry) => entry.kind === "claudeSettings")) return undefined;
  return normalized.targets.claudeSettings.scope === "shared" ? sharedClaudeSettingsTarget() : localClaudeSettingsTarget();
}

/** True when `relativePath` under `projectRoot` is a settings file holding at least one keryx-managed hook group. */
export function claudeSettingsFileHoldsManagedHooks(projectRoot: string, relativePath: string): boolean {
  const text = readTextSync(path.join(projectRoot, ...relativePath.split("/")));
  return text !== undefined && settingsTextHasManagedHooks(text);
}

/**
 * The file this project's managed Claude hooks live in.
 *
 * - `scope: "shared"` in the manifest: the tracked `.claude/settings.json`.
 * - Otherwise local — unless the tracked file still holds managed hook groups.
 *   Those are either committed by the team or waiting for `keryx update` to
 *   move them, and until one of the two is settled every installer keeps
 *   writing where the hooks already are rather than starting a second copy.
 */
export function resolveClaudeSettingsTarget(projectRoot: string): ClaudeSettingsTarget {
  const stated = statedClaudeSettingsTarget(projectRoot);
  if (stated?.scope === "shared") return stated;
  if (claudeSettingsFileHoldsManagedHooks(projectRoot, CLAUDE_SHARED_SETTINGS_PATH)) return sharedClaudeSettingsTarget();
  return localClaudeSettingsTarget();
}

/** `resolveClaudeSettingsTarget`'s path, relative to the project root. */
export function claudeSettingsRelativePath(projectRoot: string): string {
  return resolveClaudeSettingsTarget(projectRoot).path;
}

/**
 * The location fields of a Claude settings surface, to spread into its
 * `SurfaceAdapter`: `relativePath` is the default (what the capability matrix
 * and the registry's static checks see), `relativePathFor`/`settingsFile`
 * answer for one project.
 */
export function claudeSettingsLocation(): {
  readonly relativePath: string;
  readonly relativePathCandidates: readonly string[];
  relativePathFor(projectRoot: string): string;
  settingsFile(projectRoot: string): string;
} {
  return {
    relativePath: CLAUDE_LOCAL_SETTINGS_PATH,
    relativePathCandidates: CLAUDE_SETTINGS_PATHS,
    relativePathFor: claudeSettingsRelativePath,
    settingsFile: (projectRoot) => path.join(projectRoot, ...claudeSettingsRelativePath(projectRoot).split("/")),
  };
}
