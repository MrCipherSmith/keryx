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
import { withFileLock } from "../lib/file-lock";
import { sessionLeaseState } from "./lease";
import { sessionDir } from "./paths";
import { findSession, shortSessionId } from "./store";

export interface SessionFlags {
  /** Derived from the private link marker, without exposing its issue or owner. */
  hasIssue?: true;
  /** ISO time the session was archived; absent when it is not. */
  archivedAt?: string;
  /** ISO time the session was pinned; absent when it is not. */
  pinnedAt?: string;
  /** The flow package (its directory name) this session works on; absent when none. */
  flow?: string;
  /** The GitHub pull request or issue this session works on; absent when none. */
  subject?: SessionSubject;
}

/** A GitHub pull request or issue a session is bound to. `url` is its github.com page and agrees with `kind`, `repo` and `number`. */
export interface SessionSubject {
  kind: "pr" | "issue";
  /** `owner/name`, as GitHub spells it. */
  repo: string;
  number: number;
  url: string;
  /** GitHub's node id of the repository, when the binder knows it. */
  repositoryId?: string;
}

export interface SessionFlagsChange {
  archived?: boolean;
  pinned?: boolean;
  /** A flow package directory name to link, or null to unlink. */
  flow?: string | null;
  /** A subject to bind, or null to unbind. Refused unless it passes `parseSessionSubject`. */
  subject?: SessionSubject | null;
}

/** A flow package directory name as keryx writes them (`<id>-<date>-<slug>`): no path, no shell metacharacters. */
export const FLOW_REF = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

/** GitHub's owner (login) and repository-name charsets; `.` and `..` are not names. */
const REPO_REF = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/(?!\.\.?$)([A-Za-z0-9._-]{1,100})$/;
const SUBJECT_URL = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/(pull|issues)\/([1-9][0-9]{0,9})$/;
const NODE_ID = /^[A-Za-z0-9_=-]{1,200}$/;
const URL_KIND = { pull: "pr", issues: "issue" } as const;

const FLAGS_FILE = "flags.json";

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * A subject from untrusted JSON, or undefined when it is not one: kind `pr` or
 * `issue`, `owner/name` repo, positive integer number, and a
 * `https://github.com/<repo>/pull|issues/<number>` url that agrees with all
 * three (the repo compared without case, as GitHub does).
 */
export function parseSessionSubject(value: unknown): SessionSubject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const { kind, repo, number, url, repositoryId } = raw;
  if (kind !== "pr" && kind !== "issue") return undefined;
  if (typeof repo !== "string" || !REPO_REF.test(repo)) return undefined;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return undefined;
  if (typeof url !== "string") return undefined;
  const match = SUBJECT_URL.exec(url);
  if (match === null) return undefined;
  const [, urlRepo = "", urlKind = "", urlNumber = ""] = match;
  if (URL_KIND[urlKind as keyof typeof URL_KIND] !== kind || urlRepo.toLowerCase() !== repo.toLowerCase() || Number(urlNumber) !== number) return undefined;
  if (repositoryId !== undefined && (typeof repositoryId !== "string" || !NODE_ID.test(repositoryId))) return undefined;
  return { kind, repo, number, url, ...(repositoryId !== undefined ? { repositoryId } : {}) };
}

/**
 * flags.json as stored: the public flags, plus whether the person unlinked the
 * subject (`subjectUnlinked`), which only the store reads. The marker lets a
 * binder backfill a missing subject without writing back one the person removed.
 */
interface StoredFlags {
  flags: SessionFlags;
  subjectUnlinked: boolean;
}

function readStoredFlags(dir: string): StoredFlags {
  const origin: SessionFlags = existsSync(path.join(dir, "issue-link.json")) ? { hasIssue: true } : {};
  const read = readConfigFile(path.join(dir, FLAGS_FILE));
  if (!read.ok) return { flags: origin, subjectUnlinked: false };
  try {
    const raw = JSON.parse(read.text) as Record<string, unknown>;
    const subject = parseSessionSubject(raw["subject"]);
    const flags: SessionFlags = {
      ...origin,
      ...(isIso(raw["archivedAt"]) ? { archivedAt: raw["archivedAt"] } : {}),
      ...(isIso(raw["pinnedAt"]) ? { pinnedAt: raw["pinnedAt"] } : {}),
      ...(typeof raw["flow"] === "string" && FLOW_REF.test(raw["flow"]) ? { flow: raw["flow"] } : {}),
      ...(subject !== undefined ? { subject } : {}),
    };
    return { flags, subjectUnlinked: subject === undefined && raw["subjectUnlinked"] === true };
  } catch {
    return { flags: origin, subjectUnlinked: false };
  }
}

