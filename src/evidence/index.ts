import { isArchiveCheckpoint, type ArchiveCheckpoint } from "./archive-checkpoint";
import { createHash } from "node:crypto";
import type { EvidenceStorage } from "./storage";
import type { createEvidenceLifecycle, EvidenceSourceScope } from "./lifecycle";
import { chunkEvidence, evidenceChunkId, searchLexical, searchLexicalRanked, type LexicalChunk } from "./search";

import { incrementalArchiveEvidence, isArchiveChunk, type ArchiveChunk } from "./archive-chunks";
import type { ArchiveRecord } from "./sources";
import { chunkFileEvidence, isFileChunk, type FileChunk, type FileProjection } from "./file-chunks";
import { readEvidenceVectorSnapshot, type EvidenceVectorSnapshot } from "./vector-cache";
export type EvidenceChunk = LexicalChunk | ArchiveChunk | FileChunk;
export type EvidenceDocument = { sourceId: string; sourcePath: string; versionHash: string } &
  ({ text: string; fileProjection?: FileProjection; records?: never; archiveCheckpoint?: never; canReuseArchive?: never } | { records: readonly ArchiveRecord[]; text?: never; fileProjection?: never; archiveCheckpoint?: Readonly<ArchiveCheckpoint>; canReuseArchive?: (previous: unknown) => boolean });

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
interface SourceReference { sourceId: string; sourcePath: string; versionHash: string; scope: EvidenceSourceScope; archiveCheckpoint?: Readonly<ArchiveCheckpoint> }
interface Validation { projectHash: string; scopeHash: string; sources: readonly SourceReference[] }
interface Generation { schemaVersion: 1; generation: string; createdAt: string; chunks: EvidenceChunk[]; validation?: Validation; vectors?: EvidenceVectorSnapshot }
interface Pointer { schemaVersion: 1; generation: string; sha256: string }
function parsePointer(bytes: Buffer): Pointer {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid evidence CURRENT");
  const p = value as Pointer;
  if (Object.keys(p).sort().join(",") !== "generation,schemaVersion,sha256" || p.schemaVersion !== 1 || typeof p.generation !== "string" || typeof p.sha256 !== "string" ||
      !/^gen-[a-f0-9]{64}\.json$/.test(p.generation) || !/^[a-f0-9]{64}$/.test(p.sha256)) throw new Error("invalid evidence CURRENT");
  return p;
}
function parseGeneration(bytes: Buffer, expected: string): Generation {
  if (hash(bytes) !== expected) throw new Error("evidence generation checksum mismatch");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid evidence generation");
  const generation = value as Generation;
  if (!["chunks,createdAt,generation,schemaVersion", "chunks,createdAt,generation,schemaVersion,validation", "chunks,createdAt,generation,schemaVersion,vectors", "chunks,createdAt,generation,schemaVersion,validation,vectors"].includes(Object.keys(generation).sort().join(",")) ||
      generation.schemaVersion !== 1 || typeof generation.generation !== "string" || !/^gen-[a-f0-9]{64}\.json$/.test(generation.generation) ||
      typeof generation.createdAt !== "string" || !Number.isFinite(Date.parse(generation.createdAt)) ||
      !Array.isArray(generation.chunks) || generation.chunks.length > 100000 ||
      generation.chunks.some(c => !c || typeof c !== "object" || Array.isArray(c) ||
        Object.keys(c).sort().join(",") !== ("locator" in c ?
          "chunkId,contentHash,endByte,endLine,locator,redaction,role,sourceId,sourcePath,startByte,startLine,text,timestamp,trustedAsPolicy,versionHash" :
          "chunkId,contentHash,endByte,endLine,sourceId,sourcePath,startByte,startLine,text,trustedAsPolicy,versionHash") ||
        c.trustedAsPolicy !== false || typeof c.contentHash !== "string" || typeof c.chunkId !== "string" ||
        typeof c.versionHash !== "string" || !/^[a-f0-9]{64}$/.test(c.versionHash) ||
        typeof c.text !== "string" || !c.text || Buffer.byteLength(c.text) > 400 ||
        typeof c.sourceId !== "string" || !c.sourceId || typeof c.sourcePath !== "string" || !c.sourcePath ||
        !Number.isSafeInteger(c.startByte) || !Number.isSafeInteger(c.endByte) || c.startByte < 0 ||
        c.endByte - c.startByte !== Buffer.byteLength(c.text) ||
        !Number.isSafeInteger(c.startLine) || !Number.isSafeInteger(c.endLine) || c.startLine < 1 ||
        c.endLine - c.startLine + 1 !== c.text.split("\n").length ||
        c.contentHash !== hash(Buffer.from(c.text)) ||
        ("locator" in c ? (!isArchiveChunk(c) && !isFileChunk(c)) : c.chunkId !== evidenceChunkId(c))) ||
      new Set(generation.chunks.map(c => c.chunkId)).size !== generation.chunks.length)
    throw new Error("invalid evidence generation");
  if ("validation" in generation) {
    const v = generation.validation;
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== "projectHash,scopeHash,sources" ||
        typeof v.projectHash !== "string" || typeof v.scopeHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(v.projectHash) || !/^[a-f0-9]{64}$/.test(v.scopeHash) ||
        !Array.isArray(v.sources) || v.sources.length > 100000 ||
        v.sources.some(ref => !ref || typeof ref !== "object" || Array.isArray(ref) || !ref.scope ||
          typeof ref.scope !== "object" || Array.isArray(ref.scope) ||
          !["scope,sourceId,sourcePath,versionHash", "archiveCheckpoint,scope,sourceId,sourcePath,versionHash"].includes(Object.keys(ref).sort().join(",")) ||
          ("archiveCheckpoint" in ref && (ref.scope.kind !== "session-archive" || !isArchiveCheckpoint(ref.archiveCheckpoint))) ||
          Object.keys(ref.scope).sort().join(",") !== "id,kind" ||
          !["file", "session-archive"].includes(ref.scope.kind) || typeof ref.scope.id !== "string" || !ref.scope.id ||
          typeof ref.sourceId !== "string" || !ref.sourceId || typeof ref.sourcePath !== "string" || !ref.sourcePath ||
          typeof ref.versionHash !== "string" || !/^[a-f0-9]{64}$/.test(ref.versionHash)) ||
        new Set(v.sources.map(ref => ref.sourceId)).size !== v.sources.length)
      throw new Error("invalid evidence source manifest");
    v.sources = freezeSources(v.sources);
    const refs = new Map(v.sources.map(ref => [ref.sourceId, ref]));
    if (generation.chunks.some(chunk => { const ref = refs.get(chunk.sourceId);
      return !ref || ref.sourcePath !== chunk.sourcePath || ref.versionHash !== chunk.versionHash ||
        ("locator" in chunk && (chunk.locator.kind === "archive" ? ref.scope.kind !== "session-archive" : ref.scope.kind !== "file"));
    })) throw new Error("invalid evidence source reference");
  }
  if ("vectors" in generation) {
    if (!generation.vectors) throw Error("invalid evidence vectors");
    generation.vectors = readEvidenceVectorSnapshot(generation.vectors, generation.vectors.identity);
    const wanted = new Set(generation.chunks.map(chunk => chunk.contentHash));
    if (generation.vectors.records.length !== wanted.size || generation.vectors.records.some(record => !wanted.has(record.contentHash)) ||
        (generation.validation && hash(Buffer.from(generation.vectors.identity.project)) !== generation.validation.projectHash))
      throw Error("invalid evidence vector references");
  }
  return generation;
}

