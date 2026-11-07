import type { MessageDeliveries, MessageDelivery } from "../../remote-control/message-delivery";
import { validateControl } from "../../remote-control/protocol";
import type { MessageDeliveryState as State, OperationRecord, QueueRow } from "./model";
import { redact } from "./results";
import type { RemoteRepository } from "./storage";

export function initialMessageDelivery(value: unknown, afterCursor: number): State | undefined {
  const receipt = validateControl("TurnReceipt", value);
  if (!receipt.ok || receipt.value.status === "rejected") return;
  return {
    status: "hub-accepted", submittedAt: new Date().toISOString(), afterCursor,
    runId: receipt.value.runId, turnId: receipt.value.turnId,
    queued: false, reason: null,
  };
}

export function observeMessageDelivery(operation: OperationRecord, change: Partial<Pick<State,
  "status" | "queued" | "reason" | "runId" | "turnId" | "queueItemId">>): void {
  const previous = operation.messageDelivery;
  if (!previous || previous.status === "machine-started") return;
  operation.messageDelivery = { ...previous, ...change };
}

export function readMessageDeliveries(repo: RemoteRepository, projectId: string, sessionId: string, actorId: string): MessageDeliveries {
  const deliveries: MessageDelivery[] = [];
  let bytes = 2048;
  for (const operation of repo.recentMessageOperations(projectId, sessionId, actorId)) {
    const state = operation.messageDelivery;
    const request = validateControl("MessageSubmit", operation.request);
    if (!state || !request.ok) continue;
    const { queueItemId, ...publicState } = state;
    const queued = queueItemId ? repo.get<QueueRow>("remote_queue", queueItemId) : undefined;
    const text = queued?.sessionId === sessionId && queued.projectId === projectId &&
      queued.item.operationId === operation.id ? queued.item.text ?? request.value.text : request.value.text;
    const item = {
      ...publicState, operationId: operation.id,
      text: state.status === "machine-started" ? redact(text) : text,
    };
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes > 512 * 1024) break;
    deliveries.push(item);
  }
  return { deliveries: deliveries.reverse() };
}
