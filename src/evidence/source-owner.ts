import { isSessionEvidenceId } from "../session/evidence-revocation";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { chunkEvidence } from "./search";
import { chunkFileEvidence } from "./file-chunks";
import { chunkArchiveEvidence } from "./archive-chunks";
import type { EvidenceChunk } from "./index";
import { lstat, realpath } from "node:fs/promises";
import { parseEvidenceConfig, safeRelativePath } from "./config";
import type { EvidenceSourceScope } from "./lifecycle";
import { createEvidenceScanner, readVerifiedEvidenceArchive, readVerifiedEvidenceFile, type EvidenceScanner } from "./sources";

export interface EvidenceSourceReference {
  sourceId: string; sourcePath: string; versionHash: string; scope: EvidenceSourceScope;
}
/** Runtime only: projectRoot must be the owner's canonical root, not a tool argument. */
export function evidenceSourceIdentity(projectRoot: string, scope: EvidenceSourceScope) {
  if (!scope || (scope.kind !== "file" && scope.kind !== "session-archive") ||
      (scope.kind === "file" ? !safeRelativePath(scope.id) : !isSessionEvidenceId(scope.id)))
    throw Error("invalid evidence source scope");
  return {
    sourceId: createHash("sha256").update(JSON.stringify(["erl-source-v1", projectRoot, scope.kind, scope.id])).digest("hex"),
    sourcePath: scope.kind === "file" ? scope.id : `session-archive:${scope.id}`,
    scope: Object.freeze({ ...scope }),
  };
}
/** One owner per validation lease; capabilities never appear in public results. */
export async function createEvidenceSourceOwner(options: {
  projectRoot: string; config?: unknown; dataDir?: string;
  scannerFactory?: (root: string, signal?: AbortSignal) => Promise<EvidenceScanner | undefined>;
  archiveCursor?: import("./archive-cursor").ArchiveCursorAccess;
}) {
  const parsed = parseEvidenceConfig(options.config);
  if (!parsed.ok) return { code: "source-unavailable" as const };
  const config = parsed.config;
  if (!config.enabled) return { code: "disabled" as const };
  let root: string, identity;
  try {
    root = await realpath(options.projectRoot); identity = await lstat(root);
    if (!identity.isDirectory() || identity.isSymbolicLink()) return { code: "source-unavailable" as const };
  } catch { return { code: "source-unavailable" as const }; }
  const rootIdentity = identity, factory = options.scannerFactory ?? createEvidenceScanner;
  const dataDir = options.dataDir;
  let revision = 0;
  let confirmed = new Map<string, { reference: string; confirm: () => boolean }>();
  let verifiedDeadline = 0;
  let verifiedSignal: AbortSignal | undefined;
  let withheldReasons: ("stale-source" | "source-denied" | "source-unreadable" | "source-removed")[] = [];
  // Preserve every field/value while making JSON object insertion order irrelevant.
  const projectionKey = (chunk: EvidenceChunk) => JSON.stringify(Object.keys(chunk).sort().map(key => {
    const value = (chunk as unknown as Record<string, unknown>)[key];
    return [key, key === "locator" && value && typeof value === "object" ?
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)) : value];
  }));
  const key = (ref: EvidenceSourceReference) => JSON.stringify([ref.sourceId, ref.sourcePath, ref.versionHash, ref.scope.kind, ref.scope.id]);
  function valid(ref: EvidenceSourceReference) {
    try {
      if (!ref || !/^[a-f0-9]{64}$/.test(ref.versionHash)) return false;
      const expected = evidenceSourceIdentity(root, ref.scope);
      return ref.sourceId === expected.sourceId && ref.sourcePath === expected.sourcePath &&
        (ref.scope.kind !== "session-archive" || config.sessionArchives);
    } catch { return false; }
  }
  const owner = Object.freeze({
    async validateSources(input: readonly EvidenceSourceReference[], signal: AbortSignal, chunks?: readonly EvidenceChunk[], allowPartial = false): Promise<boolean> {
      const attempt = ++revision;
      confirmed = new Map(); verifiedDeadline = 0; verifiedSignal = undefined; withheldReasons = [];
      if (signal.aborted || !Array.isArray(input) || input.length > config.maxChunks ||
          !input.every(valid) || new Set(input.map(ref => ref.sourceId)).size !== input.length) return false;
      // Snapshot before the first await: callers cannot redirect a pending read.
      if (chunks !== undefined && (!Array.isArray(chunks) || chunks.length > config.maxChunks)) return false;
      const projection = chunks?.map(chunk => "locator" in chunk ? { ...chunk, locator: { ...chunk.locator } } : { ...chunk });
      const sources = input.map(ref => ({ ...ref, scope: { ...ref.scope } }));
      const deadline = performance.now() + config.timeoutMs;
      const approved = new Map<string, string>();
      const checks = new Map<string, { reference: string; confirm: () => boolean }>();
      const reasons = new Set<"stale-source" | "source-denied" | "source-unreadable" | "source-removed">();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel: () => void = () => {};
      const cancelled = new Promise<boolean>(resolve => {
        cancel = () => resolve(false);
        signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(cancel, config.timeoutMs);
        if (signal.aborted) cancel();
      });
      const active = () => !signal.aborted && attempt === revision && performance.now() < deadline;
      const work = async () => {
        try {
          const current = await lstat(root);
          if (!active() || current.isSymbolicLink() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) return false;
          const scanner = sources.length ? await factory(root, signal) : undefined;
          if (!active() || (sources.length && !scanner)) return false;
          for (const ref of sources) {
            if (!active()) return false;
            const common = { projectRoot: root, expectedRootIdentity: rootIdentity, maxSourceBytes: config.maxSourceBytes,
              maxRecords: config.maxChunks, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), signal,
              ...(scanner ? { scanner } : {}) };
            const result = ref.scope.kind === "file" ?
              await readVerifiedEvidenceFile({ ...common, path: ref.scope.id, roots: config.roots }) :
              await readVerifiedEvidenceArchive({ ...common, sessionId: ref.scope.id, sessionArchives: config.sessionArchives,
                ...(options.archiveCursor ? { cursorAccess: options.archiveCursor } : {}),
                ...(dataDir !== undefined ? { dataDir } : {}) });
            if (!active()) return false;
            if (result.code !== "ok" || result.versionHash !== ref.versionHash) {
              if (!allowPartial || (result.code !== "ok" && result.code !== "source-unavailable")) return false;
              const reason = result.code === "ok" ? "stale-source" : result.diagnostics[0];
              reasons.add(reason === "source-denied" || reason === "source-removed" || reason === "stale-source" ? reason : "source-unreadable");
              continue;
            }
            if (projection !== undefined) {
              const remaining = config.maxChunks - approved.size;
              if (remaining < 1 && "text" in result) return false;
              const reconstructed = "text" in result ? (projection.some(chunk => chunk.sourceId === ref.sourceId && "locator" in chunk) ?
                  chunkFileEvidence({ ...ref, text: result.text, fileProjection: result.fileProjection }, remaining) :
                  chunkEvidence({ ...ref, text: result.text }, 2048, remaining)) :
                chunkArchiveEvidence({ ...ref, records: result.records }, remaining);
              for (const chunk of reconstructed) approved.set(chunk.chunkId, projectionKey(chunk));
            }
            checks.set(ref.sourceId, { reference: key(ref), confirm: result.confirm });
          }
          if (projection !== undefined) {
            const sourceIds = new Set(sources.map(ref => ref.sourceId));
            if (projection.some(chunk => !sourceIds.has(chunk.sourceId)) ||
                new Set(projection.map(chunk => chunk.chunkId)).size !== projection.length) return false;
            const eligible = allowPartial ? projection.filter(chunk => checks.has(chunk.sourceId)) : projection;
            if (eligible.length !== approved.size || eligible.some(chunk => approved.get(chunk.chunkId) !== projectionKey(chunk))) return false;
          }
          return active();
        } catch { return false; }
      };
      try {
        const success = await Promise.race([work(), cancelled]);
        if (success !== true || !active()) return false;
        confirmed = checks; verifiedDeadline = deadline; verifiedSignal = signal; withheldReasons = [...reasons];
        return true;
      } finally {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      }
    },
    async validateEligibleSources(input: readonly EvidenceSourceReference[], signal: AbortSignal, chunks: readonly EvidenceChunk[]): Promise<{
      sources: readonly EvidenceSourceReference[];
      diagnostics: ("stale-source" | "source-denied" | "source-unreadable" | "source-removed")[];
    } | undefined> {
      if (!Array.isArray(input)) return undefined;
      const sources = input.map(ref => ({ ...ref, scope: { ...ref.scope } }));
      const pending = owner.validateSources(sources, signal, chunks, true);
      const attempt = revision;
      if (!await pending || attempt !== revision || signal.aborted) return undefined;
      return {
        sources: Object.freeze(sources.filter(ref => confirmed.has(ref.sourceId)).map(ref => Object.freeze({ ...ref, scope: Object.freeze(ref.scope) }))),
        diagnostics: [...withheldReasons],
      };
    },
    confirmSources(sources: readonly EvidenceSourceReference[]) {
      try {
        const current = lstatSync(root);
        if (!verifiedSignal || verifiedSignal.aborted || current.isSymbolicLink() ||
            current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino || !Array.isArray(sources) || performance.now() >= verifiedDeadline || sources.length !== confirmed.size ||
            new Set(sources.map(ref => ref.sourceId)).size !== sources.length) return false;
        return sources.every(ref => {
          if (!valid(ref)) return false;
          const check = confirmed.get(ref.sourceId);
          return check?.reference === key(ref) && check.confirm() === true;
        });
      } catch { return false; }
    },
  });
  return { code: "ok" as const, owner };
}
