// Flow 313 (W4 portability), T6 — scope roots and the per-kind/scope allowed
// bundle-path shapes, per W4-portability.md "Scopes" and "Portable bundle
// format", and plan.md "Scope roots".
//
// A bundle entry's `path` is POSIX-relative to its SCOPE root (not the bundle
// root's own on-disk layout note in the schema, which is the same thing
// worded from the export side): `skills/<name>/SKILL.md` for a user-scope
// skill mirrors `~/.keryx/skills/<name>/SKILL.md` directly, so `apply` is a
// plain copy rather than a kind-specific rewrite.

import { lstat } from "node:fs/promises";
import path from "node:path";

import { resolveContainedPath } from "../lib/contained-path";
import { userStoreRoot } from "../lib/keryx-home";
import { MEMORY_TYPES } from "../memory/types";
import { BUNDLE_REFUSAL, type BundleContentKind, type BundleRefusal, type BundleScope } from "./types";

const MEMORY_FOLDERS = new Set(MEMORY_TYPES.map((entry) => entry.folder));

export interface PathCtx {
  projectRoot: string;
  env?: NodeJS.ProcessEnv | undefined;
  homeDir?: string | undefined;
}

/** Root directory a scope resolves to. `team` shares `project`'s tree (a labeling discipline, not a separate root). */
export function scopeRoot(scope: BundleScope, ctx: PathCtx): string {
  if (scope === "user") {
    return userStoreRoot(ctx.env ?? process.env, ctx.homeDir);
  }
  return path.join(ctx.projectRoot, ".metaproject");
}

export type NormalizeResult = { ok: true; path: string } | { ok: false; refusal: BundleRefusal };

// Control characters (incl. CR, LF, TAB, DEL and the Unicode line/paragraph
// separators) and the specific characters/sequences that can forge a
// managed-block marker (`<!-- keryx:... -->`) when a bundle-supplied path is
// interpolated into rendered output (R1-F7). Refused everywhere a bundle path
// is normalized, not only for rule paths, since any kind's path can end up
// rendered (display ids, ledger keys, error messages).
// eslint-disable-next-line no-control-regex -- matching control characters is the point (R1-F7)
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f\u2028\u2029]/;
const MARKER_FORGING_RE = /[<>`]|<!--|-->/;

/**
 * Normalize a bundle-relative path: POSIX separators only, no absolute path,
 * no backslash, no NUL byte, no control character, no marker-forging
 * character/sequence, no empty/`.`/`..` segment, no trailing slash.
 */
export function normalizeBundlePath(candidate: string): NormalizeResult {
  if (candidate.length === 0) {
    return { ok: false, refusal: { reason: BUNDLE_REFUSAL.pathEscape, message: "path is empty" } };
  }
  if (candidate.includes("\\")) {
    return { ok: false, refusal: { reason: BUNDLE_REFUSAL.pathEscape, path: candidate, message: "path must use POSIX separators, not backslashes" } };
  }
  if (candidate.includes("\0")) {
    return { ok: false, refusal: { reason: BUNDLE_REFUSAL.pathEscape, path: candidate, message: "path contains a NUL byte" } };
  }
  if (CONTROL_CHAR_RE.test(candidate)) {
    return { ok: false, refusal: { reason: BUNDLE_REFUSAL.pathEscape, path: candidate, message: "path contains a control character" } };
  }
  if (MARKER_FORGING_RE.test(candidate)) {
    return {
      ok: false,
      refusal: { reason: BUNDLE_REFUSAL.pathEscape, path: candidate, message: "path contains a character or sequence that could forge a managed-block marker (<, >, `, <!--, -->)" },
    };
  }
  if (candidate.startsWith("/")) {
    return { ok: false, refusal: { reason: BUNDLE_REFUSAL.pathEscape, path: candidate, message: "path must not be absolute" } };
  }
  if (candidate.endsWith("/")) {
    return { ok: false, refusal: { reason: BUNDLE_REFUSAL.pathEscape, path: candidate, message: "path must not have a trailing slash" } };
  }
  const segments = candidate.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return {
        ok: false,
        refusal: { reason: BUNDLE_REFUSAL.pathEscape, path: candidate, message: `path segment "${segment}" is not allowed` },
      };
    }
  }
  return { ok: true, path: segments.join("/") };
}

