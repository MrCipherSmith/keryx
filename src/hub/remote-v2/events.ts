import {observeClosureReceipt,settleClosure} from './closure';
import {applicationObserved} from './application-proof';
import {releaseQueuedAttempt} from './queue-retry';
import {observeLocalCessation,type ReleasedControllerRow} from "./controller-recovery";
import { LIMITS, canonicalDigest, parseMachineFrame, runCommandDigest, sessionCommandDigest, validateControl, validateArguments, type FrameOf, type Control } from "../../remote-control/protocol";
import { fail } from "../domain";
import type { RemoteRepository } from "./storage";
import type { ApprovalRow, MachineRecord, OperationRecord, Projection, QueueRow, RunRow, SessionRow, StoredCommand } from "./model";
import { commandRunId, control, endRun, projectionKey, saveSession } from "./guards";
import { redact } from "./results";
import type { ConfirmationRow, CommandConfirmationRow } from "./config";
type ReceiptPayload = FrameOf<"command-receipt">["payload"] | FrameOf<"session-command-receipt">["payload"];
export function ingestSessionEvent(repo: RemoteRepository, m: MachineRecord, event: Control["SessionEvent"]): number {
  const row = repo.get<SessionRow>("remote_session", event.sessionId);
  if (!row || row.record.machineId !== m.machineId || row.record.projectId !== event.projectId || row.record.checkoutId !== event.checkoutId || !m.projectIds.includes(event.projectId)) fail(403, "scope-denied", "Session event ownership denied");
  const key = `${event.sessionId}:${event.sessionEventSeq}`;
  const old = repo.get<Control["SessionEvent"]>("remote_session_event", key);
  if (old) { if (canonicalDigest(old) !== canonicalDigest(event)) fail(409, "payload-conflict", "Session event changed"); return row.record.sessionEventCursor; }
  if (event.sessionEventSeq !== row.record.sessionEventCursor + 1) fail(409, "replay-gap", "Contiguous critical session events required");
  if (event.kind === "session-state") {
    const next = event.session;
    if (next.sessionId !== row.record.sessionId || next.projectId !== row.record.projectId || next.machineId !== m.machineId || next.checkoutId !== row.record.checkoutId || next.agentProfileId !== row.record.agentProfileId) fail(409, "stale-reference", "Immutable session identity changed");
    if (canonicalDigest(next.controller) !== canonicalDigest(row.record.controller)) {
      const previous = row.record.controller, lease = next.controller;
      const expiryOnly = previous?.state === "held" && lease?.state === "expired" && Date.parse(previous.expiresAt) <= Date.now() && canonicalDigest({ ...previous, state: "expired" }) === canonicalDigest(lease);
      if (!expiryOnly) fail(409, "stale-reference", "Controller authority changes require an exact accepted controller receipt");
    }
    if(next.state==='closed'&&repo.unresolvedSessionRuns(row.record.sessionId)>0)fail(409,'recovery-required','Unknown or active work prevents a closed projection');
    // Machine publishes applied projection; never roll back newer accepted controller/queue versions.
    if (next.version < row.record.version) fail(409, "stale-version", "Applied machine projection regressed");
    if (next.workspaceBaseline === "0".repeat(64) && next.state !== "opening") fail(409, "workspace-conflict", "Measured baseline required for ready session");
    if(next.state==='closed')row.closedProof={eventSeq:event.sessionEventSeq,epoch:m.epoch,ledgerId:m.ledgerId,receivedAt:new Date().toISOString()};else delete row.closedProof;
    // The machine's own applied projection supersedes Hub's overlay of a human lost resolution, except one that agrees with it: a crashed
    // session the restarted machine re-hosted stays recovery-required without the lost run (a controller change may precede its resume).
    row.record = { ...next, sessionEventCursor: event.sessionEventSeq }; row.baselineVerified = next.state !== "opening";
    if (next.state !== "recovery-required" || next.activeRunId !== null) delete row.lostRecovery;
    row.controllerVersion = next.controller?.version ?? row.controllerVersion;
    const pendingDelivery=row.pending&&repo.get<StoredCommand>('remote_command',row.pending.commandId);
    if (row.pending && next.version >= row.pending.expectedAppliedVersion && applicationObserved(repo,row,pendingDelivery,next)) {
      const admitted = repo.get<StoredCommand>("remote_command", row.pending.commandId);
      if (admitted) { admitted.status = "applied"; repo.put("remote_command", admitted.envelope.commandId, admitted, { machineId: admitted.machineId, projectId: admitted.projectId, sessionId: next.sessionId, seq: admitted.envelope.hubSequence }); }
      delete row.pending; delete row.pendingController;
    }
  } else if (event.kind === "controller-changed") {
    const proposed = row.pendingController;
    if (!proposed) observeLocalCessation(repo,row,m,event);
    else if (canonicalDigest(proposed) !== canonicalDigest(event.receipt)) fail(409, "stale-reference", "Controller lease differs from accepted authority");
    if (row.pending) updateOperation(repo,row.pending.operationId,event.receipt);
    if (event.receipt.lease.state === "released" && row.pending) repo.put("remote_controller_release", event.receipt.lease.controllerLeaseId, { receipt: event.receipt, commandId: row.pending.commandId, operationId: row.pending.operationId } satisfies ReleasedControllerRow, { projectId: event.projectId, machineId: m.machineId, sessionId: event.sessionId });
    row.record.controller = event.receipt.lease; row.record.version = event.receipt.sessionVersion; row.controllerVersion = event.receipt.lease.version;
  } else if (event.kind === "turn-admitted") {
    const run = repo.get<RunRow>("remote_run", event.runId);
    if (!run || run.machineId !== m.machineId || run.projectId !== event.projectId || run.sessionId !== event.sessionId || run.checkoutId !== event.checkoutId || run.turnId !== event.turnId || (run.turnOrdinal !== undefined && run.turnOrdinal !== event.turnOrdinal) || canonicalDigest(run.association) !== canonicalDigest(event.association)) fail(409, "stale-reference", "Admitted turn does not match its reserved owner and pins");
    const projection = repo.get<Projection>("remote_projection", projectionKey(m.machineId, event.projectId, event.checkoutId, row.record.agentProfileId));
    const selected = projection?.candidates.find((candidate) => candidate.candidateId === event.snapshot.effectiveCandidateId);
    if (canonicalDigest(event.snapshot.config) !== canonicalDigest(run.snapshot.config) || event.snapshot.configDigest !== canonicalDigest(event.snapshot.config) || !selected?.available || ![event.snapshot.config.baselineCandidateId, ...event.snapshot.config.routing.candidateIds].includes(selected.candidateId)) fail(409, "stale-reference", "Native turn snapshot differs from pinned permitted configuration");
    run.requestedSnapshot ??= run.snapshot; run.snapshot = event.snapshot; run.turnOrdinal = event.turnOrdinal; repo.put("remote_run", run.runId, run, { projectId: run.projectId, machineId: m.machineId, sessionId: run.sessionId, runId: run.runId });
  } else if (event.kind === "selection-receipt") {
    const receipt = event.receipt, run = repo.get<RunRow>("remote_run", receipt.runId);
    const projection = repo.get<Projection>("remote_projection", projectionKey(m.machineId, event.projectId, event.checkoutId, row.record.agentProfileId));
    const candidate = projection?.candidates.find((entry) => entry.candidateId === receipt.candidateId);
    if (!run || run.machineId !== m.machineId || run.projectId !== event.projectId || run.sessionId !== event.sessionId || run.turnId !== receipt.turnId || receipt.sessionId !== event.sessionId || receipt.configVersion !== run.snapshot.config.configVersion || receipt.policyDigest !== run.snapshot.config.policyDigest || !candidate) fail(409, "stale-reference", "Selection receipt is not an owned declared provider selection");
    if (receipt.reason === "provider-fallback" && !candidate.available) {
      const command = repo.get<StoredCommand>("remote_command", run.commandId), operation = command && repo.get<OperationRecord>("remote_operation", command.operationId);
      if (!command || command.envelope.kind !== "invoke-command" || !operation || receipt.confirmedOperationDigest !== operation.payloadDigest || candidate.reason !== "local-policy") fail(409, "stale-reference", "Service-only selection requires exact confirmed execution provenance");
    } else if (!candidate.available || ![run.snapshot.config.baselineCandidateId, ...run.snapshot.config.routing.candidateIds].includes(candidate.candidateId)) fail(409, "stale-reference", "Undeclared primary routing candidate");
    const previous = repo.all<Control["SessionEvent"]>("remote_session_event", { sessionId: event.sessionId }).find((prior) => prior.kind === "selection-receipt" && prior.receipt.selectionReceiptId === receipt.selectionReceiptId);
    if (previous && previous.kind === "selection-receipt" && canonicalDigest(previous.receipt) !== canonicalDigest(receipt)) fail(409, "payload-conflict", "Selection receipt changed on replay");
  } else if (event.kind === "config-receipt") {
    const receipt = event.receipt;
    if (receipt.sessionId !== event.sessionId) fail(400, "invalid-frame", "Config receipt session mismatch");
    const operation = resolveEventOperation(repo, m.machineId, event.projectId, event.sessionId, receipt.operationId);
    const delivered = row.pending && repo.get<StoredCommand>("remote_command", row.pending.commandId);
    if (delivered && delivered.operationId === operation.id && receipt.status!=="rejected") { delivered.status = "admitted"; repo.put("remote_command", delivered.envelope.commandId, delivered, { machineId: m.machineId, projectId: event.projectId, sessionId: event.sessionId, seq: delivered.envelope.hubSequence }); }
    const original = receiptRequest(repo, m, event, operation, "ConfigChange");
    if (receipt.status === "confirmation-required") {
      const card = receipt.confirmation;
      if (!card || card.sessionId !== event.sessionId || card.actorId !== operation.actorId || card.operationDigest !== operation.payloadDigest || card.policyDigest !== row.record.config.policyDigest || card.expectedConfigVersion !== row.record.config.configVersion || canonicalDigest(card.controller) !== canonicalDigest(original.controller) || Date.parse(card.expiresAt) <= Date.now() || Date.parse(card.expiresAt) > Date.now() + 300000) fail(409, "stale-reference", "Machine confirmation does not bind original operation");
      if(resolveEventOperation(repo,m.machineId,event.projectId,event.sessionId,card.operationId).id!==operation.id)fail(409,'stale-reference','Configuration confirmation operation alias differs');
      repo.put("remote_confirmation", card.confirmationId, { card, original, authority: { actor: { id: operation.actorId, kind: "human", role: "operator" }, sessionDigest: operation.sessionDigest }, consumed: false, receipt } satisfies ConfirmationRow, { projectId: event.projectId, machineId: m.machineId, sessionId: event.sessionId });
    }
    updateOperation(repo, operation.id, { ...receipt, operationId: operation.id });
    if (receipt.status === "applied") {
      if (!receipt.configVersion || !receipt.effectiveFromTurnOrdinal || row.record.activeRunId) fail(409, "stale-reference", "Applied configuration requires an idle next-turn boundary");
      // Configuration fields and CAS version arrive together in SessionRecord.
    }
  } else if (event.kind === "command-outcome") {
    const outcome = event.outcome;
    const projection = repo.get<Projection>("remote_projection", projectionKey(m.machineId, event.projectId, event.checkoutId, row.record.agentProfileId));
    const entry = projection?.catalogue.find((c) => c.commandName === outcome.commandName);
    if (!entry || (outcome.status === "applied" && !validateArguments(entry.resultSchema, outcome.result).ok)) fail(400, "invalid-arguments", "Command result violates selected schema");
    const operation = resolveEventOperation(repo, m.machineId, event.projectId, event.sessionId, outcome.operationId);
    const original = receiptRequest(repo, m, event, operation, "CommandInvoke");
    if (outcome.sessionId !== event.sessionId || original.commandName !== outcome.commandName) fail(409, "stale-reference", "Command outcome differs from original invocation");
    if (outcome.status === "confirmation-required") {
      const card = outcome.confirmation;
      if (!card || card.confirmationId !== outcome.confirmationId || card.sessionId !== event.sessionId || card.actorId !== operation.actorId || card.operationDigest !== operation.payloadDigest || card.policyDigest !== row.record.config.policyDigest || card.expectedConfigVersion !== row.record.config.configVersion || canonicalDigest(card.controller) !== canonicalDigest(original.controller) || Date.parse(card.expiresAt) <= Date.now() || Date.parse(card.expiresAt) > Date.now() + 300000) fail(409, "stale-reference", "Command confirmation does not bind original invocation");
      const cardOperation = resolveEventOperation(repo, m.machineId, event.projectId, event.sessionId, card.operationId);
      if (cardOperation.id !== operation.id) fail(409, "stale-reference", "Confirmation operation alias differs");
      const prior = repo.get<CommandConfirmationRow>("remote_confirmation", card.confirmationId);
      if (prior && canonicalDigest(prior.card) !== canonicalDigest(card)) fail(409, "payload-conflict", "Confirmation identity changed");
      if (!prior) repo.put("remote_confirmation", card.confirmationId, { card, originalOperationId: operation.id, original, authority: { actor: { id: operation.actorId, kind: "human", role: "operator" }, sessionDigest: operation.sessionDigest }, consumed: false, outcome } satisfies CommandConfirmationRow, { projectId: event.projectId, machineId: m.machineId, sessionId: event.sessionId });
    }
    if(row.pending?.operationId===operation.id&&outcome.status!=='rejected'&&outcome.status!=='recovery-required'){const accepted=repo.get<StoredCommand>('remote_command',row.pending.commandId);if(accepted){accepted.domainAccepted=true;repo.put('remote_command',accepted.envelope.commandId,accepted);}}
    updateOperation(repo, operation.id, { ...outcome, operationId: operation.id });
  } else if (event.kind === "operation-receipt") { const operation = resolveEventOperation(repo, m.machineId, event.projectId, event.sessionId, event.receipt.operationId); if(!observeClosureReceipt(repo,row,operation,event.receipt))updateOperation(repo, operation.id, { ...event.receipt, operationId: operation.id }); }
  else if (event.kind === "queue-changed") {
    const operation = resolveEventOperation(repo, m.machineId, event.projectId, event.sessionId, event.item.operationId);
    const item = { ...event.item, operationId: operation.id };
    const accepted = row.pending && repo.get<StoredCommand>("remote_command", row.pending.commandId);
    if (accepted && accepted.operationId === operation.id && "target" in accepted.envelope && accepted.envelope.target.scope==="session") { accepted.status = "admitted"; repo.put("remote_command", accepted.envelope.commandId, accepted, { machineId: m.machineId, projectId: event.projectId, sessionId: event.sessionId, seq: accepted.envelope.hubSequence }); }
    const existing = repo.get<QueueRow>("remote_queue", item.queueItemId);
    if (existing && (existing.sessionId !== event.sessionId || existing.item.version > item.version)) fail(409, "stale-version", "Queue projection regressed");
    if (event.queueVersion < row.record.queueVersion) fail(409, "stale-version", "Queue revision regressed");
    const replacement = validateControl("QueueReauthorize", operation.request);
    let request: QueueRow["request"];
    if (replacement.ok) {
      const source = repo.get<QueueRow>("remote_queue", replacement.value.queueItemId);
      if (!source || source.item.operationId !== replacement.value.originalOperationId || item.replacesOperationId !== source.item.operationId || item.position !== source.item.position || item.text !== source.item.text || item.kind !== source.item.kind) fail(409, "stale-reference", "Replacement queue lineage differs from original owned item");
      if (source.item.kind === "message") request = { ...control("MessageSubmit", source.request), expectedSessionVersion: replacement.value.expectedSessionVersion, controller: replacement.value.controller, expectedConfigVersion: replacement.value.expectedConfigVersion, association: replacement.value.association };
      else if (source.item.kind === "config") request = { ...control("ConfigChange", source.request), expectedSessionVersion: replacement.value.expectedSessionVersion, controller: replacement.value.controller, expectedConfigVersion: replacement.value.expectedConfigVersion };
      else request = { ...control("CommandInvoke", source.request), expectedSessionVersion: replacement.value.expectedSessionVersion, controller: replacement.value.controller, expectedConfigVersion: replacement.value.expectedConfigVersion, association: replacement.value.association };
    } else request = existing?.request ?? (item.kind === "message" ? control("MessageSubmit", operation.request) : item.kind === "config" ? control("ConfigChange", operation.request) : control("CommandInvoke", operation.request));
    if (item.kind === "message") request = { ...control("MessageSubmit", request), text: item.text ?? "" };
    const queued: QueueRow = { item, sessionId: event.sessionId, projectId: event.projectId, machineId: m.machineId, authority: { actor: { id: operation.actorId, kind: "human", role: "operator" }, sessionDigest: operation.sessionDigest }, controller: request.controller, request, payloadDigest: operation.payloadDigest, ...(existing?.admissionCommandId ? { admissionCommandId: existing.admissionCommandId } : {}), ...(existing&&existing.item.operationId===operation.id?{...(existing.admissionReceipt!==undefined?{admissionReceipt:existing.admissionReceipt}:{}),...(existing.retryAfter!==undefined?{retryAfter:existing.retryAfter,retryAfterSessionCursor:existing.retryAfterSessionCursor}:{})}:{}), ...("association" in request && request.association ? { association: request.association } : {}) };
    repo.put("remote_queue", item.queueItemId, queued, { sessionId: event.sessionId, projectId: event.projectId, machineId: m.machineId, seq: item.position }); row.record.queueVersion = event.queueVersion;
  } else if (event.kind === "message") {
    if (event.message.sessionId !== event.sessionId) fail(400, "invalid-frame", "History session mismatch");
    if (event.message.historyCursor !== row.record.historyCursor + 1) fail(409, "replay-gap", "History must be contiguous");
    repo.put("remote_history", event.message.messageId, event.message, { sessionId: event.sessionId, projectId: event.projectId, machineId: m.machineId, seq: event.message.historyCursor }); row.record.historyCursor = event.message.historyCursor; row.record.historyVersion++;
  }
  settleClosure(repo,row);
  repo.put("remote_session_event", key, event, { projectId: event.projectId, machineId: m.machineId, sessionId: event.sessionId, seq: event.sessionEventSeq }); row.record.sessionEventCursor = event.sessionEventSeq; saveSession(repo, row); return event.sessionEventSeq;
}
function receiptRequest<K extends "ConfigChange" | "CommandInvoke">(repo:RemoteRepository,machine:MachineRecord,event:Pick<Control["SessionEvent"],"sessionId"|"projectId"|"checkoutId">,operation:OperationRecord,kind:K):Control[K]{
  const replacement=validateControl("QueueReauthorize",operation.request);
  if(!replacement.ok)return control(kind,operation.request);
  const request=replacement.value,source=repo.get<QueueRow>("remote_queue",request.queueItemId);
  const matches=repo.all<QueueRow>("remote_queue",{projectId:event.projectId,machineId:machine.machineId,sessionId:event.sessionId}).filter(row=>row.item.operationId===operation.id);
  const queued=matches.length===1?matches[0]:undefined;
  if(!source||!queued||source.projectId!==event.projectId||source.machineId!==machine.machineId||source.sessionId!==event.sessionId
    ||source.item.operationId!==request.originalOperationId||queued.item.replacesOperationId!==request.originalOperationId||queued.item.kind!==source.item.kind
    ||queued.item.position!==source.item.position||queued.item.text!==source.item.text||queued.item.expectedConfigVersion!==request.expectedConfigVersion
    ||queued.payloadDigest!==operation.payloadDigest||operation.payloadDigest!==canonicalDigest(request)
    ||(kind==="ConfigChange"?queued.item.kind!=="config":queued.item.kind!=="command"))fail(409,"stale-reference","Replacement receipt requires exact stored queue lineage");
  const original=control(kind,source.request),projected=control(kind,queued.request);
  const expected={...original,expectedSessionVersion:request.expectedSessionVersion,controller:request.controller,expectedConfigVersion:request.expectedConfigVersion,...(kind==="CommandInvoke"?{association:request.association}:{})};
  if(canonicalDigest(expected)!==canonicalDigest(projected))fail(409,"payload-conflict","Replacement projected request changed from authorized lineage");
  return projected;
}
function resolveEventOperation(repo: RemoteRepository, machineId: string, projectId: string, sessionId: string, suppliedId: string): OperationRecord {
  const direct = repo.get<OperationRecord>("remote_operation", suppliedId); const command = repo.get<StoredCommand>("remote_command", suppliedId);
  if (command && direct && command.operationId !== direct.id) fail(409, "payload-conflict", "Ambiguous operation identity");
  if (command && (command.machineId !== machineId || command.projectId !== projectId || ("target" in command.envelope ? command.envelope.target.sessionId : command.envelope.sessionId) !== sessionId)) fail(403, "scope-denied", "Receipt command target denied");
  const operation = command ? repo.get<OperationRecord>("remote_operation", command.operationId) : direct;
  if (!operation || operation.projectId !== projectId || operation.sessionId !== sessionId && operation.derivedSessionId !== sessionId) fail(409, "stale-reference", "Receipt operation ownership denied");
  return operation;
}
function updateOperation(repo: RemoteRepository, operationId: string, response: unknown) { const operation = repo.get<OperationRecord>("remote_operation", operationId); if (!operation) fail(409, "stale-reference", "Operation not owned by Hub"); operation.response = response; operation.status=200; delete operation.deliveryFailure; repo.put("remote_operation", operationId, operation, { projectId: operation.projectId, sessionId: operation.sessionId }); }
const terminal = new Set(["succeeded", "failed", "cancelled", "rejected", "lost"]);
const transitions: Record<RunRow["state"], Set<RunRow["state"]>> = {
  dispatching: new Set(["received", "rejected", "unknown"]), received: new Set(["starting", "rejected", "unknown"]), starting: new Set(["running", "failed", "unknown"]), running: new Set(["waiting-approval", "paused", "cancelling", "succeeded", "failed", "unknown"]), "waiting-approval": new Set(["running", "paused", "cancelling", "failed", "unknown"]), paused: new Set(["running", "cancelling", "failed", "unknown"]), cancelling: new Set(["cancelled", "succeeded", "failed", "unknown"]), unknown: new Set(), succeeded: new Set(), failed: new Set(), cancelled: new Set(), rejected: new Set(), lost: new Set(),
};
/** `logBytes` is a log chunk's size as the machine sent and counted it; Hub's own ingestion mask may change the stored text's size. */
export type StoredRunEvent = { event: FrameOf<"run-event">["payload"]; payloadDigest: string; retained: boolean; logBytes?: number };
export function storedRunEvent(record: StoredRunEvent | FrameOf<"run-event">["payload"]): FrameOf<"run-event">["payload"] { return "event" in record ? record.event : record; }
export function ingestRunEvent(repo: RemoteRepository, m: MachineRecord, raw: FrameOf<"run-event">["payload"]): number | {error:"recovery-required"} {
  const run = repo.get<RunRow>("remote_run", raw.runId);
  if (!run || run.machineId !== m.machineId || run.projectId !== raw.projectId || run.checkoutId !== raw.checkoutId || run.sessionId !== raw.sessionId || run.turnId !== raw.turnId || !m.projectIds.includes(raw.projectId)) fail(403, "scope-denied", "Run event ownership denied");
  const key = `${raw.runId}:${raw.localSeq}`;
  const old = repo.get<StoredRunEvent | FrameOf<"run-event">["payload"]>("remote_event", key);
  if (old) { if (("event" in old ? old.payloadDigest : canonicalDigest(old)) !== canonicalDigest(raw)) {if(raw.kind==='state'&&terminal.has(run.state)&&raw.state!==run.state)return terminalConflict(repo,m,run,raw);fail(409, "payload-conflict", "Run event changed on replay");} return run.lastLocalSeq; }
  if (raw.kind === "log-gap") {
    if (raw.fromSeq !== run.lastLocalSeq + 1 || raw.toSeq < raw.fromSeq || raw.localSeq !== raw.toSeq + 1 || raw.toSeq - raw.fromSeq >= 100000) fail(409, "replay-gap", "Gap must cover exactly the next retained discarded-log range");
    const known = repo.all<StoredRunEvent | FrameOf<"run-event">["payload"]>("remote_event", { runId: run.runId }).map(storedRunEvent);
    if (known.some((event) => event.localSeq >= raw.fromSeq && event.localSeq <= raw.toSeq && event.kind !== "log")) fail(409, "replay-gap", "Critical events cannot be covered by a log gap");
  } else if (raw.localSeq !== run.lastLocalSeq + 1) fail(409, "replay-gap", "Contiguous durable event replay required");
  const event = structuredClone(raw); let logBytes: number | undefined;
  if (event.kind === "state") {
    if (terminal.has(run.state) && event.state !== run.state) return terminalConflict(repo,m,run,raw);
    if (event.state !== run.state && !transitions[run.state].has(event.state)) fail(409, "stale-reference", "Run transition needs actual lifecycle evidence");
    if (run.nativeIdentity && canonicalDigest(event.nativeIdentity) !== canonicalDigest(run.nativeIdentity)) fail(409, "stale-reference", "Native owner identity changed or disappeared");
    if (event.nativeIdentity) { if (event.nativeIdentity.sessionId !== run.sessionId || event.nativeIdentity.turnId !== run.turnId) fail(409, "stale-reference", "Native identity mismatch"); run.nativeIdentity = event.nativeIdentity; }
    run.state = event.state; run.version++; run.observedAt = event.observedAt;
    if (terminal.has(run.state)) {
      repo.releaseRunCapacity(run.runId);
      run.terminalAt ??= new Date().toISOString();
      // SessionRecord is updated only by its separate actual native projection.
    }
  } else if (event.kind === "log") {
    // The machine's per-run quota counts the bytes it sends; Hub counts the same bytes, so both agree at the exact boundary whatever the mask below does.
    logBytes = Buffer.byteLength(event.text);
    if (logBytes > LIMITS.logChunkBytes) fail(413, "quota-exceeded", "Log chunk exceeds quota");
    if (repo.runLogBytes(run.runId) + logBytes > LIMITS.runLogBytes) fail(413, "quota-exceeded", "Run log storage full; explicit log gap required");
    event.text = redact(event.text);
  } else if (event.kind === "approval-request") {
    const deadline = Date.parse(event.expiresAt);
    if (!Number.isFinite(deadline) || deadline > Date.now() + 300000) fail(400, "approval-expired", "Approval deadline invalid");
    // A question the machine recorded while disconnected can arrive after its own deadline: it is kept, already expired and never answerable,
    // because refusing a critical event would wedge the run's replay.
    event.summary = redact(event.summary); repo.put("remote_approval_projection", event.approvalId, { ...event, status: deadline <= Date.now() ? "expired" : "waiting" }, { runId: run.runId, sessionId: run.sessionId, projectId: run.projectId, machineId: m.machineId });
  } else if (event.kind === "approval-outcome") {
    const pending = repo.get<FrameOf<"run-event">["payload"] & { status: string; expiresAt: string }>("remote_approval_projection", event.approvalId);
    if (!pending || pending.runId !== run.runId) fail(409, "stale-reference", "Approval waiter missing");
    // An unanswered question denied at or after its deadline resolved by expiry, which the projection says rather than a bare non-application.
    const expired = (pending.status === "waiting" || pending.status === "expired") && event.decision === "deny" && event.application === "not-applied" && Date.parse(pending.expiresAt) <= Date.parse(event.observedAt);
    repo.put("remote_approval_projection", event.approvalId, { ...pending, status: expired ? "expired" : event.application, decision: event.decision }, { runId: run.runId, sessionId: run.sessionId, projectId: run.projectId, machineId: m.machineId });
  }
  repo.put("remote_event", key, { event, payloadDigest: canonicalDigest(raw), retained: true, ...(logBytes === undefined ? {} : { logBytes }) } satisfies StoredRunEvent, { projectId: run.projectId, machineId: m.machineId, sessionId: run.sessionId, runId: run.runId, seq: event.localSeq }); run.lastLocalSeq = event.localSeq; run.notificationVersion = (run.notificationVersion ?? 0) + 1; repo.put("remote_run", run.runId, run, { projectId: run.projectId, machineId: m.machineId, sessionId: run.sessionId, runId: run.runId }); return event.localSeq;
}
/**
 * Does this receipt say the command never applied, so its session fence settles now? `rejected` is a delivery refusal: the machine
 * refused before starting it (a delivery receipt means received/admitted/rejected, never started), so nothing applied whatever the
 * code. That includes recovery-required, e.g. a claim or resume a restarted machine cannot re-host before the operator's
 * release-resolved-run step: the human retries after that step instead of meeting session-busy. `not-applied` follows an attempted
 * application, and with recovery-required its effect is not known, so that fence stays.
 */
