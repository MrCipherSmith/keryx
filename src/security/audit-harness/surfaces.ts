// Flow 308 (W8 Design part A, Lane A) — surface discovery for
// `keryx security audit-harness`. Read-only: locates the files each surface
// enumerates and reports paths, never content, back to the caller.
//
// Every discovery function returns paths relative to `root`, POSIX
// separators, sorted deterministically — the report's `pathsScanned` /
// `pathsUnreadable` fields read directly off these.

import path from "node:path";
import { readdir } from "node:fs/promises";
import { pathExists, toPosix } from "../../lib/fs";
import { SETTINGS_FILE_OWNERS, HARNESS_ADAPTERS } from "../../integrations/index";
import type { SurfaceId } from "./types";

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

async function listMarkdownFiles(root: string, dirRelative: string): Promise<string[]> {
  const dirAbsolute = path.join(root, dirRelative);
  if (!(await pathExists(dirAbsolute))) {
    return [];
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dirAbsolute, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => toPosix(path.join(dirRelative, entry.name)))
    .sort();
}

export async function discoverAgentDefinitions(root: string): Promise<string[]> {
  const [canonical, exported] = await Promise.all([
    listMarkdownFiles(root, ".metaproject/agents"),
    listMarkdownFiles(root, ".claude/agents"),
  ]);
  return [...new Set([...canonical, ...exported])].sort();
}

// --- skills ----------------------------------------------------------------

const SCRIPT_EXTENSIONS = new Set([".sh", ".py", ".js", ".ts"]);

async function walkScripts(root: string, dirRelative: string, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  const dirAbsolute = path.join(root, dirRelative);
  if (!(await pathExists(dirAbsolute))) {
    return [];
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dirAbsolute, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const childRelative = path.join(dirRelative, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walkScripts(root, childRelative, depth + 1)));
    } else if (entry.isFile() && SCRIPT_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(toPosix(childRelative));
    }
  }
  return found;
}

export async function discoverSkillScripts(root: string): Promise<string[]> {
  const [metaSkills, claudeSkills] = await Promise.all([
    walkScripts(root, ".metaproject/skills"),
    walkScripts(root, ".claude/skills"),
  ]);
  return [...new Set([...metaSkills, ...claudeSkills])].sort();
}

export { rel };
