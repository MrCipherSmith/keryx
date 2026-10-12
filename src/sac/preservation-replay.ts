import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { readConfigFile } from "../lib/config-dir";
import { withFileLock } from "../lib/fs";
import { readPreservation, writePreservationFile } from "../session/preservation";
import { projectSessionsDir } from "../session/paths";
import { createHarnessProposalLifecycleService, ProposalLifecycleError } from "./proposal-lifecycle";

async function readReplayJson(file: string) {
  // Only lstat's real ENOENT may mean a delivery marker does not exist.
  // Unreadable, oversized and nonregular records must not be overwritten.
  if (!(await lstat(file)).isFile()) throw new Error("nonregular replay record");
  const result = readConfigFile(file);
  if (!result.ok) throw new Error(`unreadable replay record: ${result.reason}`);
  return JSON.parse(result.text);
}

/** Deterministic offline proposal delivery, never acceptance or inference. */
export async function replayPreservation(input: { cwd: string; dir: string; snapshot: string; signal?: AbortSignal; afterCreate?: () => void }): Promise<"proposed" | "unbound" | "already-delivered"> {
  input.signal?.throwIfAborted();
  const snapshot = readPreservation(input.dir, input.snapshot);
  const raw = snapshot?.files["slate.json"];
  if (raw === undefined) throw new Error("preserved Slate missing");
  const slate = JSON.parse(raw) as { workspaceId?: unknown };
  if (slate.workspaceId === undefined) return "unbound";
  if (typeof slate.workspaceId !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(slate.workspaceId)) throw new Error("invalid workspace identity");
  const workspaceId = slate.workspaceId;
  const outbox = path.join(input.dir, "preservation", "outbox");
  const receipt = await readReplayJson(path.join(outbox, `${input.snapshot}.json`)) as { version?: unknown; snapshot?: unknown; state?: unknown };
  if (receipt.version !== 1 || receipt.snapshot !== input.snapshot || receipt.state !== "pending-review") throw new Error("invalid outbox receipt");
  return withFileLock<"proposed" | "already-delivered">(path.join(outbox, `${input.snapshot}.delivery.lock`), async () => {
    input.signal?.throwIfAborted();
    const { service, wrapUpAuthority, authorizationServer } = createHarnessProposalLifecycleService(input.cwd, {
      workspaceId, preserved: { dir: input.dir, snapshot: input.snapshot, ...(input.signal ? { signal: input.signal } : {}) },
    });
    const requestCorrelationId = `preservation-${randomUUID()}`;
    const actor = await authorizationServer.actorContextFor(undefined, requestCorrelationId);
    if (!actor) throw new Error("trusted actor required");
    const sourceRef = `./.metaproject/workspaces/${workspaceId}/preserved-evidence/${input.snapshot}/wrap-up.md`;
    const wrapUp = await wrapUpAuthority.issue({ actor, source: "session", sourceRef });
    // SAC IDs are at most 64 characters. Keep 248 hash bits in the locator;
    // the full snapshot is checked in the revision and evidence on conflict.
    const id = `p-${input.snapshot.slice(0, 62)}`;
    try {
      await service.create({ request: undefined, requestCorrelationId, workspaceId, id,
        proposalRevision: input.snapshot, kind: "follow-up", wrapUp, ...(input.signal ? { signal: input.signal } : {}) });
    } catch (error) {
      // Fresh ACL/strict guard are checked before create reports conflict.
      if (!(error instanceof ProposalLifecycleError) || error.code !== "conflict") throw error;
      const existing = await readReplayJson(path.join(input.cwd, ".metaproject", "workspaces", workspaceId, "proposals", `${id}.json`));
      const refs = (evidence: readonly { uri: string; revision: string }[]) => evidence.map(e => [e.uri, e.revision]);
      if (existing.workspaceId !== workspaceId || existing.author !== actor.subject || existing.kind !== "follow-up" || existing.proposalRevision !== input.snapshot || existing.wrapUp?.sourceRef !== sourceRef || existing.wrapUp?.sourceRevision !== wrapUp.sourceRevision || JSON.stringify(refs(existing.evidence)) !== JSON.stringify(refs(wrapUp.evidence))) throw new Error("delivery conflict mismatch", { cause: error });
    }
    // Consult the marker only after fresh ACL and evidence validation.
    const delivered = path.join(outbox, `${input.snapshot}.delivered`);
    try {
      const marker = await readReplayJson(delivered);
      if (marker.version !== 1 || marker.workspaceId !== workspaceId || marker.proposalId !== id || marker.snapshot !== input.snapshot) {
        throw new Error("invalid delivery marker");
      }
      return "already-delivered";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    input.afterCreate?.();
    input.signal?.throwIfAborted();
    writePreservationFile(path.join(outbox, `${input.snapshot}.delivered`), JSON.stringify({ version: 1, workspaceId, proposalId: id, snapshot: input.snapshot }));
    return "proposed";
  }, input.signal ? { signal: input.signal } : {});
}

/** Corruption/ACL denial retains pending evidence; other items continue. */
export async function replayPreservationOutbox(input: { cwd: string; dir: string; signal?: AbortSignal; maxItems?: number; deadline?: number }): Promise<{ proposed: number; deferred: number; unbound: number }> {
  return boundedReplay(input, scanPreservationOutbox);
}
function resumeScan(entries: string[], cursorFile: string): string[] {
  const sorted = [...entries].sort();
  const read = readConfigFile(cursorFile);
  if (!read.ok || !sorted.includes(read.text)) return sorted;
  return [...sorted.filter(entry => entry > read.text), ...sorted.filter(entry => entry <= read.text)];
}
function recordScanCursor(cursorFile: string, entry: string): void {
  try { writePreservationFile(cursorFile, entry); } catch { /* Hint only; immutable evidence remains pending. */ }
}
async function scanPreservationOutbox(input: ReplayInput): Promise<ReplayResult> {
  const result = { proposed: 0, deferred: 0, unbound: 0 };
  let entries: string[];
  try { entries = await readdir(path.join(input.dir, "preservation", "outbox")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
  let attempted = 0;
  const cursorFile = path.join(input.dir, "preservation", "outbox", "SCAN_CURSOR");
  for (const entry of resumeScan(entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name)), cursorFile)) {
    if (input.signal?.aborted || Date.now() >= (input.deadline ?? Infinity) || attempted >= (input.maxItems ?? 8)) break;
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
    input.signal?.throwIfAborted();
    recordScanCursor(cursorFile, entry);
    attempted++;
    try {
      const outcome = await replayPreservation({ ...input, snapshot: entry.slice(0, -5) });
      if (outcome === "already-delivered") attempted--;
      else result[outcome]++;
    }
    catch { result.deferred++; }
  }
  return result;
}

/** Replay project-scoped siblings; never follow symlink directories or mutate live Slates. */
export async function replayProjectPreservationOutboxes(input: { cwd: string; dir: string; signal?: AbortSignal; maxItems?: number; deadline?: number }): Promise<{ proposed: number; deferred: number; unbound: number }> {
  return boundedReplay(input, scanProjectPreservationOutboxes);
}
/** Explicit offline CLI retry, using shell's project-scoped data root. */
export async function retryProjectPreservation(cwd: string): Promise<{ proposed: number; deferred: number; unbound: number }> {
  // The sibling scanner needs a child path; no live session is created or leased.
  return replayProjectPreservationOutboxes({ cwd, dir: path.join(projectSessionsDir(cwd), ".explicit-retry") });
}
async function scanProjectPreservationOutboxes(input: ReplayInput): Promise<ReplayResult> {
  const result = { proposed: 0, deferred: 0, unbound: 0 };
  // dir is the shell-resolved session directory in its project-specific root.
  const root = path.dirname(input.dir);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
  const deadline = input.deadline ?? Date.now() + 2_000;
  let scanned = 0;
  const cursorFile = path.join(root, ".preservation-replay-cursor");
  const candidates = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(entry => entry.name);
  for (const name of resumeScan(candidates, cursorFile)) {
    if (input.signal?.aborted || Date.now() >= deadline || scanned >= 32) break;
    input.signal?.throwIfAborted();
    recordScanCursor(cursorFile, name);
    scanned++;
    try {
      const replay = await replayPreservationOutbox({ ...input, deadline, maxItems: 1, dir: path.join(root, name) });
      result.proposed += replay.proposed; result.deferred += replay.deferred; result.unbound += replay.unbound;
    } catch { result.deferred++; }
  }
  return result;
}


type ReplayInput = { cwd: string; dir: string; signal?: AbortSignal; maxItems?: number; deadline?: number };
type ReplayResult = { proposed: number; deferred: number; unbound: number };
/** A time limit alone does not cancel writes. Abort is checked at commit boundaries. */
async function boundedReplay(input: ReplayInput, scan: (input: ReplayInput) => Promise<ReplayResult>): Promise<ReplayResult> {
  const controller = new AbortController();
  const deadline = input.deadline ?? Date.now() + 2_000;
  const deferred = (): ReplayResult => ({ proposed: 0, deferred: 1, unbound: 0 });
  if (input.signal?.aborted || deadline <= Date.now()) return deferred();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const cancelled = new Promise<ReplayResult>((resolve) => {
    onAbort = () => { controller.abort(); resolve(deferred()); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(onAbort, Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([scan({ ...input, deadline, signal: controller.signal }), cancelled]);
  } finally {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
