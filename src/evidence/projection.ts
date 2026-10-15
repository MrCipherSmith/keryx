import { isFileChunk, type FileChunk } from "./file-chunks";
import { isArchiveChunk, type ArchiveChunk } from "./archive-chunks";
import type { EvidenceRuntimeSearchResult } from "./runtime";
export type EvidenceDiagnostic = "semantic-fallback" | "source-denied" | "source-removed" | "source-unreadable" | "empty-corpus" | "index-corrupt" | "index-incompatible" | "stale-source" | "retention-expired" | "packing-budget" | "index-absent" | "disabled" | "query-timeout" | "query-budget";
export interface PublicEvidenceItem {
  sourceId: string; sourcePath: string; versionHash: string; chunkId: string; contentHash: string;
  locator: FileChunk["locator"] | ArchiveChunk["locator"]; text: string;
  role: string | null; timestamp: string | null; trustedAsPolicy: false;
  redaction: "applied" | "not-needed"; score: number;
}
export interface PublicEvidenceSearchResult {
  schemaVersion: 1; code: "ok" | "no-match" | "index-absent" | "disabled" | "budget-exceeded" | "source-unavailable" | "timeout";
  coverage: "full" | "partial" | "unknown"; generation: string | null;
  items: PublicEvidenceItem[]; diagnostics: EvidenceDiagnostic[];
}
/** Trusted runtime handoff projection only; never infer original citations from sanitized offsets. */
export function projectEvidenceSearch(input: EvidenceRuntimeSearchResult, maxTokens = 2000): PublicEvidenceSearchResult {
  const refuse = (code: PublicEvidenceSearchResult["code"], diagnostics: EvidenceDiagnostic[] = []): PublicEvidenceSearchResult =>
    ({ schemaVersion: 1, code, coverage: "unknown", generation: "generation" in input ? input.generation ?? null : null, items: [], diagnostics });
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 2000) return refuse("budget-exceeded", ["packing-budget"]);
  if (input.code !== "ok") {
    if (input.code === "index-corrupt") return refuse("source-unavailable", ["index-corrupt"]);
    const reason = "reason" in input ? input.reason : undefined;
    return refuse(input.code, reason ? [reason] : "diagnostics" in input && input.diagnostics?.length ? input.diagnostics : input.code === "disabled" || input.code === "index-absent" ? [input.code] : input.code === "timeout" ? ["query-timeout"] : input.code === "budget-exceeded" ? ["query-budget"] : []);
  }
  if (!input.generation || input.items.length > 10) return refuse("source-unavailable");
  let cost = 0, skipped = input.packingOmitted === true;
  const items: PublicEvidenceItem[] = [];
  for (const chunk of input.items) {
    const score = (chunk as typeof chunk & { score?: number }).score;
    if ((!isFileChunk(chunk) && !isArchiveChunk(chunk)) || typeof score !== "number" || !Number.isFinite(score) || score < 0)
      return refuse("source-unavailable");
    const size = Buffer.byteLength(chunk.text);
    if (cost + size > maxTokens) { skipped = true; continue; }
    cost += size;
    items.push({ sourceId: chunk.sourceId, sourcePath: chunk.sourcePath, versionHash: chunk.versionHash,
      chunkId: chunk.chunkId, contentHash: chunk.contentHash, locator: { ...chunk.locator }, text: chunk.text,
      role: chunk.role, timestamp: chunk.timestamp, trustedAsPolicy: false, redaction: chunk.redaction, score });
  }
  if ((input.items.length || skipped) && !items.length) return refuse("budget-exceeded", ["packing-budget"]);
  return { schemaVersion: 1, code: items.length ? "ok" : "no-match", coverage: input.diagnostics?.length ? "partial" : "full",
    generation: input.generation, items, diagnostics: [...(input.diagnostics ?? []), ...(skipped ? ["packing-budget" as const] : input.corpusChunkCount === 0 && !input.diagnostics?.length ? ["empty-corpus" as const] : [])] };
}
