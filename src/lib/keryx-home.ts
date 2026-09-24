// Flow 313 (W4) user scope `~/.keryx/` layout per
// docs/requirements/keryx-agent-platform-expansion/workstreams/W4-portability.md.
// `learning/` is owned by W3 (only paths are named here).
// This module never creates directories.

import os from "node:os";
import path from "node:path";

/**
 * Shared home-dir resolver for user-store paths — `KERYX_HOME` first,
 * an explicit `homeDir` override (e.g. from a test) wins over even that,
 * then the real `os.homedir()`.
 *
 * Exact same semantics as `resolveHookHomeDir` in `src/harness/hooks/config.ts`.
 */
export function resolveKeryxHomeDir(env: NodeJS.ProcessEnv, homeDir?: string): string {
  if (homeDir !== undefined) return homeDir;
  const fromEnv = env.KERYX_HOME;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : os.homedir();
}

export const USER_STORE_DIRNAME = ".keryx";

/**
 * Resolves the root of the user store, typically `~/.keryx`.
 * Never creates directories.
 */
export function userStoreRoot(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  const home = resolveKeryxHomeDir(env, homeDir);
  return path.join(home, USER_STORE_DIRNAME);
}

export interface UserStorePaths {
  root: string;
  skills: string;
  agents: string;
  memory: string;
  learning: string;
  learningPatterns: string;
  bundles: string;
  appliedState: string;
  hooksJson: string;
  externalSkillImports: string;
}

/**
 * Resolves all standard user-store paths under `~/.keryx`.
 * Never creates directories.
 */
export function userStorePaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): UserStorePaths {
  const root = userStoreRoot(env, homeDir);
  return {
    root,
    skills: path.join(root, "skills"),
    agents: path.join(root, "agents"),
    memory: path.join(root, "memory"),
    learning: path.join(root, "learning"),
    learningPatterns: path.join(root, "learning", "patterns"),
    bundles: path.join(root, "bundles"),
    appliedState: path.join(root, "bundles", "applied-state.json"),
    hooksJson: path.join(root, "hooks.json"),
    externalSkillImports: path.join(root, "skills", "external-imports.json"),
  };
}