/** Prior data is a disposable optimization, never an authoritative source. Pin
 * before reading CURRENT so maintenance cannot collect a selected generation. */
function previousGeneration(store: EvidenceStorage): Generation | undefined {
  const release = store.pinReaders();
  if (!release) throw Error("evidence generation unavailable");
  try {
    const current = store.read("CURRENT", 4096);
    if (!current) return undefined;
    const pointer = parsePointer(current), bytes = store.read(pointer.generation, MAX_INDEX_BYTES);
    if (!bytes) return undefined;
    const loaded = parseGeneration(bytes, pointer.sha256);
    return loaded.generation === pointer.generation ? loaded : undefined;
  } catch {
    // Explicit rebuild can replace corrupt derived data; never reuse a partial load.
    return undefined;
  } finally { release(); }
}

/** Atomic replacement from the entire freshly scanned source set. Complete
 * archive record projections may be reused after content/metadata validation;
 * omitted or rewritten records can never survive via an incremental merge. */
export async function publishEvidenceGeneration(options: {
  store: EvidenceStorage;
  buildLease?: ReturnType<EvidenceStorage["acquireBuild"]>;
  documents: readonly EvidenceDocument[];
  /** Reference rebuild without previous chunks or vectors. */
  forceFull?: boolean;
  maxChunks?: number;
  maxIndexBytes?: number;
  validateSources: (chunks: readonly EvidenceChunk[]) => Promise<boolean>;
  validation?: Validation;
  /** Trusted owner callback only; sanitized chunks and checksum-verified prior snapshot.
   * Embedding capability/consent and cancellation remain the caller's responsibility. */
  buildVectors?: (chunks: readonly EvidenceChunk[], previous: EvidenceVectorSnapshot | undefined) => Promise<EvidenceVectorSnapshot | undefined>;
  beforePublish?: () => void;
  now?: () => number;
}) {
  const buildLease = options.buildLease ?? options.store.acquireBuild();
  try {
    options.store.checkBuildLease(buildLease);
    const maxIndexBytes = options.maxIndexBytes ?? MAX_INDEX_BYTES;
    if (!Number.isSafeInteger(maxIndexBytes) || maxIndexBytes < 1 || maxIndexBytes > MAX_INDEX_BYTES) throw new Error("evidence index byte budget exceeded");
    const maxChunks = options.maxChunks ?? 100000;
    if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 100000 || options.documents.length > maxChunks) throw new Error("evidence index budget exceeded");
    // Preflight source/work budgets before allocating lines, chunks or JSON.
    let sourceBytes = 0;
    for (const document of options.documents) {
      const archive = "records" in document;
      if (archive ? !Array.isArray(document.records) || "text" in document : typeof document.text !== "string")
        throw new Error("invalid evidence document");
      let size = 0;
      if (archive) {
        if (document.records!.length > maxChunks) throw new Error("evidence record budget exceeded");
        for (const record of document.records!) {
          if (!record || typeof record.text !== "string") throw new Error("invalid evidence record");
          size += Buffer.byteLength(record.text);
          if (size > 8 * 1024 * 1024) throw new Error("evidence source budget exceeded");
        }
      } else size = Buffer.byteLength(document.text!);
      if (size > 8 * 1024 * 1024) throw new Error("evidence source budget exceeded");
      sourceBytes += size;
      if (sourceBytes > maxIndexBytes) throw new Error("evidence index byte budget exceeded");
    }
    const previous = options.forceFull ? undefined : previousGeneration(options.store);
    const age = previous ? (options.now?.() ?? Date.now()) - Date.parse(previous.createdAt) : Infinity;
    const compatible = options.validation && previous?.validation && age >= 0 && age <= 30 * 86400000 &&
      previous.validation.projectHash === options.validation.projectHash &&
      previous.validation.scopeHash === options.validation.scopeHash;
    const oldSources = new Map(compatible ? previous!.validation!.sources.map(ref => [ref.sourceId, ref]) : []);
    const newSources = new Map(options.validation?.sources.map(ref => [ref.sourceId, ref]) ?? []);
    const oldArchives = new Map<string, ArchiveChunk[]>();
    if (compatible) for (const chunk of previous!.chunks) {
      if (!("locator" in chunk) || chunk.locator.kind !== "archive") continue;
      const oldRef = oldSources.get(chunk.sourceId), newRef = newSources.get(chunk.sourceId);
      if (!oldRef || !newRef || oldRef.sourcePath !== newRef.sourcePath ||
          oldRef.scope.kind !== newRef.scope.kind || oldRef.scope.id !== newRef.scope.id) continue;
      const group = oldArchives.get(chunk.sourceId) ?? [];
      group.push(chunk as ArchiveChunk); oldArchives.set(chunk.sourceId, group);
    }
    const chunks: EvidenceChunk[] = [];
    let reusedArchiveChunks = 0;
    for (const document of options.documents) {
      const remaining = maxChunks - chunks.length;
      if (!remaining && !("records" in document)) throw new Error("evidence chunk budget exceeded");
      const archive = "records" in document ? incrementalArchiveEvidence({ ...document, records: document.records! },
        oldSources.get(document.sourceId)?.archiveCheckpoint && document.canReuseArchive?.(oldSources.get(document.sourceId)!.archiveCheckpoint) === true ?
          oldArchives.get(document.sourceId) ?? [] : [], remaining) : undefined;
      reusedArchiveChunks += archive?.reusedChunks ?? 0;
      const projected = archive ? archive.chunks :
        document.fileProjection ? chunkFileEvidence({ ...document, text: document.text!, fileProjection: document.fileProjection }, remaining) :
        chunkEvidence({ ...document, text: document.text! }, 2048, remaining);
      for (const chunk of projected) chunks.push(chunk);
    }
    let vectors: EvidenceVectorSnapshot | undefined;
    if (options.buildVectors) {
      const priorVectors = previous?.vectors?.identity.project === options.store.projectRoot ? previous.vectors : undefined;
      const generated = await options.buildVectors(Object.freeze(chunks.map(chunk => Object.freeze({ ...chunk,
        ...("locator" in chunk ? { locator: Object.freeze({ ...chunk.locator }) } : {}) }))), priorVectors);
      if (generated) {
        vectors = readEvidenceVectorSnapshot(generated, generated.identity, maxIndexBytes);
        if (vectors.identity.project !== options.store.projectRoot) throw Error("invalid evidence vector project");
      }
    }
    const body = { schemaVersion: 1 as const, ...(vectors ? { vectors } : {}), createdAt: new Date(options.now?.() ?? Date.now()).toISOString(), chunks, ...(options.validation ? { validation: options.validation } : {}) };
    const canonical = Buffer.from(JSON.stringify(body));
    if (canonical.length > maxIndexBytes) throw new Error("evidence index byte budget exceeded");
    const generation = `gen-${hash(canonical)}.json`;
    const bytes = Buffer.from(JSON.stringify({ ...body, generation }));
    if (bytes.length > maxIndexBytes) throw new Error("evidence index byte budget exceeded");
    parseGeneration(bytes, hash(bytes)); // Validate staging with the reader contract before publication.
    if (!await options.validateSources(chunks)) throw new Error("evidence source changed during build");
    const pointer = Buffer.from(JSON.stringify({ schemaVersion: 1, generation, sha256: hash(bytes) }));
    options.store.withWriter(() => {
      options.store.checkBuildLease(buildLease);
      options.beforePublish?.();
      const existing = options.store.read(generation, MAX_INDEX_BYTES);
      if (existing && !existing.equals(bytes)) throw new Error("immutable evidence generation collision");
      if (!existing) options.store.writeAtomic(generation, bytes);
      options.beforePublish?.();
      options.store.writeAtomic("CURRENT", pointer);
    });
    return { generation, chunkCount: chunks.length, reusedArchiveChunks };
  } finally { if (!options.buildLease) buildLease.release(); }
}

