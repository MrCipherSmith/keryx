// Flow 308 (W8 Design part A, Lane A) — surface discovery for
// `keryx security audit-harness`. Read-only: locates the files each surface
// enumerates and reports paths, never content, back to the caller.
//
// Every discovery function returns paths relative to `root`, POSIX
// separators, sorted deterministically — the report's `pathsScanned` /
// `pathsUnreadable` fields read directly off these.

import path from "node:path";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isPathInside, pathExists, toPosix } from "../../lib/fs";
import { SETTINGS_FILE_OWNERS, HARNESS_ADAPTERS, SUBSYSTEM_AGENTS, SUBSYSTEM_RULES_EXPORT } from "../../integrations/index";
import type { SurfaceId } from "./types";

/** A directory or file discovery result that distinguishes "found" from
 * "discovered but could not be read/resolved" — the latter must surface as
 * `pathsUnreadable`, never be silently dropped (flow 308 W8 review F7/F21). */
export type DiscoveryResult = { found: string[]; unreadable: string[] };

/**
 * Whether `absolute` is safe to report as a found file: it resolves (via
 * realpath, so a symlink is followed) to somewhere INSIDE `root`. A symlink
 * that resolves outside root, or a dangling one, is never silently skipped —
 * the caller reports it under `unreadable` instead (F21).
 */
async function resolvesInsideRoot(root: string, absolute: string): Promise<boolean> {
  try {
    // Resolve `root` too, not just `absolute` — `root` itself commonly sits
    // behind a symlink (e.g. macOS's `/tmp` -> `/private/tmp`), and comparing
    // a realpath'd `absolute` against a NOT-realpath'd `root` would flag
    // every ordinary, perfectly-contained symlink target as "outside root"
    // purely from the string mismatch, not from anything actually escaping.
    const rootReal = await realpath(root).catch(() => path.resolve(root));
    const real = await realpath(absolute);
    return isPathInside(rootReal, real);
  } catch {
    return false;
  }
}

export type SurfaceFiles = {
  surface: SurfaceId;
  /** Existing, readable-as-a-file candidate paths (relative to root, posix). */
  found: string[];
};

function rel(root: string, absolute: string): string {
  return toPosix(path.relative(root, absolute)) || ".";
}

async function existingFiles(root: string, relativePaths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const relativePath of relativePaths) {
    const absolute = path.join(root, relativePath);
    if (await pathExists(absolute)) {
      found.push(toPosix(relativePath));
    }
  }
  return [...new Set(found)].sort();
}

// --- instructions --------------------------------------------------------

// Flow 313 (W4 portability), T9: extended with the `rules-export` surface's
// own target files (`src/integrations/surfaces-rules.ts`) — a managed
// `keryx:rules` index block can land in any of these, some of which
// (`.cursor/rules/keryx-rules.mdc`, `.kiro/steering/keryx-rules.md`,
// `.windsurf/rules/keryx-rules.md`) were not previously scanned by
// `keryx security audit-harness` at all. `.github/copilot-instructions.md`
// and `.kiro/steering/keryx.md` were already covered by the pre-existing list
// (the latter via `INSTRUCTIONS_KIRO`'s markdown-block target) — kept
// deduplicated below rather than listed twice.
const INSTRUCTION_FILENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".cursor/rules/keryx-rules.mdc",
  ".kiro/steering/keryx-rules.md",
  ".kiro/steering/keryx.md",
  ".windsurf/rules/keryx-rules.md",
];

export async function discoverInstructions(root: string): Promise<string[]> {
  return existingFiles(root, INSTRUCTION_FILENAMES);
}

// --- settings --------------------------------------------------------------

const EXTRA_SETTINGS_PATHS = [
  ".claude/settings.local.json",
  ".cursor/settings.json",
  ".windsurf/settings.json",
  ".codex/config.toml",
];

export async function discoverSettings(root: string): Promise<string[]> {
  const fromRegistry = SETTINGS_FILE_OWNERS.map((owner) => owner.relativePath);
  return existingFiles(root, [...fromRegistry, ...EXTRA_SETTINGS_PATHS]);
}

// --- mcp-configs -------------------------------------------------------------

const MCP_CONFIG_PATHS = [".mcp.json", ".cursor/mcp.json", ".codex/config.toml"];

