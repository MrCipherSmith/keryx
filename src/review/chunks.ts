// A chunked pass over the blast-radius files the cap dropped. The plan is written once, before the first pass; the
// passes run one at a time through review-regression, and the flow-430 retry plan decides what follows each result.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { withFileLock, writeFileAtomic } from "../lib/fs";
import { type BlastRadius, BLAST_RADIUS_SCOPE_REVIEWER, DEFAULT_BLAST_RADIUS_MAX_FILES } from "./blast-radius";
import { type RetryDecision, type RetryState, emptyRetryState, planRetry, scopeFingerprint } from "./retry-plan";
import { DEFAULT_SLICE_MAX_BYTES, type SliceEntry, type SliceManifest } from "./slice";
import { sliceGraph } from "./waves";
import { readJsonFileOr } from "../lib/json";

export const CHUNKS_FILE = "chunks.json";
export const CHUNK_STATE_FILE = "chunk-state.json";
export const CHUNK_PASS_FILE = "chunk-pass.json";
const CHUNK_STATE_LOCK = "chunk-state.lock";
/** How long a writer waits for the chunk lock: a record on a large pass can take a while, and giving up would drop an outcome. */
export const CHUNK_LOCK_WAIT_MS = 120_000;

/** Every writer of chunks.json, chunk-state.json, chunk-estimate.json and chunk-pass.json takes this one lock. It is not reentrant. */
export function withChunkStateLock<T>(packageDir: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(packageDir, CHUNK_STATE_LOCK), fn, { timeoutMs: CHUNK_LOCK_WAIT_MS });
}
export const CHUNK_REVIEWER = BLAST_RADIUS_SCOPE_REVIEWER;
/** The tier every chunk pass runs on: one down from the flagship. */
export const CHUNK_TIER = "middle";

export type ChunkEntry = {
  id: string;
  files: string[];
  bytes: number;
  retryOf?: string[];
  attempt?: number;
};

export type ChunkPlan = {
  schemaVersion: 1;
  reviewer: string;
  tier: string;
  source: "blast-radius.json";
  maxFiles: number;
  maxBytes: number;
  dropped: number;
  /** Hash of the dropped file set the plan was cut from; a plan written before this field existed has none. */
  droppedKey?: string;
  chunks: ChunkEntry[];
};

export type ChunkOutcome = {
  status: string;
  decision?: RetryDecision;
  attempts: number;
  /** Order in which outcomes were recorded; the latest outcome of a chunk and its retry children decides its state. */
  seq: number;
  findings: ChunkFinding[];
};

export type ChunkFinding = { file?: string; line?: number; severity?: string; title?: string; [key: string]: unknown };

export type ChunkState = {
  schemaVersion: 1;
  retry: RetryState;
  /** Smaller chunks a retry cut from a failed one. */
  derived: ChunkEntry[];
  outcomes: Record<string, ChunkOutcome>;
};

export type ChunkRunState = "done" | "failed" | "pending";

export type ChunkPass = {
  schemaVersion: 1;
  reviewer: string;
  tier: string;
  totals: { chunks: number; files: number; done: number; failed: number; pending: number };
  chunks: Array<{ id: string; files: string[]; state: ChunkRunState; attempts: number }>;
  uncoveredFiles: string[];
  findings: ChunkFinding[];
};

type Dropped = Pick<BlastRadius["dropped"][number], "file" | "hop" | "fanIn">;

export type PlanChunksInput = {
  dropped: readonly Dropped[];
  maxFiles?: number;
  maxBytes?: number;
  sizeOf?: (file: string) => number;
};

