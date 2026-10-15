/** Public v1 contracts; raw evidence is never policy or accepted knowledge. */
export type EvidenceDiagnostic = "empty-corpus" | "semantic-fallback" | "index-corrupt" |
  "index-incompatible" | "ledger-unavailable" | "stale-source" | "source-denied" |
  "source-removed" | "source-unreadable" | "retention-expired" | "visible-filtered" |
  "visibility-unstable" | "packing-budget" | "query-budget" | "query-timeout" |
  "index-absent" | "disabled";
export type EvidenceLocator =
  { kind: "file"; startByte: number; endByte: number; startLine: number; endLine: number } |
  { kind: "archive"; startByte: number; endByte: number; recordId: string };
export interface EvidenceItem {
  sourceId: string; sourcePath: string; versionHash: string; chunkId: string;
  contentHash: string; locator: EvidenceLocator; text: string; role: string | null;
  timestamp: string | null; trustedAsPolicy: false; redaction: "not-needed" | "applied"; score: number;
}
export type EvidenceSearchResult = {
  schemaVersion: 1; diagnostics: EvidenceDiagnostic[];
} & (
  { code: "ok" | "no-match"; coverage: "full" | "partial"; generation: string; items: EvidenceItem[] } |
  { code: "index-absent" | "disabled" | "budget-exceeded" | "source-unavailable" | "timeout";
    coverage: "unknown"; generation: string | null; items: [] }
);
export const sanitizerVersion = "erl-harness-scanner-v1";
