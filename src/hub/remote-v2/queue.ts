import { readOnlyAdmissionState } from "./admission-state";
import {validateControl} from '../../remote-control/protocol';
import { fail, HubFailure } from "../domain";
import type { HubState } from "../store";
import type { RemoteRepository } from "./storage";
import type { OperationRecord, QueueRow, SessionRow } from "./model";
import { control, held, machine } from "./guards";
import { admitCommand, admitMessage, checkAssociation, completeProjection, type SessionDependencies } from "./sessions";
import { sessionCommand } from "./commands";

/** Every queued application is a new immutable delivery, never reuse the admission grant. */
export function drainSessionQueue(state: HubState, repo: RemoteRepository, deps: SessionDependencies, sessionId: string): void {
  const row = repo.get<SessionRow>("remote_session", sessionId);
  if (!row || row.closing || row.pending || row.record.state !== "idle" || row.record.activeRunId || !deps.online(row.record.machineId)) return;
  // FIFO includes suspended work: a suspended item ahead fences every later one until it is reauthorized or removed, exactly as the native queue does.
  const head = repo.all<QueueRow>("remote_queue", { sessionId }).filter((q) => q.item.state === "queued" || q.item.state === "suspended").sort((a, b) => a.item.position - b.item.position)[0];
  if (!head || head.item.state !== "queued" || head.admissionCommandId) return;
  if(head.retryAfter!==undefined&&(Date.now()<head.retryAfter||row.record.sessionEventCursor<=(head.retryAfterSessionCursor??0)))return;
  const operation = repo.get<OperationRecord>("remote_operation", head.item.operationId);
  // Native application emits its receipt/state before the matching queue event.
  // Keep FIFO fenced until that event arrives: this is neither a new admission
  // nor evidence that the remaining observed queue item became stale.
  const status = (operation?.response as { status?: string } | undefined)?.status;
  const replacement = operation && validateControl("QueueReauthorize", operation.request);
  const replacementSource = replacement?.ok ? repo.get<QueueRow>("remote_queue", replacement.value.queueItemId) : undefined;
  const reauthorized = replacement?.ok === true && head.item.replacesOperationId === replacement.value.originalOperationId
    && replacementSource?.item.operationId === replacement.value.originalOperationId && replacementSource.sessionId === head.sessionId
    && replacementSource.machineId === head.machineId && replacementSource.projectId === head.projectId
    && head.item.position === replacementSource.item.position && head.item.kind === replacementSource.item.kind;
  const edit = operation && validateControl("QueueEdit",operation.request);
  const editedSource = edit?.ok ? repo.get<QueueRow>("remote_queue",edit.value.queueItemId) : undefined;
  const edited = edit?.ok === true && editedSource?.item.operationId === head.item.replacesOperationId && editedSource.sessionId === head.sessionId && editedSource.projectId === head.projectId && editedSource.machineId === head.machineId && editedSource.item.position === head.item.position && editedSource.item.kind === "message" && head.item.kind === "message" && head.item.text === edit.value.text;
  if ((status === "applied" && !reauthorized && !edited) || status === "admitted" || status === "confirmation-required") return;
  // SQL rollback alone cannot rewind objects later persisted by an outer caller.
  // Admission therefore mutates proposed rows only, and legacy state is a lazy
  // read-only view rather than a full-project clone.
  const proposed = {row:structuredClone(row),head:structuredClone(head),operation:structuredClone(operation)};
  const admissionState = readOnlyAdmissionState(state);
  try {
    repo.atomic(() => {
      const {row,head,operation}=proposed;
    if (!deps.authorityValid(head.authority)) fail(403, "forbidden", "Queued actor no longer authorized");
    held(row, head.authority, head.controller);
    if (head.item.expectedConfigVersion !== row.record.config.configVersion) fail(409, "stale-version", "Queued configuration changed");
    completeProjection(repo, row);
    if (head.association) checkAssociation(admissionState, head.association,head.projectId);
    if (!operation) fail(409, "recovery-required", "Queued operation identity missing");
    head.admissionReceipt??=structuredClone(operation.response);
    if (head.item.kind === "message") {
      const request = control("MessageSubmit", head.request);
      const receipt = admitMessage(admissionState, repo, {auth:head.authority, row, body:{ ...request, expectedSessionVersion: row.record.version, expectedConfigVersion: row.record.config.configVersion, controller: head.controller }, operationId:head.item.operationId, originalMessageId:head.item.operationId, deps});
      operation.response = receipt;
    } else if (head.item.kind === "config") {
      const request = control("ConfigChange", head.request);
      sessionCommand(repo, machine(repo, row.record.machineId), row, head.authority, head.item.operationId, "change-config", { ...request, expectedSessionVersion: row.record.version });
    } else {
      const request = control("CommandInvoke", head.request);
      const projection = completeProjection(repo, row);
      if (projection.catalogueDigest !== request.catalogueDigest || !projection.catalogue.some((entry) => entry.commandName === request.commandName && entry.availability === "available" && entry.mutationClass === "workspace" && entry.busyPolicy === "queue-at-idle")) fail(409, "stale-catalogue", "Queued command catalogue changed");
      operation.response = admitCommand(admissionState, repo, head.authority, row, { ...request, expectedSessionVersion: row.record.version }, head.item.operationId);
    }
    repo.put("remote_operation", operation.id, operation, { projectId: row.record.projectId, sessionId });
    head.admissionCommandId = row.pending!.commandId;
    repo.put("remote_queue", head.item.queueItemId, head, { projectId: head.projectId, machineId: head.machineId, sessionId, seq: head.item.position });
    });
  } catch (error) {
    if (!(error instanceof HubFailure)) throw error;
    deps.admissionRefused?.(head.item.operationId);
    // Refusal is not an observed native queue transition. A fresh machine
    // queue event owns suspension/version changes and any terminal receipt.
    return;
  }
}
