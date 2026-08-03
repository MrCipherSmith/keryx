// Paths for per-project interactive sessions (MVP).
//
// Layout:
//   <dataDir>/sessions/<project-key>/<session-id>/{summary.json,transcript.jsonl}
//
// dataDir defaults to the same XDG-style home as shell auth
// (`~/.local/share/keryx` on Unix). Project key is derived from the git root
// when available, else absolute cwd — sessions never cross projects.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Cross-platform keryx data root for SESSIONS.
 *
 * Not for `auth.json`, and the docstring that said so was wrong. The
 * user-global configuration files — `auth.json`, `projects.json`, `serve.json`,
 * `serve-credentials.json` — are resolved by `keryxConfigDir` in
 * `src/lib/config-dir.ts`, which applies the same platform rules but does NOT
 * honour `KERYX_DATA_DIR`. With that variable set the two diverge: `sessions/`
 * moves and those four files do not.
 *
 * The divergence is deliberate for now — teaching `keryxConfigDir` about
 * `KERYX_DATA_DIR` would relocate the `auth.json` of any existing install that
 * sets it, which is a migration rather than a cleanup. What is not acceptable is
 * a comment claiming the opposite of what the code does, so it is stated here.
 */
export function keryxDataDir(override?: string): string {
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const env = process.env.KERYX_DATA_DIR;
  if (env !== undefined && env.length > 0) {
    return env;
  }
  const home = homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    const base = appData !== undefined && appData.length > 0 ? appData : path.join(home, "AppData", "Roaming");
    return path.join(base, "keryx");
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : path.join(home, ".local", "share");
  return path.join(base, "keryx");
}

/**
 * Resolve the project root for session scoping: git toplevel if this cwd is
 * inside a work tree, otherwise the absolute cwd.
 */
export function resolveProjectRoot(cwd: string): string {
  const abs = path.resolve(cwd);
  // Walk up looking for .git (dir or file — worktrees use a gitfile).
  let dir = abs;
  for (;;) {
    const gitPath = path.join(dir, ".git");
    if (existsSync(gitPath)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return abs;
}

/**
 * Stable filesystem-safe key for a project path.
 * Prefer URL-encoding (readable); fall back to hash-style if too long.
 */
export function projectKeyFromPath(projectPath: string): string {
  const abs = path.resolve(projectPath);
  // Encode path separators and specials; keep alnum readable via encodeURIComponent.
  const encoded = encodeURIComponent(abs);
  if (encoded.length <= 200) {
    return encoded;
  }
  // Long paths: short slug + length + simple hash (no crypto dep required).
  const base = path.basename(abs).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40);
  let h = 0;
  for (let i = 0; i < abs.length; i++) {
    h = (Math.imul(31, h) + abs.charCodeAt(i)) | 0;
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `${base}_${abs.length}_${hex}`;
}

export function projectSessionsDir(projectPath: string, dataDir?: string): string {
  const key = projectKeyFromPath(resolveProjectRoot(projectPath));
  return path.join(keryxDataDir(dataDir), "sessions", key);
}

export function sessionDir(projectPath: string, sessionId: string, dataDir?: string): string {
  return path.join(projectSessionsDir(projectPath, dataDir), sessionId);
}
