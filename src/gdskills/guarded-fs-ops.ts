// Flow 315 T16 (R2-F3 fix): `src/gdskills/install.ts` carried a whole-file
// ratchet allowlist entry to keep a handful of legitimately-raw
// `node:fs/promises` calls (a recursive `cp` for bundled directory installs,
// and the `unlink` two sweep functions use once they have confirmed a target
// is safe to delete). A whole-file allowlist entry protects nothing beyond
// those calls in practice: any OTHER raw write reintroduced anywhere in a
// thousand-line file — the exact `writeFile`/`copyFile` shape R1-F1 fixed —
// would ship with the ratchet still green, because `isAllowed()` matches by
// file, not by call site (R2-F3).
//
// This module is the fix: it is the ONLY place in `src/gdskills` that may
// call a raw `node:fs/promises` write/remove verb, and every export here
// carries its own containment guard right next to the raw call, the same
// posture `managed-git-hook.ts` already has for `.git/hooks` writes. The
// ratchet allowlists THIS file (a handful of narrowly-guarded exports) and
// nothing else in `src/gdskills` — a raw write anywhere else, `install.ts`
// included, is caught.

import { cp, lstat, mkdir, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_GDSKILLS } from "./catalog";
import { HARNESS_SKILL_RUNTIMES, skillBuildFileName } from "./export";
import {
  MOVED_RULES,
  movedToPackId,
  RETIRED_RULES,
  retiredRuleSizeCapBytes,
  type MovedDestinationCause,
  type RetiredRuleEntry,
  type RetiredRuleFailureStage,
  type RetiredRuleOutcome,
} from "./retired-rules";
import { stackPackInstallCommand } from "./stack-rules-install";

/** Every entry the core cleanup checks: rules dropped outright and rules moved to another layer. */
export const CORE_CLEANUP_ENTRIES: readonly RetiredRuleEntry[] = [...RETIRED_RULES, ...MOVED_RULES];

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** ENOENT/ENOTDIR: nothing at that path — a steady state, never a warning. */
export function isMissingPathError(error: unknown): boolean {
  return isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

export function errorCodeOf(error: unknown): string {
  return isErrnoException(error) && error.code ? error.code : "UNKNOWN";
}

/**
 * Where the bundled copy of a catalogued skill lives on disk, resolved
 * relative to this module's own location so it works both from source and
 * from a packaged build. Used by `installGdskills`'s per-skill loop (to
 * decide between a directory `cp` and a rendered single-file write) and by
 * `removeStaleRuntimeBuilds` below (to know which per-runtime builds a skill
 * still ships).
 */
export function bundledSkillSourcePath(category: string, skillName: string): string {
  const directPath = fileURLToPath(new URL(`./bundled/skills/${category}/${skillName}`, import.meta.url));
  if (existsSync(directPath)) {
    return directPath;
  }

  const packagedSourcePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "gdskills",
    "bundled",
    "skills",
    category,
    skillName,
  );
  if (existsSync(packagedSourcePath)) {
    return packagedSourcePath;
  }

  return directPath;
}

/**
 * Force-copy a bundled directory tree (a skill, the shared assets, or the
 * core rules) over an already-containment-checked install target.
 *
 * This is the ONE raw `cp` in `src/gdskills`. Every call site is required to
 * have just confirmed, via `mkdirContained`/`mkdirContainedOrWarn`, that
 * `target` resolves inside the project's `.metaproject` with no escaping
 * symlink anywhere on the path — `cp` itself has no containment primitive
 * for a whole-tree copy, so that check happens immediately before this call
 * at each call site (belt-and-braces, not gap-free: a symlink swapped in
 * between the two calls is not caught, the same narrowing every other TOCTOU
 * note in `install.ts` accepts).
 */
export async function copyDirectoryContained(source: string, target: string): Promise<void> {
  await cp(source, target, { recursive: true, force: true });
}

/** `SKILL.codex.md`, `SKILL.cursor.md`, … — every per-runtime build name. */
const RUNTIME_BUILD_FILE_NAMES: readonly string[] = HARNESS_SKILL_RUNTIMES
  .filter((runtime) => runtime !== "claude")
  .map((runtime) => skillBuildFileName(runtime));

/** Why a directory was left unswept instead of being looked inside. */
type UnsweepableDirReason = "symlink" | "not-a-directory" | "outside-skills-root";

