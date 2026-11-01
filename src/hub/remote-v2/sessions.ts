import { releasedControllerAlias, verifiedControllerRecovery } from "./controller-recovery";
import { canonicalDigest, criteriaDigest, type Control } from "../../remote-control/protocol";
import { assertLegacyFlowWritable, fail } from "../domain";
import type { HubState } from "../store";
import type { RemoteRepository } from "./storage";
import type { HumanAuthority, Projection, QueueRow, RunRow, SessionRow } from "./model";
import { control, held, id, idleFence, iso, machine, projectionKey, saveSession, version } from "./guards";
import { runCommand, sessionCommand } from "./commands";
export type SessionDependencies = { online(machineId: string): boolean; authorityValid(auth: HumanAuthority,projectId?:string): boolean; beforeAdmission?(auth:HumanAuthority,row:SessionRow,operationId:string):void; admitted?(run:RunRow,operationId:string):void };
export function completeProjection(repo: RemoteRepository, row: SessionRow): Projection {
  const p = repo.get<Projection>("remote_projection", projectionKey(row.record.machineId, row.record.projectId, row.record.checkoutId, row.record.agentProfileId));
  const current = machine(repo, row.record.machineId);
  if (current.connectedEpoch !== current.epoch) fail(409, "machine-offline", "Machine capability projection is offline");
  const inventory=repo.get<import('../../remote-control/protocol').FrameOf<'inventory'>['payload']>('remote_inventory',current.machineId);
  const checkout=inventory?.checkouts.find(c=>c.projectId===row.record.projectId&&c.checkoutId===row.record.checkoutId);
  const profile=checkout?.agentProfiles.find(profile=>profile.profileId===row.record.agentProfileId);
  if (!p || p.connectionEpoch !== current.epoch || p.inventoryVersion !== current.inventoryVersion || inventory?.inventoryVersion!==current.inventoryVersion || checkout?.headSha!==row.headSha || !profile || profile.readiness!=='ready' || profile.policyDigest!==row.record.config.policyDigest || profile.capabilityDigest!==row.record.config.capabilityDigest || p.policyDigest !== row.record.config.policyDigest || p.capabilityDigest !== row.record.config.capabilityDigest) fail(409, "setup-required", "Complete current capability projection required");
  return p;
}
export function checkAssociation(state: HubState, association: Control["FlowAssociation"], projectId?: string): void {
  if (association.mode === "flow") {
    const flow = state.flows.find((f) => f.id === association.flowId);
    if(flow&&(projectId===undefined||flow.projectId===projectId))assertLegacyFlowWritable(state,flow.projectId,flow.id);
    const spec = flow && state.documents.find((d) => d.id === flow.specDocumentId);
    if (!flow || (projectId !== undefined && flow.projectId !== projectId) || !spec || flow.status !== "in-progress" || flow.version !== association.expectedFlowVersion || flow.specContentDigest !== association.specDigest || spec.contentDigest !== association.specDigest || criteriaDigest(flow.criteria) !== association.criteriaDigest) fail(409, "stale-reference", "Managed Flow association is not current executable work");
  }
}
export function createSession(state: HubState, repo: RemoteRepository, deps: SessionDependencies, auth: HumanAuthority, projectId: string, body: Control["SessionCreate"], operationId: string, deliver = true) {
  const m = machine(repo, body.machineId);
  if (!m.projectIds.includes(projectId)) fail(404, "not-found", "Machine not found");
  if (!deps.online(m.machineId) || m.recoveryRequired) fail(409, "machine-offline", "Machine is unavailable or requires recovery");
  const inventory = repo.get<{ inventoryVersion: number; checkouts: { projectId: string; checkoutId: string; headSha: string; clean: boolean; available: boolean; busy: boolean; agentProfiles: { profileId: string; readiness: string; capabilityDigest: string; policyDigest: string }[] }[] }>("remote_inventory", m.machineId);
  const checkout = inventory?.checkouts.find((c) => c.projectId === projectId && c.checkoutId === body.checkoutId);
  const profile = checkout?.agentProfiles.find((p) => p.profileId === body.agentProfileId);
  if (!inventory || inventory.inventoryVersion !== body.expectedInventoryVersion || !checkout || checkout.headSha !== body.expectedHeadSha || !profile || profile.readiness !== "ready" || profile.capabilityDigest !== body.capabilityDigest || profile.policyDigest !== body.policyDigest) fail(409, "stale-reference", "Inventory or capability selection changed");
  if (!checkout.clean) fail(409, "checkout-dirty", "Initial checkout must be clean");
  if (!checkout.available || checkout.busy) fail(409, "machine-busy", "Checkout unavailable");
  const projection = repo.get<Projection>("remote_projection", projectionKey(m.machineId, projectId, body.checkoutId, body.agentProfileId));
  if (!projection || projection.connectionEpoch !== m.epoch || m.inventoryEpoch !== m.epoch || projection.inventoryVersion !== inventory.inventoryVersion || projection.policyDigest !== body.policyDigest || projection.capabilityDigest !== body.capabilityDigest) fail(409, "setup-required", "Complete capability projection required");
  const baseline = projection.candidates.find((candidate) => candidate.available && candidate.reason === "none");
  const profileId = projection.profileIds[0];
  if (!baseline || !profileId) fail(409, "setup-required", "No connected permitted local candidate");
  const sessionId = id();
  const record: Control["SessionRecord"] = { sessionId, projectId, machineId: m.machineId, checkoutId: body.checkoutId, agentProfileId: body.agentProfileId, version: 1, historyVersion: 1, state: "opening", title: body.title, config: { configVersion: 1, baselineCandidateId: baseline.candidateId, reasoningEffort: baseline.reasoningEfforts.includes("none") ? "none" : baseline.reasoningEfforts[0] ?? "none", routing: { enabled: false, profileId, candidateIds: [baseline.candidateId], fallbackCandidateId: baseline.candidateId }, policyDigest: body.policyDigest, capabilityDigest: body.capabilityDigest }, controller: null, activeRunId: null, activeTurnId: null, nextTurnOrdinal: 1, historyCursor: 0, sessionEventCursor: 0, queueVersion: 0, workspaceBaseline: "0".repeat(64), forkedFromSessionId: null, capabilities: { literalText: true, attachments: false, attachmentReason: "typed-artifact-contract-required", commandCatalogue: true, modelRouting: true } };
  const row: SessionRow = { baselineVerified: false, record, acceptedVersion: 1, controllerVersion: 0, catalogueVersion: projection.catalogueVersion, catalogueDigest: projection.catalogueDigest, inventoryVersion: inventory.inventoryVersion, headSha: body.expectedHeadSha };
  saveSession(repo, row); if (deliver) sessionCommand(repo, m, row, auth, operationId, "create-session", body);
  return { receiptId: id(), operationId, sessionId, kind: "create-session", status: "pending", observedSessionVersion: 0, session: record, reason: "none" } satisfies Control["SessionOperationReceipt"];
}
export function controllerMutation(repo: RemoteRepository, auth: HumanAuthority, row: SessionRow, action: string, input: unknown): Control["ControllerReceipt"] {
  idleFence(row);
  const proposed = structuredClone(row);
  const receipt = calculateControllerMutation(repo, auth, proposed, action, input);
  row.pendingController = receipt; saveSession(repo, row);
  return receipt;
}
function calculateControllerMutation(repo: RemoteRepository, auth: HumanAuthority, row: SessionRow, action: string, input: unknown): Control["ControllerReceipt"] {
  const now = Date.now();
  if (action === "release") {
    const body = control("ControllerRelease", input); version(row.record.version, body.expectedSessionVersion); held(row, auth, body.controller);
    const lease = row.record.controller!; lease.state = "released"; lease.expiresAt = iso(now); lease.version = ++row.controllerVersion; row.record.version++;
    const receipt = { receiptId: id(), sessionVersion: row.record.version, lease } satisfies Control["ControllerReceipt"];
    return receipt;
  }
  const body = control("ControllerClaim", input); version(row.record.version, body.expectedSessionVersion); version(row.controllerVersion, body.expectedControllerVersion);
  const existing = row.record.controller;
  if (body.mode === "renew") {
    if (action !== "renew" || !body.controllerLeaseId) fail(400, "invalid-arguments", "Explicit controller renewal required");
    held(row, auth, { controllerLeaseId: body.controllerLeaseId, expectedControllerVersion: body.expectedControllerVersion });
  } else {
    if (existing) {
      const release = existing.state === "released" ? releasedControllerAlias(repo, row, existing.controllerLeaseId) : undefined;
      const released = release && release.receiptId === body.previousReleaseReceiptId && release.lease.version === row.controllerVersion;
      const recovered = body.previousReleaseReceiptId && verifiedControllerRecovery(repo, row, body.previousReleaseReceiptId);
      if (body.mode !== "takeover" || (!released && !recovered)) fail(409, "controller-conflict", "Exact applied release or verified local recovery required before takeover");
    }
    row.controllerVersion++;
  }
  row.record.controller = { controllerLeaseId: body.mode === "renew" ? existing!.controllerLeaseId : id(), sessionId: row.record.sessionId, version: row.controllerVersion, actorId: auth.actor.id, actorKind: "human-operator", expiresAt: iso(now + body.requestedLeaseSeconds * 1000), state: "held" };
  row.record.version++;
  return { receiptId: id(), sessionVersion: row.record.version, lease: row.record.controller };
}
export function submitMessage(state: HubState, repo: RemoteRepository, deps: SessionDependencies, auth: HumanAuthority, row: SessionRow, body: Control["MessageSubmit"], operationId: string): Control["TurnReceipt"] {
  idleFence(row); version(row.record.version, body.expectedSessionVersion); held(row, auth, body.controller); version(row.record.config.configVersion, body.expectedConfigVersion);
  if (!row.baselineVerified) fail(409, "recovery-required", "Measured local workspace baseline required");
  if (row.closing || row.record.state === "closed" || row.record.state === "opening" || row.record.state === "recovery-required") fail(409, "session-closed", "Session is not ready for work");
  if (Buffer.byteLength(body.text) > 32768) fail(413, "quota-exceeded", "Message exceeds byte quota");
  if (!deps.online(row.record.machineId)) fail(409, "machine-offline", "No offline execution queue");
  completeProjection(repo, row); checkAssociation(state, body.association, row.record.projectId);
  const queued = repo.all<QueueRow>("remote_queue", { sessionId: row.record.sessionId }).filter((q) => q.item.state === "queued");
  if (row.record.activeRunId || queued.length) {
    if (body.busyPolicy !== "enqueue") fail(409, "session-busy", "Session has active or queued work");
    if (queued.length >= 100) fail(413, "quota-exceeded", "Session queue is full");
    sessionCommand(repo, machine(repo, row.record.machineId), row, auth, operationId, "submit-message", body);
    return { operationId, messageId: id(), sessionId: row.record.sessionId, sessionVersion: row.record.version, queueItemId: null, status: "queued", runId: null, turnId: null, turnOrdinal: null };
  }
  return admitMessage(repo, auth, row, body, operationId, undefined, deps);
}
export function admitMessage(repo: RemoteRepository, auth: HumanAuthority, row: SessionRow, body: Control["MessageSubmit"], operationId: string, originalMessageId?: string, deps?:SessionDependencies): Control["TurnReceipt"] {
  deps?.beforeAdmission?.(auth,row,operationId);
  if(repo.activeRuns()>=repo.budgets.activeRuns)fail(413,'quota-exceeded','Active work budget exhausted; reconcile existing ownership');
  const m = machine(repo, row.record.machineId); const runId = id(), turnId = id(), ordinal = row.record.nextTurnOrdinal;
  const snapshot: Control["ConfigSnapshot"] = { config: structuredClone(row.record.config), configDigest: canonicalDigest(row.record.config), effectiveCandidateId: row.record.config.baselineCandidateId, routingDecision: "baseline", fallbackReason: "none", selectionReceiptId: id() };
  const start: Control["StartTurnRequest"] = { sessionId: row.record.sessionId, expectedSessionVersion: row.record.version, controller: body.controller, expectedConfigVersion: body.expectedConfigVersion, expectedHistoryVersion: row.record.historyVersion, expectedWorkspaceBaseline: row.record.workspaceBaseline, association: body.association, messageId: originalMessageId ?? id(), text: body.text };
  const command = runCommand(repo, m, row, auth, operationId, runId, turnId, 1, "start-turn", { request: start, snapshot, turnOrdinal: ordinal }, body.controller);
  const run: RunRow = { runId, turnId, sessionId: row.record.sessionId, projectId: row.record.projectId, checkoutId: row.record.checkoutId, machineId: m.machineId, version: 1, state: "dispatching", lastLocalSeq: 0, commandDigest: command.envelope.commandDigest, commandId: command.envelope.commandId, association: body.association, snapshot, turnOrdinal: ordinal, partial: false };
  repo.put("remote_run", runId, run, { projectId: row.record.projectId, machineId: m.machineId, sessionId: row.record.sessionId, runId }); saveSession(repo, row);
  deps?.admitted?.(run,operationId);
  return { operationId, messageId: id(), sessionId: row.record.sessionId, sessionVersion: row.record.version, queueItemId: null, status: "admitted", runId, turnId, turnOrdinal: ordinal };
}

