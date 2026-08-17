// Per-project interactive session store (production).
//
// Isolation: sessions never cross project roots (git toplevel or abs cwd).
// Dual files:
//   context.jsonl  — model window (what resume loads for the agent)
//   archive.jsonl  — full audit log (export; survives /compact)
// Legacy: transcript.jsonl is still written as a copy of context for older tools.
//
// All writes are atomic (temp + rename). continue/list/resume only see the
// current project.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, readTranscriptFile } from "../lib/config-dir";
import { randomUUID } from "node:crypto";
import type { NormalizedMessage } from "../harness/provider/types";
import {
  keryxDataDir,
  projectKeyFromPath,
  projectSessionsDir,
  resolveProjectRoot,
  sessionDir as sessionDirPath,
} from "./paths";
import { compactMessages, type CompactOptions } from "./compact";
import { readSlate, type Slate } from "./slate";

export const SESSION_SCHEMA_VERSION = 1 as const;

export interface SessionSummary {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string;
  projectKey: string;
  projectPath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Messages in the active model context. */
  messageCount: number;
  /** Messages in the full archive (includes pre-compact history). */
  archiveMessageCount: number;
  compactCount: number;
  provider?: string;
  model?: string;
  parentSessionId?: string;
  /** Flow 165 (Slate Phase 5) catch-up field: how this session was driven. */
  runMode?: "interactive" | "unattended";
  /** Flow 165 (Slate Phase 5) catch-up field: this session's Course lifecycle state. */
  courseStatus?: "unbound" | "active" | "blocked" | "done";
}

export interface SessionHandle {
  summary: SessionSummary;
  dir: string;
}

export interface OpenSessionOptions {
  cwd: string;
  resumeId?: string;
  continueLast?: boolean;
  dataDir?: string;
  provider?: string;
  model?: string;
  parentSessionId?: string;
}