/**
 * Settings files that may carry an inline `mcpServers` object are the same
 * files `discoverSettings` already found; the mcp-configs surface lists a
 * settings file here ONLY when it actually has an `mcpServers` key — the
 * caller (`checks.ts`) reads and filters.
 */
export async function discoverMcpConfigCandidates(root: string): Promise<{
  standalone: string[];
  settingsFiles: string[];
}> {
  const standalone = await existingFiles(root, MCP_CONFIG_PATHS);
  const settingsFiles = await discoverSettings(root);
  return { standalone, settingsFiles };
}

// --- hooks -------------------------------------------------------------------

/**
 * Every `HARNESS_ADAPTERS[].surfaces[]` file that is NOT owned by a JSON
 * `SettingsFileOwner` is a hook ARTIFACT this surface scans as text (a
 * generated script/plugin file), not merged JSON. This mirrors
 * `SETTINGS_FILE_OWNERS`'s own ownership test in `registry.ts` exactly:
 * "owned by JSON" there means `merge`/`strip` both defined — whatever that
 * builder excludes as a non-JSON artifact is what this list picks up.
 * Previously this only matched `relativePath.endsWith(".js")`, which missed
 * any future non-JSON artifact with a different extension (e.g. `.py`,
 * `.sh`) — a surface with a `relativePath` but no `merge`/`strip` pair.
 *
 * Flow 310 (W2) T13: a surface in the `agents` SUBSYSTEM (`SUBSYSTEM_AGENTS`
 * — `.claude/agents`, `.codex/agents`, `.kiro/agents`, `.opencode/agents`,
 * each a whole DIRECTORY of per-agent files written by
 * `src/agents/export.ts`) also has no `merge`/`strip` pair — a custom
 * surface, same as a hook artifact — but it is not a hook artifact at all.
 * Before this exclusion, every agents-export directory was picked up here
 * and reported as an unreadable "hook file" (a directory, not a file) by
 * `discoverHookSurfaceFiles` below, turning the `hooks` coverage surface
 * `status: "error"` for every project that exported agent definitions. Named
 * exclusion by subsystem, not by extension or shape, so a future non-JSON
 * hook artifact still lands here and a future non-agents custom surface is
 * unaffected.
 *
 * Flow 313 (W4 portability) T9: the `rules-export` SUBSYSTEM
 * (`SUBSYSTEM_RULES_EXPORT` — `surfaces-rules.ts`) is excluded the same way:
 * its target files (CLAUDE.md, AGENTS.md, GEMINI.md, ...) are managed
 * INSTRUCTIONS artifacts, already covered by `discoverInstructions`'s own
 * `INSTRUCTION_FILENAMES` list, not hook artifacts — without this exclusion
 * a project whose CLAUDE.md/AGENTS.md already exists (the ordinary case) got
 * that same file double-reported here as a "hook file", incorrectly turning
 * `hooks` coverage `status: "scanned"` for a project with no hook artifacts
 * at all.
 */
const NON_JSON_HOOK_SURFACE_PATHS = (() => {
  const paths = new Set<string>();
  for (const adapter of HARNESS_ADAPTERS) {
    for (const surface of adapter.surfaces) {
      if (surface.subsystem === SUBSYSTEM_AGENTS || surface.subsystem === SUBSYSTEM_RULES_EXPORT) continue;
      if (surface.relativePath && !(surface.merge && surface.strip)) {
        paths.add(surface.relativePath);
      }
    }
  }
  return [...paths];
})();

export async function discoverHookSurfaceFiles(root: string): Promise<string[]> {
  return existingFiles(root, [...NON_JSON_HOOK_SURFACE_PATHS, ".metaproject/hooks.json"]);
}

// --- agent-definitions ---------------------------------------------------

/**
 * Flow 310 (W2) T13: generalized from a markdown-only walk (`.md`) to any of
 * `extensions` — codex ships `.codex/agents/<name>.toml`, kiro ships
 * `.kiro/agents/<name>.json`; claude/opencode keep `.md`. One walk, one
 * extension set per call, so the symlink/unreadable handling below (F7/F21)
 * stays in exactly one place regardless of which host directory or format is
 * being scanned.
 */