export type KindPathCheck = { ok: true } | { ok: false; refusal: BundleRefusal };

const AGENT_NAME_SEGMENT = /^[^/]+\.md$/;
const RULE_FILE = /\.(md|mdc)$/;

/**
 * Case-folded, NFC-normalized form of a path segment/prefix comparison, so a
 * reserved-path guard behaves identically on a case-insensitive filesystem
 * (macOS/Windows) and a case-sensitive one (Linux CI) — R1-F2. `normalize`
 * before `toLowerCase` so composed and decomposed Unicode forms of the same
 * reserved name also collide.
 */
function caseFold(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

const GLOBALLY_FORBIDDEN_EXACT = [caseFold("skills/external-imports.json"), caseFold("learning/index.json")];
const GLOBALLY_FORBIDDEN_PREFIXES = [
  caseFold("learning/observations/"),
  caseFold("data/learning/observations/"),
  caseFold("bundles/"),
  caseFold("data/bundles/"),
];

/**
 * Forbidden regardless of kind: paths reserved for other subsystems that a
 * bundle must never be able to target (the W3 evidence index/observations,
 * the bundle cache/ledger directories, or the external-imports registry
 * itself). Compared case-folded and NFC-normalized so a case-variant path
 * (`skills/External-Imports.json`) is caught even on a case-sensitive
 * filesystem, since APFS/exFAT treat it as the same file (R1-F2).
 */
function isGloballyForbidden(relPath: string): boolean {
  const folded = caseFold(relPath);
  if (GLOBALLY_FORBIDDEN_EXACT.includes(folded)) return true;
  return GLOBALLY_FORBIDDEN_PREFIXES.some((prefix) => folded.startsWith(prefix));
}

/** Does `relPath` (already normalized) match the allowed on-disk shape for `kind` at `scope`? */
export function validateKindPath(kind: BundleContentKind, scope: BundleScope, relPath: string): KindPathCheck {
  if (isGloballyForbidden(relPath)) {
    return {
      ok: false,
      refusal: { reason: BUNDLE_REFUSAL.pathNotValidForScope, path: relPath, message: `${relPath} is reserved and may never be a bundle target` },
    };
  }

  switch (kind) {
    case "skill": {
      // The reserved skills/external-imports.json path is refused by
      // isGloballyForbidden above (case-folded, every kind/scope).
      const underSkills = relPath.startsWith("skills/") && relPath.length > "skills/".length;
      const underProjectSkills = scope === "project" && relPath.startsWith("project-skills/") && relPath.length > "project-skills/".length;
      if (!underSkills && !underProjectSkills) return kindMismatch(kind, relPath);
      const basename = relPath.slice(relPath.lastIndexOf("/") + 1);
      // A non-canonical casing of SKILL.md (skill.md, Skill.MD, ...) is the
      // same file on a case-insensitive filesystem, so it must be refused
      // rather than silently evading the SKILL.md-only checks that key on
      // the exact basename elsewhere (audit-harness, agent-skills readers) —
      // R1-F8.
      if (caseFold(basename) === caseFold("SKILL.md") && basename !== "SKILL.md") {
        return {
          ok: false,
          refusal: { reason: BUNDLE_REFUSAL.kindPathMismatch, path: relPath, message: `${relPath}: SKILL.md must use canonical casing (got "${basename}")` },
        };
      }
      return { ok: true };
    }
    case "rule": {
      if (scope === "user") {
        return { ok: false, refusal: { reason: BUNDLE_REFUSAL.userScopeRuleRefused, path: relPath, message: "user scope has no rules root" } };
      }
      if (relPath.startsWith("rules/") && RULE_FILE.test(relPath)) return { ok: true };
      return kindMismatch(kind, relPath);
    }
    case "agent": {
      const rest = relPath.startsWith("agents/") ? relPath.slice("agents/".length) : "";
      if (relPath.startsWith("agents/") && AGENT_NAME_SEGMENT.test(rest) && !rest.includes("/")) {
        return { ok: true };
      }
      return kindMismatch(kind, relPath);
    }
    case "memory-entry": {
      const parts = relPath.split("/");
      if (parts.length === 3 && parts[0] === "memory" && MEMORY_FOLDERS.has(parts[1] as string) && (parts[2] as string).endsWith(".md")) {
        return { ok: true };
      }
      return kindMismatch(kind, relPath);
    }
    case "hook-config": {
      if (relPath === "hooks.json") return { ok: true };
      return kindMismatch(kind, relPath);
    }
    case "learned-pattern": {
      if (scope === "user") {
        if (/^learning\/patterns\/[^/]+\.json$/.test(relPath)) return { ok: true };
        return kindMismatch(kind, relPath);
      }
      // project / team
      if (/^data\/learning\/candidates\/[^/]+\.json$/.test(relPath)) return { ok: true };
      return kindMismatch(kind, relPath);
    }
    default: {
      const _exhaustive: never = kind;
      return kindMismatch(_exhaustive, relPath);
    }
  }
}

function kindMismatch(kind: string, relPath: string): { ok: false; refusal: BundleRefusal } {
  return {
    ok: false,
    refusal: { reason: BUNDLE_REFUSAL.kindPathMismatch, path: relPath, message: `${relPath} does not match the on-disk shape for kind "${kind}"` },
  };
}

export type TargetResult = { ok: true; absolutePath: string } | { ok: false; refusal: BundleRefusal };

/**
 * Resolve an entry's absolute on-disk target path for `targetScope`,
 * refusing anything that escapes the scope root or passes through/lands on a
 * symlink. Retargeting (entry.scope !== targetScope) is allowed only when the
 * same relative path is also valid for the target scope's kind rules; callers
 * that must never retarget (learned patterns) check that before calling this.
 */
export async function targetFor(
  entry: { path: string; kind: BundleContentKind; scope: BundleScope },
  targetScope: BundleScope,
  ctx: PathCtx,
): Promise<TargetResult> {
  const normalized = normalizeBundlePath(entry.path);
  if (!normalized.ok) return { ok: false, refusal: normalized.refusal };

  const kindCheck = validateKindPath(entry.kind, targetScope, normalized.path);
  if (!kindCheck.ok) return { ok: false, refusal: kindCheck.refusal };

  const root = scopeRoot(targetScope, ctx);
  const containment = await resolveContainedPathForWrite(root, normalized.path);
  if (!containment.ok) return containment;

  // Refuse when any existing ancestor in the scope root, or the target itself,
  // is a symlink — apply must never follow one out of the scope root.
  const symlinkCheck = await refuseSymlinkChain(root, normalized.path);
  if (!symlinkCheck.ok) return symlinkCheck;

  return { ok: true, absolutePath: containment.absolutePath };
}

/**
 * Like `resolveContainedPath`, but for a path that may not exist yet (apply
 * writes new files). Resolves lexically under `root` and checks containment
 * without requiring the target to already exist.
 */
async function resolveContainedPathForWrite(root: string, relPath: string): Promise<TargetResult> {
  const absolute = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  const relative = path.relative(rootResolved, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return {
      ok: false,
      refusal: { reason: BUNDLE_REFUSAL.pathEscape, path: relPath, message: `${relPath} resolves outside the scope root` },
    };
  }
  return { ok: true, absolutePath: absolute };
}

/**
 * Refuse when the scope root itself, any existing ancestor directory under
 * it, or the target itself is a symlink. Exported so `apply` can re-run this
 * exact check immediately before each write (R1-I1): the audit runs between
 * plan and apply, and a parent directory (or the scope root) swapped for a
 * symlink in that window must not be silently followed by `mkdir -p`/`rename`.
 */
export async function refuseSymlinkChain(root: string, relPath: string): Promise<{ ok: true } | { ok: false; refusal: BundleRefusal }> {
  const rootResolved = path.resolve(root);
  try {
    const rootStat = await lstat(rootResolved);
    if (rootStat.isSymbolicLink()) {
      return {
        ok: false,
        refusal: { reason: BUNDLE_REFUSAL.symlinkRefused, path: relPath, message: `${relPath}: the scope root itself is a symlink` },
      };
    }
  } catch {
    // scope root does not exist yet — fine, apply's mkdir -p will create it
  }
  const segments = relPath.split("/");
  let current = rootResolved;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        return {
          ok: false,
          refusal: { reason: BUNDLE_REFUSAL.symlinkRefused, path: relPath, message: `${relPath} passes through a symlink at ${segment}` },
        };
      }
    } catch {
      // does not exist yet — fine, nothing to refuse
    }
  }
  return { ok: true };
}

export { resolveContainedPath };
