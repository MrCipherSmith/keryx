import { canAppendArchive, createArchiveCheckpoint } from "./archive-checkpoint";
import { isSessionEvidenceId } from "../session/evidence-revocation";
import { lstat, realpath } from "node:fs/promises";
import { createFileConfirmation } from "./file-verifier";
import { readDescriptorChainAsync, type DescriptorIdentity } from "../lib/descriptor-read";
import path from "node:path";
import { createHash } from "node:crypto";
import { projectSessionsDir, projectKeyFromPath, keryxDataDir } from "../session/paths";
import { ArchiveCursor, type ArchiveCursorAccess } from "./archive-cursor";
import { safeRelativePath } from "./config";
import { buildHarnessScanner } from "../security/harness-scan";
import { Worker } from "node:worker_threads";
import { existsSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runEvidenceScan } from "./scanner-runner";
export type Sanitized = { code: "ok"; text: string; redaction: "not-needed" | "applied" };
export type EvidenceScanner = (text: string, signal?: AbortSignal) => Promise<Sanitized | { code: "blocked" }>;
export const evidenceHash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const refused = (reason = "source-unreadable") => ({ code: "source-unavailable" as const, diagnostics: [reason] });
const inside = (root: string, target: string) => target === root || target.startsWith(root + path.sep);
const denied = (name: string) => name.split("/").some(part =>
  /^(\.env.*|\.git|node_modules|vendor|\.ssh|\.aws|\.gnupg|auth\.json|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_(?:rsa|ed25519)|.*token.*)$/i.test(part));
