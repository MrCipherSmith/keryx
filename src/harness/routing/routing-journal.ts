import path from "node:path";
import { appendPrivateRecord, ensureKeryxSubdir } from "../../lib/config-dir";
import { redactSensitiveText } from "../../security/service";
import { routingV2Digest } from "./config-v2";
import type { RoutingDecision, RoutingReason } from "./decision";

export interface RoutingJournalLocation {
  readonly cwd: string;
  readonly configDir?: string;
}

type AttemptOutcome = "started" | "completed" | "rejected" | "interrupted" | "cancelled";

export type RoutingJournalEvent =
  | {
      readonly kind: "preview" | "dispatch";
      readonly decision: RoutingDecision;
      readonly previousDecisionId?: string;
      readonly fallbackReason?: RoutingReason;
    }
  | {
      readonly kind: "attempt";
      readonly decisionId: string;
      readonly attempt: number;
      readonly outcome: AttemptOutcome;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
    };

function safeDecision(event: Extract<RoutingJournalEvent, { decision: RoutingDecision }>) {
  const { decision } = event;
  const selection = decision.status === "selected" ? decision.selection : undefined;
  return {
    kind: event.kind,
    requestId: routingV2Digest(decision.requestId),
    decisionId: decision.decisionId,
    configDigest: decision.configDigest,
    snapshotDigest: decision.snapshotDigest,
    assignmentSource: decision.assignmentSource,
    recommendationSource: decision.recommendationSource,
    status: decision.status,
    requestedClass: decision.requestedClass,
    selectedClass: decision.selectedClass,
    classifierReceiptId: decision.classifierReceiptId,
    parentDecisionId: event.previousDecisionId ?? decision.parentDecisionId,
    fallbackReason: event.fallbackReason ?? decision.fallbackReason,
    reason: decision.status === "blocked" ? decision.reason : undefined,
    ...(selection === undefined ? {} : {
      selection: {
        providerId: redactSensitiveText(selection.providerId),
        modelId: redactSensitiveText(selection.modelId),
      },
    }),
    exclusions: decision.exclusions.map(({ reason, modelClass, target }) => ({
      reason,
      modelClass,
      ...(target === undefined ? {} : {
        target: {
          providerId: redactSensitiveText(target.providerId),
          modelId: redactSensitiveText(target.modelId),
        },
      }),
    })),
  };
}

/** Append one owner-only record without following a pre-existing journal symlink. */
export function appendRoutingJournal(location: RoutingJournalLocation, event: RoutingJournalEvent): void {
  const root = ensureKeryxSubdir(["routing-v2", "journal"], location.configDir);
  const filename = `${routingV2Digest(path.resolve(location.cwd))}.jsonl`;
  const payload = event.kind === "attempt" ? {
    kind: event.kind,
    decisionId: event.decisionId,
    attempt: event.attempt,
    outcome: event.outcome,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
  } : safeDecision(event);
  appendPrivateRecord(path.join(root, filename), JSON.stringify({ version: 1, recordedAt: new Date().toISOString(), ...payload }));
}