export function admitCommand(state: HubState, repo: RemoteRepository, auth: HumanAuthority, row: SessionRow, request: Control["CommandInvoke"], operationId: string): Control["CommandOutcome"] {
  if (!request.association) fail(400, "ad-hoc-forbidden", "Executing command requires an explicit turn association");
  checkAssociation(state, request.association, row.record.projectId);
  if (row.record.activeRunId || row.pending || row.record.state !== "idle" || !row.baselineVerified) fail(409, "session-busy", "Executing command requires an idle verified workspace");
  if(repo.activeRuns()>=repo.budgets.activeRuns)fail(413,'quota-exceeded','Active work budget exhausted; reconcile existing ownership');
  const m = machine(repo, row.record.machineId), runId = id(), turnId = id();
  const snapshot: Control["ConfigSnapshot"] = { config: structuredClone(row.record.config), configDigest: canonicalDigest(row.record.config), effectiveCandidateId: row.record.config.baselineCandidateId, routingDecision: "baseline", fallbackReason: "none", selectionReceiptId: id() };
  const command = sessionCommand(repo, m, row, auth, operationId, "invoke-command", request, { scope: "run", sessionId: row.record.sessionId, runId, turnId, expectedRunVersion: 1, expectedSessionVersion: row.record.version });
  const run: RunRow = { runId, turnId, sessionId: row.record.sessionId, projectId: row.record.projectId, checkoutId: row.record.checkoutId, machineId: m.machineId, version: 1, state: "dispatching", lastLocalSeq: 0, commandDigest: command.envelope.commandDigest, commandId: command.envelope.commandId, association: request.association, snapshot, turnOrdinal: row.record.nextTurnOrdinal, partial: false };
  repo.put("remote_run", runId, run, { projectId: row.record.projectId, machineId: m.machineId, sessionId: row.record.sessionId, runId });
  return { operationId, sessionId: row.record.sessionId, commandName: request.commandName, status: "queued", sessionVersion: row.record.version, result: null, confirmationId: null, errorCode: null, confirmation: null, runId, turnId };
}