export { denied as evidenceFilePathDenied };
/** Bounded descriptor read; no symlink components within the canonical store. */
async function boundedBytes(root: string, relative: string, limit: number, expectedRootIdentity?: DescriptorIdentity, expectedTargetIdentity?: DescriptorIdentity): Promise<Buffer> {
  if (!safeRelativePath(relative) || !Number.isInteger(limit) || limit < 1 || limit > 8 * 1024 * 1024) throw Error("denied");
  const canonical = await realpath(root), target = path.resolve(canonical, relative);
  if (!inside(canonical, target)) throw Error("denied");
  const rootIdentity = expectedRootIdentity ?? await lstat(canonical), before = await lstat(target);
  if (!before.isFile() || before.size > limit || before.nlink !== 1) throw Error("denied");
  const bytes = await readDescriptorChainAsync(canonical, target, { maxBytes: limit, requireRegularFile: true, expectedRootIdentity: rootIdentity, expectedTargetIdentity: expectedTargetIdentity ?? before });
  const after = await lstat(target);
  if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1 || after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev || !inside(canonical, await realpath(target))) throw Error("unstable");
  return bytes;
}
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
class SourceBudgetError extends Error {
  constructor(readonly code: "timeout" | "budget-exceeded") { super(code); }
}
function sourceBudget(opts: { timeoutMs?: number; maxRecords?: number; signal?: AbortSignal }) {
  const timeoutMs = opts.timeoutMs ?? 1000, maxRecords = opts.maxRecords ?? 100000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1000 || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 100000) throw new SourceBudgetError("budget-exceeded");
  const deadline = performance.now() + timeoutMs;
  return { deadline, maxRecords, signal: opts.signal };
}
type SourceBudget = ReturnType<typeof sourceBudget>;
function checkBudget(budget: SourceBudget) {
  if (budget.signal?.aborted || performance.now() >= budget.deadline) throw new SourceBudgetError("timeout");
}
function sourceFailure(error: unknown) {
  return error instanceof SourceBudgetError ? { code: error.code, diagnostics: [error.code === "timeout" ? "query-timeout" : "query-budget"] } : refused();
}
async function sanitize(scanner: EvidenceScanner, text: string, budget: SourceBudget): Promise<Sanitized> {
  checkBudget(budget);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(new SourceBudgetError("timeout")); controller.abort(); };
    budget.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(onAbort, Math.max(1, budget.deadline - performance.now()));
  });
  let result: Awaited<ReturnType<EvidenceScanner>>;
  try {
    result = await Promise.race([scanner(text, controller.signal), cancelled]);
    checkBudget(budget);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) budget.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
  if (!result || result.code !== "ok" || typeof result.text !== "string" ||
      (result.redaction !== "applied" && result.redaction !== "not-needed") ||
      (result.redaction === "not-needed" && result.text !== text) ||
      Buffer.byteLength(result.text) > 8 * 1024 * 1024) throw Error("scanner");
  return { code: "ok", text: result.text, redaction: result.redaction };
}
export async function createEvidenceScanner(projectRoot: string): Promise<EvidenceScanner | undefined> {
  const scanner = await buildHarnessScanner(projectRoot);
  if (!scanner.available) return undefined;
  return async (text, signal) => {
    if (signal?.aborted || Buffer.byteLength(text) > 8 * 1024 * 1024) return { code: "blocked" };
    const ts = new URL("./scanner-worker.ts", import.meta.url);
    const url = existsSync(fileURLToPath(ts)) ? ts : new URL("./scanner-worker.js", import.meta.url);
    return runEvidenceScan(new Worker(url, { workerData: { projectRoot, text } }), signal);
  };
}
type EvidenceFileOptions = {
  projectRoot: string; path: string; roots: string[]; maxSourceBytes: number; scanner?: EvidenceScanner; timeoutMs?: number; maxRecords?: number; signal?: AbortSignal; expectedRootIdentity?: DescriptorIdentity;
};
async function readEvidenceFileInternal(opts: EvidenceFileOptions, verified: boolean) {
  opts = { ...opts, roots: Array.isArray(opts.roots) ? [...opts.roots] : opts.roots };
  if (!opts.scanner || !safeRelativePath(opts.path) || denied(opts.path) || !Array.isArray(opts.roots) ||
      !opts.roots.some(root => safeRelativePath(root) && !denied(root) && inside(path.resolve(root), path.resolve(opts.path)))) return refused("source-denied");
  try {
    const budget = sourceBudget(opts); checkBudget(budget);
    const root = await realpath(opts.projectRoot), rootIdentity = opts.expectedRootIdentity ?? await lstat(root);
    const targetIdentity = await lstat(path.join(root, opts.path));
    const bytes = await boundedBytes(root, opts.path, opts.maxSourceBytes, rootIdentity, targetIdentity);
    const original = decode(bytes);
    const clean = await sanitize(opts.scanner, original, budget);
    if (!bytes.equals(await boundedBytes(root, opts.path, opts.maxSourceBytes, rootIdentity, targetIdentity))) return refused("stale-source");
    checkBudget(budget);
    const versionHash = evidenceHash(bytes);
    const result = { ...clean, versionHash, trustedAsPolicy: false as const,
      fileProjection: { redaction: clean.redaction, originalByteLength: bytes.length, originalLineCount: original.split("\n").length } };
    if (!verified) return result;
    const confirm = createFileConfirmation({ root, relativePath: opts.path, maxBytes: opts.maxSourceBytes,
      rootIdentity, targetIdentity, versionHash, ...(opts.signal ? { signal: opts.signal } : {}) });
    return { ...result, confirm };
  } catch (error) { return sourceFailure(error); }
}
export async function readEvidenceFile(opts: EvidenceFileOptions) {
  const result = await readEvidenceFileInternal(opts, false);
  if (result.code !== "ok") return result;
  return { code: result.code, text: result.text, redaction: result.redaction,
    versionHash: result.versionHash, trustedAsPolicy: result.trustedAsPolicy, fileProjection: result.fileProjection };
}
/** Runtime-owner seam; scanner success precedes creation of a final synchronous verifier. */
export async function readVerifiedEvidenceFile(opts: EvidenceFileOptions) {
  const result = await readEvidenceFileInternal(opts, true);
  if (result.code !== "ok") return result;
  if (!("confirm" in result) || typeof result.confirm !== "function") return refused();
  return { ...result, confirm: result.confirm };
}
export interface ArchiveRecord {
  text: string; role: string; timestamp: string | null; recordId: string; startByte: number; endByte: number;
  redaction: Sanitized["redaction"]; trustedAsPolicy: false;
}
/** Dedicated session-store adapter; never reads opaque replay or spill files. */
type EvidenceArchiveOptions = {
  cursorAccess?: ArchiveCursorAccess;
  projectRoot: string; sessionId: string; dataDir?: string; sessionArchives: boolean; maxSourceBytes: number; scanner?: EvidenceScanner; timeoutMs?: number; maxRecords?: number; signal?: AbortSignal; expectedRootIdentity?: DescriptorIdentity;
};
async function readEvidenceArchiveInternal(opts: EvidenceArchiveOptions, verified: boolean) {
  if (!opts.sessionArchives || !opts.scanner || !isSessionEvidenceId(opts.sessionId)) return refused("source-denied");
  try {
    const budget = sourceBudget(opts); checkBudget(budget);
    const project = await realpath(opts.projectRoot), store = keryxDataDir(opts.dataDir);
    const ownerIdentity = opts.expectedRootIdentity ?? await lstat(project);
    const ownerCurrent = await lstat(project);
    if (ownerCurrent.dev !== ownerIdentity.dev || ownerCurrent.ino !== ownerIdentity.ino || ownerCurrent.isSymbolicLink()) return refused("source-denied");
    const dir = projectSessionsDir(project, opts.dataDir);
    const storageRoot = await realpath(store), storageIdentity = await lstat(storageRoot);
    const relative = path.relative(path.resolve(store), path.join(dir, opts.sessionId)).split(path.sep).join("/");
    if (!safeRelativePath(relative)) return refused("source-denied");
    const sessionRoot = path.join(storageRoot, relative), sessionIdentity = await lstat(sessionRoot);
    if (!sessionIdentity.isDirectory() || sessionIdentity.isSymbolicLink()) return refused("source-denied");
    const summaryIdentity = await lstat(path.join(sessionRoot, "summary.json"));
    const archiveIdentity = await lstat(path.join(sessionRoot, "archive.jsonl"));
    const readSession = async (name: string, limit: number) => {
      const assertSession = async () => {
        const current = await lstat(sessionRoot);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== sessionIdentity.dev || current.ino !== sessionIdentity.ino) throw Error("unstable-session");
      };
      await assertSession();
      const result = await boundedBytes(storageRoot, `${relative}/${name}`, limit, storageIdentity,
        name === "summary.json" ? summaryIdentity : archiveIdentity);
      await assertSession();
      return result;
    };
    const summaryBytes = await readSession("summary.json", 65536);
    const summary = JSON.parse(decode(summaryBytes));
    if (summary.id !== opts.sessionId || summary.schemaVersion !== 1 || summary.projectKey !== projectKeyFromPath(project) ||
        typeof summary.projectPath !== "string" || await realpath(summary.projectPath) !== project) return refused("source-denied");
    const bytes = await readSession("archive.jsonl", opts.maxSourceBytes), records: ArchiveRecord[] = [];
    const cursor = opts.cursorAccess?.cursor ?? new ArchiveCursor();
    let prepared;
    try { prepared = cursor.prepare(JSON.stringify([project, storageRoot, relative]), bytes, archiveIdentity,
      budget.maxRecords, () => checkBudget(budget)); }
    catch (error) { if (/record budget/.test(String(error))) throw new SourceBudgetError("budget-exceeded"); throw error; }
    for (const projected of prepared.records) {
      if (Buffer.byteLength(projected.text) > opts.maxSourceBytes) throw new SourceBudgetError("budget-exceeded");
      const clean = await sanitize(opts.scanner, projected.text, budget);
      records.push({ ...projected, text: clean.text,
        redaction: clean.redaction, trustedAsPolicy: false });
    }
    if (!summaryBytes.equals(await readSession("summary.json", 65536))) return refused("source-denied");
    if (!bytes.equals(await readSession("archive.jsonl", opts.maxSourceBytes))) return refused("stale-source");
    checkBudget(budget);
    const finalOwner = await lstat(project);
    if (finalOwner.dev !== ownerIdentity.dev || finalOwner.ino !== ownerIdentity.ino || finalOwner.isSymbolicLink()) return refused("source-denied");
    const archiveCheckpoint = createArchiveCheckpoint(bytes, archiveIdentity);
    const canReuseArchive = (previous: unknown) => canAppendArchive(bytes, archiveIdentity, previous);
    checkBudget(budget);
    if (opts.cursorAccess) prepared.commit(opts.cursorAccess.checkpoint);
    const result = { code: "ok" as const, versionHash: evidenceHash(bytes), records, archiveCheckpoint, canReuseArchive };
    if (!verified) return result;
    const summaryConfirm = createFileConfirmation({ root: storageRoot, relativePath: `${relative}/summary.json`,
      maxBytes: 65536, rootIdentity: storageIdentity, targetIdentity: summaryIdentity,
      versionHash: evidenceHash(summaryBytes), ...(opts.signal ? { signal: opts.signal } : {}) });
    const archiveConfirm = createFileConfirmation({ root: storageRoot, relativePath: `${relative}/archive.jsonl`,
      maxBytes: opts.maxSourceBytes, rootIdentity: storageIdentity, targetIdentity: archiveIdentity,
      versionHash: result.versionHash, ...(opts.signal ? { signal: opts.signal } : {}) });
    const signal = opts.signal;
    const confirm = () => {
      try {
        const identitiesMatch = () => {
          const owner = lstatSync(project), session = lstatSync(sessionRoot);
          return !signal?.aborted && owner.isDirectory() && !owner.isSymbolicLink() &&
            owner.dev === ownerIdentity.dev && owner.ino === ownerIdentity.ino &&
            session.isDirectory() && !session.isSymbolicLink() &&
            session.dev === sessionIdentity.dev && session.ino === sessionIdentity.ino;
        };
        return identitiesMatch() && summaryConfirm() && archiveConfirm() && identitiesMatch();
      } catch { return false; }
    };
    return { ...result, confirm };
  } catch (error) { return sourceFailure(error); }
}

export async function readEvidenceArchive(opts: EvidenceArchiveOptions) {
  const result = await readEvidenceArchiveInternal({ ...opts }, false);
  if (result.code !== "ok") return result;
  return { code: result.code, versionHash: result.versionHash, records: result.records,
    archiveCheckpoint: result.archiveCheckpoint, canReuseArchive: result.canReuseArchive };
}
/** Runtime-only capability: summary ownership and both complete file hashes are pinned. */
export async function readVerifiedEvidenceArchive(opts: EvidenceArchiveOptions) {
  const result = await readEvidenceArchiveInternal({ ...opts }, true);
  if (result.code !== "ok") return result;
  if (!("confirm" in result) || typeof result.confirm !== "function") return refused();
  return { ...result, confirm: result.confirm };
}
