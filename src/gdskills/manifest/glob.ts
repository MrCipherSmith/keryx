// Flow 309 (W1), T6: a minimal, deterministic glob resolver for module
// `paths` entries. Supports plain literal file paths, `*` (single path
// segment), and `**` (any number of segments, used as a directory's `/** `
// "everything under here" suffix — the only shape module paths use today).
// No external glob dependency: the manifest's `paths` vocabulary is narrow
// enough that a hand-rolled resolver is simpler to reason about than pulling
// in a package for it.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../lib/fs";

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if ("+.^$(){}|[]\\".includes(c ?? "")) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/** The directory to walk: everything in `glob` before its first `*`. */
function staticPrefixDir(glob: string): string {
  const starIndex = glob.indexOf("*");
  const prefix = starIndex === -1 ? glob : glob.slice(0, starIndex);
  if (prefix.endsWith("/")) return prefix.slice(0, -1);
  const dir = path.posix.dirname(prefix.split(path.sep).join("/"));
  return dir === "." ? "" : dir;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve one `paths` entry (repo-relative, possibly a glob) against
 * `repoRoot`, returning repo-relative, forward-slash, sorted file paths.
 * A literal path that does not exist resolves to an empty array (not an
 * error) — the caller (`plan.ts`) decides what an empty resolution means for
 * the module as a whole.
 */
export async function resolveGlob(repoRoot: string, pattern: string): Promise<string[]> {
  if (!pattern.includes("*")) {
    const abs = path.join(repoRoot, pattern);
    return (await pathExists(abs)) ? [pattern.split(path.sep).join("/")] : [];
  }
  const prefixDir = staticPrefixDir(pattern);
  const baseDir = path.join(repoRoot, prefixDir);
  const all = await listFilesRecursive(baseDir);
  const regex = globToRegExp(pattern);
  return all
    .map((f) => path.relative(repoRoot, f).split(path.sep).join("/"))
    .filter((rel) => regex.test(rel))
    .sort();
}

/** Resolve every entry in `patterns`, deduped and sorted. */
export async function resolveGlobs(repoRoot: string, patterns: readonly string[]): Promise<string[]> {
  const sets = await Promise.all(patterns.map((p) => resolveGlob(repoRoot, p)));
  return [...new Set(sets.flat())].sort();
}
