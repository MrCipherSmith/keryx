// Project identity (W3 spec, "Scope & project identity"): a sha256 hash of
// the normalized git remote URL, falling back to a sha256 of the resolved
// worktree root path when there is no remote (or not a git repo at all).
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { ProjectIdentity } from "./types";

const GIT_SPAWN_TIMEOUT_MS = 2000;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Normalize a git remote URL so the same conceptual remote hashes the same
 * way regardless of protocol decoration: trim, lowercase, strip the scheme
 * (`https://`, `ssh://`, ...) entirely, strip embedded credentials
 * (`user:pass@`/`user@`), rewrite the scp-style `user@host:owner/repo` form's
 * `:` separator to `/` (so it lands on the same `host/owner/repo` shape as
 * its `ssh://` equivalent), strip a `:22` (the ssh default port, and the one
 * `ssh://` spells out where scp-style never does) immediately after the
 * host, strip the query string and fragment, strip trailing slashes, strip a
 * trailing `.git`.
 *
 * R1-F6: an earlier version of this function kept the scheme (so
 * `https://host/owner/repo` and `ssh://host/owner/repo` normalized to two
 * different strings) and kept the scp-style `:` separator (so
 * `git@host:owner/repo` differed from both). Three spellings of the exact
 * same remote then hashed to three different `project.identity` values —
 * each one only a single git remote away from the promotion rule's ">= 2
 * distinct project identities" threshold, since a project that happens to
 * carry two different remote spellings (e.g. `origin` over `https`,
 * `upstream` over `ssh`) would silently look like two different projects.
 * Every one of `https://host/owner/repo(.git)?`, `git@host:owner/repo(.git)?`,
 * `ssh://git@host/owner/repo(.git)?` and `ssh://git@host:22/owner/repo` now
 * normalizes to the identical `host/owner/repo`.
 *
 * This is intentionally lossy (case, scheme, scp-vs-ssh form, the ssh default
 * port) — the goal is a stable hash for "the same remote", not a
 * byte-preserving canonical URL. A non-default port is kept: it genuinely
 * reaches a different endpoint, not just a different spelling of the same one.
 */
export function normalizeRemoteUrl(url: string): string {
  let value = url.trim().toLowerCase();

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(value);
  if (hasScheme) {
    // Strip the scheme entirely — https/ssh/git are decoration, not identity.
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    // user:pass@host/... or user@host/... -> host/...
    value = value.replace(/^[^@/]+@/, "");
  } else {
    // scp-style: user@host:owner/repo(.git)? -> host/owner/repo(.git)?
    // (also accepts a bare host:owner/repo with no user@, for symmetry).
    const scpMatch = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(value);
    if (scpMatch) {
      value = `${scpMatch[1]}/${scpMatch[2]}`;
    }
  }

  // The ssh default port, spelled out only by the `ssh://` form — strip it so
  // it agrees with the scp-style/https forms, which never carry a port here.
  value = value.replace(/^([^/:]+):22(?=\/|$)/, "$1");

  // Strip fragment and query string.
  value = value.split("#")[0]!.split("?")[0]!;
  // Strip trailing slash(es), then a trailing `.git`.
  value = value.replace(/\/+$/, "");
  value = value.replace(/\.git$/, "");

  return value;
}

/** Best-effort repo/dir basename for review UIs only — never used for identity. */
function displayNameFromNormalizedRemote(normalized: string): string | undefined {
  const parts = normalized.split(/[/:]/).filter((part) => part.length > 0);
  const last = parts[parts.length - 1];
  return last !== undefined && last.length > 0 ? last : undefined;
}

function tryGitRemoteGetUrl(root: string, name: string): string | null {
  try {
    const result = spawnSync("git", ["-C", root, "remote", "get-url", name], {
      timeout: GIT_SPAWN_TIMEOUT_MS,
      encoding: "utf8",
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      const url = result.stdout.trim();
      return url.length > 0 ? url : null;
    }
    return null;
  } catch {
    return null;
  }
}

function tryGitRemoteList(root: string): string[] {
  try {
    const result = spawnSync("git", ["-C", root, "remote"], {
      timeout: GIT_SPAWN_TIMEOUT_MS,
      encoding: "utf8",
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
    return [];
  } catch {
    return [];
  }
}

/** Default remote resolver: `origin`, else the first remote in `git remote`'s listing order. Never throws — git absence reads as "no remote". */
function defaultGitRemoteUrl(root: string): string | null {
  const origin = tryGitRemoteGetUrl(root, "origin");
  if (origin !== null) return origin;
  const [first] = tryGitRemoteList(root);
  return first === undefined ? null : tryGitRemoteGetUrl(root, first);
}

function defaultRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

export interface ResolveProjectIdentityDeps {
  /** Injectable git-remote lookup; returns the remote URL to hash, or null when there is none. Defaults to `origin`, else the first `git remote`. */
  gitRemoteUrl?: (root: string) => string | null;
  /** Injectable realpath resolver for the path-hash fallback. */
  realpath?: (p: string) => string;
}

/**
 * `project.identity` + `identityKind` for `root`: a sha256 of the normalized
 * remote URL when one exists (`identityKind: "remote-hash"`), else a sha256 of
 * the resolved, absolute worktree root path (`identityKind: "path-hash"`).
 * Never throws — a missing `git` binary or a non-repo directory both fall
 * through to the path-hash case.
 */
export function resolveProjectIdentity(root: string, deps: ResolveProjectIdentityDeps = {}): ProjectIdentity {
  const gitRemoteUrl = deps.gitRemoteUrl ?? defaultGitRemoteUrl;
  const realpath = deps.realpath ?? defaultRealpath;

  const remoteUrl = gitRemoteUrl(root);
  if (remoteUrl !== null && remoteUrl.length > 0) {
    const normalized = normalizeRemoteUrl(remoteUrl);
    const displayName = displayNameFromNormalizedRemote(normalized);
    return {
      identity: sha256Hex(normalized),
      identityKind: "remote-hash",
      ...(displayName !== undefined ? { displayName } : {}),
    };
  }

  const resolvedRoot = realpath(root);
  return {
    identity: sha256Hex(resolvedRoot),
    identityKind: "path-hash",
    displayName: path.basename(resolvedRoot),
  };
}
