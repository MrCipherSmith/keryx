import path from "node:path";
import { ArchiveCursor } from "./archive-cursor";
import { createSessionEvidenceOwner } from "../session/evidence-revocation";
import { keryxDataDir } from "../session/paths";
import { projectEvidenceSearch, type PublicEvidenceSearchResult } from "./projection";
import { FILE_CHUNKER_VERSION } from "./file-chunks";
import { ARCHIVE_CHUNKER_VERSION } from "./archive-chunks";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { parseEvidenceConfig } from "./config";
import { createEvidenceService, loadEvidenceConfig, type EvidenceServiceOptions } from "./service";
import { createEvidenceSourceOwner, evidenceSourceIdentity } from "./source-owner";
import { openEvidenceStorage, EvidenceStorageAbsentError } from "./storage";
import { createEvidenceLifecycle, type EvidenceSourceScope } from "./lifecycle";
import { publishValidatedEvidenceGeneration, searchValidatedEvidenceGeneration, evidenceGenerationStatus, evidenceGenerationRetentionStatus,
  type EvidenceDocument, type ValidatedSearchResult } from "./index";
import { searchLexical, EVIDENCE_CHUNKER_VERSION } from "./search";
import { sanitizerVersion } from "./types";
import { collectEvidenceFiles } from "./inventory";
import { createEvidenceEmbeddingBuilder, type EvidenceEmbeddingOptions } from "./embedding-builder";
import { rankEvidenceHybrid, evidenceVectorKey, type EvidenceSemanticPool } from "./hybrid";
import { readEvidenceVectorSnapshot } from "./vector-cache";
import { chunkEvidence } from "./search";
import { createEvidenceScanner } from "./sources";

// Internal transport seam, NOT the public search-result schema. No CLI/tool uses it yet.
export type EvidenceRuntimeSearchResult = ValidatedSearchResult | {
  code: "disabled" | "timeout" | "budget-exceeded"; items: []; generation?: string;
};
type BuildResult = { code: "ok"; generation: string; chunkCount: number } |
  { code: "disabled" | "timeout" | "source-unavailable" | "budget-exceeded" };
