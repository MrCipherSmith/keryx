// Resource registry: read-only `metaproject://<class>/<relpath>` scheme
// (specification.md §7; M-4, AC2).
//
// `resources/list` enumerates on-disk generated artifacts; `resources/read`
// returns raw file contents. No computation, no mutation. URIs are resolved and
// CONFINED to their class root — any path escaping the root is rejected. Imports
// only shared libs (M-3).

import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { isPathInside, pathExists, toPosix } from "../lib/fs";

export type ResourceClass = "artifacts" | "wiki" | "memory";

export const RESOURCE_CLASSES: ResourceClass[] = ["artifacts", "wiki", "memory"];

export interface ResourceListing {
  uri: string;
  name: string;
  mimeType: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

const URI_PREFIX = "metaproject://";

function mimeForPath(filePath: string): string {
  if (filePath.endsWith(".json") || filePath.endsWith(".jsonl")) {
    return "application/json";
  }
  if (filePath.endsWith(".md")) {
    return "text/markdown";
  }
  return "text/plain";
}

function dataRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "data");
}

function wikiRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "wiki");
}

function memoryRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "memory");
}

async function walkFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out.sort();
}

// Build the `artifacts` class listing: every file under
// `.metaproject/data/<module>/artifacts/**`, keyed as `<module>/<relpath>`.
async function listArtifacts(cwd: string): Promise<ResourceListing[]> {
  const base = dataRoot(cwd);
  if (!(await pathExists(base))) {
    return [];
  }
  const listings: ResourceListing[] = [];
  let modules: import("node:fs").Dirent[];
  try {
    modules = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const moduleEntry of modules) {
    if (!moduleEntry.isDirectory()) {
      continue;
    }
    const artifactsDir = path.join(base, moduleEntry.name, "artifacts");
    for (const file of await walkFiles(artifactsDir)) {
      const rel = toPosix(path.relative(artifactsDir, file));
      const relPath = `${moduleEntry.name}/${rel}`;
      listings.push({
        uri: `${URI_PREFIX}artifacts/${relPath}`,
        name: relPath,
        mimeType: mimeForPath(file),
      });
    }
  }
  return listings;
}

async function listUnderRoot(
  cwd: string,
  cls: ResourceClass,
  root: string,
): Promise<ResourceListing[]> {
  const listings: ResourceListing[] = [];
  for (const file of await walkFiles(root)) {
    const rel = toPosix(path.relative(root, file));
    listings.push({
      uri: `${URI_PREFIX}${cls}/${rel}`,
      name: rel,
      mimeType: mimeForPath(file),
    });
  }
  return listings;
}

// Enumerate all readable resources for the configured classes. `roots` is the
// config allowlist (`resources.roots`); classes outside it are not exposed.
export async function listResources(
  cwd: string,
  roots: string[],
): Promise<ResourceListing[]> {
  const allowed = new Set(roots);
  const listings: ResourceListing[] = [];
  if (allowed.has("artifacts")) {
    listings.push(...(await listArtifacts(cwd)));
  }
  if (allowed.has("wiki")) {
    listings.push(...(await listUnderRoot(cwd, "wiki", wikiRoot(cwd))));
  }
  if (allowed.has("memory")) {
    listings.push(...(await listUnderRoot(cwd, "memory", memoryRoot(cwd))));
  }
  return listings;
}

// Parse a `metaproject://<class>/<relpath>` URI. Returns null when the scheme or
// class is unrecognized.
export function parseResourceUri(
  uri: string,
): { cls: ResourceClass; relPath: string } | null {
  if (!uri.startsWith(URI_PREFIX)) {
    return null;
  }
  const rest = uri.slice(URI_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) {
    return null;
  }
  const cls = rest.slice(0, slash);
  const relPath = rest.slice(slash + 1);
  if (cls !== "artifacts" && cls !== "wiki" && cls !== "memory") {
    return null;
  }
  return { cls, relPath };
}

// Resolve a class + relative path to an on-disk file, confined to the class
// root. Returns null when the target escapes the root (path-traversal) — the
// caller then rejects the read.
function resolveConfined(
  cwd: string,
  cls: ResourceClass,
  relPath: string,
): { root: string; absolute: string } | null {
  if (cls === "artifacts") {
    const firstSlash = relPath.indexOf("/");
    if (firstSlash <= 0) {
      return null;
    }
    const moduleName = relPath.slice(0, firstSlash);
    const rest = relPath.slice(firstSlash + 1);
    // Confine the module segment itself (no `..` module).
    if (moduleName.includes("..") || moduleName.length === 0) {
      return null;
    }
    const root = path.join(dataRoot(cwd), moduleName, "artifacts");
    const absolute = path.resolve(root, rest);
    return isPathInside(root, absolute) ? { root, absolute } : null;
  }
  const root = cls === "wiki" ? wikiRoot(cwd) : memoryRoot(cwd);
  const absolute = path.resolve(root, relPath);
  return isPathInside(root, absolute) ? { root, absolute } : null;
}

// Read a resource by URI. Throws with a leak-safe message when the URI is
// malformed, the class is not exposed, the path escapes the root, or the file is
// absent. Never returns content outside a configured, confined root.
export async function readResource(
  cwd: string,
  roots: string[],
  uri: string,
): Promise<ResourceContents> {
  const parsed = parseResourceUri(uri);
  if (!parsed) {
    throw new Error(`Unrecognized resource URI: ${uri}`);
  }
  if (!roots.includes(parsed.cls)) {
    throw new Error(`Resource class not exposed: ${parsed.cls}`);
  }
  const resolved = resolveConfined(cwd, parsed.cls, parsed.relPath);
  if (!resolved) {
    throw new Error(`Resource path is outside its root (rejected): ${uri}`);
  }
  const info = await stat(resolved.absolute).catch(() => null);
  if (!info || !info.isFile()) {
    throw new Error(`Resource not found: ${uri}`);
  }
  const text = await readFile(resolved.absolute, "utf8");
  return { uri, mimeType: mimeForPath(resolved.absolute), text };
}