async function listFilesByExtensions(
  root: string,
  dirRelative: string,
  extensions: ReadonlySet<string>,
): Promise<DiscoveryResult> {
  const dirAbsolute = path.join(root, dirRelative);
  if (!(await pathExists(dirAbsolute))) {
    // Genuinely absent: not-applicable, not an error (F7).
    return { found: [], unreadable: [] };
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dirAbsolute, { withFileTypes: true });
  } catch {
    // Exists but could not be listed (e.g. permission denied) — a coverage
    // gap, not silence (F7): report the directory itself as unreadable.
    return { found: [], unreadable: [toPosix(dirRelative)] };
  }
  const found: string[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    if (!extensions.has(path.extname(entry.name))) continue;
    const childRelative = path.join(dirRelative, entry.name);
    if (entry.isFile()) {
      found.push(toPosix(childRelative));
      continue;
    }
    if (entry.isSymbolicLink()) {
      // F21: a symlinked entry was previously skipped in total silence
      // (`entry.isFile()` is false for a symlink dirent). Follow it, but
      // only report it found when it resolves to somewhere inside root.
      const absolute = path.join(root, childRelative);
      if (await resolvesInsideRoot(root, absolute)) {
        found.push(toPosix(childRelative));
      } else {
        unreadable.push(toPosix(childRelative));
      }
    }
  }
  return { found: found.sort(), unreadable: unreadable.sort() };
}

/** Every extension a bundled agent-definition catalog exporter writes: markdown (claude/opencode/`.metaproject/agents`), TOML (codex), JSON (kiro). */
const AGENT_DEFINITION_EXTENSIONS = new Set([".md", ".toml", ".json"]);

/**
 * Flow 310 (W2) T13: the canonical `.metaproject/agents` source directory
 * plus every host directory the W5 registry's `agents`-subsystem surfaces
 * declare (`SUBSYSTEM_AGENTS` — `surfaces-agents.ts`'s `AGENTS_CLAUDE`/
 * `AGENTS_CODEX`/`AGENTS_KIRO`/`AGENTS_OPENCODE`), derived from the registry
 * rather than hand-copied here so a future host runtime's agents surface is
 * picked up without a second edit. `.claude/agents` is kept as an explicit
 * fallback in case that runtime's surface is ever unregistered — the
 * exit-criterion promise ("codex/kiro/opencode exports actually get
 * scanned") must not silently regress to claude-only if a registry edit
 * elsewhere ever drops a runtime's surface.
 */
function agentDefinitionHostDirs(): string[] {
  const dirs = new Set<string>([".metaproject/agents", ".claude/agents"]);
  for (const adapter of HARNESS_ADAPTERS) {
    for (const surface of adapter.surfaces) {
      if (surface.subsystem === SUBSYSTEM_AGENTS && surface.relativePath) {
        dirs.add(surface.relativePath);
      }
    }
  }
  return [...dirs];
}

export async function discoverAgentDefinitions(root: string): Promise<DiscoveryResult> {
  const results = await Promise.all(
    agentDefinitionHostDirs().map((dirRelative) =>
      listFilesByExtensions(root, dirRelative, AGENT_DEFINITION_EXTENSIONS),
    ),
  );
  const found = new Set<string>();
  const unreadable = new Set<string>();
  for (const result of results) {
    result.found.forEach((f) => found.add(f));
    result.unreadable.forEach((f) => unreadable.add(f));
  }
  return { found: [...found].sort(), unreadable: [...unreadable].sort() };
}

// --- skills ----------------------------------------------------------------

const SCRIPT_EXTENSIONS = new Set([".sh", ".py", ".js", ".ts"]);

/**
 * N3: `discoverSkillScripts`'s coverage-vs-silence contract, matching the
 * `unreadable` handling everywhere else in this file — plus `reasons`, for a
 * gap that is not tied to one specific path (a depth-cap truncation covers
 * everything below it, not one file).
 */
export type SkillsDiscoveryResult = DiscoveryResult & { reasons: string[] };

const SKILL_WALK_MAX_DEPTH = 8;

type WalkAccumulator = { found: string[]; unreadable: string[]; reasons: Set<string> };