interface TranscriptLine {
  role: NormalizedMessage["role"];
  content: string;
  provenance?: NormalizedMessage["provenance"];
  ts: string;
  kind?: "message" | "compaction";
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The `sessions/` directory keryx creates under a given data root.
 *
 * Derived from the data root, NOT searched for in the path. The first version
 * did `dir.indexOf("/sessions/")`, which finds whichever `sessions` segment
 * comes first — so with `KERYX_DATA_DIR=/srv/sessions/keryx` the walk started
 * at `/srv/sessions`, a directory shared with other services, and chmodded it
 * and the data root itself to 0700. The comment below it claimed the data root
 * was left alone; a review measured 0775 → 0700 on both.
 *
 * The guard that was supposed to cover this asserted `mode(dataDir) === "775"`
 * and passed, because its fixture path happened to contain no `sessions`
 * segment. Deriving the answer removes the question.
 */
function sessionsRootFor(dataDir: string | undefined): string {
  return path.join(keryxDataDir(dataDir), "sessions");
}

/**
 * Create a session directory owner-only, without widening what is above it.
 *
 * A recursive `mkdirSync` with no mode created every level under the current
 * umask, and with `KERYX_DATA_DIR` unset the top level IS the shared
 * user-global config directory — the one that holds `auth.json`. A review ran
 * `keryx shell` on a fresh install under `umask 002` and measured the result:
 * `~/.local/share/keryx` and the whole `sessions/` subtree at 0775, so any
 * member of the operator's primary group could pre-create or replace
 * `auth.json` before the first `/connect`, and unlink transcripts indefinitely.
 *
 * So the shared root goes through `ensureKeryxConfigDir`, which owns its mode,
 * and every level below it is forced to 0700.
 *
 * The walk runs under `KERYX_DATA_DIR` too. A first version skipped it there —
 * scoped, again, to the call site the finding named — which left every install
 * that sets that variable with a permanently group-writable `sessions/`, and
 * transcripts anyone in the group could read or unlink. The data root itself is
 * not touched in that case: it is the operator's chosen directory and may
 * legitimately hold other things, so the tighten starts one level in, at
 * `sessions/`.
 *
 * `chmod` is best-effort and skipped on Windows, matching `ensureKeryxConfigDir`.
 */
function ensureDir(dir: string, dataDir?: string): void {
  const configRoot = keryxConfigDir();
  const shared = dir === configRoot || dir.startsWith(configRoot + path.sep);
  if (shared) {
    // Only when the session tree really is inside the shared directory. With
    // `KERYX_DATA_DIR` or an explicit `dataDir` it is not, and creating the
    // shared directory as a side effect of writing somewhere else would be a
    // surprise.
    ensureKeryxConfigDir();
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    return;
  }
  // `mode` applies at CREATION only, so a level that already exists — from a
  // release before this one, or created under a umask that stripped the bits —
  // keeps whatever it had. Walk down and force each level.
  //
  // Where the walk STARTS is the whole question. Inside the shared config
  // directory it starts at the root, which `ensureKeryxConfigDir` has already
  // tightened. Outside it, the root is the operator's own directory and is left
  // alone; the walk begins at the first level keryx itself creates.
  const root = shared ? configRoot : sessionsRootFor(dataDir);
  if (!dir.startsWith(root + path.sep)) {
    // Not under the tree this function is responsible for. Nothing outside it
    // is keryx's to re-permission, and a walk that starts somewhere else is
    // exactly the defect this guard replaced.
    return;
  }
  if (!shared) {
    // `sessions/` itself is the first level keryx creates outside the shared
    // directory, so it is part of the walk rather than its already-tightened
    // starting point. Omitting it left it at 0775 while every level below it
    // was 0700 — which is the level that matters, since group write there is
    // enough to unlink a whole project's transcripts.
    tighten(root);
  }
  let current = root;
  for (const segment of dir.slice(root.length + 1).split(path.sep)) {
    current = path.join(current, segment);
    tighten(current);
  }
}

/** Force one directory owner-only. Best-effort, like every other mode here. */
function tighten(target: string): void {
  try {
    chmodSync(target, 0o700);
  } catch {
    // Not ours to chmod, or a filesystem that refuses it. The directory is
    // still created; the mode is best-effort, exactly as it is one level up.
  }
}

function atomicWriteText(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

function atomicWriteJson(file: string, value: unknown): void {
  atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readSummaryFile(file: string): SessionSummary | undefined {
  // `readConfigFile`, not `readFileSync`: a summary is config-sized, and an
  // oversized one aborts the process outright (SIGABRT, no output, uncatchable
  // — the `try/catch` below does not run). A non-regular file in its place
  // hangs the read forever. See MAX_CONFIG_FILE_BYTES.
  const read = readConfigFile(file);
  if (!read.ok) {
    return undefined;
  }
  try {
    const o = JSON.parse(read.text) as Partial<SessionSummary> & { messageCount?: number };
    if (typeof o.id !== "string" || typeof o.projectPath !== "string") {
      return undefined;
    }
    const messageCount = typeof o.messageCount === "number" ? o.messageCount : 0;
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: o.id,
      projectKey: typeof o.projectKey === "string" ? o.projectKey : "",
      projectPath: o.projectPath,
      title: typeof o.title === "string" && o.title.length > 0 ? o.title : "Untitled",
      createdAt: typeof o.createdAt === "string" ? o.createdAt : nowIso(),
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : nowIso(),
      messageCount,
      archiveMessageCount:
        typeof o.archiveMessageCount === "number" ? o.archiveMessageCount : messageCount,
      compactCount: typeof o.compactCount === "number" ? o.compactCount : 0,
      ...(typeof o.provider === "string" ? { provider: o.provider } : {}),
      ...(typeof o.model === "string" ? { model: o.model } : {}),
      ...(typeof o.parentSessionId === "string" ? { parentSessionId: o.parentSessionId } : {}),
      ...(o.runMode === "interactive" || o.runMode === "unattended" ? { runMode: o.runMode } : {}),
      ...(o.courseStatus === "unbound" || o.courseStatus === "active" || o.courseStatus === "blocked" || o.courseStatus === "done" ? { courseStatus: o.courseStatus } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Human title from the first user line. */
export function titleFromPrompt(content: string): string {
  const one = content.replace(/\s+/g, " ").trim();
  if (one.length === 0) {
    return "Untitled session";
  }
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

/** Short id for UI: last 8 hex chars of uuid. */
export function shortSessionId(id: string): string {
  const clean = id.replace(/-/g, "");
  return clean.length >= 8 ? clean.slice(-8) : id.slice(0, 8);
}

function writeJsonl(file: string, history: readonly NormalizedMessage[], ts: string): void {
  const lines: string[] = [];
  for (const m of history) {
    const row: TranscriptLine = {
      role: m.role,
      content: m.content,
      ts,
      kind: "message",
      ...(m.provenance !== undefined ? { provenance: m.provenance } : {}),
    };
    lines.push(JSON.stringify(row));
  }
  atomicWriteText(file, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

/**
 * A transcript that exists but could not be read, so history is UNKNOWN rather
 * than empty.
 *
 * `readJsonl` returns `[]` for a session that has no transcript yet, which is a
 * true statement about a new session. Returning the same `[]` for a transcript
 * that is too large, or is a FIFO, or cannot be read, would say "this
 * conversation had no messages" about an audit log the process could not open —
 * and the caller would resume a session that silently appears to have no
 * history. So it throws instead, and the operator is told which file and why.
 */
export class TranscriptUnreadableError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`session transcript ${file} could not be read (${reason})`);
    this.name = "TranscriptUnreadableError";
  }
}

function readJsonl(file: string): NormalizedMessage[] {
  if (!existsSync(file)) {
    return [];
  }
  // `readTranscriptFile`, not `readFileSync`: an oversized file aborts the
  // process (SIGABRT, uncatchable) and a non-regular one blocks forever. The
  // bound is the transcript bound, not the config bound — a real conversation
  // legitimately exceeds the latter.
  const read = readTranscriptFile(file);
  if (!read.ok) {
    throw new TranscriptUnreadableError(file, read.reason);
  }
  const out: NormalizedMessage[] = [];
  for (const line of read.text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const o = JSON.parse(line) as TranscriptLine;
      if (
        o.role !== "system" &&
        o.role !== "user" &&
        o.role !== "assistant" &&
        o.role !== "tool"
      ) {
        continue;
      }
      if (typeof o.content !== "string") {
        continue;
      }
      out.push({
        role: o.role,
        content: o.content,
        ...(o.provenance === "trusted" ||
        o.provenance === "project" ||
        o.provenance === "model" ||
        o.provenance === "tool"
          ? { provenance: o.provenance }
          : {}),
      });
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function createSession(opts: {
  cwd: string;
  dataDir?: string;
  provider?: string;
  model?: string;
  title?: string;
  parentSessionId?: string;
  id?: string;
}): SessionHandle {
  const projectPath = resolveProjectRoot(opts.cwd);
  const projectKey = projectKeyFromPath(projectPath);
  const id = opts.id ?? randomUUID();
  const dir = sessionDirPath(projectPath, id, opts.dataDir);
  ensureDir(dir, opts.dataDir);
  const ts = nowIso();
  const summary: SessionSummary = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    projectKey,
    projectPath,
    title: opts.title ?? "New session",
    createdAt: ts,
    updatedAt: ts,
    messageCount: 0,
    archiveMessageCount: 0,
    compactCount: 0,
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
  };
  atomicWriteJson(path.join(dir, "summary.json"), summary);
  atomicWriteText(path.join(dir, "context.jsonl"), "");
  atomicWriteText(path.join(dir, "archive.jsonl"), "");
  atomicWriteText(path.join(dir, "transcript.jsonl"), "");
  const marker = path.join(projectSessionsDir(projectPath, opts.dataDir), ".project.json");
  if (!existsSync(marker)) {
    atomicWriteJson(marker, {
      projectPath,
      projectKey,
      createdAt: ts,
      schemaVersion: SESSION_SCHEMA_VERSION,
    });
  }
  return { summary, dir };
}

/** List sessions for a project only (isolation). Newest updated first. */
export function listSessions(cwd: string, dataDir?: string): SessionSummary[] {
  const projectPath = resolveProjectRoot(cwd);
  const root = projectSessionsDir(projectPath, dataDir);
  if (!existsSync(root)) {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".")) {
      continue;
    }
    const summary = readSummaryFile(path.join(root, name, "summary.json"));
    if (summary === undefined) {
      continue;
    }
    if (path.resolve(summary.projectPath) !== path.resolve(projectPath)) {
      continue;
    }
    out.push(summary);
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}

export function latestSession(cwd: string, dataDir?: string): SessionSummary | undefined {
  return listSessions(cwd, dataDir)[0];
}

export function findSession(cwd: string, idOrPrefix: string, dataDir?: string): SessionSummary | undefined {
  const needle = idOrPrefix.trim();
  if (needle.length === 0) {
    return undefined;
  }
  const all = listSessions(cwd, dataDir);
  const exact = all.find((s) => s.id === needle);
  if (exact !== undefined) {
    return exact;
  }
  const matches = all.filter(
    (s) => s.id.startsWith(needle) || shortSessionId(s.id) === needle || s.title === needle,
  );
  if (matches.length === 1) {
    return matches[0];
  }
  return undefined;
}

/**
 * SLATE-21: this session's `slate.json`, lenient (`undefined`, never thrown)
 * on any read failure — no `slate.json` yet (an ordinary chat that never
 * opened a Slate), a mid-write race, or a corrupted file. Lives here rather
 * than a raw `sessionDirPath(...)` + `readSlate(...)` call at each caller so
 * every direct use of `sessionDir`-family resolvers alongside a raw file
 * write stays confined to this already-exempted file (see
 * `config-dir.writers.test.ts`'s EXEMPTIONS) — `session-wrap-up.ts` needs
 * this session's Slate AND writes evidence files of its own, and a resolver
 * name plus a raw write in the SAME file is exactly what that guard exists
 * to catch, regardless of which resolved path each write actually targets.
 */
export async function readSessionSlate(cwd: string, sessionId: string, dataDir?: string): Promise<Slate | undefined> {
  try {
    return await readSlate(sessionDirPath(resolveProjectRoot(cwd), sessionId, dataDir));
  } catch {
    return undefined;
  }
}

/** Load the active model context (what the agent should resume with). */
export function loadContext(cwd: string, sessionId: string, dataDir?: string): NormalizedMessage[] {
  const dir = sessionDirPath(resolveProjectRoot(cwd), sessionId, dataDir);
  const contextPath = path.join(dir, "context.jsonl");
  if (existsSync(contextPath)) {
    return readJsonl(contextPath);
  }
  // Legacy single-file sessions.
  return readJsonl(path.join(dir, "transcript.jsonl"));
}

/**
 * Full archive for export (falls back to context/transcript).
 *
 * The fallback covers an UNREADABLE archive, not only an absent one. Before it
 * did, a `TranscriptUnreadableError` on `archive.jsonl` aborted the resume of a
 * session whose `context.jsonl` was perfectly readable — and `archive.jsonl` is
 * the file most likely to reach the 64 MiB bound, because it is the one that
 * keeps everything compaction removed. Every caller answers that throw by
 * starting a brand new session, so the effect was that the longest
 * conversations became the ones that could not be resumed.
 *
 * The degradation is REPORTED, never swallowed. `onDegraded` is how a caller
 * tells "this session has no archive" from "this session's archive could not be
 * read", and the module's rule — an unreadable file must not read back as an
 * empty one — survives one level up instead of being traded away here.
 *
 * A failure of the CONTEXT still throws. Falling back from a fallback would be
 * the silent-empty this whole area exists to prevent.
 */
export function loadArchive(
  cwd: string,
  sessionId: string,
  dataDir?: string,
  onDegraded?: (error: TranscriptUnreadableError) => void,
): NormalizedMessage[] {
  const dir = sessionDirPath(resolveProjectRoot(cwd), sessionId, dataDir);
  const archivePath = path.join(dir, "archive.jsonl");
  if (existsSync(archivePath)) {
    try {
      const archive = readJsonl(archivePath);
      if (archive.length > 0) {
        return archive;
      }
    } catch (cause) {
      if (!(cause instanceof TranscriptUnreadableError)) {
        throw cause;
      }
      onDegraded?.(cause);
    }
  }
  return loadContext(cwd, sessionId, dataDir);
}

/** @deprecated use loadContext — kept for callers/tests. */
export function loadTranscript(cwd: string, sessionId: string, dataDir?: string): NormalizedMessage[] {
  return loadContext(cwd, sessionId, dataDir);
}

export interface PersistMeta {
  provider?: string;
  model?: string;
  title?: string;
  /**
   * Full archive to write. When omitted, `context` is also used as the archive
   * (first-turn sessions / non-compact path).
   */
  archive?: readonly NormalizedMessage[];
}

/**
 * Persist model context (+ archive). Atomic multi-file write.
 * Title auto-fills from the first user message while still default.
 */
export function persistHistory(
  handle: SessionHandle,
  context: readonly NormalizedMessage[],
  meta?: PersistMeta,
): SessionHandle {
  const ts = nowIso();
  const archive = meta?.archive ?? context;

  writeJsonl(path.join(handle.dir, "context.jsonl"), context, ts);
  writeJsonl(path.join(handle.dir, "archive.jsonl"), archive, ts);
  // Legacy mirror: tools/docs that still look for transcript.jsonl.
  writeJsonl(path.join(handle.dir, "transcript.jsonl"), context, ts);

  let title = meta?.title ?? handle.summary.title;
  if (title === "New session" || title === "Untitled session") {
    const firstUser =
      archive.find((m) => m.role === "user" && !m.content.startsWith("[Compacted")) ??
      context.find((m) => m.role === "user");
    if (firstUser !== undefined) {
      title = titleFromPrompt(firstUser.content);
    }
  }

  const summary: SessionSummary = {
    ...handle.summary,
    schemaVersion: SESSION_SCHEMA_VERSION,
    title,
    updatedAt: ts,
    messageCount: context.length,
    archiveMessageCount: archive.length,
    ...(meta?.provider !== undefined ? { provider: meta.provider } : {}),
    ...(meta?.model !== undefined ? { model: meta.model } : {}),
  };
  atomicWriteJson(path.join(handle.dir, "summary.json"), summary);
  return { summary, dir: handle.dir };
}

/**
 * Compact the live model context. Archive is preserved (and grown if needed).
 * Returns the new context array for the caller to swap into memory.
 */
export function compactSession(
  handle: SessionHandle,
  context: readonly NormalizedMessage[],
  archive: readonly NormalizedMessage[],
  opts?: CompactOptions & { provider?: string; model?: string },
): { handle: SessionHandle; context: NormalizedMessage[]; result: ReturnType<typeof compactMessages> } {
  const result = compactMessages(context, opts);
  if (result.noop) {
    return { handle, context: [...context], result };
  }
  // Archive keeps everything we had before compact + a marker line is not needed
  // as messages — full prior context already lives in archive.
  const nextArchive = archive.length >= context.length ? [...archive] : [...context];
  const next = persistHistory(handle, result.context, {
    archive: nextArchive,
    ...(opts?.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts?.model !== undefined ? { model: opts.model } : {}),
  });
  const withCount: SessionHandle = {
    dir: next.dir,
    summary: {
      ...next.summary,
      compactCount: next.summary.compactCount + 1,
    },
  };
  atomicWriteJson(path.join(withCount.dir, "summary.json"), withCount.summary);
  return { handle: withCount, context: result.context, result };
}

/** Typed rejection for a fork whose source session is not in this project. */
export class UnknownSessionError extends Error {
  constructor(readonly idOrPrefix: string) {
    super(`no session matching "${idOrPrefix}" in this project`);
    this.name = "UnknownSessionError";
  }
}

/**
 * Fork `sourceIdOrPrefix` into a NEW session that starts from the same history.
 *
 * Branching existed in the harness as `harness/branch/forkBranch` — deterministic,
 * append-only, tested — and had no way in: no CLI verb, no slash command, and
 * nothing that ever set `parentSessionId`. The only way to try an alternative
 * line from a point in a conversation was to copy transcript files by hand,
 * which is exactly the kind of edit the store's atomic writes exist to avoid.
 *
 * This is the interactive-session half of that, and it is deliberately not a
 * call into `forkBranch`: that operates on the harness's in-memory append-only
 * entry trail, which has no durable store behind it, while THIS store is what
 * `keryx shell -r` resumes from. Ancestry here is `parentSessionId` on the
 * summary, which the store, the resume path and `sessions list` already carry.
 *
 * The copy is a copy, not a reference: the fork owns its files from the first
 * turn, so writing to it can never mutate the session it came from. Both
 * `context` and `archive` come across, because a fork that resumed with the
 * model window but lost the pre-compact history would silently be a different
 * conversation from the one it claims to branch.
 *
 * `slate.json` is deliberately NEVER part of this copy (SLATE-1/SLATE-2, AC-1
 * / AC-2, `docs/requirements/slate/specification.md`'s "Future storage
 * structure": "`keryx sessions fork` ... creates no `slate.json` for the new
 * session — the fork opens with a fresh, empty slate, exactly as a
 * brand-new session would... No code path may special-case fork to carry
 * `slate.json` across."). This mirrors the same principle already applied to
 * `messageCount` etc. below: only raw transcript (`context`/`archive`) and
 * explicit identity fields (`title`/`provider`/`model`) are copied, never
 * derived/computed session state — and Anchors/Course/Seeds are exactly
 * that. `createSession` below never writes a `slate.json` on its own, so
 * simply not touching `slate.ts` here is sufficient; see
 * `src/session/store.test.ts` for the regression assertion.
 */
export function forkSession(opts: {
  cwd: string;
  sourceIdOrPrefix: string;
  title?: string;
  dataDir?: string;
}): { handle: SessionHandle; source: SessionSummary; messageCount: number; archiveCount: number } {
  const source = findSession(opts.cwd, opts.sourceIdOrPrefix, opts.dataDir);
  if (source === undefined) {
    throw new UnknownSessionError(opts.sourceIdOrPrefix);
  }

  // Throws `TranscriptUnreadableError` rather than forking an empty session off
  // a transcript it could not open — a fork that silently starts blank is the
  // worst outcome here, because it looks like it worked.
  const context = loadContext(opts.cwd, source.id, opts.dataDir);
  const archive = loadArchive(opts.cwd, source.id, opts.dataDir);

  const title = opts.title !== undefined && opts.title.trim().length > 0
    ? opts.title.trim()
    : `${source.title} (fork)`;

  const created = createSession({
    cwd: opts.cwd,
    parentSessionId: source.id,
    title,
    ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
    ...(source.provider !== undefined ? { provider: source.provider } : {}),
    ...(source.model !== undefined ? { model: source.model } : {}),
  });

  const handle = persistHistory(created, context, {
    archive,
    title,
    ...(source.provider !== undefined ? { provider: source.provider } : {}),
    ...(source.model !== undefined ? { model: source.model } : {}),
  });

  return { handle, source, messageCount: context.length, archiveCount: archive.length };
}

export function renameSession(handle: SessionHandle, title: string): SessionHandle {
  const summary: SessionSummary = {
    ...handle.summary,
    title: title.trim().length > 0 ? title.trim() : handle.summary.title,
    updatedAt: nowIso(),
  };
  atomicWriteJson(path.join(handle.dir, "summary.json"), summary);
  return { summary, dir: handle.dir };
}

/**
 * Open or create a session. resumeId is resolved only inside the current project.
 */
export function openSession(opts: OpenSessionOptions): {
  handle: SessionHandle;
  history: NormalizedMessage[];
  archive: NormalizedMessage[];
  resumed: boolean;
  /**
   * Set when the session resumed WITHOUT its archive because the archive could
   * not be read. The resume succeeded and is not a lie about what it loaded:
   * a caller that ignores this reports a shorter history than the session has,
   * which is the one thing the transcript readers throw to prevent.
   */
  archiveDegraded?: string;
} {
  const cwd = opts.cwd;
  const dataDir = opts.dataDir;

  const loadHandle = (found: SessionSummary): {
    handle: SessionHandle;
    history: NormalizedMessage[];
    archive: NormalizedMessage[];
    resumed: true;
    archiveDegraded?: string;
  } => {
    const dir = sessionDirPath(resolveProjectRoot(cwd), found.id, dataDir);
    const handle: SessionHandle = { summary: found, dir };
    const history = loadContext(cwd, found.id, dataDir);
    let degraded: string | undefined;
    const archive = loadArchive(cwd, found.id, dataDir, (error) => {
      degraded = error.message;
    });
    return {
      handle,
      history,
      archive,
      resumed: true,
      ...(degraded !== undefined ? { archiveDegraded: degraded } : {}),
    };
  };

  if (opts.resumeId !== undefined && opts.resumeId.length > 0) {
    const found = findSession(cwd, opts.resumeId, dataDir);
    if (found === undefined) {
      throw new Error(
        `No session matching "${opts.resumeId}" in this project. ` +
          `Use \`keryx sessions list\` (sessions are per-project).`,
      );
    }
    return loadHandle(found);
  }

  if (opts.continueLast === true) {
    const last = latestSession(cwd, dataDir);
    if (last !== undefined) {
      return loadHandle(last);
    }
  }

  const handle = createSession({
    cwd,
    ...(dataDir !== undefined ? { dataDir } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
  });
  return { handle, history: [], archive: [], resumed: false };
}

/** Export archive (preferred) as markdown. */
export function exportSessionMarkdown(cwd: string, sessionId: string, dataDir?: string): string {
  const summary = findSession(cwd, sessionId, dataDir);
  const id = summary?.id ?? sessionId;
  let degraded: string | undefined;
  const history = loadArchive(cwd, id, dataDir, (error) => {
    degraded = error.message;
  });
  const lines: string[] = [
    `# ${summary?.title ?? sessionId}`,
    "",
    `- id: \`${summary?.id ?? sessionId}\``,
    `- project: \`${summary?.projectPath ?? resolveProjectRoot(cwd)}\``,
    `- updated: ${summary?.updatedAt ?? ""}`,
    summary?.model !== undefined ? `- model: ${summary.provider ?? ""}/${summary.model}` : "",
    summary !== undefined
      ? `- context: ${summary.messageCount} · archive: ${summary.archiveMessageCount} · compact×${summary.compactCount}`
      : "",
    // In the document, not on stderr: an export is read later, by someone who
    // was not at the terminal, and "this is the whole conversation" is exactly
    // what they will assume of a file that does not say otherwise.
    degraded !== undefined
      ? `- **incomplete**: exported from the active context because the archive could not be read (${degraded})`
      : "",
    "",
    "---",
    "",
  ].filter((l) => l.length > 0);
  for (const m of history) {
    lines.push(`## ${m.role}`, "", m.content, "");
  }
  return lines.join("\n");
}
