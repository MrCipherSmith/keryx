// The in-process side of R4d (flow 369): a running turn asks, the broker records
// the question durably, delivers it, and waits for the store to say what became of
// it. The store is the only source of truth; the broker holds no state a restart
// would lose, so a second process (or the local CLI) answering is just a write the
// poll observes.

import { randomUUID } from "node:crypto";
import type { ToolRisk } from "../harness/tool/types";
import {
  consumeApproval,
  countPending,
  createApproval,
  newApprovalId,
  readApproval,
  resolveApproval,
  type ApprovalView,
  type ResolvedState,
} from "./serve-approvals-store";

export interface ApprovalBrokerOptions {
  dir?: string | undefined;
  expirySeconds: number;
  maxPending: number;
  /** When true, an ask with no consumer attached is undeliverable at once. */
  requireConsumer: boolean;
  hasConsumer: () => boolean;
  pollMs?: number;
  now?: () => Date;
}

export interface ApprovalAsk {
  turnId: string;
  sessionId: string;
  toolName: string;
  risk: ToolRisk;
  callFingerprint: string;
  floors: readonly string[];
  /** Announce the pending record to the stream. Throwing means the ask could not be delivered. */
  deliver: (approval: ApprovalView) => void;
  /** Announce the resolution. Best effort: the evidence ledger already has it. */
  resolved: (approvalId: string, resolution: ResolvedState) => void;
}

export interface ApprovalBrokerOutcome {
  approvalId: string;
  resolution: ResolvedState;
  approved: boolean;
  reason?: string;
}

export interface ApprovalBroker {
  readonly maxPending: number;
  request(ask: ApprovalAsk): Promise<ApprovalBrokerOutcome>;
  /** Wake waiters after an in-process answer instead of waiting for the next poll. */
  wake(): void;
}

const CONSEQUENCE: Record<ToolRisk, string> = {
  read: "Reads project data.",
  write: "Changes files in the project.",
  shell: "Runs a command on this machine.",
  network: "Makes a network request from this machine.",
  credential: "Uses a credential.",
  delegate: "Starts delegated work.",
  destructive: "Deletes or overwrites data and cannot be undone.",
};

/** Never derived from the call's arguments: a reader of the store must not learn the command. */
function describeAsk(ask: ApprovalAsk): { summary: string; scope: string; consequence: string } {
  const floors = ask.floors.length > 0 ? ` Needs a fresh answer every time (${ask.floors.join(", ")}).` : "";
  return {
    summary: `Run tool "${ask.toolName}" (risk: ${ask.risk})`,
    scope: `This one call to "${ask.toolName}" only. Not a session grant, not a standing rule.`,
    consequence: `${CONSEQUENCE[ask.risk]}${floors}`,
  };
}

export function createApprovalBroker(options: ApprovalBrokerOptions): ApprovalBroker {
  const now = options.now ?? (() => new Date());
  const pollMs = options.pollMs ?? 250;
  const wakers = new Set<() => void>();

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      wakers.add(wake);
    });

  const finish = (ask: ApprovalAsk, outcome: ApprovalBrokerOutcome): ApprovalBrokerOutcome => {
    try {
      ask.resolved(outcome.approvalId, outcome.resolution);
    } catch {
      // The ledger has the resolution; a stream that cannot take it must not change the answer.
    }
    return outcome;
  };

  const resolveNow = (approvalId: string, state: ResolvedState, reason: string): ApprovalBrokerOutcome => {
    try {
      const resolved = resolveApproval(approvalId, { state, reason }, options.dir, now());
      const settled = resolved.view.state === "pending" ? state : resolved.view.state;
      return { approvalId, resolution: settled, approved: false, reason };
    } catch {
      return { approvalId, resolution: state, approved: false, reason };
    }
  };

  return {
    maxPending: options.maxPending,
    wake: () => {
      for (const wake of [...wakers]) {
        wake();
      }
    },
    async request(ask: ApprovalAsk): Promise<ApprovalBrokerOutcome> {
      const approvalId = newApprovalId();
      const createdAt = now();
      const overLimit = countPending(options.dir, ask.sessionId, createdAt) >= options.maxPending;
      const text = describeAsk(ask);
      try {
        createApproval(
          {
            approvalId,
            turnId: ask.turnId,
            sessionId: ask.sessionId,
            ...text,
            expiresAt: new Date(createdAt.getTime() + options.expirySeconds * 1000),
            correlationId: randomUUID(),
            callFingerprint: ask.callFingerprint,
            floors: ask.floors,
          },
          options.dir,
          createdAt,
        );
      } catch {
        return finish(ask, { approvalId, resolution: "undeliverable", approved: false, reason: "record-unwritable" });
      }

      if (overLimit) {
        return finish(ask, resolveNow(approvalId, "denied", "max-pending-exceeded"));
      }
      if (options.requireConsumer && !options.hasConsumer()) {
        return finish(ask, resolveNow(approvalId, "undeliverable", "no-consumer-attached"));
      }
      try {
        const view = readApproval(approvalId, options.dir);
        if (!view.ok) {
          throw new Error("record unreadable");
        }
        ask.deliver(view.value);
      } catch {
        return finish(ask, resolveNow(approvalId, "undeliverable", "delivery-failed"));
      }

      for (;;) {
        const read = readApproval(approvalId, options.dir, now());
        if (!read.ok) {
          return finish(ask, resolveNow(approvalId, "denied", "record-unreadable"));
        }
        const view = read.value;
        if (view.state === "pending") {
          await sleep(Math.max(1, Math.min(pollMs, Date.parse(view.expiresAt) - now().getTime() + 1)));
          continue;
        }
        if (view.state !== "allowed") {
          return finish(ask, { approvalId, resolution: view.state, approved: false, ...(view.reason !== undefined ? { reason: view.reason } : {}) });
        }
        const consumed = consumeApproval(approvalId, ask.callFingerprint, options.dir, now());
        if (consumed !== "consumed") {
          return finish(ask, { approvalId, resolution: "denied", approved: false, reason: `not-consumable:${consumed}` });
        }
        return finish(ask, { approvalId, resolution: "allowed", approved: true });
      }
    },
  };
}

export interface ApprovalConsumers {
  /** Record that something is reading approvals right now. */
  touch(): void;
  attached(): boolean;
}

/**
 * Whether anything that could answer an approval is around.
 *
 * A consumer is a caller that recently listed approvals, read a turn's event
 * stream, or submitted a turn. The local CLI answering does not count: it reads
 * the store directly and is not a reason to hold a remote question open.
 */
export function createConsumerRegistry(options: { ttlMs?: number; now?: () => number } = {}): ApprovalConsumers {
  const ttl = options.ttlMs ?? 60_000;
  const clock = options.now ?? Date.now;
  let last = Number.NEGATIVE_INFINITY;
  return {
    touch: () => {
      last = clock();
    },
    attached: () => clock() - last <= ttl,
  };
}