/** The flags of the session stored in `dir`; an absent or unreadable file reads as none, an invalid subject as absent. */
export function readSessionFlags(dir: string): SessionFlags {
  return readStoredFlags(dir).flags;
}

function writeFlags(dir: string, { flags, subjectUnlinked }: StoredFlags): void {
  const stored = { archivedAt: flags.archivedAt, pinnedAt: flags.pinnedAt, flow: flags.flow, subject: flags.subject,
    ...(subjectUnlinked && flags.subject === undefined ? { subjectUnlinked: true } : {}) };
  writeOwnerOnlyFileAtomic(path.join(dir, FLAGS_FILE), `${JSON.stringify(stored, null, 2)}\n`);
}

/** How long a flags writer waits for another, and when a lock is taken as abandoned (the critical section is one small file). */
const FLAGS_LOCK_TIMEOUT_MS = 3_000;
const FLAGS_LOCK_STALE_MS = 2_000;

/**
 * Runs a read-modify-write of flags.json holding `<dir>/flags.json.lock`, so
 * that writers in other keryx processes (one ACP server per Desktop window, the
 * issue-workspace child) cannot lose each other's change. Synchronous: callers
 * are synchronous, and the section is one read and one atomic write.
 */
function withFlagsLock<T>(dir: string, apply: () => T): T {
  const held = withFileLock(path.join(dir, `${FLAGS_FILE}.lock`), () => ({ value: apply() }), {
    timeoutMs: FLAGS_LOCK_TIMEOUT_MS,
    staleMs: FLAGS_LOCK_STALE_MS,
  });
  if (held === null) throw new Error(`the flags of session ${path.basename(dir)} are locked by another keryx process; retry`);
  return held.value;
}

/**
 * Writes `subject` as the session's subject when it has none and the person
 * has not unlinked one. Returns whether it wrote. For a binder that learns the
 * subject after the session was bound (a binding made before subjects existed).
 */
export function backfillSessionSubject(dir: string, subject: SessionSubject): boolean {
  const parsed = parseSessionSubject(subject);
  if (parsed === undefined) throw new Error(`not a GitHub subject: ${JSON.stringify(subject).slice(0, 300)}`);
  return withFlagsLock(dir, () => {
    const current = readStoredFlags(dir);
    if (current.flags.subject !== undefined || current.subjectUnlinked) return false;
    writeFlags(dir, { flags: { ...current.flags, subject: parsed }, subjectUnlinked: false });
    return true;
  });
}

/**
 * Applies a change to the flags stored in `dir` and returns them as stored.
 * For a caller that already holds the session directory, such as a binder
 * that has just created the session and cannot look it up yet.
 */
export function updateSessionFlagsAt(dir: string, change: SessionFlagsChange, now: () => Date = () => new Date()): SessionFlags {
  return withFlagsLock(dir, () => applyFlagsChange(dir, change, now));
}

function applyFlagsChange(dir: string, change: SessionFlagsChange, now: () => Date): SessionFlags {
  const { flags: current, subjectUnlinked } = readStoredFlags(dir);
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
  if (change.subject !== undefined && change.subject !== null) {
    const subject = parseSessionSubject(change.subject);
    if (subject === undefined) throw new Error(`not a GitHub subject: ${JSON.stringify(change.subject).slice(0, 300)}`);
    next.subject = subject;
  }
  if (change.subject === null) delete next.subject;
  const unlinked = change.subject === null ? true : change.subject !== undefined ? false : subjectUnlinked;
  writeFlags(dir, { flags: next, subjectUnlinked: unlinked });
  return next;
}

/** The project root and directory of a stored session, by its exact id. */
function locate(cwd: string, sessionId: string, dataDir?: string): { projectPath: string; dir: string } {
  const summary = findSession(cwd, sessionId, dataDir);
  if (summary === undefined || summary.id !== sessionId) throw new Error(`no session ${sessionId} in this project`);
  return { projectPath: summary.projectPath, dir: sessionDir(summary.projectPath, sessionId, dataDir) };
}

/**
 * Archives or unarchives, pins or unpins a session, links or unlinks its flow
 * and subject. A flag already in the asked state keeps its original time.
 * Returns the flags as stored.
 */
export function setSessionFlags(
  cwd: string,
  sessionId: string,
  change: SessionFlagsChange,
  dataDir?: string,
  now: () => Date = () => new Date(),
): SessionFlags {
  const { dir } = locate(cwd, sessionId, dataDir);
  return updateSessionFlagsAt(dir, change, now);
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