/** Reads one checksum-verified immutable generation; corruption never yields partial results. */
export function searchEvidenceGeneration(store: EvidenceStorage, query: string, limit = 10) {
  const current = store.read("CURRENT", 4096);
  if (!current) return { code: "index-absent" as const, items: [] as EvidenceChunk[] };
  try {
    const pointer = parsePointer(current), bytes = store.read(pointer.generation, MAX_INDEX_BYTES);
    if (!bytes) throw new Error("evidence generation missing");
    const generation = parseGeneration(bytes, pointer.sha256);
    if (generation.generation !== pointer.generation) throw new Error("evidence generation mismatch");
    return { code: "ok" as const, generation: generation.generation, items: searchLexical(generation.chunks, query, limit) };
  } catch {
    return { code: "index-corrupt" as const, items: [] as EvidenceChunk[] };
  }
}


/** Owner maintenance: age of verified derived data, independent of current config. */
export function evidenceGenerationRetentionStatus(store: EvidenceStorage) {
  const current = store.read("CURRENT", 4096);
  if (!current) return "index-absent" as const;
  try {
    const pointer = parsePointer(current), bytes = store.read(pointer.generation, MAX_INDEX_BYTES);
    if (!bytes) throw Error("generation missing");
    const generation = parseGeneration(bytes, pointer.sha256);
    if (generation.generation !== pointer.generation) throw Error("generation mismatch");
    const age = Date.now() - Date.parse(generation.createdAt);
    if (!Number.isFinite(age) || age < 0) return "index-corrupt" as const;
    return age > 30 * 86400000 ? "retention-expired" as const : "ok" as const;
  } catch { return "index-corrupt" as const; }
}

