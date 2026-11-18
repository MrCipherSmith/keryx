import { createHash } from "node:crypto";
import path from "node:path";
import { writeContained } from "../lib/contained-write";
import { withFileLock } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { PROJECT_SKILLS_LOCK_PATH, PROJECT_SKILLS_MANIFEST_PATH } from "./project-skills";

/** Where a project's own rules live; `rules/core` belongs to keryx's install and is never written here. */
export const PROJECT_RULES_DIR = ".metaproject/rules/project";

export type ProjectRuleMode = "copy" | "link";

/**
 * One rule a project registered with `keryx skills import --rules`.
 *
 * `copy`: the bytes the gate let through are at `path`; `sha256` is their hash and
 * `originSha256` is the hash of the source they came from, so drift is the source
 * moving on. `link`: nothing was copied; `origin` is read in place for as long as
 * its hash is `sha256` (equal to `originSha256`).
 */
export type ProjectRuleRegistryEntry = {
  kind: "rule";
  /** Path below `rules/project/`, posix. */
  ref: string;
  /** Project-relative path of the copy, or of the slot a copy would take. */
  path: string;
  mode: ProjectRuleMode;
  /** Portable origin reference: project-relative, `~/…`, or absolute. */
  origin: string;
  sha256: string;
  originSha256: string;
  description: string;
  globs: string[];
  alwaysApply: boolean;
  taskTypes?: string[];
  updatedAt: string;
};

type RuleManifest = {
  modules?: { gdskills?: { projectRuleRegistry?: ProjectRuleRegistryEntry[] } };
};

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function projectRulePathFor(ref: string): string {
  return `${PROJECT_RULES_DIR}/${ref}`;
}

function isEntry(value: unknown): value is ProjectRuleRegistryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.kind === "rule" &&
    typeof entry.ref === "string" &&
    (entry.mode === "copy" || entry.mode === "link") &&
    typeof entry.sha256 === "string"
  );
}

/** The registered rules, sorted by ref. A registry that is absent or unreadable is empty. */
export async function readProjectRuleRegistry(projectRoot: string): Promise<ProjectRuleRegistryEntry[]> {
  const manifest = await readJsonFileOr<RuleManifest>(path.join(projectRoot, PROJECT_SKILLS_MANIFEST_PATH), {});
  const raw = manifest.modules?.gdskills?.projectRuleRegistry;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isEntry).sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Add or replace entries by ref, and drop `remove` refs, under the lock every registry writer takes. */
export async function updateProjectRuleRegistry(
  projectRoot: string,
  change: { upsert?: readonly ProjectRuleRegistryEntry[]; remove?: readonly string[] },
): Promise<void> {
  await withFileLock(path.join(projectRoot, PROJECT_SKILLS_LOCK_PATH), async () => {
    const manifestPath = path.join(projectRoot, PROJECT_SKILLS_MANIFEST_PATH);
    const manifest = await readJsonFileOr<RuleManifest>(manifestPath, {});
    manifest.modules ??= {};
    manifest.modules.gdskills ??= {};
    const dropped = new Set([...(change.remove ?? []), ...(change.upsert ?? []).map((entry) => entry.ref)]);
    const kept = (manifest.modules.gdskills.projectRuleRegistry ?? []).filter(
      (entry) => !dropped.has(entry.ref),
    );
    manifest.modules.gdskills.projectRuleRegistry = [...kept, ...(change.upsert ?? [])].sort((a, b) =>
      a.ref.localeCompare(b.ref),
    );
    await writeContained(projectRoot, PROJECT_SKILLS_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  });
}

/** One registry entry a rule move rewrote: `from` -> `to` are refs below `rules/project/`. */
export type MovedRegistryEntry = { from: string; to: string };

/**
 * Follow a rule move in the `skills import --rules` registry (review LS-2): an
 * entry registered at `core/<name>` for a rule keryx moved to `<layer>/<name>`
 * is re-keyed to the new ref and slot, so `skills update --rules` writes the
 * slot references now resolve through instead of recreating the old one.
 *
 * Only when nothing is left at the old slot (the installer moved the copy, or
 * the entry is a link) and no entry holds the new ref yet: with both slots
 * taken the installer has already warned, and the entry stays where it is.
 */
export async function migrateMovedRuleRegistry(
  projectRoot: string,
  moves: readonly { fileName: string; movedTo: string }[],
  oldSlotExists: (ref: string) => Promise<boolean>,
): Promise<MovedRegistryEntry[]> {
  const registry = await readProjectRuleRegistry(projectRoot);
  if (registry.length === 0) return [];
  const refs = new Set(registry.map((entry) => entry.ref));
  const upsert: ProjectRuleRegistryEntry[] = [];
  const remove: string[] = [];
  const moved: MovedRegistryEntry[] = [];
  for (const move of moves) {
    const from = `core/${move.fileName}`;
    const entry = registry.find((candidate) => candidate.ref === from);
    if (entry === undefined || refs.has(move.movedTo) || (await oldSlotExists(from))) continue;
    upsert.push({ ...entry, ref: move.movedTo, path: path.posix.join(PROJECT_RULES_DIR, move.movedTo) });
    remove.push(from);
    moved.push({ from, to: move.movedTo });
  }
  if (moved.length > 0) await updateProjectRuleRegistry(projectRoot, { upsert, remove });
  return moved;
}
