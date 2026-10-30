import {isOwnedControlCommand} from '../../remote-control/owned-controls';
import { createLifecycleOperations } from "./lifecycle";
import { validateOwnedControl } from "./owned-control";
import { canonicalDigest, validateArguments, type Control } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { HubStore } from "../store";
import type { HumanAuthority, OperationRecord, QueueRow, SessionRow } from "./model";
import { control, held, id, idleFence, machine, version } from "./guards";
import { admitCommand, checkAssociation, completeProjection, type SessionDependencies } from "./sessions";
import { sessionCommand } from "./commands";
import type { CommandConfirmationRow } from "./config";
export function createSessionOperations(store: HubStore, deps: SessionDependencies) {
  const lifecycleOps = createLifecycleOperations(store, deps);
  function queueMutation(row: SessionRow, auth: HumanAuthority, queueId: string, method: string, input: unknown, operationId: string, suffix?: string) {
    if(row.closing&&(method!=='DELETE'||suffix==='reauthorize'))fail(409,'session-closed','Closing session cannot accept queue work');
    const b = suffix === "reauthorize" ? control("QueueReauthorize", input) : method === "PATCH" ? control("QueueEdit", input) : control("QueueRemove", input);
    if (b.queueItemId !== queueId) fail(400, "invalid-arguments", "Queue path/body identity mismatch");
    version(row.record.version, b.expectedSessionVersion); held(row, auth, b.controller); version(row.record.queueVersion, b.expectedQueueVersion);
    const q = store.remote.get<QueueRow>("remote_queue", queueId); if (!q || q.sessionId !== row.record.sessionId) fail(404, "not-found", "Queue item not found"); version(q.item.version, b.expectedItemVersion);
    if (suffix === "reauthorize") {
      const request = control("QueueReauthorize", input);
      if (q.item.state !== "suspended" || q.item.operationId !== request.originalOperationId) fail(409, "stale-version", "Only exact suspended item can be reauthorized");
      version(row.record.config.configVersion, request.expectedConfigVersion);
    } else {
      if (q.item.state !== "queued" || q.admissionCommandId) fail(409, "stale-version", "Claimed or suspended item cannot be edited");
      if (method === "PATCH" && q.item.kind !== "message") fail(409, "invalid-arguments", "Only literal queued messages may be edited");
    }
    const kind = suffix === "reauthorize" ? "reauthorize-queue" : method === "PATCH" ? "edit-queue" : "remove-queue";
    sessionCommand(store.remote, machine(store.remote, row.record.machineId), row, auth, operationId, kind, input);
    return { receiptId: id(), operationId, sessionId: row.record.sessionId, kind, status: "pending", observedSessionVersion: row.record.version, session: row.record, reason: "none" } satisfies Control["SessionOperationReceipt"];
  }
  const lifecycle = lifecycleOps.direct;
  function invoke(row: SessionRow, auth: HumanAuthority, action: string, input: unknown, operationId: string): unknown {
    if (action === "confirm") {
      const confirmation = control("CommandConfirmation", input);if(row.closing&&confirmation.decision==='allow-once')fail(409,'session-closed','Closing session cannot admit pending command work'); held(row, auth, confirmation.controller); version(row.record.version, confirmation.expectedSessionVersion);
      const pending = store.remote.get<CommandConfirmationRow>("remote_confirmation", confirmation.confirmationId);
      if (!pending || !pending.outcome || pending.consumed || pending.card.sessionId !== row.record.sessionId || pending.card.operationDigest !== confirmation.operationDigest || pending.card.policyDigest !== confirmation.policyDigest || pending.card.actorId !== auth.actor.id || canonicalDigest(pending.card.controller) !== canonicalDigest(confirmation.controller)) fail(409, "stale-reference", "Command confirmation binding changed");
      if (Date.parse(pending.card.expiresAt) <= Date.now()) fail(409, "approval-expired", "Native confirmation deadline expired");
      version(row.record.config.configVersion, pending.card.expectedConfigVersion);
      if(confirmation.decision==='allow-once'){
        if(!deps.authorityValid(pending.authority,row.record.projectId))fail(403,'forbidden','Original command actor authority was revoked');
        const projection=completeProjection(store.remote,row),entry=projection.catalogue.find(entry=>entry.commandName===pending.original.commandName);
        if(projection.catalogueDigest!==pending.original.catalogueDigest||!entry||entry.availability!=='available'||!validateArguments(entry.inputSchema,pending.original.arguments).ok)fail(409,'stale-catalogue','Confirmed command catalogue or arguments changed');
      }
      sessionCommand(store.remote, machine(store.remote, row.record.machineId), row, auth, operationId, "confirm-command", confirmation);
      pending.consumed = true;
      pending.outcome = { ...pending.outcome, status: "queued", confirmation: null, confirmationId: null };
      store.remote.put("remote_confirmation", confirmation.confirmationId, pending, { sessionId: row.record.sessionId, projectId: row.record.projectId, machineId: row.record.machineId });
      // The response acknowledges delivery reservation; only a native outcome
      // changes the original operation's final disposition.
      const original = store.remote.get<OperationRecord>("remote_operation", pending.originalOperationId);
      if (!original) fail(409, "stale-reference", "Original command operation unavailable");
      return { ...pending.outcome, operationId: original.id };
    }
    if (action !== "invoke") fail(404, "not-found", "Command route not found");
    const b = control("CommandInvoke", input); version(row.record.version, b.expectedSessionVersion); held(row, auth, b.controller); version(row.record.config.configVersion, b.expectedConfigVersion);
    idleFence(row);
    const projection = completeProjection(store.remote, row); if (projection.catalogueDigest !== b.catalogueDigest) fail(409, "stale-catalogue", "Selected catalogue changed");
    const entry = projection.catalogue.find((c) => c.commandName === b.commandName); if (!entry) fail(400, "unknown-command", "Unknown command");
    if(row.closing&&entry.mutationClass!=='read'&&!isOwnedControlCommand(b.commandName))fail(409,'session-closed','Session queue is sealed for close');
    if (entry.availability !== "available" || entry.confirmation === "local-only" || entry.mutationClass === "sensitive-setup") fail(403, "forbidden", "Command requires permitted local setup");
    const validation = validateArguments(entry.inputSchema, b.arguments).ok; if (!validation) fail(400, "invalid-arguments", "Arguments violate selected command schema");
    const backlog = store.remote.all<QueueRow>("remote_queue", {sessionId:row.record.sessionId}).filter((q) => q.item.state === "queued" || q.item.state === "suspended");
    const queuedWorkspace = entry.mutationClass === "workspace" && (row.record.state === "busy" || !!row.record.activeRunId || backlog.length > 0) && b.busyPolicy === "queue-at-idle" && entry.busyPolicy === "queue-at-idle" && entry.states.includes("idle");
    if (!queuedWorkspace && !entry.states.includes(row.record.state === "opening" || row.record.state === "recovery-required" ? "paused" : row.record.state)) fail(409, "session-busy", "Command not applicable to session state");
    const derived = lifecycleOps.fromCommand(row, auth, b, operationId); if (derived) return derived;
    validateOwnedControl(store.remote, row, b);
    if (entry.mutationClass === "workspace" && !queuedWorkspace) return admitCommand(store.load(), store.remote, auth, row, b, operationId);
    if (queuedWorkspace) {
      if (!row.baselineVerified || !b.association || !deps.online(row.record.machineId)) fail(409, "recovery-required", "Online verified command queue with explicit association required");
      if (backlog.length >= 100) fail(413, "quota-exceeded", "Session queue is full");
      // Validate Flow pins now and again on fresh idle admission.
      checkAssociation(store.load(), b.association, row.record.projectId);
    }
    const outcome: Control["CommandOutcome"] = { operationId, sessionId: row.record.sessionId, commandName: b.commandName, status: "queued", sessionVersion: row.record.version, result: null, confirmationId: null, errorCode: null, confirmation: null, runId: null, turnId: null };
    sessionCommand(store.remote, machine(store.remote, row.record.machineId), row, auth, operationId, "invoke-command", b);
    return outcome;
  }
  return { queueMutation, lifecycle, invoke };
}