/** Derived-store metadata only. Does not validate/read sources or return excerpt bodies. */
export function evidenceGenerationStatus(store: EvidenceStorage, scopeHash: string) {
  const current = store.read("CURRENT", 4096);
  if (!current) return { code: "index-absent" as const };
  try {
    const pointer = parsePointer(current), bytes = store.read(pointer.generation, MAX_INDEX_BYTES);
    if (!bytes) throw Error("generation missing");
    const generation = parseGeneration(bytes, pointer.sha256);
    if (generation.generation !== pointer.generation) throw Error("generation mismatch");
    const v = generation.validation;
    if (!v || v.scopeHash !== scopeHash || v.projectHash !== hash(Buffer.from(store.projectRoot)))
      return { code: "index-incompatible" as const };
    const age = Date.now() - Date.parse(generation.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > 30 * 86400000) return { code: "retention-expired" as const };
    return { code: "ok" as const, sourceCount: v.sources.length, chunkCount: generation.chunks.length };
  } catch { return { code: "index-corrupt" as const }; }
}

type Lifecycle = ReturnType<typeof createEvidenceLifecycle>;
export type SourceWithholdingReason = "stale-source" | "source-denied" | "source-removed" | "source-unreadable";
interface ValidatedOptions {
  store: EvidenceStorage; lifecycle: Lifecycle; scopeHash: string;
  validateSources: (sources: readonly SourceReference[], signal: AbortSignal, chunks: readonly EvidenceChunk[]) => Promise<boolean>;
  selectSources?: (sources: readonly SourceReference[], signal: AbortSignal, chunks: readonly EvidenceChunk[]) => Promise<{
    sources: readonly SourceReference[]; diagnostics: SourceWithholdingReason[];
  } | undefined>;
  /** Owner-side synchronous identity/version check at the final serialized handoff. */
  confirmSources: (sources: readonly SourceReference[]) => boolean;
  timeoutMs?: number; now?: () => number;
}
const RETENTION_MS = 30 * 86400000;
function freezeSources(sources: readonly SourceReference[]): readonly SourceReference[] {
  return Object.freeze(sources.map(ref => Object.freeze({ ...ref, scope: Object.freeze({ ...ref.scope }),
    ...(ref.archiveCheckpoint ? { archiveCheckpoint: Object.freeze({ ...ref.archiveCheckpoint }) } : {}) })));
}
function expired(generation: Generation, options: ValidatedOptions) {
  const age = (options.now?.() ?? Date.now()) - Date.parse(generation.createdAt);
  return !Number.isFinite(age) || age < 0 || age > RETENTION_MS;
}