export type StaleRuntimeBuildOutcome =
  | { path: string; action: "removed" }
  | { path: string; action: "kept-not-regular-file" }
  | { path: string; action: "kept-error"; errorCode: string }
  | { path: string; action: "skipped-dir"; blockedAt: string; reason: UnsweepableDirReason }
  | { path: string; action: "skipped-dir-error"; blockedAt: string; errorCode: string };

/**
 * Remove per-runtime builds (`SKILL.<runtime>.md`) the bundle no longer ships
 * from the installed keryx-managed skill directories.
 *
 * `installGdskills` copies each bundled skill directory over the installed one
 * with `cp(force)`, which overwrites but never deletes. A project installed
 * before flow 257 therefore keeps a `SKILL.codex.md` (etc.) that the bundle
 * dropped because it was a byte-identical copy of `SKILL.md` — and
 * `resolveSkillBuild` prefers an existing `SKILL.<runtime>.md`, so that stale
 * copy would win every later `--runtime` export over the current `SKILL.md`.
 *
 * This function deletes files, so its scope is fixed by three rules and
 * nothing else:
 *
 *   1. Containment. Only `<skillsRoot>/<category>/<name>/` for a catalogued
 *      bundled skill — never `project-skills/`, `shared/`, or anything else —
 *      and only when that directory is reachable without following a symlink
 *      at any step: `skillsRoot` and every component below it is `lstat`ed and
 *      must be a real directory, and the skill directory's `realpath` must
 *      still sit at `<realpath(skillsRoot)>/<category>/<name>`. Composing a
 *      path and `lstat`ing only its last component is not enough: with the
 *      skills root, a category, or a single skill directory symlinked (a
 *      shared checkout, a relocated tree), the `unlink` lands in the link's
 *      target, outside `.metaproject` entirely — round-1 finding, where a
 *      hand-written `SKILL.zed.md` in the target was deleted. A tree reached
 *      through a link is reported and left untouched instead.
 *   2. Exact names. The directory is `readdir`ed, and an entry is a candidate
 *      only when the name the filesystem reports is exactly one of
 *      RUNTIME_BUILD_FILE_NAMES. Never `SKILL.md`, never a companion such as
 *      `SKILL.detail.md` — and, because the comparison is against a real
 *      directory entry rather than a path keryx composed, never a user's
 *      `skill.codex.md` that a case-insensitive filesystem would have
 *      resolved for us and then reported under the canonical spelling.
 *   3. Still-shipped names are left alone: a build the bundle still ships for
 *      that skill was just refreshed by the copy above.
 *
 * There is deliberately no content check, unlike `removeUnmodifiedRetiredRules`
 * below (this is *not* a mirror of that cleanup — it is strictly less
 * discriminating, and the rules above are the whole guarantee). That one hashes
 * against `RETIRED_RULES[].shippedSha256`, a recorded list of the bytes keryx
 * shipped under each retired *rule* name. No equivalent list exists here and
 * none could be maintained: a stale build is a copy of whatever `SKILL.md` said
 * in the release that shipped it, so its content is per-skill and per-release,
 * and it would take a hash of every skill in every past release to recognise
 * one. The one hash that *is* at hand — the `SKILL.md` next to it — has just
 * been overwritten with the current bundle's bytes, which a stale build by
 * definition does not match, so gating on that would keep every genuine stale
 * build forever and do nothing. Because nothing is content-gated, every
 * removal is reported (see `staleRuntimeBuildMessage`) rather than silent: a
 * file does not leave a project's tree without the operator being told — as a
 * notice, not a warning, because it succeeded (`staleRuntimeBuildSeverity`).
 *
 * Each candidate is `lstat`ed before the `unlink` (a symlink or other
 * non-regular file is kept, never followed or read), and no single entry's or
 * directory's failure escapes the loop — it becomes an outcome that
 * `staleRuntimeBuildMessage` turns into a warning.
 */
