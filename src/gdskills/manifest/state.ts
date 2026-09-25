// Flow 309 (W1), T6: per-target install-state for `keryx skills install`'s
// new manifest-driven path. Conforms to install-manifest.schema.json's
// `$defs/installState`/`$defs/installedModuleRecord` — the same shape
// `src/integrations/install-state.ts` (W5-b) writes for `keryx integrations`,
// reused here rather than redefined, but at a different path:
// `.metaproject/data/skills/install-state/<target>.json` (this module's own
// surface), not `.metaproject/data/integrations/install-state/<runtimeId>.json`
// (W5-b's).

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../../lib/fs";
import { removeContained, writeContained } from "../../lib/contained-write";
import { NotARegularFileError, sha256OfRegularFile as sha256OfFile, type InstallState, type InstalledModuleRecord } from "../../integrations/install-state";
import { validateAgainstSchemaObject } from "../../contracts/validator";
import installManifestSchemaJson from "../../../docs/requirements/keryx-agent-platform-expansion/schemas/install-manifest.schema.json" with {
  type: "json",
};

export const SKILLS_INSTALL_STATE_SCHEMA_VERSION = "1.0.0";

export { NotARegularFileError, sha256OfFile };
export type { InstallState, InstalledModuleRecord };

/**
 * F19: real schema validation, not a hand-rolled shape check — a document is
 * install-state only when it satisfies install-manifest.schema.json's own
 * `$defs/installState` (id patterns, sha256 hex pattern, `writtenPaths`
 * `minItems: 1`, the harness-id enum on `target`, `additionalProperties:
 * false`, ...). The `$ref` is resolved against the full schema's `$defs` by
 * making that object double as the local validation root (see
 * `validateAgainstSchemaObject`: the schema argument IS the `$ref` root).
 */
const INSTALL_STATE_SCHEMA = {
  $ref: "#/$defs/installState",
  $defs: (installManifestSchemaJson as unknown as { $defs: Record<string, unknown> }).$defs,
};

function isValidInstallState(value: unknown): value is InstallState {
  return validateAgainstSchemaObject(INSTALL_STATE_SCHEMA, value).valid;
}

/** F3: a target id is only ever used as a bare filename component (`<target>.json`); reject anything that could traverse (`/`, `..`, an absolute path) before it ever reaches a path.join. */
const TARGET_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function skillsInstallStatePath(repoRoot: string, target: string): string {
  if (!TARGET_ID_PATTERN.test(target)) {
    throw new Error(`invalid install-state target id "${target}" (must match ${TARGET_ID_PATTERN})`);
  }
  return path.join(repoRoot, ".metaproject", "data", "skills", "install-state", `${target}.json`);
}

async function parseInstallStateFile(
  repoRoot: string,
  target: string,
): Promise<{ state: InstallState | undefined; unreadable: boolean }> {
  const file = skillsInstallStatePath(repoRoot, target);
  if (!(await pathExists(file))) return { state: undefined, unreadable: false };
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (isValidInstallState(parsed)) return { state: parsed, unreadable: false };
    return { state: undefined, unreadable: true };
  } catch {
    return { state: undefined, unreadable: true };
  }
}

/** Reads `<target>.json`, or `undefined` when absent/unreadable/not valid install-state JSON (schema-checked, F19). */
export async function readSkillsInstallState(repoRoot: string, target: string): Promise<InstallState | undefined> {
  return (await parseInstallStateFile(repoRoot, target)).state;
}

/**
 * True when `<target>.json` EXISTS but is not usable install-state (bad
 * JSON, or valid JSON that fails install-manifest.schema.json's
 * `$defs/installState`) — the case `doctor`/`uninstall` must report as a
 * problem (F17), distinct from "nothing recorded yet" (no file at all),
 * which is normal and silent.
 */
export async function skillsInstallStateIsUnreadable(repoRoot: string, target: string): Promise<boolean> {
  return (await parseInstallStateFile(repoRoot, target)).unreadable;
}

export type ContainedPathResult = { ok: true; abs: string } | { ok: false; reason: string };

