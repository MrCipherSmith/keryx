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

/**
 * Normalize a bundle-relative path: POSIX separators only, no absolute path,
 * no backslash, no NUL byte, no empty/`.`/`..` segment, no trailing slash.
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
 * Forbidden regardless of kind: paths reserved for other subsystems that a
 * bundle must never be able to target (the W3 evidence index/observations,
 * or the bundle cache/ledger directories themselves).
 */
function isGloballyForbidden(relPath: string): boolean {
  return (
    relPath === "learning/index.json" ||
    relPath.startsWith("learning/observations/") ||
    relPath.startsWith("data/learning/observations/") ||
    relPath.startsWith("bundles/") ||
    relPath.startsWith("data/bundles/")
  );
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
      if (scope === "user" && relPath === "skills/external-imports.json") {
        return {
          ok: false,
          refusal: { reason: BUNDLE_REFUSAL.pathNotValidForScope, path: relPath, message: "user-scope skills may never target skills/external-imports.json" },
        };
      }
      const underSkills = relPath.startsWith("skills/") && relPath.length > "skills/".length;
      const underProjectSkills = scope === "project" && relPath.startsWith("project-skills/") && relPath.length > "project-skills/".length;
      if (underSkills || underProjectSkills) return { ok: true };
      return kindMismatch(kind, relPath);
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

async function refuseSymlinkChain(root: string, relPath: string): Promise<{ ok: true } | { ok: false; refusal: BundleRefusal }> {
  const segments = relPath.split("/");
  let current = path.resolve(root);
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