export async function removeStaleRuntimeBuilds(
  skillsRoot: string,
  fsOps: {
    unlink: (target: string) => Promise<void>;
    /** Where a catalogued skill's bundled directory lives. A test seam: no shipped skill has a per-runtime build, so the "still shipped" rule needs a synthetic bundle to be exercised. */
    bundledSkillSource?: (category: string, skillName: string) => string;
  } = { unlink },
): Promise<StaleRuntimeBuildOutcome[]> {
  const outcomes: StaleRuntimeBuildOutcome[] = [];

  const root = await resolveSweepableDir(skillsRoot);
  if (root.kind === "missing") {
    // No installed skills tree at all — nothing to sweep, nothing to report.
    return outcomes;
  }
  if (root.kind !== "usable") {
    // One notice for the whole tree, not one per bundled skill.
    outcomes.push(root.outcome);
    return outcomes;
  }

  // Probed once per category for the same reason: a symlinked category
  // directory must produce one notice, not one for each skill inside it.
  const categories = new Map<string, SweepableDir>();

  for (const skillEntry of BUNDLED_GDSKILLS) {
    const categoryDir = path.join(skillsRoot, skillEntry.category);
    let category = categories.get(categoryDir);
    if (!category) {
      category = await resolveSweepableDir(categoryDir);
      categories.set(categoryDir, category);
      if (category.kind === "blocked") {
        outcomes.push(category.outcome);
      }
    }
    if (category.kind !== "usable") continue;

    const installedDir = path.join(categoryDir, skillEntry.name);
    const skillDir = await resolveSweepableDir(installedDir);
    if (skillDir.kind === "missing") {
      // The case for every skill this profile did not install.
      continue;
    }
    if (skillDir.kind !== "usable") {
      outcomes.push(skillDir.outcome);
      continue;
    }
    // Belt and braces: the walk above refused to follow a symlink at any step,
    // so this equality already holds by construction. It is here as a direct
    // statement of the invariant the `unlink` below depends on, independent of
    // that walk being right. It does not close the gap between check and
    // `unlink` — nothing short of an `openat`-based walk would — but it does
    // mean a single missed case in the walk cannot, on its own, delete outside
    // the installed skills root.
    if (skillDir.realPath !== path.join(root.realPath, skillEntry.category, skillEntry.name)) {
      outcomes.push({
        path: installedDir,
        blockedAt: installedDir,
        action: "skipped-dir",
        reason: "outside-skills-root",
      });
      continue;
    }

    let entries: string[];
    try {
      entries = await readdir(installedDir);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      outcomes.push({
        path: installedDir,
        blockedAt: installedDir,
        action: "skipped-dir-error",
        errorCode: errorCodeOf(error),
      });
      continue;
    }

    const bundledDir = (fsOps.bundledSkillSource ?? bundledSkillSourcePath)(skillEntry.category, skillEntry.name);
    for (const entryName of entries) {
      // Exact, case-sensitive match against the on-disk name…
      if (!RUNTIME_BUILD_FILE_NAMES.includes(entryName)) continue;
      // …and only names this skill no longer ships. A skill rendered from the
      // catalogue (no bundled directory) ships no per-runtime build at all, so
      // every such name in its installed directory is stale.
      if (existsSync(path.join(bundledDir, entryName))) continue;
      const installedPath = path.join(installedDir, entryName);
      try {
        const stats = await lstat(installedPath);
        if (!stats.isFile()) {
          outcomes.push({ path: installedPath, action: "kept-not-regular-file" });
          continue;
        }
        await fsOps.unlink(installedPath);
        outcomes.push({ path: installedPath, action: "removed" });
      } catch (error) {
        if (isMissingPathError(error)) {
          // Gone between the readdir and here — the work is done either way.
          continue;
        }
        outcomes.push({ path: installedPath, action: "kept-error", errorCode: errorCodeOf(error) });
      }
    }
  }
  return outcomes;
}

type SweepableDir =
  | { kind: "usable"; realPath: string }
  | { kind: "missing" }
  | { kind: "blocked"; outcome: StaleRuntimeBuildOutcome };

/**
 * One step of the containment walk: `dir` may be looked inside only if it is a
 * real directory in its own right. `lstat` never follows a symlink, so a link
 * here is judged without touching its target; that is the point, since the
 * hazard is deleting *through* it.
 */
async function resolveSweepableDir(dir: string): Promise<SweepableDir> {
  try {
    const stats = await lstat(dir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return {
        kind: "blocked",
        outcome: {
          path: dir,
          blockedAt: dir,
          action: "skipped-dir",
          reason: stats.isSymbolicLink() ? "symlink" : "not-a-directory",
        },
      };
    }
    return { kind: "usable", realPath: await realpath(dir) };
  } catch (error) {
    if (isMissingPathError(error)) {
      return { kind: "missing" };
    }
    return {
      kind: "blocked",
      outcome: { path: dir, blockedAt: dir, action: "skipped-dir-error", errorCode: errorCodeOf(error) },
    };
  }
}

