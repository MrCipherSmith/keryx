import type { QuickStartRequest } from "./quick-contract";
import type { QuickDraft } from "./quick-request";

export type Pending = { id: string; request: QuickStartRequest; draft: QuickDraft };
export type Unresolved = { pending: Pending; message: string; inFlight: boolean };

/**
 * Unresolved operations, keyed by principal, project and adapter mode. They live outside the component, so leaving
 * the Work tab and coming back (which unmounts it) keeps the operation id and the exact request: the next Retry
 * replays the same operation instead of minting a new one. An entry is dropped on success or a definite refusal.
 * This module imports nothing at runtime, so the app shell can reach it without pulling the lazy Work view into the main chunk.
 */
export const unresolved = new Map<string, Unresolved>();

/** Entries hold typed text and operation ids of the previous principal, so they must not outlive it. */
export function clearQuickStartUnresolved() {
  unresolved.clear();
}