function validateOptions(options: ValidatedOptions) {
  if (!/^[a-f0-9]{64}$/.test(options.scopeHash) || typeof options.confirmSources !== "function" ||
      typeof options.validateSources !== "function" || !Number.isSafeInteger(options.timeoutMs ?? 5000) ||
      (options.timeoutMs ?? 5000) < 1 || (options.timeoutMs ?? 5000) > 30000) throw new Error("invalid evidence validation options");
}
function createValidationLease(signal: AbortSignal, deadline: number) {
  const controller = new AbortController();
  let cancel: () => void = () => {};
  const stop = () => { controller.abort(); cancel(); };
  const cancelled = new Promise<boolean>(resolve => { cancel = () => resolve(false); });
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, Math.max(0, deadline - performance.now()));
  if (signal.aborted) stop();
  return {
    signal: controller.signal,
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted || performance.now() >= deadline) throw Error("evidence build deadline exceeded");
      const value = await Promise.race([
        cancelled.then((): never => { throw Error("evidence build cancelled"); }),
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw Error("evidence build cancelled");
          return work();
        }),
      ]);
      if (controller.signal.aborted || performance.now() >= deadline) throw Error("evidence build deadline exceeded");
      return value;
    },
    async validate(options: ValidatedOptions, sources: readonly SourceReference[], chunks: readonly EvidenceChunk[]) {
      return await Promise.race([
        cancelled,
        Promise.resolve().then(() => controller.signal.aborted ? false : options.validateSources(sources, controller.signal, chunks)),
      ]) === true && !controller.signal.aborted && performance.now() < deadline;
    },
    close() { clearTimeout(timer); signal.removeEventListener("abort", stop); stop(); },
  };
}
/** Internal P1 entrypoint. Raw publication above is a storage primitive, not a retrieval surface. */
export async function publishValidatedEvidenceGeneration(options: ValidatedOptions & {
  buildLease?: ReturnType<EvidenceStorage["acquireBuild"]>;
  documents: readonly (SourceReference & EvidenceDocument)[]; maxChunks?: number; maxIndexBytes?: number;
  forceFull?: boolean;
  buildVectors?: (chunks: readonly EvidenceChunk[], previous: EvidenceVectorSnapshot | undefined, signal: AbortSignal) => Promise<EvidenceVectorSnapshot | undefined>;
}) {
  validateOptions(options);
  const sources = freezeSources(options.documents.map(({ sourceId, sourcePath, versionHash, scope, archiveCheckpoint }) =>
    ({ sourceId, sourcePath, versionHash, scope: { ...scope }, ...(archiveCheckpoint ? { archiveCheckpoint } : {}) })));
  if (new Set(sources.map(ref => ref.sourceId)).size !== sources.length) throw new Error("duplicate evidence source");
  const reader = options.lifecycle.beginReaders(sources.map(ref => ref.scope));
  const deadline = performance.now() + (options.timeoutMs ?? 5000);
  const validation = createValidationLease(reader.signal, deadline);
  try {
    const { buildVectors, ...publicationOptions } = options;
    return await publishEvidenceGeneration({ ...publicationOptions,
      validation: { projectHash: hash(Buffer.from(options.store.projectRoot)), scopeHash: options.scopeHash, sources },
      ...(buildVectors ? { buildVectors: (chunks: readonly EvidenceChunk[], previous: EvidenceVectorSnapshot | undefined) =>
        validation.run(async () => {
          reader.checkpoint();
          const result = await buildVectors(chunks, previous, validation.signal);
          reader.checkpoint();
          return result;
        }) } : {}),
      validateSources: chunks => validation.validate(options, sources, chunks),
      beforePublish: () => {
        reader.checkpoint();
        if (options.confirmSources(sources) !== true || performance.now() >= deadline) throw new Error("evidence source changed before publication");
        reader.checkpoint(); // Confirmation must not close or poison a checked reader.
      },
    });
  } finally { validation.close(); reader.close(); }
}
export interface ValidatedSearchResult {
  code: "ok" | "index-absent" | "index-corrupt" | "source-unavailable";
  items: EvidenceChunk[]; generation?: string; corpusChunkCount?: number; packingOmitted?: boolean; diagnostics?: (SourceWithholdingReason | "semantic-fallback")[]; reason?: "retention-expired" | "index-incompatible" | "stale-source";
}
/**
 * Trusted owner transport seam only: handoff must synchronously serialize to the transport,
 * never retain excerpts for later delivery. Agent input must never supply these callbacks.
 * Native async functions are refused before invocation; thenable returns are a programmer error,
 * not a sandbox for an arbitrary callback (which could schedule work even while returning void).
 */
