// Flow 309, W1 Lane C — the one catalog read every governance gate (scout,
// eval, stocktake) shares.
//
// WHY ONE LOADER
//
// `BUNDLED_GDSKILLS` (catalog.ts) exists to render and install the 72 shipped
// skills; it does not expose a skill's body text, its content hash, or its
// `metadata.origin`, none of which the install path ever needed. Governance
// needs all three — the lint reads the body, `stocktake`'s cache is keyed by
// content hash, and provenance is the whole point of W1-AC12 — so this is a
// second walk of the same tree rather than a widened `BundledSkill`, on
// purpose: `BUNDLED_GDSKILLS` also carries `renderedSkill()` entries with no
// `SKILL.md` on disk at all (metaproject-router, context-router, …), which a
// governance gate that lints and hashes FILES has no way to evaluate. This
// loader only ever returns entries backed by a real `SKILL.md`.
//
// SCOPE
//
// `"bundled"` is `src/gdskills/bundled/skills/**` plus, once any exist,
// `src/gdskills/bundled/stacks/*/skills/**` (W1's stack packs — none shipped
// yet, so that walk returns nothing today and the loader does not fail when
// the directory is absent). `"all"` additionally walks a target project's
// `.metaproject/skills/gdskills/**` (the installed mirror) and
// `.metaproject/project-skills/**` (generated entity/project skills), so a
// scout run against a real checkout also dedupes against what that checkout
// already generated for itself.
//
// DETERMINISM
//
// Every directory read is sorted before it is walked, and the returned array
// is sorted by `id` — `stocktake`'s cache and `scout`'s "top 5" ranking both
// depend on ties breaking the same way on every run.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { defaultBundledRoot } from "../bundled-eval";
import { parseSkillFrontmatter } from "../skill-frontmatter";

export type CatalogScope = "bundled" | "all";

export interface CatalogEntry {
  /** `${category}/${name}` — stable, matches every other per-skill map in this tree. */
  readonly id: string;
  readonly category: string;
  readonly name: string;
  readonly description: string;
  readonly triggers: readonly string[];
  /** The whole `SKILL.md`, frontmatter included. */
  readonly body: string;
  readonly bodyLines: number;
  /** `metadata.origin`, when the frontmatter declares one. */
  readonly origin?: string;
  readonly sha256: string;
  /** Absolute path to the `SKILL.md` this entry was read from. */
  readonly path: string;
}

export interface LoadSkillCatalogOptions {
  readonly scope: CatalogScope;
}

/**
 * R3-4 (flow 309 review round 3): one catalog entry (a `SKILL.md`) or
 * directory listing this loader could not read — `code` is the underlying
 * `NodeJS.ErrnoException.code` when available (`"EACCES"`, `"ELOOP"`, ...),
 * or `"UNKNOWN"` otherwise. Surfaced as a top-level list rather than thrown:
 * one unreadable project skill must not make `stocktake`/`eval`/`scout
 * --scope all` abort with no report for the other 71 skills.
 */
export interface UnreadableCatalogEntry {
  readonly path: string;
  readonly code: string;
}

function errnoCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : "UNKNOWN";
}

function sortedDirs(dir: string, unreadable: UnreadableCatalogEntry[]): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    unreadable.push({ path: dir, code: errnoCode(error) });
    return [];
  }
}

function readCatalogEntry(skillMdPath: string, category: string, name: string): CatalogEntry {
  const body = readFileSync(skillMdPath, "utf8");
  const frontmatter = parseSkillFrontmatter(body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    id: `${category}/${name}`,
    category,
    name,
    description: frontmatter.description ?? "",
    triggers: frontmatter.triggers ?? [],
    body,
    bodyLines: body.split("\n").length,
    ...(frontmatter.metadataOrigin !== undefined ? { origin: frontmatter.metadataOrigin } : {}),
    sha256,
    path: skillMdPath,
  };
}

/**
 * Reads one `SKILL.md` into a `CatalogEntry`, or records it in `unreadable`
 * and returns `undefined` (R3-4) — a single unreadable file (EACCES on the
 * file itself, or on an ancestor directory an `existsSync` probe cannot
 * detect) must not abort the whole catalog walk.
 */
