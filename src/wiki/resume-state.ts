// Shared `ResumeState` shape for `wiki enrich` (flow 169 T5/T7/T9).
//
// Hoisted out of `enrich.ts` into its own module (flow 169 T9, code-verifier
// finding #1) so `staleness.ts` can import the TYPE without creating an
// `enrich.ts` <-> `staleness.ts` import cycle: before this split,
// `staleness.ts` did `import type { ResumeState } from "./enrich"` while
// `enrich.ts` imports `checkPageStalenessGate`/`computePageNodeHash`/
// `isPageUnchangedSinceLastEnrich` from `./staleness` at runtime — type-only
// on one side, but this repo's `keryx gdgraph query cycles` treats type-only
// edges the same as value edges, so it still flagged as a structural cycle.
// `enrich.ts` re-exports this type (`export type { ResumeState } from
// "./resume-state"`) so existing importers of `ResumeState` from `./enrich`
// (e.g. `enrich.test.ts`) do not need to change their import path.

export interface ResumeState {
  updatedAt: string;
  provider?: string;
  model?: string;
  completed: string[];
  /**
   * Per-page staleness (TRD §3.3, flow 169 T5): page `relativePath` -> hash
   * of its key files' content at last successful enrich (see
   * `staleness.ts`'s `computePageNodeHash`/`isPageUnchangedSinceLastEnrich`).
   * Additive/optional so old resume-state JSON (written before this field
   * existed) still loads — an absent map is never treated as "everything
   * changed" vs "everything unchanged", it is simply not consulted.
   */
  completedNodeHashes?: Record<string, string>;
  failed: Array<{ path: string; reason: string }>;
}