export async function searchValidatedEvidenceGeneration<T>(
  options: ValidatedOptions & { query: string; limit?: number;
    expectedVectorIdentity?: EvidenceVectorSnapshot["identity"];
    rank?: (chunks: readonly EvidenceChunk[], vectors: EvidenceVectorSnapshot | undefined, signal: AbortSignal) => Promise<{
      items: { chunk: EvidenceChunk; score: number }[]; diagnostics: ("semantic-fallback")[];
    }>;
  },
  handoff: (result: ValidatedSearchResult) => T & (T extends PromiseLike<unknown> ? never : unknown),
): Promise<T> {
  validateOptions(options);
  if (typeof handoff !== "function" || Object.prototype.toString.call(handoff) === "[object AsyncFunction]")
    throw new Error("evidence handoff must be synchronous");
  const send = (result: ValidatedSearchResult): T => {
    const value = handoff(result);
    if (value && typeof (value as { then?: unknown }).then === "function") throw new Error("evidence handoff must be synchronous");
    return value;
  };
  searchLexical([], options.query, options.limit ?? 10);
  // Protect CURRENT selection and generation loading from foreign GC.
  let releaseSnapshot: (() => void) | undefined;
  try { releaseSnapshot = options.store.pinReaders(); } catch { /* fail closed */ }
  if (!releaseSnapshot) return send({ code: "source-unavailable", items: [] });
  try {
  let snapshotEpoch: number;
  try { snapshotEpoch = options.lifecycle.currentEpoch(); }
  catch { return send({ code: "source-unavailable", items: [] }); }
  let generation: Generation | undefined;
  let readError = false;
  try {
    const current = options.store.read("CURRENT", 4096);
    if (current) {
      const pointer = parsePointer(current), bytes = options.store.read(pointer.generation, MAX_INDEX_BYTES);
      if (!bytes) throw new Error("evidence generation missing");
      generation = parseGeneration(bytes, pointer.sha256);
      if (generation.generation !== pointer.generation) throw new Error("evidence generation mismatch");
    }
  } catch { readError = true; }
  // Storage exceptions must never catch a transport exception and invoke it twice.
  if (readError) return send({ code: "index-corrupt", items: [] });
  if (!generation) return send({ code: "index-absent", items: [] });
  const v = generation.validation;
  if (!v || v.scopeHash !== options.scopeHash || v.projectHash !== hash(Buffer.from(options.store.projectRoot)))
    return send({ code: "source-unavailable", generation: generation.generation, reason: "index-incompatible", items: [] });
  if (generation.vectors && options.expectedVectorIdentity) {
    try { readEvidenceVectorSnapshot(generation.vectors, options.expectedVectorIdentity); }
    catch {
      return send({ code: "source-unavailable", generation: generation.generation,
        reason: "index-incompatible", items: [] });
    }
  }
  if (expired(generation, options))
    return send({ code: "source-unavailable", generation: generation.generation, reason: "retention-expired", items: [] });
  let reader: ReturnType<Lifecycle["beginReaders"]>;
  try { reader = options.lifecycle.beginReaders(v.sources.map(ref => ref.scope), snapshotEpoch); }
  catch { return send({ code: "source-unavailable", generation: generation.generation, items: [] }); }
  const deadline = performance.now() + (options.timeoutMs ?? 5000);
  const validation = createValidationLease(reader.signal, deadline);
  try {
    let valid = false;
    let eligibleSources = v.sources;
    let diagnostics: SourceWithholdingReason[] = [];
    const validationOptions: ValidatedOptions = options.selectSources ? { ...options,
      validateSources: async (sources, signal, chunks) => {
        const selected = await options.selectSources!(sources, signal, chunks);
        if (!selected || !Array.isArray(selected.sources) || !Array.isArray(selected.diagnostics)) return false;
        const referenceKey = (ref: SourceReference) => JSON.stringify([ref.sourceId, ref.sourcePath, ref.versionHash, ref.scope.kind, ref.scope.id]);
        const known = new Set(sources.map(referenceKey));
        if (selected.sources.some(ref => !known.has(referenceKey(ref))) ||
            new Set(selected.sources.map(ref => ref.sourceId)).size !== selected.sources.length ||
            selected.diagnostics.some(reason => !["stale-source", "source-denied", "source-removed", "source-unreadable"].includes(reason))) return false;
        const ids = new Set(selected.sources.map(ref => ref.sourceId));
        eligibleSources = sources.filter(ref => ids.has(ref.sourceId));
        if ((eligibleSources.length < sources.length) !== (selected.diagnostics.length > 0)) return false;
        diagnostics = [...new Set(selected.diagnostics)];
        return true;
      },
    } : options;
    try { valid = await validation.validate(validationOptions, v.sources, generation.chunks); reader.checkpoint(); }
    catch { /* No stale excerpts on validation/ledger failure. */ }
    if (!valid) return send({ code: "source-unavailable", generation: generation.generation, reason: "stale-source", items: [] });
    if (v.sources.length && !eligibleSources.length)
      return send({ code: "source-unavailable", generation: generation.generation, diagnostics, items: [] });
    const ids = new Set(eligibleSources.map(ref => ref.sourceId));
    const eligibleChunks = generation.chunks.filter(chunk => ids.has(chunk.sourceId));
    let ranked;
    try {
      ranked = options.rank ? await validation.run(() => options.rank!(eligibleChunks, generation.vectors, validation.signal)) :
        { items: searchLexicalRanked(eligibleChunks, options.query, options.limit ?? 10), diagnostics: [] };
      reader.checkpoint();
      const allowed = new Set(eligibleChunks);
      if (ranked.items.length > (options.limit ?? 10) || ranked.items.some(row => !allowed.has(row.chunk) || !Number.isFinite(row.score) || row.score < 0))
        throw Error("invalid evidence ranking");
    } catch { return send({ code: "source-unavailable", generation: generation.generation, items: [] }); }
    const result: ValidatedSearchResult = { code: "ok", generation: generation.generation,
      diagnostics: [...diagnostics, ...ranked.diagnostics], corpusChunkCount: eligibleChunks.length,
      items: ranked.items.map(({ chunk, score }) => ({ ...chunk, score })) };
    let entered = false, reason: "stale-source" | "retention-expired" = "stale-source";
    try {
      return reader.deliver(() => {
        if (options.confirmSources(eligibleSources) !== true) throw new Error("evidence source changed before delivery");
        if (expired(generation, options)) { reason = "retention-expired"; throw new Error("evidence retention expired"); }
        if (performance.now() >= deadline) throw new Error("evidence validation deadline exceeded");
        reader.checkpoint(); // Final ledger/cancellation check after every owner callback.
        entered = true; return send(result);
      });
    } catch (error) {
      if (entered) throw error;
      return send({ code: "source-unavailable", generation: generation.generation, reason, items: [] });
    }
  } finally { validation.close(); reader.close(); }
  } finally { releaseSnapshot(); }
}
