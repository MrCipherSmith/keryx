// Mirrors `StreamEvent`/`StreamEventKind` from `src/lib/serve-turn-store.ts`
// (the real `keryx serve` turn-event schema, `stream-event.schema.json`).
// Duplicated here rather than imported because `vscode-extension/` is a
// separate TypeScript project (its own `tsconfig.json`, own `dist/`,
// deliberately outside the core CLI's `src/` compile unit — see
// `.metaproject/flows/185-.../plan.md`) with no existing cross-project
// import seam. Keep this in lockstep with the source of truth by hand; a
// schema-version mismatch is caught defensively by `output-channel-logic.ts`
// treating anything missing the required fields as unparseable rather than
// crashing.

export type StreamEventKind =
  | "turn.started"
  | "assistant.delta"
  | "tool.started"
  | "tool.finished"
  | "approval.pending"
  | "approval.resolved"
  | "turn.finished";

export interface StreamEvent {
  schemaVersion?: string;
  turnId: string;
  /** Monotonic within a turn, from 0. The resume cursor (`Last-Event-ID`). */
  seq: number;
  kind: StreamEventKind | string;
  at: string;
  text?: string;
  tool?: {
    name: string;
    summary?: string;
    decision?: "allow" | "ask" | "deny";
    outcome?: "ok" | "error" | "denied" | "refused";
  };
  approvalId?: string;
  resolution?: "allowed" | "denied" | "expired" | "undeliverable";
  /** True on the final event of a stream. */
  terminal?: boolean;
}