/** True when any `/`- or `\`-separated segment of `relPath` is literally `..`. */
function hasDotDotSegment(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * R3-3 (flow 309 review round 3): `rel` (posix-separated, project-relative,
 * no leading/trailing slash) is a DESCENDANT of `root` — compared by whole
 * path segments, never a raw string prefix (so `.claude/skillsX` never
 * matches root `.claude/skills`). `rel === root` itself is REFUSED, not
 * accepted: Keryx only ever records individual FILES in install-state
 * (`writtenPaths`), never a bare destination root directory — a record
 * naming `.claude/skills` itself used to pass containment and then crash
 * `sha256OfFile` with a raw `EISDIR` the moment doctor/uninstall/apply tried
 * to hash it (that root is always an existing directory once anything is
 * installed under it).
 */
function isUnderDestinationRoot(rel: string, root: string): boolean {
  return rel.startsWith(`${root}/`);
}

/**
 * R2-1/R2-2: walk every segment of `relPath` from `repoRoot` down to (and
 * including) the leaf, `lstat`-ing each one that exists. Any segment that IS
 * a symlink — an intermediate ancestor (e.g. a symlinked `.claude/`) or the
 * leaf itself (e.g. a destination file that is itself a symlink to
 * somewhere outside the project) — means the path this process would
 * actually touch on disk cannot be trusted from the textual/resolved
 * comparison alone, so the whole path is refused. A segment that does not
 * exist yet ends the walk (nothing further down can exist either under
 * normal filesystem semantics) and is not itself a violation.
 */
async function hasSymlinkSegment(repoRoot: string, posixRel: string): Promise<boolean> {
  const segments = posixRel.split("/").filter((segment) => segment.length > 0);
  let current = repoRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * F2/F3 class fix (hardened R2-1/R2-2): the single containment guard for
 * every place that turns a path RECORDED in install-state (never one this
 * process just computed itself from the trusted destination table) into a
 * filesystem operation — `uninstall.ts`'s `rm`, `doctor.ts`'s
 * re-hash/orphan-scan, and `apply.ts`'s read of prior state AND its own
 * write of new files. Refuses:
 *   - an absolute path (a recorded path is always project-relative);
 *   - a raw path containing a `..` segment or a backslash at all — state is
 *     Keryx-written, so either one means tampering, even if the path would
 *     textually normalize to somewhere inside the root (R2-1);
 *   - any path whose NORMALIZED resolution against `repoRoot`
 *     (`path.relative` after `path.resolve`) is empty or escapes it (`..`)
 *     or is itself absolute;
 *   - (when `destinationRoots` is given) a normalized path not under any of
 *     the target's own known destination roots, compared by whole path
 *     segments rather than a raw string prefix — a record naming a real,
 *     contained file OUTSIDE those roots (or under a same-prefixed sibling
 *     directory, e.g. `.claude/skillsX`) is still not something this
 *     target's install/doctor/uninstall surface could ever have written;
 *   - a path where any existing segment from `repoRoot` down to the leaf —
 *     including the leaf itself — is a symlink (R2-2): such a path can be
 *     made to point anywhere on disk regardless of where it textually or
 *     even real-path resolves to.
 * A record failing this check makes the WHOLE install-state document
 * untrustworthy (see callers): this function only classifies one path — it
 * never mutates file content (it does `lstat` the path's own segments).
 */
export async function resolveContainedPath(
  repoRoot: string,
  relPath: string,
  destinationRoots?: readonly string[],
): Promise<ContainedPathResult> {
  if (typeof relPath !== "string" || relPath.length === 0) {
    return { ok: false, reason: "empty path" };
  }
  if (path.isAbsolute(relPath)) {
    return { ok: false, reason: `absolute path "${relPath}" is not allowed in recorded install-state` };
  }
  if (relPath.includes("\\") || hasDotDotSegment(relPath)) {
    return {
      ok: false,
      reason: `path "${relPath}" contains a ".." segment or a backslash, which is never valid in recorded install-state`,
    };
  }

  const resolvedRoot = path.resolve(repoRoot);
  const abs = path.resolve(resolvedRoot, relPath);
  const rel = path.relative(resolvedRoot, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: `path "${relPath}" escapes the project root` };
  }
  const posixRel = rel.split(path.sep).join("/");

  if (destinationRoots !== undefined && destinationRoots.length > 0) {
    // R4-3 (flow 309 review round 4): `posixRel` equal to one of the roots
    // itself (refused by `isUnderDestinationRoot` above, never accepted as
    // contained) used to fall into the generic "not under any of this
    // target's known destination roots" message — self-contradictory, since
    // the path IS one of the roots listed right there. Name that case on its
    // own terms instead.
    if (destinationRoots.includes(posixRel)) {
      return {
        ok: false,
        reason: `path "${relPath}" is a destination root itself, not a file under it`,
      };
    }
    const contained = destinationRoots.some((root) => isUnderDestinationRoot(posixRel, root));
    if (!contained) {
      return {
        ok: false,
        reason: `path "${relPath}" is not under any of this target's known destination roots (${destinationRoots.join(", ")})`,
      };
    }
  }

  if (await hasSymlinkSegment(resolvedRoot, posixRel)) {
    return {
      ok: false,
      reason: `path "${relPath}" resolves through a symlink (an ancestor directory or the destination itself)`,
    };
  }

  return { ok: true, abs };
}

function sortedRecords(records: readonly InstalledModuleRecord[]): InstalledModuleRecord[] {
  return [...records].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
}

/**
 * Upsert a batch of module records (keyed by `moduleId`) into `<target>.json`.
 * A record with an empty `writtenPaths` removes any existing record for that
 * module id instead of writing an empty one.
 */
export async function writeSkillsInstallState(
  repoRoot: string,
  target: string,
  moduleRecords: readonly InstalledModuleRecord[],
  profile: string | undefined,
): Promise<void> {
  const existing = await readSkillsInstallState(repoRoot, target);
  const byId = new Map(
    (existing?.installedModules ?? []).map((record) => [record.moduleId, record] as const),
  );
  for (const record of moduleRecords) {
    if (record.writtenPaths.length === 0) {
      byId.delete(record.moduleId);
    } else {
      byId.set(record.moduleId, record);
    }
  }
  const installedModules = sortedRecords([...byId.values()]);
  const file = skillsInstallStatePath(repoRoot, target);

  if (installedModules.length === 0) {
    await removeContained(repoRoot, path.relative(repoRoot, file));
    return;
  }

  const state: InstallState = {
    schemaVersion: SKILLS_INSTALL_STATE_SCHEMA_VERSION,
    target,
    ...(profile !== undefined ? { profile } : existing?.profile !== undefined ? { profile: existing.profile } : {}),
    installedModules,
    recordedAt: new Date().toISOString(),
  };
  await writeContained(repoRoot, path.relative(repoRoot, file), `${JSON.stringify(state, null, 2)}\n`);
}
