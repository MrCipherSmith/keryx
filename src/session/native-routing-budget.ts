import type { NormalizedRequest, NormalizedUsage } from "../harness/provider/types";
import type { NormalizedRoutingConfig } from "../harness/routing/config";
import type { ModelRef } from "../harness/routing/model-class";
import type { RoutingBudgetLedger } from "../harness/routing/routing-budget";
import type { RoutingJournalLocation } from "../harness/routing/routing-journal";
import type { RoutingDecisionReceipt } from "../harness/routing/routing-runtime";

/** Local-only state carried from native selection into the admitted model turn. */
export interface NativeRoutingExecutionBudget {
  readonly target: ModelRef;
  readonly receipt: RoutingDecisionReceipt;
  readonly config: NormalizedRoutingConfig;
  readonly budget: RoutingBudgetLedger;
  readonly journal: RoutingJournalLocation;
  readonly estimatedCostUsd: (request: NormalizedRequest) => number | null;
  readonly actualCostUsd?: (input: {
    readonly request: NormalizedRequest;
    readonly usage?: NormalizedUsage;
    readonly estimatedCostUsd: number | null;
  }) => number;
}

/**
 * Process-local handoff for authority that must never be serialized through the
 * Hub protocol. A context is consumed by exactly one admitted native turn; the
 * provider wrapper retained by that turn then shares its ledger across rounds.
 */
export class NativeRoutingBudgetStore {
  static readonly MAX_PENDING = 128;
  static readonly PENDING_TTL_MS = 10 * 60_000;
  readonly #pending = new Map<string, { readonly context: NativeRoutingExecutionBudget; readonly expiresAt: number }>();

  #pruneExpired(now = Date.now()): void {
    for (const [receiptId, entry] of this.#pending) if (entry.expiresAt <= now) this.#pending.delete(receiptId);
  }

  publish(selectionReceiptId: string, context: NativeRoutingExecutionBudget): void {
    if (selectionReceiptId !== context.receipt.receiptId
      || context.receipt.decision.status !== "selected"
      || context.receipt.decision.decisionId !== selectionReceiptId
      || context.receipt.decision.selection.providerId !== context.target.providerId
      || context.receipt.decision.selection.modelId !== context.target.modelId) {
      throw new Error("native routing budget context does not match its selected receipt");
    }
    const now = Date.now();
    this.#pruneExpired(now);
    while (this.#pending.size >= NativeRoutingBudgetStore.MAX_PENDING) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    this.#pending.set(selectionReceiptId, { context, expiresAt: now + NativeRoutingBudgetStore.PENDING_TTL_MS });
  }

  take(selectionReceiptId: string): NativeRoutingExecutionBudget | undefined {
    this.#pruneExpired();
    const entry = this.#pending.get(selectionReceiptId);
    if (entry !== undefined) this.#pending.delete(selectionReceiptId);
    return entry?.context;
  }
}