function knownNonApplication(p: ReceiptPayload): boolean {
  return p.status === "rejected" || (p.status === "not-applied" && p.errorCode !== "recovery-required");
}
/**
 * A session command the machine rejected before starting it fails its operation with the machine's own code, as an expired delivery
 * does. A FIFO admission of a queued item is the exception: its refusal does not reject the still-queued logical operation.
 */
function failRejectedDelivery(repo: RemoteRepository, command: StoredCommand, p: ReceiptPayload): void {
  if (p.status !== "rejected" || p.errorCode === null) return;
  if (repo.all<QueueRow>("remote_queue", { sessionId: p.sessionId }).some((queued) => queued.admissionCommandId === p.commandId)) return;
  const operation = repo.get<OperationRecord>("remote_operation", command.operationId);
  if (!operation) return;
  operation.status = 409; operation.deliveryFailure = { error: { code: p.errorCode, message: "The machine refused this operation before starting it; nothing was applied" } };
  repo.put("remote_operation", operation.id, operation);
}
/**
 * A run whose command the machine refused before starting it never ran, and the machine sends no run-event for it: Hub ends it
 * here, frees its run capacity and fails its operation. A queued admission is ended by releaseQueuedAttempt first, so it is
 * past `dispatching` by now.
 */
function endRefusedRun(repo: RemoteRepository, command: StoredCommand, p: ReceiptPayload): void {
  if (p.status !== "rejected") return;
  const runId = commandRunId(command.envelope);
  const run = runId ? repo.get<RunRow>("remote_run", runId) : undefined;
  if (!run || run.commandId !== command.envelope.commandId || run.state !== "dispatching") return;
  endRun(repo, run, "rejected"); command.capacityReleased = true;
  failRejectedDelivery(repo, command, p);
}
export function commandReceipt(repo: RemoteRepository, machine: MachineRecord, frame: FrameOf<"command-receipt"> | FrameOf<"session-command-receipt">,authorityValid?:(authority:StoredCommand["authority"],projectId:string)=>boolean): void {
  const p = frame.payload; const command = repo.get<StoredCommand>("remote_command", p.commandId);
  if (!command || command.machineId !== machine.machineId || p.hubSequence !== command.envelope.hubSequence) fail(403, "scope-denied", "Command receipt ownership denied");
  const checked = parseMachineFrame(JSON.stringify(frame), "machine-to-hub");
  const targetSession = "target" in command.envelope ? command.envelope.target.sessionId : command.envelope.sessionId;
  if (!checked.ok || p.sessionId !== targetSession || (frame.type === "command-receipt" && (command.frameType !== "command" || !("runId" in command.envelope) || frame.payload.runId !== command.envelope.runId))
    || (frame.type === "session-command-receipt" && command.frameType !== "session-command")) fail(409, "stale-reference", "Receipt target differs from immutable command");
  const digest = command.frameType === "command" && "runId" in command.envelope ? runCommandDigest(command.envelope) : "target" in command.envelope ? sessionCommandDigest(command.envelope) : null;
  if (digest !== command.envelope.commandDigest) fail(409, "payload-conflict", "Stored command integrity changed");
  if (command.receipt && canonicalDigest(command.receipt) !== canonicalDigest(p) && ["applied", "rejected", "not-applied"].includes((command.receipt as {status:string}).status)) fail(409, "payload-conflict", "Terminal command receipt changed");
  releaseQueuedAttempt(repo,command,frame,authorityValid?.(command.authority,command.projectId)===true);
  if (knownNonApplication(p) && command.status !== "admitted" && command.status !== "applied") {
    const row = repo.get<SessionRow>("remote_session", targetSession);
    if (row?.pending?.commandId === p.commandId) {
      if (row.record.machineId !== machine.machineId || row.record.projectId !== command.projectId
        || (frame.type === "session-command-receipt" && frame.payload.observedSessionVersion !== row.record.version)) fail(409, "stale-reference", "Rejection requires the same applied session projection");
      delete row.pending; delete row.pendingController; saveSession(repo, row);
      if (frame.type === "session-command-receipt") failRejectedDelivery(repo, command, frame.payload);
    }
  }
  if(command.envelope.kind==='close-session'&&knownNonApplication(p)&&!command.domainAccepted){const row=repo.get<SessionRow>('remote_session',targetSession);if(row?.pendingClosure?.commandId===p.commandId){delete row.pendingClosure;row.closing=false;saveSession(repo,row);if(frame.type==='session-command-receipt')failRejectedDelivery(repo,command,frame.payload);}}
  if (command.envelope.kind === "answer-approval") {
    const question = repo.get<ApprovalRow>("remote_approval_projection", command.envelope.body.approvalId);
    if (question?.answer?.commandId === command.envelope.commandId && ["recorded", "delivered"].includes(question.status)) { question.status = p.status === "not-applied" || p.status === "rejected" ? "not-applied" : "delivered"; repo.put("remote_approval_projection", question.approvalId, question, { projectId: question.projectId, machineId: machine.machineId, sessionId: question.sessionId, runId: question.runId }); const affected = repo.get<RunRow>("remote_run", question.runId); if (affected) { affected.notificationVersion = (affected.notificationVersion ?? 0) + 1; repo.put("remote_run", affected.runId, affected, { projectId: affected.projectId, machineId: machine.machineId, sessionId: affected.sessionId, runId: affected.runId }); } }
  }
  if(p.status==='applied'&&frame.type==='session-command-receipt'){
    const row=repo.get<SessionRow>('remote_session',targetSession);
    if(row?.pending?.commandId===p.commandId&&frame.payload.observedSessionVersion===row.record.version&&applicationObserved(repo,row,{...command,receipt:p},row.record)){delete row.pending;delete row.pendingController;saveSession(repo,row);}
  }
  endRefusedRun(repo, command, p);
  command.receipt = p; command.status = p.status; repo.put("remote_command", p.commandId, command, { machineId: machine.machineId, projectId: command.projectId, sessionId: targetSession, ...("runId" in command.envelope ? { runId: command.envelope.runId } : {}), seq: p.hubSequence });
}

function terminalConflict(repo:RemoteRepository,m:MachineRecord,run:RunRow,event:FrameOf<'run-event'>['payload']):{error:'recovery-required'} {
 run.incident='incompatible-late-terminal';run.notificationVersion=(run.notificationVersion??0)+1;repo.put('remote_run',run.runId,run);
 const id=canonicalDigest(['terminal-incident',run.runId,run.lastLocalSeq,event.localSeq]);
 if(!repo.get('remote_operation',id))repo.put('remote_operation',id,{id,key:id,actorId:`machine:${m.machineId}`,sessionDigest:'',projectId:run.projectId,sessionId:run.sessionId,payloadDigest:canonicalDigest(event),request:{runId:run.runId,localSeq:event.localSeq,kind:event.kind,observedAt:event.observedAt},kind:'remote-run-incident',status:409,response:{error:{code:'recovery-required',message:'Incompatible late terminal observation retained; original terminal state preserved'}}} satisfies OperationRecord,{projectId:run.projectId,machineId:m.machineId,sessionId:run.sessionId,runId:run.runId});
 return {error:'recovery-required'};
}