/** Sorted by distance from the change, then fan-in, then name; packed greedily under the file and byte caps. A file over the byte cap travels alone. */
export function planChunks(input: PlanChunksInput): ChunkEntry[] {
  const maxFiles = input.maxFiles ?? DEFAULT_BLAST_RADIUS_MAX_FILES;
  const maxBytes = input.maxBytes ?? DEFAULT_SLICE_MAX_BYTES;
  const sizeOf = input.sizeOf ?? (() => 0);
  const unique = new Map<string, Dropped>();
  for (const entry of input.dropped) if (!unique.has(entry.file)) unique.set(entry.file, entry);
  const ordered = [...unique.values()].sort((a, b) => a.hop - b.hop || b.fanIn - a.fanIn || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const groups: Array<{ files: string[]; bytes: number }> = [];
  let current: { files: string[]; bytes: number } | undefined;
  for (const entry of ordered) {
    const size = sizeOf(entry.file);
    if (current === undefined || current.files.length >= maxFiles || (current.files.length > 0 && current.bytes + size > maxBytes)) {
      current = { files: [], bytes: 0 };
      groups.push(current);
    }
    current.files.push(entry.file);
    current.bytes += size;
  }
  const width = Math.max(3, String(groups.length).length);
  return groups.map((group, index) => ({ id: `chunk-${String(index + 1).padStart(width, "0")}`, files: group.files, bytes: group.bytes }));
}

const readJson = <T>(file: string): Promise<T | undefined> => readJsonFileOr<T | undefined>(file, undefined);

const droppedKeyOf = (files: readonly string[]): string => createHash("sha256").update([...new Set(files)].sort().join("\n")).digest("hex").slice(0, 16);

export async function readBlastRadius(packageDir: string): Promise<BlastRadius | undefined> {
  const radius = await readJson<BlastRadius>(path.join(packageDir, "blast-radius.json"));
  return radius !== undefined && Array.isArray(radius.dropped) && Array.isArray(radius.files) ? radius : undefined;
}

export async function readChunkPlan(packageDir: string): Promise<ChunkPlan | undefined> {
  const plan = await readJson<ChunkPlan>(path.join(packageDir, CHUNKS_FILE));
  return plan !== undefined && Array.isArray(plan.chunks) ? plan : undefined;
}

/**
 * Writes `chunks.json` from the dropped files of `blast-radius.json`. No dropped file means no plan (null).
 * A plan whose dropped set still matches is kept (so is one written before `droppedKey` existed). A plan cut from a
 * different dropped set is replaced while no pass is recorded and refused once one is: the plan may not move under a pass.
 */
export async function ensureChunkPlan(packageDir: string, projectRoot: string, options: { maxBytes?: number; maxFiles?: number } = {}): Promise<ChunkPlan | null> {
  const radius = await readBlastRadius(packageDir);
  if (radius === undefined || radius.dropped.length === 0) return null;
  return withChunkStateLock(packageDir, () => cutChunkPlan(packageDir, projectRoot, radius, options));
}

async function cutChunkPlan(packageDir: string, projectRoot: string, radius: BlastRadius, options: { maxBytes?: number; maxFiles?: number }): Promise<ChunkPlan> {
  const droppedKey = droppedKeyOf(radius.dropped.map((entry) => entry.file));
  const existing = await readChunkPlan(packageDir);
  if (existing !== undefined) {
    if (existing.droppedKey === undefined || existing.droppedKey === droppedKey) return existing;
    // The dropped set moved. With no pass recorded the plan is replaced; with one, it may not move under the pass.
    if (Object.keys((await readChunkState(packageDir)).outcomes).length > 0) {
      throw new Error(
        `${CHUNKS_FILE} was cut from a different dropped set than blast-radius.json now lists, and passes are already recorded. Remove ${CHUNKS_FILE}, ${CHUNK_STATE_FILE} and ${CHUNK_PASS_FILE} in ${packageDir} to plan again.`,
      );
    }
  }
  const sizes = new Map<string, number>();
  await Promise.all(
    radius.dropped.map(async (entry) => {
      const info = await stat(path.join(projectRoot, entry.file)).catch(() => undefined);
      sizes.set(entry.file, info?.isFile() === true ? info.size : 0);
    }),
  );
  const maxFiles = options.maxFiles ?? DEFAULT_BLAST_RADIUS_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_SLICE_MAX_BYTES;
  const chunks = planChunks({ dropped: radius.dropped, maxFiles, maxBytes, sizeOf: (file) => sizes.get(file) ?? 0 });
  const plan: ChunkPlan = {
    schemaVersion: 1,
    reviewer: CHUNK_REVIEWER,
    tier: CHUNK_TIER,
    source: "blast-radius.json",
    maxFiles,
    maxBytes,
    dropped: new Set(radius.dropped.map((entry) => entry.file)).size,
    droppedKey,
    chunks,
  };
  await mkdir(packageDir, { recursive: true });
  await writeFileAtomic(path.join(packageDir, CHUNKS_FILE), `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

function emptyChunkState(): ChunkState {
  return { schemaVersion: 1, retry: emptyRetryState(), derived: [], outcomes: {} };
}

export async function readChunkState(packageDir: string): Promise<ChunkState> {
  const state = await readJson<ChunkState>(path.join(packageDir, CHUNK_STATE_FILE));
  return state !== undefined && state.retry !== undefined && Array.isArray(state.derived) && state.outcomes !== undefined ? state : emptyChunkState();
}

async function writeChunkState(packageDir: string, state: ChunkState): Promise<void> {
  await writeFileAtomic(path.join(packageDir, CHUNK_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

const textOf = (entry: { files: readonly string[] }): string => `${entry.files.join("\n")}\n`;

/** The chunks as a slice manifest, so the retry plan treats a chunk like any other slice. */
export function chunkManifest(plan: ChunkPlan, derived: readonly ChunkEntry[]): SliceManifest {
  const slices: SliceEntry[] = [...plan.chunks, ...derived].map((chunk) => ({
    id: chunk.id,
    path: `chunks/${chunk.id}`,
    bytes: Math.max(chunk.bytes, 1),
    contentHash: createHash("sha256").update(textOf(chunk)).digest("hex"),
    files: chunk.files,
    domain: "blast-radius",
    split: "file",
    ...(chunk.retryOf === undefined ? {} : { retryOf: chunk.retryOf, reviewer: CHUNK_REVIEWER }),
    ...(chunk.attempt === undefined ? {} : { attempt: chunk.attempt }),
  }));
  return {
    schemaVersion: 1,
    maxBytes: plan.maxBytes,
    waveBytes: plan.maxBytes,
    source: "diff",
    slices,
    omissions: [],
    totals: { slices: slices.length, bytes: slices.reduce((sum, s) => sum + s.bytes, 0), files: new Set(slices.flatMap((s) => s.files)).size, omittedFiles: 0, omittedBytes: 0, droppedBlocks: 0 },
  };
}

function readText(manifest: SliceManifest): (entry: SliceEntry) => string {
  return (entry) => textOf(manifest.slices.find((slice) => slice.id === entry.id) ?? entry);
}

function covered(state: ChunkState): Set<string> {
  return new Set(state.retry.reviewers[CHUNK_REVIEWER]?.covered ?? []);
}

function runStates(plan: ChunkPlan, state: ChunkState): Array<{ chunk: ChunkEntry; state: ChunkRunState }> {
  const manifest = chunkManifest(plan, state.derived);
  const graph = sliceGraph(manifest, CHUNK_REVIEWER);
  const accounted = graph.accounted(covered(state));
  return plan.chunks.map((chunk) => {
    if (accounted.has(chunk.id)) return { chunk, state: "done" as const };
    const family = [chunk.id, ...state.derived.filter((d) => d.retryOf?.includes(chunk.id)).map((d) => d.id)];
    const outcome = family.map((id) => state.outcomes[id]).filter((o): o is ChunkOutcome => o !== undefined).sort((a, b) => b.seq - a.seq)[0];
    const owed = outcome?.decision === "retry" || outcome?.decision === "context" || outcome?.decision === "wave";
    return { chunk, state: outcome !== undefined && outcome.status !== "DONE" && owed ? ("failed" as const) : ("pending" as const) };
  });
}

export type NextChunk = { chunk: ChunkEntry | null; remaining: number; reason: string; reviewer: string; tier: string };

/** The one chunk to dispatch now. The retry plan's next wave is cut to its first chunk: passes run one at a time. */
export function nextChunk(packageDir: string): Promise<NextChunk> {
  return withChunkStateLock(packageDir, () => nextChunkLocked(packageDir));
}

async function nextChunkLocked(packageDir: string): Promise<NextChunk> {
  const plan = await readChunkPlan(packageDir);
  if (plan === undefined) throw new Error(`No ${CHUNKS_FILE} in ${packageDir}: nothing was dropped from the blast radius, or \`keryx review chunks plan\` has not run.`);
  const state = await readChunkState(packageDir);
  const manifest = chunkManifest(plan, state.derived);
  const read = readText(manifest);
  const result = planRetry({
    manifest,
    result: {},
    reviewer: CHUNK_REVIEWER,
    sliceIds: plan.chunks.map((chunk) => chunk.id),
    nextWave: true,
    state: state.retry,
    readSliceText: read,
  });
  const first = result.wave[0];
  const entry = first === undefined ? undefined : [...plan.chunks, ...state.derived].find((chunk) => chunk.id === first.id);
  return { chunk: entry ?? null, remaining: result.remaining.slices, reason: result.reason, reviewer: CHUNK_REVIEWER, tier: CHUNK_TIER };
}

export type ChunkResultInput = { status: string; findings?: unknown };

function findingsOf(value: unknown): ChunkFinding[] {
  return Array.isArray(value) ? value.filter((item): item is ChunkFinding => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
}

function halves(chunk: ChunkEntry, attempt: number): ChunkEntry[] {
  const middle = Math.ceil(chunk.files.length / 2);
  return [chunk.files.slice(0, middle), chunk.files.slice(middle)]
    .filter((files) => files.length > 0)
    .map((files, index) => ({
      id: `${chunk.id}.r${attempt}-${index + 1}`,
      files,
      bytes: Math.max(1, Math.round((chunk.bytes * files.length) / chunk.files.length)),
      retryOf: [chunk.id],
      attempt,
    }));
}

/**
 * Records what one chunk pass returned. A DONE pass covers its chunk. A failed pass goes through the retry plan: it is
 * handed back smaller (the chunk is cut in half) while the plan still allows a retry, and otherwise stays pending.
 */
export function recordChunk(packageDir: string, chunkId: string, result: ChunkResultInput): Promise<ChunkRecordResult> {
  // Two overlapping records would each start from the same snapshot, and the later write would erase the earlier outcome.
  return withChunkStateLock(packageDir, () => recordChunkLocked(packageDir, chunkId, result));
}

export type ChunkRecordResult = { decision: RetryDecision; reason: string; state: ChunkRunState };

async function recordChunkLocked(packageDir: string, chunkId: string, result: ChunkResultInput): Promise<ChunkRecordResult> {
  const plan = await readChunkPlan(packageDir);
  if (plan === undefined) throw new Error(`No ${CHUNKS_FILE} in ${packageDir}.`);
  const state = await readChunkState(packageDir);
  const all = [...plan.chunks, ...state.derived];
  const chunk = all.find((entry) => entry.id === chunkId);
  if (chunk === undefined) throw new Error(`Unknown chunk ${chunkId}; the plan has ${all.map((entry) => entry.id).join(", ")}.`);
  const { next, decision } = applyChunkResult(plan, state, chunk, result);
  await writeChunkState(packageDir, next);
  const states = runStates(plan, next);
  const mine = states.find((entry) => entry.chunk.id === chunkId || next.derived.some((d) => d.id === chunkId && d.retryOf?.includes(entry.chunk.id)));
  return { decision: decision.decision, reason: decision.reason, state: mine?.state ?? "pending" };
}

/** The state after one chunk's result, and the retry decision that led to it. Reads and writes nothing. */
function applyChunkResult(plan: ChunkPlan, state: ChunkState, chunk: ChunkEntry, result: ChunkResultInput): { next: ChunkState; decision: ReturnType<typeof planRetry> } {
  const manifest = chunkManifest(plan, state.derived);
  const read = readText(manifest);
  const status = result.status.toUpperCase();
  const finished = status === "DONE" || status === "DONE_WITH_CONCERNS";
  const fingerprint = scopeFingerprint(manifest, read);
  const decision = planRetry({
    manifest,
    result: {
      reviewer: CHUNK_REVIEWER,
      status,
      ...(fingerprint === undefined ? {} : { scopeFingerprint: fingerprint }),
      slices: finished ? [chunk.id] : [],
    },
    reviewer: CHUNK_REVIEWER,
    sliceIds: plan.chunks.map((entry) => entry.id),
    state: state.retry,
    readSliceText: read,
  });
  const next: ChunkState = { ...state, retry: decision.state, derived: [...state.derived], outcomes: { ...state.outcomes } };
  const prior = state.outcomes[chunk.id];
  next.outcomes[chunk.id] = {
    status,
    decision: decision.decision,
    attempts: (prior?.attempts ?? 0) + 1,
    seq: Math.max(0, ...Object.values(state.outcomes).map((o) => o.seq)) + 1,
    findings: finished ? findingsOf(result.findings) : (prior?.findings ?? []),
  };
  const alreadySplit = state.derived.some((d) => d.retryOf?.includes(chunk.id));
  if (!finished && decision.decision === "retry" && !decision.progress && chunk.files.length > 1 && !alreadySplit) {
    next.derived.push(...halves(chunk, decision.priorAttempts + 1));
  }
  return { next, decision };
}

// The finding contract's names are blocker/major/minor/info. critical, high and medium are aliases of blocker, major and minor;
// low is not an alias of any of them: it ranks between minor and info. A severity named otherwise ranks last (5).
const SEVERITY_RANK: Record<string, number> = { blocker: 0, critical: 0, major: 1, high: 1, minor: 2, medium: 2, low: 3, info: 4 };

const findingKey = (finding: ChunkFinding): string =>
  `${finding.file ?? ""}:${typeof finding.line === "number" ? finding.line : (finding.title ?? "")}`;

/** Findings of every finished chunk; two on the same file and line collapse into the more severe one. */
export function mergeFindings(outcomes: ReadonlyArray<{ chunk: string; findings: readonly ChunkFinding[] }>): ChunkFinding[] {
  const byKey = new Map<string, ChunkFinding & { chunks: string[] }>();
  for (const outcome of outcomes) {
    for (const finding of outcome.findings) {
      const key = findingKey(finding);
      const known = byKey.get(key);
      if (known === undefined) {
        byKey.set(key, { ...finding, chunks: [outcome.chunk] });
        continue;
      }
      if (!known.chunks.includes(outcome.chunk)) known.chunks.push(outcome.chunk);
      const rank = (value: ChunkFinding): number => SEVERITY_RANK[String(value.severity ?? "").toLowerCase()] ?? 5;
      if (rank(finding) < rank(known)) Object.assign(known, finding, { chunks: known.chunks });
    }
  }
  return [...byKey.values()].sort((a, b) => findingKey(a).localeCompare(findingKey(b)));
}

/** Per-chunk state and the merged findings, from the plan and the recorded outcomes. Writes nothing. */
export async function computeChunkPass(packageDir: string): Promise<ChunkPass | null> {
  const plan = await readChunkPlan(packageDir);
  if (plan === undefined) return null;
  const state = await readChunkState(packageDir);
  const states = runStates(plan, state);
  const done = states.filter((entry) => entry.state === "done");
  const outcomeIds = (chunk: ChunkEntry): string[] => [chunk.id, ...state.derived.filter((d) => d.retryOf?.includes(chunk.id)).map((d) => d.id)];
  const findings = mergeFindings(
    done.flatMap((entry) => outcomeIds(entry.chunk).map((id) => ({ chunk: entry.chunk.id, findings: state.outcomes[id]?.findings ?? [] }))),
  );
  const pass: ChunkPass = {
    schemaVersion: 1,
    reviewer: plan.reviewer,
    tier: plan.tier,
    totals: {
      chunks: plan.chunks.length,
      files: new Set(plan.chunks.flatMap((chunk) => chunk.files)).size,
      done: done.length,
      failed: states.filter((entry) => entry.state === "failed").length,
      pending: states.filter((entry) => entry.state === "pending").length,
    },
    chunks: states.map((entry) => ({
      id: entry.chunk.id,
      files: entry.chunk.files,
      state: entry.state,
      attempts: outcomeIds(entry.chunk).reduce((sum, id) => sum + (state.outcomes[id]?.attempts ?? 0), 0),
    })),
    uncoveredFiles: states.filter((entry) => entry.state !== "done").flatMap((entry) => entry.chunk.files).sort(),
    findings,
  };
  return pass;
}

/** Writes `chunk-pass.json`. Deterministic for a given state. */
export async function mergeChunkPass(packageDir: string): Promise<ChunkPass | null> {
  if ((await readChunkPlan(packageDir)) === undefined) return null;
  return withChunkStateLock(packageDir, async () => {
    const pass = await computeChunkPass(packageDir);
    if (pass !== null) await writeFileAtomic(path.join(packageDir, CHUNK_PASS_FILE), `${JSON.stringify(pass, null, 2)}\n`);
    return pass;
  });
}

export function hasChunkPlan(packageDir: string): boolean {
  return existsSync(path.join(packageDir, CHUNKS_FILE));
}