/**
 * N3: previously a symlinked directory vanished in total silence — a
 * `Dirent` for a symlink reports `isDirectory() === false` even when its
 * target is a directory (that check never follows the link), so it matched
 * neither the `isDirectory()` recursion branch nor the `isSymbolicLink()`
 * branch below (which only handled a symlinked FILE with a script
 * extension). Depth-cap truncation was silent too — `depth > 8` just
 * returned an empty result with no trace in `unreadable`/coverage at all.
 * Both are now reported: a symlinked directory resolving OUTSIDE root, or a
 * dangling one, lands in `unreadable` (surfaces as `pathsUnreadable` +
 * `status: "error"`, same as every other unreadable path here); one
 * resolving INSIDE root is followed, guarded against a symlink cycle by
 * `visited` (realpaths already walked); and a walk truncated by the depth
 * cap adds a `reasons` entry rather than returning as if nothing were there.
 */
async function walkScripts(
  root: string,
  dirRelative: string,
  depth: number,
  visited: Set<string>,
  acc: WalkAccumulator,
): Promise<void> {
  if (depth > SKILL_WALK_MAX_DEPTH) {
    acc.reasons.add(`skills: walk truncated at depth ${depth} (${toPosix(dirRelative)})`);
    return;
  }
  const dirAbsolute = path.join(root, dirRelative);
  if (!(await pathExists(dirAbsolute))) {
    return;
  }
  // I3 (review round 3): a TOP-LEVEL entry point (`.metaproject/skills`,
  // `.claude/skills` — the two calls in `discoverSkillScripts`) reaches this
  // function directly, never through the nested `entry.isSymbolicLink()`
  // branch below that already applies `resolvesInsideRoot` before recursing.
  // A top-level directory that is ITSELF a symlink pointing outside root
  // (or dangling) was walked — and any script under it silently reported as
  // `found` — without ever being containment-checked. Applying the same
  // check here, uniformly, regardless of how this directory was reached,
  // closes that gap; for a nested symlinked directory it is a harmless
  // repeat of the check the caller already made.
  const lst = await lstat(dirAbsolute).catch(() => undefined);
  if (lst?.isSymbolicLink() && !(await resolvesInsideRoot(root, dirAbsolute))) {
    acc.unreadable.push(toPosix(dirRelative));
    return;
  }
  const dirReal = await realpath(dirAbsolute).catch(() => undefined);
  if (dirReal !== undefined) {
    if (visited.has(dirReal)) return; // symlink cycle: already walked this real directory
    visited.add(dirReal);
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dirAbsolute, { withFileTypes: true });
  } catch {
    // Exists but unreadable (F7): a coverage gap, not a silent empty result.
    acc.unreadable.push(toPosix(dirRelative));
    return;
  }
  for (const entry of entries) {
    const childRelative = path.join(dirRelative, entry.name);
    if (entry.isDirectory()) {
      await walkScripts(root, childRelative, depth + 1, visited, acc);
      continue;
    }
    if (entry.isFile() && SCRIPT_EXTENSIONS.has(path.extname(entry.name))) {
      acc.found.push(toPosix(childRelative));
      continue;
    }
    if (entry.isSymbolicLink()) {
      const absolute = path.join(root, childRelative);
      if (!(await resolvesInsideRoot(root, absolute))) {
        // F21/N3: resolves outside root (or dangling) — never silently
        // skipped, whether it turns out to be a file or a directory.
        acc.unreadable.push(toPosix(childRelative));
        continue;
      }
      const stats = await stat(absolute).catch(() => undefined);
      if (stats?.isDirectory()) {
        await walkScripts(root, childRelative, depth + 1, visited, acc);
      } else if (stats?.isFile() && SCRIPT_EXTENSIONS.has(path.extname(entry.name))) {
        acc.found.push(toPosix(childRelative));
      } else if (stats === undefined) {
        acc.unreadable.push(toPosix(childRelative));
      }
    }
  }
}

export async function discoverSkillScripts(root: string): Promise<SkillsDiscoveryResult> {
  const metaAcc: WalkAccumulator = { found: [], unreadable: [], reasons: new Set() };
  const claudeAcc: WalkAccumulator = { found: [], unreadable: [], reasons: new Set() };
  await Promise.all([
    walkScripts(root, ".metaproject/skills", 0, new Set(), metaAcc),
    walkScripts(root, ".claude/skills", 0, new Set(), claudeAcc),
  ]);
  return {
    found: [...new Set([...metaAcc.found, ...claudeAcc.found])].sort(),
    unreadable: [...new Set([...metaAcc.unreadable, ...claudeAcc.unreadable])].sort(),
    reasons: [...new Set([...metaAcc.reasons, ...claudeAcc.reasons])].sort(),
  };
}

export { rel };
