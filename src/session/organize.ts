// How a person organises their sessions: archived, pinned, or moved to the trash.
//
// The flags live in `<sessionDir>/flags.json`, a file of their own: a live
// session rewrites `summary.json` from its in-memory copy on every save, so a
// flag kept there would be lost to the next turn of a session open elsewhere.
// Every client of the store (the desktop app over ACP, later `keryx shell`)
// reads the same file.

import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { sessionLeaseState } from "./lease";
import { sessionDir } from "./paths";
import { findSession, shortSessionId } from "./store";

export interface SessionFlags {
  /** ISO time the session was archived; absent when it is not. */
  archivedAt?: string;
  /** ISO time the session was pinned; absent when it is not. */
  pinnedAt?: string;
  /** The flow package (its directory name) this session works on; absent when none. */
  flow?: string;
}

export interface SessionFlagsChange {
  archived?: boolean;
  pinned?: boolean;
  /** A flow package directory name to link, or null to unlink. */
  flow?: string | null;
}

/** A flow package directory name as keryx writes them (`<id>-<date>-<slug>`): no path, no shell metacharacters. */
export const FLOW_REF = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

const FLAGS_FILE = "flags.json";

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** The flags of the session stored in `dir`; an absent or unreadable file reads as none. */
export function readSessionFlags(dir: string): SessionFlags {
  const read = readConfigFile(path.join(dir, FLAGS_FILE));
  if (!read.ok) return {};
  try {
    const raw = JSON.parse(read.text) as Record<string, unknown>;
    return {
      ...(isIso(raw["archivedAt"]) ? { archivedAt: raw["archivedAt"] } : {}),
      ...(isIso(raw["pinnedAt"]) ? { pinnedAt: raw["pinnedAt"] } : {}),
      ...(typeof raw["flow"] === "string" && FLOW_REF.test(raw["flow"]) ? { flow: raw["flow"] } : {}),
    };
  } catch {
    return {};
  }
}

function writeFlags(dir: string, flags: SessionFlags): void {
  writeOwnerOnlyFileAtomic(path.join(dir, FLAGS_FILE), `${JSON.stringify(flags, null, 2)}\n`);
}

/** The project root and directory of a stored session, by its exact id. */
function locate(cwd: string, sessionId: string, dataDir?: string): { projectPath: string; dir: string } {
  const summary = findSession(cwd, sessionId, dataDir);
  if (summary === undefined || summary.id !== sessionId) throw new Error(`no session ${sessionId} in this project`);
  return { projectPath: summary.projectPath, dir: sessionDir(summary.projectPath, sessionId, dataDir) };
}

/**
 * Archives or unarchives, pins or unpins a session. A flag already in the
 * asked state keeps its original time. Returns the flags as stored.
 */
export function setSessionFlags(
  cwd: string,
  sessionId: string,
  change: SessionFlagsChange,
  dataDir?: string,
  now: () => Date = () => new Date(),
): SessionFlags {
  const { dir } = locate(cwd, sessionId, dataDir);
  const current = readSessionFlags(dir);
  const stamp = now().toISOString();
  const next: SessionFlags = { ...current };
  if (change.archived === true) next.archivedAt ??= stamp;
  if (change.archived === false) delete next.archivedAt;
  if (change.pinned === true) next.pinnedAt ??= stamp;
  if (change.pinned === false) delete next.pinnedAt;
  if (typeof change.flow === "string") {
    if (!FLOW_REF.test(change.flow)) throw new Error(`not a flow package name: ${change.flow}`);
    next.flow = change.flow;
  }
  if (change.flow === null) delete next.flow;
  writeFlags(dir, next);
  return next;
}

export interface TrashOptions {
  dataDir?: string | undefined;
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** The folder deleted files go to, or undefined where keryx knows none. */
export function trashDirectory(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): { files: string; info?: string } | undefined {
  if (platform === "darwin") return { files: path.join(home, ".Trash") };
  if (platform === "linux") {
    const base = path.join(env["XDG_DATA_HOME"] || path.join(home, ".local", "share"), "Trash");
    return { files: path.join(base, "files"), info: path.join(base, "info") };
  }
  return undefined;
}

function freeName(dir: string, base: string): string {
  if (!existsSync(path.join(dir, base))) return base;
  for (let i = 2; ; i++) {
    const name = `${base} ${i}`;
    if (!existsSync(path.join(dir, name))) return name;
  }
}

/**
 * Moves a stored session to the trash (macOS `~/.Trash`, or the freedesktop
 * trash on Linux), so it can be restored from there until the trash is
 * emptied. Refused while another keryx process holds the session, and on a
 * platform with no trash keryx knows. Returns where the session went.
 */
export function trashSession(cwd: string, sessionId: string, options: TrashOptions = {}): string {
  const { projectPath, dir } = locate(cwd, sessionId, options.dataDir);
  const lease = sessionLeaseState(projectPath, sessionId, options.dataDir);
  if (lease.state !== "free" && lease.state !== "mine") {
    throw new Error(`session ${shortSessionId(sessionId)} is open in another keryx; close it there first`);
  }
  const trash = trashDirectory(options.platform ?? process.platform, options.home ?? homedir(), options.env ?? process.env);
  if (trash === undefined) throw new Error("this platform has no trash keryx can move a session to");
  mkdirSync(trash.files, { recursive: true });
  const name = freeName(trash.files, `keryx session ${shortSessionId(sessionId)}`);
  const target = path.join(trash.files, name);
  if (trash.info !== undefined) {
    mkdirSync(trash.info, { recursive: true });
    const deleted = (options.now ?? (() => new Date()))().toISOString().slice(0, 19);
    writeFileSync(path.join(trash.info, `${name}.trashinfo`), `[Trash Info]\nPath=${encodeURI(dir)}\nDeletionDate=${deleted}\n`);
  }
  try {
    try {
      renameSync(dir, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      cpSync(dir, target, { recursive: true });
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (error) {
    if (trash.info !== undefined) rmSync(path.join(trash.info, `${name}.trashinfo`), { force: true });
    throw error;
  }
  return target;
}