/** Trusted owner construction only: neither source scopes nor callbacks come from tool options. */
export async function createEvidenceRuntime(options: EvidenceServiceOptions & { embedding?: EvidenceEmbeddingOptions }) {
  const parsed = parseEvidenceConfig(options.config);
  if (!parsed.ok) return parsed;
  const config = parsed.config;
  if (config.enabled && config.mode === "hybrid" && !options.embedding)
    return { ok: false as const, diagnostics: ["hybrid-owner-unavailable"] };
  // Capture options before the first await; callers cannot redirect a pending operation.
  const embedding = options.embedding ? Object.freeze({ ...options.embedding,
    identity: Object.freeze({ ...options.embedding.identity }), spec: Object.freeze({ ...options.embedding.spec }) }) : undefined;
  const buildVectors = config.enabled && config.mode === "hybrid" && embedding ? createEvidenceEmbeddingBuilder(embedding) : undefined;
  const embedQuery = config.enabled && config.mode === "hybrid" && embedding ? createEvidenceEmbeddingBuilder(embedding, "query") : undefined;
  const projectRoot = options.projectRoot, dataDir = path.resolve(keryxDataDir(options.dataDir)), scannerFactory = options.scannerFactory;
  let root = projectRoot, identity: { dev: number; ino: number } | undefined;
  if (config.enabled) {
    try {
      root = await realpath(projectRoot);
      const current = await lstat(root);
      if (!current.isDirectory() || current.isSymbolicLink()) throw Error("invalid root");
      identity = { dev: current.dev, ino: current.ino };
    } catch { return { ok: false as const, diagnostics: ["source-unreadable"] }; }
  }
  const ownerOptions = { projectRoot: root, config,
    ...(dataDir !== undefined ? { dataDir } : {}), ...(scannerFactory ? { scannerFactory } : {}) };
  const facade = await createEvidenceService(ownerOptions);
  if (!facade.ok) return facade;
  const scopeHash = createHash("sha256").update(JSON.stringify([
    "erl-runtime-retrieval-v1", root, dataDir ?? null, { ...config, automatic: false }, EVIDENCE_CHUNKER_VERSION, FILE_CHUNKER_VERSION, ARCHIVE_CHUNKER_VERSION, sanitizerVersion,
  ])).digest("hex");
  let state: { store: ReturnType<typeof openEvidenceStorage>; lifecycle: ReturnType<typeof createEvidenceLifecycle> } | undefined;
  let closed = false, busy = false, revoking = 0;
  const archiveCursor = new ArchiveCursor();
  let cursorEpoch: number | undefined;
  function checkRoot() {
    if (closed) throw Error("evidence runtime closed");
    const current = lstatSync(root);
    if (!identity || current.isSymbolicLink() || !current.isDirectory() ||
        current.dev !== identity.dev || current.ino !== identity.ino) throw Error("evidence root changed");
  }
  function resources(create = true) {
    checkRoot();
    if (!state) {
      const store = openEvidenceStorage(root, create);
      try { state = { store, lifecycle: createEvidenceLifecycle(store, { create }) }; }
      catch (error) { store.close(); throw error; }
    }
    return state;
  }
  function lease(parent?: AbortSignal, outerDeadline = Infinity) {
    const controller = new AbortController(), deadline = Math.min(performance.now() + config.timeoutMs, outerDeadline);
    const abort = () => controller.abort();
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    const timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
    return { signal: controller.signal,
      active: () => !controller.signal.aborted && performance.now() < deadline,
      close() { clearTimeout(timer); parent?.removeEventListener("abort", abort); controller.abort(); },
    };
  }
  async function verifier(operation: ReturnType<typeof lease>, checkpoint: () => void = () => {}, reuseArchive = false) {
    checkRoot();
    const result = await createEvidenceSourceOwner({ ...ownerOptions,
      ...(reuseArchive ? { archiveCursor: { cursor: archiveCursor, checkpoint } } : {}) });
    checkRoot();
    if (result.code !== "ok" || !operation.active()) throw Error("evidence owner unavailable");
    return {
      validateSources: async (...args: Parameters<typeof result.owner.validateSources>) => {
        if (!operation.active()) return false;
        checkpoint();
        checkRoot();
        const valid = await result.owner.validateSources(args[0], AbortSignal.any([args[1], operation.signal]), args[2]);
        checkpoint();
        checkRoot(); return valid && operation.active();
      },
      selectSources: async (...args: Parameters<typeof result.owner.validateEligibleSources>) => {
        if (!operation.active()) return undefined;
        checkpoint(); checkRoot();
        const selected = await result.owner.validateEligibleSources(args[0], AbortSignal.any([args[1], operation.signal]), args[2]);
        checkpoint(); checkRoot();
        return operation.active() ? selected : undefined;
      },
      confirmSources: (sources: Parameters<typeof result.owner.confirmSources>[0]) => {
        checkpoint();
        checkRoot();
        if (!operation.active()) return false;
        const confirmed = result.owner.confirmSources(sources);
        checkpoint();
        return confirmed && operation.active();
      },
    };
  }
  const sessionOwner = createSessionEvidenceOwner({ projectRoot: root, revokeAndDrain: async scope => {
    if (!config.enabled || closed) throw Error("evidence owner unavailable");
    await resources().lifecycle.revokeAndDrain({ kind: scope.sourceKind, id: scope.sessionId });
  } });
  const runtime = Object.freeze({
    /** Trusted session-owner port only; deliberately absent from CLI/tool inputs. */
    async revokeSessionEvidence(sessionId: string) {
      archiveCursor.clear();
      revoking++;
      try { return await sessionOwner.revokeSessionEvidence(sessionId); }
      finally { revoking--; }
    },
    async build(input: readonly EvidenceSourceScope[], signal?: AbortSignal, outerDeadline = Infinity, forceFull = false): Promise<BuildResult> {
      if (!config.enabled) return { code: "disabled" };
      if (typeof outerDeadline !== "number" || Number.isNaN(outerDeadline)) return { code: "source-unavailable" };
      if (signal !== undefined && !(signal instanceof AbortSignal)) return { code: "source-unavailable" };
      if (signal?.aborted) return { code: "timeout" };
      if (closed || busy || revoking) return { code: "source-unavailable" };
      busy = true;
      const operation = lease(signal, outerDeadline);
      let reader: ReturnType<ReturnType<typeof createEvidenceLifecycle>["beginReaders"]> | undefined;
      let buildLease: ReturnType<ReturnType<typeof openEvidenceStorage>["acquireBuild"]> | undefined;
      try {
        if (!operation.active()) return { code: "timeout" };
        if (!Array.isArray(input) || input.length > config.maxChunks) return { code: "budget-exceeded" };
        const scopes = input.map(scope => ({ ...scope }));
        const refs = scopes.map(scope => evidenceSourceIdentity(root, scope));
        if (new Set(refs.map(ref => ref.sourceId)).size !== refs.length) return { code: "source-unavailable" };
        const current = resources();
        buildLease = current.store.acquireBuild();
        reader = current.lifecycle.beginReaders(scopes);
        const epoch = current.lifecycle.currentEpoch();
        if (forceFull || cursorEpoch !== epoch) archiveCursor.clear();
        cursorEpoch = epoch;
        const documents: (EvidenceDocument & { scope: EvidenceSourceScope })[] = [];
        let bytes = 0;
        for (const ref of refs) {
          if (!operation.active()) return { code: "timeout" };
          reader.checkpoint();
          const source = ref.scope.kind === "file" ? await facade.service.readSourceFile(ref.scope.id, operation.signal) :
            await facade.service.readArchive(ref.scope.id, operation.signal,
              forceFull ? undefined : { cursor: archiveCursor, checkpoint: () => reader!.checkpoint() });
          if (!operation.active()) return { code: "timeout" };
          if (source.code !== "ok") return { code: "source-unavailable" };
          const document = "text" in source ? { ...ref, versionHash: source.versionHash, text: source.text, fileProjection: source.fileProjection } :
            { ...ref, versionHash: source.versionHash, records: source.records,
              archiveCheckpoint: source.archiveCheckpoint, canReuseArchive: source.canReuseArchive };
          bytes += "text" in source ? Buffer.byteLength(source.text) : source.records.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0);
          if (bytes > config.maxIndexBytes) return { code: "budget-exceeded" };
          documents.push(document);
        }
        reader.checkpoint();
        // Retain the collection epoch through final publication.
        const collection = reader;
        const owner = await verifier(operation, () => collection.checkpoint(), !forceFull);
        const result = await publishValidatedEvidenceGeneration({ ...current, ...owner, scopeHash, documents, buildLease, forceFull,
          ...(buildVectors ? { buildVectors: (chunks, previous, signal) => {
            if (embedding!.projectRoot !== root) throw Error("evidence embedding owner mismatch");
            return buildVectors(chunks, previous, AbortSignal.any([signal, operation.signal]));
          } } : {}),
          maxChunks: config.maxChunks, maxIndexBytes: config.maxIndexBytes, timeoutMs: config.timeoutMs });
        reader.close(); reader = undefined;
        // Publication has succeeded. GC is best-effort: foreign pins or faults retain
        // superseded artifacts for the next approved rebuild/clear, never roll back CURRENT.
        try { current.lifecycle.collectSuperseded(); } catch { /* safely retain derived artifacts */ }
        return { code: "ok", ...result };
      } catch (error) {
        return { code: !operation.active() ? "timeout" : /budget/.test(String(error)) ? "budget-exceeded" : "source-unavailable" };
      } finally { reader?.close(); buildLease?.release(); operation.close(); busy = false; }
    },
    async buildConfiguredFiles(signal?: AbortSignal, forceFull = false): Promise<BuildResult> {
      const deadline = performance.now() + config.timeoutMs;
      const inventory = await collectEvidenceFiles({ projectRoot: root, config, ...(dataDir !== undefined ? { dataDir } : {}), ...(signal ? { signal } : {}) });
      if (inventory.code !== "ok") return { code: inventory.code };
      return runtime.build(inventory.scopes, signal, deadline, forceFull);
    },
    async search<T>(query: string,
      handoff: (result: EvidenceRuntimeSearchResult) => T & (T extends PromiseLike<unknown> ? never : unknown),
      signal?: AbortSignal, limit = config.maxResults): Promise<T> {
      if (typeof handoff !== "function" || Object.prototype.toString.call(handoff) === "[object AsyncFunction]")
        throw Error("evidence handoff must be synchronous");
      const send = (result: EvidenceRuntimeSearchResult): T => {
        const value = handoff(result);
        if (value && typeof (value as { then?: unknown }).then === "function") throw Error("evidence handoff must be synchronous");
        return value;
      };
      if (!config.enabled) return send({ code: "disabled", items: [] });
      if (typeof query !== "string" || Buffer.byteLength(query) > 8192 || !query.trim() ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > config.maxResults) return send({ code: "budget-exceeded", items: [] });
      searchLexical([], query, limit);
      if (signal?.aborted) return send({ code: "timeout", items: [] });
      if (closed || busy || revoking) return send({ code: "source-unavailable", items: [] });
      busy = true;
      const operation = lease(signal);
      let entered = false;
      try {
        let current;
        try { current = resources(false); }
        catch (error) {
          if (!(error instanceof EvidenceStorageAbsentError)) throw error;
          entered = true;
          return send({ code: "index-absent", items: [] });
        }
        if (!current.store.read("CURRENT", 65536)) {
          entered = true;
          return send({ code: "index-absent", items: [] });
        }
        const owner = await verifier(operation);
        return await searchValidatedEvidenceGeneration({ ...current, ...owner, scopeHash,
          ...(embedding ? { expectedVectorIdentity: embedding.identity } : {}),
          ...(config.mode === "hybrid" ? { rank: async (chunks, vectors, signal) => {
            let semantic: EvidenceSemanticPool | null = null;
            try {
              if (embedding && embedQuery && vectors && embedding.projectRoot === root) {
                const approved = readEvidenceVectorSnapshot(vectors, embedding.identity);
                const combined = AbortSignal.any([signal, operation.signal]);
                const scan = await (scannerFactory ?? createEvidenceScanner)(root, combined);
                if (!scan || combined.aborted) throw Error("evidence query scanner unavailable");
                const sanitized = await scan(query, combined);
                if (sanitized.code !== "ok" || combined.aborted) throw Error("evidence query denied");
                const queryChunks = chunkEvidence({ sourceId: "query", sourcePath: "query", versionHash: createHash("sha256").update(sanitized.text).digest("hex"), text: sanitized.text });
                if (queryChunks.length !== 1) throw Error("evidence query budget exceeded");
                const queryVector = await embedQuery(queryChunks, undefined, combined);
                const keys = new Set(chunks.map(chunk => evidenceVectorKey(embedding.identity, chunk.contentHash)));
                semantic = { identity: approved.identity, expectedIdentity: embedding.identity,
                  query: queryVector.records[0]!.values, vectors: approved.records.filter(record => keys.has(record.key)) };
              }
            } catch { /* Read-only lexical fallback; never persist a query vector. */ }
            return rankEvidenceHybrid(chunks, query, semantic, limit);
          } } : {}),
          query, limit, timeoutMs: config.timeoutMs }, result => {
          entered = true;
          if (!operation.active()) return send({ code: "timeout", items: [], ...("generation" in result && result.generation ? { generation: result.generation } : {}) }) as T & (T extends PromiseLike<unknown> ? never : unknown);
          if (result.code !== "ok") return send(result) as T & (T extends PromiseLike<unknown> ? never : unknown);
          let bytes = 0;
          const items = result.items.filter(item => {
            const cost = Buffer.byteLength(item.text);
            if (bytes + cost > config.maxTokens) return false;
            bytes += cost;
            return true;
          });
          return send({ ...result, items, packingOmitted: items.length !== result.items.length }) as T & (T extends PromiseLike<unknown> ? never : unknown);
        });
      } catch (error) {
        if (entered) throw error; // Never turn a transport error into a second delivery.
        return send({ code: operation.active() ? "source-unavailable" : "timeout", items: [] });
      } finally { operation.close(); busy = false; }
    },
    async searchPublic<T>(query: string,
      handoff: (result: PublicEvidenceSearchResult) => T & (T extends PromiseLike<unknown> ? never : unknown),
      signal?: AbortSignal, limit = config.maxResults): Promise<T> {
      if (typeof handoff !== "function" || Object.prototype.toString.call(handoff) === "[object AsyncFunction]")
        throw Error("evidence handoff must be synchronous");
      return runtime.search(query, result => handoff(projectEvidenceSearch(result, config.maxTokens)), signal, limit);
    },
    status() {
      const metadata = { mode: config.mode, model: config.mode === "hybrid" ? embedding?.identity.model ?? null : null };
      if (!config.enabled) return { ...metadata, code: "disabled" as const };
      if (closed || busy || revoking) return { ...metadata, code: "source-unavailable" as const };
      let store: ReturnType<typeof openEvidenceStorage> | undefined;
      try {
        checkRoot();
        store = openEvidenceStorage(root, false);
        const release = store.pinReaders();
        if (!release) return { ...metadata, code: "source-unavailable" as const };
        try { return { ...metadata, ...evidenceGenerationStatus(store, scopeHash) }; }
        finally { release(); }
      } catch (error) {
        return { ...metadata, code: error instanceof EvidenceStorageAbsentError ? "index-absent" as const : "source-unavailable" as const };
      } finally { store?.close(); }
    },
    /** Explicit owner mutation only: never called by search/status or automatic recall. */
    async maintenance() {
      archiveCursor.clear();
      if (!config.enabled) return { code: "disabled" as const };
      if (closed || busy || revoking) return { code: "source-unavailable" as const };
      busy = true;
      try {
        const { store, lifecycle } = resources(false);
        let absent = false;
        const cleared = await lifecycle.clearDerived(5000, () => {
          const status = evidenceGenerationRetentionStatus(store);
          if (status === "index-corrupt") throw Error("evidence generation corrupt");
          absent = status === "index-absent";
          return absent || status === "retention-expired";
        });
        if (cleared) return { code: "ok" as const, outcome: absent ? "orphan-cleared" as const : "expired-cleared" as const };
        if (absent) return { code: "index-absent" as const };
        return { code: "ok" as const, outcome: lifecycle.collectSuperseded() };
      } catch (error) {
        return { code: error instanceof EvidenceStorageAbsentError ? "index-absent" as const : "source-unavailable" as const };
      } finally { busy = false; }
    },
    async clear() {
      archiveCursor.clear();
      if (!config.enabled) return { code: "disabled" as const };
      if (closed || busy || revoking) return { code: "source-unavailable" as const };
      busy = true;
      try { await resources().lifecycle.clearDerived(); return { code: "ok" as const }; }
      catch { return { code: "source-unavailable" as const }; }
      finally { busy = false; }
    },
    close() {
      archiveCursor.clear();
      if (busy || revoking) throw Error("evidence runtime operation active");
      if (!closed) { state?.lifecycle.close(); state?.store.close(); closed = true; }
    },
  });
  return { ok: true as const, runtime };
}

/** Explicit owner-only configuration loading; never accept configuration from tool input. */
export async function loadEvidenceRuntime(options: Omit<EvidenceServiceOptions, "config">) {
  const captured = { ...options };
  const loaded = await loadEvidenceConfig(captured.projectRoot);
  if (!loaded.ok) return loaded;
  return createEvidenceRuntime({ ...captured, config: loaded.config });
}
