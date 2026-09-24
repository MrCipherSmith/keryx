// Flow 308 (W8 Design part A, Lane A) — surface discovery for
// `keryx security audit-harness`. Read-only: locates the files each surface
// enumerates and reports paths, never content, back to the caller.
//
// Every discovery function returns paths relative to `root`, POSIX
// separators, sorted deterministically — the report's `pathsScanned` /
// `pathsUnreadable` fields read directly off these.

import path from "node:path";
import { readdir, realpath } from "node:fs/promises";
import { isPathInside, pathExists, toPosix } from "../../lib/fs";
import { SETTINGS_FILE_OWNERS, HARNESS_ADAPTERS } from "../../integrations/index";
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

const INSTRUCTION_FILENAMES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"];

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
 */
const NON_JSON_HOOK_SURFACE_PATHS = (() => {
  const paths = new Set<string>();
  for (const adapter of HARNESS_ADAPTERS) {
    for (const surface of adapter.surfaces) {
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

async function listMarkdownFiles(root: string, dirRelative: string): Promise<DiscoveryResult> {
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
    if (!entry.name.endsWith(".md")) continue;
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

export async function discoverAgentDefinitions(root: string): Promise<DiscoveryResult> {
  const [canonical, exported] = await Promise.all([
    listMarkdownFiles(root, ".metaproject/agents"),
    listMarkdownFiles(root, ".claude/agents"),
  ]);
  return {
    found: [...new Set([...canonical.found, ...exported.found])].sort(),
    unreadable: [...new Set([...canonical.unreadable, ...exported.unreadable])].sort(),
  };
}

// --- skills ----------------------------------------------------------------

const SCRIPT_EXTENSIONS = new Set([".sh", ".py", ".js", ".ts"]);

async function walkScripts(root: string, dirRelative: string, depth = 0): Promise<DiscoveryResult> {
  if (depth > 8) return { found: [], unreadable: [] };
  const dirAbsolute = path.join(root, dirRelative);
  if (!(await pathExists(dirAbsolute))) {
    return { found: [], unreadable: [] };
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dirAbsolute, { withFileTypes: true });
  } catch {
    // Exists but unreadable (F7): a coverage gap, not a silent empty result.
    return { found: [], unreadable: [toPosix(dirRelative)] };
  }
  const found: string[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    const childRelative = path.join(dirRelative, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkScripts(root, childRelative, depth + 1);
      found.push(...nested.found);
      unreadable.push(...nested.unreadable);
      continue;
    }
    if (entry.isFile() && SCRIPT_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(toPosix(childRelative));
      continue;
    }
    if (entry.isSymbolicLink() && SCRIPT_EXTENSIONS.has(path.extname(entry.name))) {
      // F21: a symlinked script previously vanished silently — `entry.isFile()`
      // is false for a symlink dirent, so it never reached the extension
      // check at all. Follow it; report it unreadable rather than dropping it
      // when it resolves outside root (or not at all).
      const absolute = path.join(root, childRelative);
      if (await resolvesInsideRoot(root, absolute)) {
        found.push(toPosix(childRelative));
      } else {
        unreadable.push(toPosix(childRelative));
      }
    }
  }
  return { found, unreadable };
}

export async function discoverSkillScripts(root: string): Promise<DiscoveryResult> {
  const [metaSkills, claudeSkills] = await Promise.all([
    walkScripts(root, ".metaproject/skills"),
    walkScripts(root, ".claude/skills"),
  ]);
  return {
    found: [...new Set([...metaSkills.found, ...claudeSkills.found])].sort(),
    unreadable: [...new Set([...metaSkills.unreadable, ...claudeSkills.unreadable])].sort(),
  };
}

export { rel };