function tryReadCatalogEntry(skillMdPath: string, category: string, name: string, unreadable: UnreadableCatalogEntry[]): CatalogEntry | undefined {
  try {
    return readCatalogEntry(skillMdPath, category, name);
  } catch (error) {
    unreadable.push({ path: skillMdPath, code: errnoCode(error) });
    return undefined;
  }
}

/** `<root>/<category>/<name>/SKILL.md` for every `category`/`name` pair under `root`. */
function walkCategorizedSkills(root: string, unreadable: UnreadableCatalogEntry[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const category of sortedDirs(root, unreadable)) {
    const categoryDir = path.join(root, category);
    for (const name of sortedDirs(categoryDir, unreadable)) {
      const skillMd = path.join(categoryDir, name, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const entry = tryReadCatalogEntry(skillMd, category, name, unreadable);
      if (entry !== undefined) out.push(entry);
    }
  }
  return out;
}

/** `<stacksRoot>/<stack-id>/skills/<name>/SKILL.md` — category is the stack id. */
function walkStackSkills(stacksRoot: string, unreadable: UnreadableCatalogEntry[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const stackId of sortedDirs(stacksRoot, unreadable)) {
    const skillsDir = path.join(stacksRoot, stackId, "skills");
    for (const name of sortedDirs(skillsDir, unreadable)) {
      const skillMd = path.join(skillsDir, name, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const entry = tryReadCatalogEntry(skillMd, stackId, name, unreadable);
      if (entry !== undefined) out.push(entry);
    }
  }
  return out;
}

/** Any `SKILL.md` under `root`, category/name derived from its immediate parent dirs. */
function walkLooseSkillTree(root: string, unreadable: UnreadableCatalogEntry[]): CatalogEntry[] {
  if (!existsSync(root)) return [];
  const out: CatalogEntry[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      unreadable.push({ path: dir, code: errnoCode(error) });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name !== "SKILL.md") continue;
      const name = path.basename(dir);
      const category = path.basename(path.dirname(dir)) || "project";
      const catalogEntry = tryReadCatalogEntry(full, category, name, unreadable);
      if (catalogEntry !== undefined) out.push(catalogEntry);
    }
  };
  walk(root);
  return out;
}

export interface CatalogLoadResult {
  readonly entries: readonly CatalogEntry[];
  /** R3-4: every `SKILL.md`/directory this loader could not read, skipped rather than aborting the whole walk. Empty in the common case. */
  readonly unreadable: readonly UnreadableCatalogEntry[];
}

/**
 * Loads the skill catalog governance gates score against, plus (R3-4,
 * flow 309 review round 3) any entries it could not read — an unreadable
 * project `SKILL.md` (EACCES, a broken symlink, ...) is skipped and
 * recorded rather than making the whole load throw. See the module header
 * for scope semantics.
 */
export function loadSkillCatalogWithDiagnostics(root: string, options: LoadSkillCatalogOptions): CatalogLoadResult {
  const bundledRoot = defaultBundledRoot();
  const unreadable: UnreadableCatalogEntry[] = [];
  const entries: CatalogEntry[] = [
    ...walkCategorizedSkills(path.join(bundledRoot, "skills"), unreadable),
    ...walkStackSkills(path.join(bundledRoot, "stacks"), unreadable),
  ];

  if (options.scope === "all") {
    entries.push(...walkCategorizedSkills(path.join(root, ".metaproject", "skills", "gdskills"), unreadable));
    entries.push(...walkLooseSkillTree(path.join(root, ".metaproject", "project-skills"), unreadable));
  }

  const byId = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    // First writer wins: the bundled/stack entries are pushed first, so an
    // installed mirror of a bundled skill (same id, same content almost
    // always) never displaces the canonical source entry.
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return {
    entries: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    unreadable: [...unreadable].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Loads the skill catalog governance gates score against. See the module header for scope semantics. Drops diagnostics — use `loadSkillCatalogWithDiagnostics` to also learn which entries could not be read (R3-4). */
export function loadSkillCatalog(root: string, options: LoadSkillCatalogOptions): CatalogEntry[] {
  return [...loadSkillCatalogWithDiagnostics(root, options).entries];
}