/**
 * Where one stale-build outcome belongs in the install result.
 *
 * `removed` is the sweep doing its job: the file is a per-runtime build the
 * bundle stopped shipping, and deleting it is what makes every later runtime
 * export read the current `SKILL.md`. It is still reported — nothing here is
 * content-gated, so no file leaves a tree silently — but it asks nothing of the
 * operator. Every other outcome is a file keryx REFUSED to touch (a symlink, a
 * non-regular file, a directory it could not enter, an `unlink` that failed),
 * and each of those leaves a stale build in place for someone to remove by
 * hand. Only the second kind is a warning.
 */
export function staleRuntimeBuildSeverity(outcome: StaleRuntimeBuildOutcome): "notice" | "warning" {
  return outcome.action === "removed" ? "notice" : "warning";
}

/**
 * Message for one stale-build outcome — including removals, which used to be
 * silent. `keryx update` deleting a file from a project's tree with no content
 * check behind it (see `removeStaleRuntimeBuilds`) is exactly the kind of thing
 * an operator should be able to see afterwards. `projectRoot` only shortens the
 * paths in the message. `staleRuntimeBuildSeverity` decides which heading the
 * message is printed under; this function only renders the words.
 */
export function staleRuntimeBuildMessage(outcome: StaleRuntimeBuildOutcome, projectRoot: string): string {
  const shown = displayPath(outcome.path, projectRoot);
  switch (outcome.action) {
    case "removed":
      return `${shown} was removed: a per-runtime build keryx no longer ships (that runtime now reads SKILL.md), which every later runtime export would otherwise have kept preferring over the current SKILL.md`;
    case "kept-not-regular-file":
      return `${staleBuildPrefix(shown)}; kept because it is not a regular file (a symlink, directory, or similar) — keryx will not read or remove it; delete it yourself if appropriate`;
    case "kept-error":
      return `${staleBuildPrefix(shown)}; it could not be removed (${outcome.errorCode}) — delete it by hand`;
    case "skipped-dir":
      return `${unsweptDirPrefix(shown)}: ${unsweepableDirCause(outcome, projectRoot)} — if a stale SKILL.<runtime>.md sits in there, delete it yourself`;
    case "skipped-dir-error":
      return `${unsweptDirPrefix(shown)}: it could not be inspected (${outcome.errorCode}) — if a stale SKILL.<runtime>.md sits in there, delete it yourself`;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled stale runtime build outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function staleBuildPrefix(shown: string): string {
  return `${shown} is a per-runtime build keryx no longer ships (that runtime now reads SKILL.md), and a runtime export would still prefer it over SKILL.md`;
}

function unsweptDirPrefix(shown: string): string {
  return `${shown} was not swept for per-runtime builds keryx no longer ships`;
}

function unsweepableDirCause(
  outcome: Extract<StaleRuntimeBuildOutcome, { action: "skipped-dir" }>,
  projectRoot: string,
): string {
  // `blockedAt` is the component that stopped the walk; it equals `path` today
  // for every case, but the wording stays correct if a future caller reports a
  // skill directory blocked by an ancestor.
  const subject = outcome.blockedAt === outcome.path ? "it is" : `${displayPath(outcome.blockedAt, projectRoot)} is`;
  switch (outcome.reason) {
    case "symlink":
      return `${subject} a symlink, and keryx will not delete through one`;
    case "not-a-directory":
      return `${subject} not a directory`;
    case "outside-skills-root":
      return "it does not resolve to a location inside the installed skills tree";
    default: {
      const exhaustive: never = outcome.reason;
      throw new Error(`unhandled unsweepable directory reason: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function displayPath(target: string, projectRoot: string): string {
  return path.relative(projectRoot, target).split(path.sep).join("/");
}

/**
 * For each name `entries` tracks (`RETIRED_RULES` and `MOVED_RULES` by
 * default), decide what to do with whatever sits
 * at that path in the installed project — without ever letting a hostile or
 * merely unusual entry (a directory, symlink, FIFO, socket, device, huge
 * file, or permission-denied file) abort the rest of `installGdskills`.
 *
 * `.metaproject/rules/core` is git-tracked, so a project's repo — not just
 * the project's own edits — can plant any of these at a retired name (round-1
 * finding S-001). The rule this function follows: `lstat` first and never
 * follow a symlink or read anything that is not a plain regular file; cap
 * the size of what it will read; and let no single entry's failure escape
 * this loop — every failure becomes a warning instead.
 */
export async function removeUnmodifiedRetiredRules(
  rulesTarget: string,
  // Injectable so the unlink-failure branch can be tested on every platform:
  // a read-only directory is not a portable way to make only this unlink fail,
  // because on Linux Bun's `cp({ force: true })` unlinks every destination
  // first and aborts the bulk copy before this function runs.
  fsOps: { unlink: (target: string) => Promise<void> } = { unlink },
  // Injectable so a move can be proven with fixture entries independent of
  // what `MOVED_RULES` holds.
  entries: readonly RetiredRuleEntry[] = CORE_CLEANUP_ENTRIES,
  // Whether this keryx bundle ships a moved rule's new path at all. Lets a
  // kept old copy say "the package is incomplete" instead of blaming a layer
  // directory that is fine. Unset means "shipped".
  isDestinationShipped: (movedTo: string) => boolean = () => true,
  // Whether this project's detected stack selects the moved rule's new path.
  // Unset means "required". A rule moved to a pack the stack does not select
  // (ADR-0001 P4) keeps its unmodified old copy until the pack is installed:
  // detection reads the repository root only, so a monorepo or an app in a
  // subfolder can miss a stack the project uses (review M1).
  isDestinationRequired: (movedTo: string) => boolean = () => true,
  // Whether a not-required pack move is plainly irrelevant here (no stack of
  // that family anywhere a miss could hide): its unmodified copy is removed
  // instead of kept and reported on every update (review RT2-3).
  isObsolete: (movedTo: string) => boolean = () => false,
): Promise<RetiredRuleOutcome[]> {
  const outcomes: RetiredRuleOutcome[] = [];
  for (const retired of entries) {
    const installedPath = path.join(rulesTarget, retired.fileName);
    const subject = retired.movedTo === undefined
      ? { fileName: retired.fileName }
      : { fileName: retired.fileName, movedTo: retired.movedTo };
    // Updated right before each step so the catch block below can name
    // which one actually failed (round-2 finding L-008).
    let stage: RetiredRuleFailureStage = "lstat";
    try {
      const stats = await lstat(installedPath);

      // Symlinks, directories, FIFOs, sockets, and devices are all rejected
      // here. `lstat` never follows a symlink, so a link at a retired name
      // is judged (and, if kept, left alone) without ever touching its
      // target — reading through it is the hazard, not the link itself.
      if (!stats.isFile()) {
        outcomes.push({ ...subject, action: "kept-not-regular-file" });
        continue;
      }

      // Bound the read before doing it: a regular file far larger than
      // anything keryx ever shipped under this name is not a plausible
      // untouched leftover, so there is no reason to read all of it.
      if (stats.size > retiredRuleSizeCapBytes(retired)) {
        outcomes.push({ ...subject, action: "kept-oversized", sizeBytes: stats.size });
        continue;
      }

      stage = "read";
      const content = await readFile(installedPath);
      const hash = createHash("sha256").update(normalizeRetiredRuleContent(content)).digest("hex");
      if (retired.shippedSha256.includes(hash)) {
        // A move removes the old copy only once the new one is really there:
        // otherwise the rule would exist nowhere (ADR-0001 P2 review F-001).
        // An installed destination is enough, selected or not: a pack added
        // with `keryx skills install --with` counts.
        if (retired.movedTo !== undefined) {
          const destination = await installedLayerFileState(path.dirname(rulesTarget), retired.movedTo);
          const pack = movedToPackId(retired.movedTo);
          const required = pack === undefined || isDestinationRequired(retired.movedTo);
          if (destination !== "installed" && required) {
            const cause = isDestinationShipped(retired.movedTo) ? destination : "not-shipped";
            outcomes.push({ ...subject, action: "kept-destination-missing", cause });
            continue;
          }
          if (destination !== "installed" && pack !== undefined && !isObsolete(retired.movedTo)) {
            outcomes.push({ ...subject, action: "kept-pack-not-selected", pack });
            continue;
          }
          // Installed, or an obsolete pack move: removed like any unmodified copy.
        }
        const unused = retired.movedTo !== undefined && movedToPackId(retired.movedTo) !== undefined
          && await installedLayerFileState(path.dirname(rulesTarget), retired.movedTo) !== "installed";
        stage = "unlink";
        await fsOps.unlink(installedPath);
        outcomes.push(unused ? { ...subject, action: "removed", unused: true } : { ...subject, action: "removed" });
      } else {
        outcomes.push({ ...subject, action: "kept-modified" });
      }
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        // Nothing at this retired name — the steady state once every
        // installation has caught up. Not an outcome, not a warning.
        continue;
      }
      // Anything else (EACCES on an unreadable file, a read-only
      // directory blocking the unlink of a confirmed-unmodified copy, a
      // race where the entry disappears between lstat and
      // readFile/unlink, etc.): keep the file, warn, and move on to the
      // next retired name. Cleanup of one entry must never abort the rest
      // of installGdskills. `stage` records which step was in flight, so
      // the warning below can tell a read failure (the file's status is
      // still unknown) apart from an unlink failure (the file was already
      // confirmed as an unmodified shipped copy — only its removal failed).
      outcomes.push({
        ...subject,
        action: "kept-error",
        stage,
        errorCode: isErrnoException(error) && error.code ? error.code : "UNKNOWN",
      });
    }
  }
  return outcomes;
}

/**
 * Whether `<rulesRoot>/<layer>/<name>` is a regular file inside a layer that is
 * a plain directory. `lstat` throughout: a symlinked layer or file is not one
 * keryx installed, and a missing one is not there at all.
 */
async function installedLayerFileState(
  rulesRoot: string,
  layerRelative: string,
): Promise<"installed" | Exclude<MovedDestinationCause, "not-shipped">> {
  const layerDir = path.join(rulesRoot, path.dirname(layerRelative));
  try {
    if (!(await lstat(layerDir)).isDirectory()) return "layer-unusable";
  } catch {
    return "layer-unusable";
  }
  try {
    return (await lstat(path.join(rulesRoot, layerRelative))).isFile() ? "installed" : "missing";
  } catch {
    return "missing";
  }
}

/**
 * What one `MOVED_RULES` entry's project override — a project's own version at
 * `rules/project/core/<fileName>` — became when the rule moved. After the move
 * every reference resolves through `rules/project/<movedTo>`
 * (`canonicalRuleReference`), so an override left under `core/` is read by
 * nothing; it is moved to the new slot, or kept and reported, never dropped.
 */
export type ProjectOverrideOutcome = { fileName: string; movedTo: string } & (
  | { action: "moved" }
  /** Both the old and the new slot hold a file; the old one is no longer read. */
  | { action: "kept-both" }
  | { action: "kept-not-regular-file" }
  | { action: "kept-error"; errorCode: string }
);

/**
 * Move each moved rule's project override from `rules/project/core/` to
 * `rules/project/<layer>/`. `lstat` first and never through a symlink: a
 * `rules/project` or `rules/project/core` that is not a plain directory is left
 * alone, and so is any entry that is not a regular file. One entry's failure
 * never stops the rest.
 */
export async function migrateMovedRuleOverrides(
  rulesRoot: string,
  entries: readonly RetiredRuleEntry[] = MOVED_RULES,
): Promise<ProjectOverrideOutcome[]> {
  const projectDir = path.join(rulesRoot, "project");
  const oldDir = path.join(projectDir, "core");
  // Every directory on the way, `rules/` included, must be a real one: a
  // symlinked `.metaproject/rules` would send the mkdir and rename outside
  // the project, where the layer installs already refused to write (LS-4).
  for (const dir of [rulesRoot, projectDir, oldDir]) {
    if (!(await isPlainDirectory(dir))) return [];
  }
  const outcomes: ProjectOverrideOutcome[] = [];
  for (const entry of entries) {
    if (entry.movedTo === undefined) continue;
    const subject = { fileName: entry.fileName, movedTo: entry.movedTo };
    const oldPath = path.join(oldDir, entry.fileName);
    const newPath = path.join(projectDir, entry.movedTo);
    try {
      const stats = await lstatOrNull(oldPath);
      if (stats === null) continue;
      if (!stats.isFile()) {
        outcomes.push({ ...subject, action: "kept-not-regular-file" });
        continue;
      }
      // One level at a time, never recursive: `projectDir` was just confirmed a
      // plain directory, and each level below it (`process/`, or `stacks/` then
      // `<pack>/` for a pack move) is created only where nothing is, and must be
      // a plain directory where something is — never followed through a link.
      let blocked = false;
      let dir = projectDir;
      for (const segment of path.posix.dirname(entry.movedTo).split("/")) {
        dir = path.join(dir, segment);
        const stats = await lstatOrNull(dir);
        if (stats === null) {
          await mkdir(dir);
        } else if (!stats.isDirectory()) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        outcomes.push({ ...subject, action: "kept-error", errorCode: "ENOTDIR" });
        continue;
      }
      if ((await lstatOrNull(newPath)) !== null) {
        outcomes.push({ ...subject, action: "kept-both" });
        continue;
      }
      await rename(oldPath, newPath);
      outcomes.push({ ...subject, action: "moved" });
    } catch (error) {
      outcomes.push({ ...subject, action: "kept-error", errorCode: isErrnoException(error) && error.code ? error.code : "UNKNOWN" });
    }
  }
  return outcomes;
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function isPlainDirectory(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** A notice for an override that was moved, a warning for one that was kept. */
export function movedRuleOverrideMessage(outcome: ProjectOverrideOutcome): { kind: "notice" | "warning"; text: string } {
  const oldSlot = `rules/project/core/${outcome.fileName}`;
  const newSlot = `rules/project/${outcome.movedTo}`;
  const lead = `${oldSlot} is this project's version of a rule keryx moved to rules/${outcome.movedTo}`;
  switch (outcome.action) {
    case "moved":
      return { kind: "notice", text: `${lead}; moved it to ${newSlot}, where it is read now` };
    case "kept-both":
      return {
        kind: "warning",
        text: `${lead}, and ${newSlot} already exists; nothing reads the copy under core/ any more — merge it into ${newSlot}, then delete it`,
      };
    case "kept-not-regular-file":
      return {
        kind: "warning",
        text: `${lead}, but it is not a regular file, so keryx left it alone and nothing reads it — replace it with a file at ${newSlot}`,
      };
    case "kept-error":
      return {
        kind: "warning",
        text: `${lead}; it could not be moved to ${newSlot} (${outcome.errorCode}), so nothing reads it — move it by hand`,
      };
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled override outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Decode as UTF-8, strip one leading U+FEFF byte-order mark, and normalise
 * `\r\n` to `\n` before hashing. `RETIRED_RULES[].shippedSha256` records
 * hashes of content normalised this same way (the files themselves are
 * shipped LF, BOM-less) — without this, an unmodified copy checked out with
 * CRLF line endings (e.g. Windows `core.autocrlf=true`) or carrying a BOM
 * would never match and would be kept + warned as "modified" forever
 * (round-1 finding L-001).
 *
 * Exported so `install.test.ts` can hash fixtures the same way the
 * installer does, instead of maintaining its own copy of this function
 * that could silently drift from it (round-2 finding T-008).
 */
export function normalizeRetiredRuleContent(content: Buffer): string {
  let text = content.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text.replace(/\r\n/g, "\n");
}

/**
 * Human-readable notice for one retired-rule outcome, or `null` for
 * "removed" (nothing to tell the operator). Each kept-* case gets its own
 * wording naming why the file is no longer shipped (`RETIRED_RULES[].reason`)
 * and what to do about it, rather than one generic "modified" message that
 * repeats forever with no remedy (round-1 finding L-002).
 */
export function retiredRuleWarning(
  outcome: RetiredRuleOutcome,
  entries: readonly RetiredRuleEntry[] = CORE_CLEANUP_ENTRIES,
): string | null {
  if (outcome.action === "removed") {
    return null;
  }
  const reason = entries.find((retired) => retired.fileName === outcome.fileName)?.reason
    ?? "no longer shipped by keryx";
  const prefix = outcome.movedTo === undefined
    ? `${outcome.fileName} is no longer shipped by keryx (${reason})`
    : `rules/core/${outcome.fileName} moved to rules/${outcome.movedTo} (${reason})`;
  switch (outcome.action) {
    case "kept-modified": {
      if (outcome.movedTo === undefined) {
        return `${prefix}; kept because it differs from every shipped version — delete it, or rename it if you still rely on it`;
      }
      const pack = movedToPackId(outcome.movedTo);
      // rules/project/stacks/<pack>/ replaces the pack's copy only where the
      // pack is installed, so name how to install it (review LS-5).
      const packNote = pack === undefined
        ? ""
        : ` (read in place of the ${pack} pack's copy once that pack is installed: it installs where the ${pack} `
          + `stack is detected, or run \`${stackPackInstallCommand(pack)}\`)`;
      return `${prefix}; the old copy was kept because it differs from every shipped version, and keryx no longer updates `
        + `it or points its own skills at it — carry your edits into rules/project/${outcome.movedTo}${packNote}, then delete `
        + `rules/core/${outcome.fileName}`;
    }
    case "kept-pack-not-selected":
      return `${prefix}; the old copy was kept because this project's stack was not detected as ${outcome.pack} `
        + `(detection reads the repository root only, so a workspace monorepo or an app in a subfolder can be missed) — `
        + `if the project uses ${outcome.pack}, run \`${stackPackInstallCommand(outcome.pack)}\` and keryx removes the old `
        + `copy on the next \`keryx update\`; if it does not, delete rules/core/${outcome.fileName}`;
    case "kept-destination-missing": {
      const movedTo = outcome.movedTo ?? outcome.fileName;
      const layer = path.posix.dirname(movedTo);
      switch (outcome.cause) {
        case "not-shipped":
          return `${prefix}; the old copy was kept because this keryx installation does not ship rules/${movedTo} `
            + `— the package is incomplete; reinstall keryx, then run \`keryx update\``;
        case "layer-unusable":
          return `${prefix}; the old copy was kept because rules/${layer}/ is not a plain directory — if it is a `
            + `symlink or a file, replace it with a real directory and re-run; keryx removes the old copy once `
            + `rules/${movedTo} is in place`;
        case "missing":
          return `${prefix}; the old copy was kept because rules/${movedTo} was not installed — re-run \`keryx update\`; `
            + `keryx removes the old copy once the new path is in place`;
        default: {
          const exhaustive: never = outcome.cause;
          throw new Error(`unhandled destination cause: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
    case "kept-not-regular-file":
      return `${prefix}; kept because it is not a regular file (a symlink, directory, or similar) — keryx will not read or remove it; delete or rename it yourself if appropriate`;
    case "kept-oversized":
      return `${prefix}; kept because it is ${outcome.sizeBytes} bytes, far larger than any version keryx ever shipped under this name — inspect it, then delete or rename it if appropriate`;
    case "kept-error":
      // `lstat`/`read` failures leave the file's status unconfirmed, so
      // they keep the original "could not be read" wording. An `unlink`
      // failure means the file *was* read and hash-matched an unmodified
      // shipped copy — only the removal failed — so it gets its own
      // wording rather than the misleading "could not be read"
      // (round-2 finding L-008).
      return outcome.stage === "unlink"
        ? `${prefix}; matches a shipped version but could not be removed (${outcome.errorCode}) — delete it by hand`
        : `${prefix}; kept because it could not be read (${outcome.errorCode}) — inspect it, then delete or rename it if appropriate`;
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled retired rule outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * One warning for every unmodified core copy kept because its pack is not
 * installed (review RT2-3: one line per copy on every update was noise), or
 * `null` when there is none.
 */
export function keptPackCopiesWarning(outcomes: readonly RetiredRuleOutcome[]): string | null {
  const kept = outcomes.filter((outcome): outcome is RetiredRuleOutcome & { action: "kept-pack-not-selected"; pack: string } =>
    outcome.action === "kept-pack-not-selected");
  if (kept.length === 0) return null;
  const files = kept.map((outcome) => `${outcome.fileName} (${outcome.pack})`).join(", ");
  const packs = [...new Set(kept.map((outcome) => outcome.pack))].sort();
  const commands = packs.map((pack) => `${pack}: \`${stackPackInstallCommand(pack)}\``).join("; ");
  return `rules/core/ keeps ${kept.length} rule${kept.length === 1 ? "" : "s"} keryx moved into stack packs this project's stack `
    + `was not detected as — ${files} (detection reads the repository root only, so an app in a subfolder can be missed). `
    + `If the project uses one of these stacks, install its pack and the next \`keryx update\` removes the old copy (${commands}); `
    + `if it does not, delete the copy`;
}

/**
 * Informational line for a moved rule whose stale `core/` copy was removed,
 * or `null` for every other outcome. A plain retirement stays silent as it
 * always has; a move is reported because a path the operator may know
 * changed under them.
 */
export function movedRuleNotice(outcome: RetiredRuleOutcome): string | null {
  if (outcome.action !== "removed" || outcome.movedTo === undefined) {
    return null;
  }
  const pack = movedToPackId(outcome.movedTo);
  if (outcome.unused === true && pack !== undefined) {
    return `rules/core/${outcome.fileName} is keryx's ${pack} rule, now shipped in the ${pack} stack pack; this project has no `
      + `${pack} or other JavaScript stack, so the pack is not installed and the unmodified old copy was removed — `
      + `update any citation of rules/core/${outcome.fileName} in your own files (CLAUDE.md, AGENTS.md, project skills, wiki)`;
  }
  const where = pack === undefined
    ? `rules/${outcome.movedTo}`
    : `rules/${outcome.movedTo} (the ${pack} stack pack, installed where that stack is detected)`;
  return `rules/core/${outcome.fileName} moved to ${where}; removed the unmodified old copy — `
    + `update any citation of rules/core/${outcome.fileName} in your own files (CLAUDE.md, AGENTS.md, project skills, wiki)`;
}
