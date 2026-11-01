import { isStopOnlyCommand, validateOwnedControl } from "./owned-control";
import {authorizeLifecycle} from './lifecycle';
import {expirePendingCommands} from "./delivery";
import { retireRunLogs } from "./retention";
import { admitHello, completeCursorRecovery } from "./replay";
import { releasedControllerAlias } from "./controller-recovery";
import { reconcile, resolveRun } from "./recovery";
import { executionBinding } from "./execution";
import { drainSessionQueue } from "./queue";
import { createRemoteReader } from "./read-model";
import { createSessionOperations } from "./session-operations";
import { randomBytes } from "node:crypto";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { canonicalDigest, runCommandDigest, sessionCommandDigest, validateControl, parseClosedJson, parseMachineFrame, LIMITS, MACHINE_SUBPROTOCOL, type Control } from "../../remote-control/protocol";
import { fail, HubFailure, hubRead, sha256 } from "../domain";
import type { HubStore, HubState } from "../store";
import type { ApprovalRow, HumanAuthority, MachineRecord, OperationRecord, PairingRecord, RunRow, SessionRow, StoredCommand } from "./model";
import { control, held, id, idleFence, iso, machine, operator, scoped, session, unwrap, version, saveSession } from "./guards";
import { controllerMutation, createSession, submitMessage, checkAssociation,completeProjection, type SessionDependencies } from "./sessions";
import { configChange, configConfirm,authorizeConfirmation } from "./config";
import { ingestCapabilities } from "./projection";
import { commandReceipt, ingestRunEvent, ingestSessionEvent } from "./events";
import { resultUpload } from "./results";
import { runCommand, sessionCommand } from "./commands";
export type RemoteSocketData = { kind: "machine"; machineId: string; credentialDigest: string; projectScopeDigest: string; epoch: number; daemonId: string | null; lastHeartbeat: number } | { kind: "browser"; authority: HumanAuthority; request: Request; projectId: string; lastHeartbeat: number };
export type RemoteTransportObservation={peer:"machine"|"browser";frameBytes:number;bufferedBytes:number;result:number;closeReason:string|null};
export type RemotePorts = { observeTransport?:(observation:RemoteTransportObservation)=>void; store: HubStore; human(request: Request): Promise<HumanAuthority>; authorityValid(auth: HumanAuthority, projectId?: string, readOnly?: boolean): boolean; checkOrigin(request: Request): void; transportAllowed(request: Request): boolean; serialized<T>(action: () => Promise<T>): Promise<T> };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const mutationKey = (request: Request) => { const key = request.headers.get("idempotency-key"); if (!key || key.length > 200 || [...key].some((char) => char.charCodeAt(0) < 32)) fail(400, "idempotency-key-required", "Bounded operation key required"); return key; };
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) fail(400, "json-required", "JSON body required");
  if (!request.body) fail(400, "invalid-json", "JSON body required");
  const parts: Uint8Array[] = []; let size = 0; const reader = request.body.getReader();
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 32 * 1024 * 1024) { await reader.cancel(); fail(413, "quota-exceeded", "Request exceeds quota"); } parts.push(next.value); } } finally { reader.releaseLock(); }
  return unwrap(parseClosedJson(Buffer.concat(parts).toString("utf8"), 32 * 1024 * 1024));
}
export function createRemoteControl(ports: RemotePorts) {
  const { store } = ports; let transportsClosed = false;
  const trackedTransports = new Set<ServerWebSocket<RemoteSocketData>>();
  let shutdownSnapshot: ServerWebSocket<RemoteSocketData>[] | undefined;
  const machines = new Map<string, ServerWebSocket<RemoteSocketData>>(); const pending = new Set<string>(); const browsers = new Set<ServerWebSocket<RemoteSocketData>>();
  const attempts = new Map<string, { count: number; reset: number }>();
  const deps: SessionDependencies = { online: (machineId) => { const socket = machines.get(machineId); return !!socket && socket.data.kind === "machine" && socket.data.daemonId !== null && socket.readyState === 1; }, authorityValid: ports.authorityValid };
  const humanRead = createRemoteReader(store, deps);
  const { queueMutation, lifecycle, invoke } = createSessionOperations(store, deps);
  const resolveMachine = (request: Request): MachineRecord | undefined => { const header = request.headers.get("authorization"); if (!header?.startsWith("Bearer ")) return undefined; const digest = sha256(header.slice(7)); return store.remote.all<MachineRecord>("remote_machine").find((m) => !m.revoked && m.credentialDigest === digest); };
  const scopedMachine = (request: Request) => { const m = resolveMachine(request); if (!m) fail(401, "unauthorized", "Current machine credential required"); return m; };
  const socketAuthorityCurrent = (m: MachineRecord, data: Extract<RemoteSocketData, {kind:"machine"}>) => !m.revoked && m.epoch === data.epoch && m.credentialDigest === data.credentialDigest && canonicalDigest([...m.projectIds].sort()) === data.projectScopeDigest;
  const send = (socket: ServerWebSocket<RemoteSocketData>, frame: unknown) => {
    const raw=JSON.stringify(frame),frameBytes=Buffer.byteLength(raw),before=socket.getBufferedAmount();
    if(frameBytes>LIMITS.frameBytes||before+frameBytes>LIMITS.bufferBytes){ports.observeTransport?.({peer:socket.data.kind,frameBytes,bufferedBytes:before,result:0,closeReason:"Consumer unavailable"});socket.close(1008,"Consumer unavailable");return;}
    const result=socket.send(raw);ports.observeTransport?.({peer:socket.data.kind,frameBytes,bufferedBytes:socket.getBufferedAmount(),result,closeReason:null});
  };

  function invalidate(projectId: string, resource: Control["BrowserInvalidation"]["resource"], resourceId: string, resourceVersion: number) {
    for (const socket of browsers) if (socket.data.kind === "browser" && socket.data.projectId === projectId && ports.authorityValid(socket.data.authority, projectId, true)) send(socket, { v: 2, type: "resource-changed", projectId, resource, resourceId, version: resourceVersion });
  }
  function invalidateMachine(m:MachineRecord) { for(const projectId of m.projectIds) invalidate(projectId,"machine",m.machineId,m.notificationVersion??0); }
  const unsubscribeStore = store.subscribe((state, previous) => {
    for (const project of state.projects) if (project.contextRevision !== previous.projects.find((p) => p.id === project.id)?.contextRevision) {
      invalidate(project.id, "context", project.id, project.contextRevision);
      for (const [machineId, socket] of machines) {
        const m = store.remote.get<MachineRecord>("remote_machine", machineId);
        if (socket.data.kind === "machine" && socket.data.daemonId && m && socketAuthorityCurrent(m,socket.data) && m.projectIds.includes(project.id)) send(socket, { v: 2, type: "context-changed", messageId: id(), epoch: socket.data.epoch, payload: { projectId: project.id, contextRevision: project.contextRevision } });
      }
    }
  });
  function dispatch() {
    const outgoing = store.writeTransaction((_state, repo) => {
      const expired=expirePendingCommands(repo);
      const deliveries: { socket: ServerWebSocket<RemoteSocketData>; command: StoredCommand; epoch: number }[] = [];
      for (const command of repo.dispatchCommands<StoredCommand>()) {
        const socket = machines.get(command.machineId), m = repo.get<MachineRecord>("remote_machine", command.machineId);
        if (!socket || socket.data.kind !== "machine" || !socket.data.daemonId || command.status !== "pending" || Date.parse(command.envelope.expiresAt) <= Date.now() || !ports.authorityValid(command.authority, command.projectId) || !m || m.revoked || m.recoveryRequired || m.connectedEpoch !== m.epoch || m.inventoryEpoch !== m.epoch || !m.projectIds.includes(command.projectId)) continue;
        const sessionId = "target" in command.envelope ? command.envelope.target.sessionId : command.envelope.sessionId;
        const row = repo.get<SessionRow>("remote_session", sessionId);
        const projection = row && repo.get<import("./model").Projection>("remote_projection", canonicalDigest([m.machineId, command.projectId, command.envelope.checkoutId, row.record.agentProfileId]));
        if (!socketAuthorityCurrent(m,socket.data) || !projection || projection.connectionEpoch !== m.epoch || projection.inventoryVersion !== m.inventoryVersion) continue;
        if (command.deliveryEpoch === m.epoch && command.deliveredAt && Date.now() - Date.parse(command.deliveredAt) < 5000) continue;
        command.deliveredAt = iso(); command.deliveryEpoch = m.epoch;
        repo.put("remote_command", command.envelope.commandId, command, { projectId: command.projectId, machineId: m.machineId, sessionId, seq: command.envelope.hubSequence });
        deliveries.push({ socket, command, epoch: m.epoch });
      }
      return {deliveries,expired};
    });
    for (const delivery of outgoing.deliveries) send(delivery.socket, { v: 2, type: delivery.command.frameType, messageId: id(), epoch: delivery.epoch, payload: delivery.command.envelope });
    for(const change of outgoing.expired){const row=store.remote.get<SessionRow>('remote_session',change.sessionId);if(row)for(const resource of ['session','config','controller','queue'] as const)invalidate(change.projectId,resource,change.sessionId,row.notificationVersion??0);if(change.runId){const run=store.remote.get<RunRow>('remote_run',change.runId);if(run)for(const resource of ['run','approval'] as const)invalidate(change.projectId,resource,change.runId,run.notificationVersion??0);}}

  }
  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/hub/v2/")) return undefined;
    if (!ports.transportAllowed(request)) fail(403, "forbidden", "Remote control requires TLS except explicit loopback access");
    if (url.pathname.endsWith("/socket")) fail(426, "upgrade-required", "Native WebSocket upgrade required");
    const p = url.pathname.slice("/hub/v2/".length).split("/").map(decodeURIComponent);
    if (p.some((s) => !s || s.includes("/") || s.includes("\\"))) fail(404, "not-found", "Route not found");
    const method = request.method; const write = method !== "GET"; const input = write ? await body(request) : undefined;
    if (p.length === 2 && p[0] === "machines" && p[1] === "enroll" && method === "POST") {
      const b = control("EnrollmentRequest", input);
      const rateKey = "enrollment-global"; let rate = attempts.get(rateKey); if (!rate || rate.reset <= Date.now()) { rate = { count: 0, reset: Date.now() + 60000 }; attempts.set(rateKey, rate); } if (++rate.count > 20) fail(429, "rate-limited", "Enrollment temporarily rate limited");
      return ports.serialized(async () => store.writeTransaction((_state, repo) => {
        const pairing = repo.all<PairingRecord>("remote_pairing").find((entry) => entry.codeDigest === sha256(b.code));
        if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) fail(401, "unauthorized", "Pairing unavailable");
        if (pairing.consumed) fail(409, "payload-conflict", "Pairing already consumed");
        pairing.consumed = true; repo.put("remote_pairing", pairing.pairingId, pairing);
        const secret = randomBytes(32).toString("base64url");
        const m: MachineRecord = { machineId: id(), version: 1, displayName: pairing.displayName, projectIds: pairing.projectIds, credentialDigest: sha256(secret), ledgerId: b.ledgerId, revoked: false, createdAt: iso(), lastSeenAt: null, epoch: 0, hubSequence: 0, inventoryVersion: 0, recoveryRequired: false };
        repo.put("remote_machine", m.machineId, m); return json({ machineId: m.machineId, secret });
      }));
    }
    const m = resolveMachine(request);
    if (m) return machineHttp(request, p, input, m);
    const auth = await ports.human(request);
    if (write) { ports.checkOrigin(request); mutationKey(request); if (!(p[0] === "projects" && p[2] === "sessions" && p[4] === "open")) operator(auth); }
    if (!write) return humanRead(p, url, auth);
    return ports.serialized(async () => {
      const current = await ports.human(request); if (!(p[2] === "sessions" && p[4] === "open")) operator(current);
      const key = mutationKey(request); const operationId = sha256(JSON.stringify([current.actor.id, method, url.pathname, key])); const payloadDigest = canonicalDigest(input);
      const response = store.writeTransaction((state, repo) => {
        const old = repo.get<OperationRecord>("remote_operation", operationId); if (old) { if (old.payloadDigest !== payloadDigest) fail(409, "payload-conflict", "Operation payload changed"); return json(old.deliveryFailure ?? old.response, old.status); }
        let value: unknown;
        if (p[0] === "machines") {
          if (p.length === 2 && p[1] === "pairings" && method === "POST") {
            const b = control("PairingCreate", input); for (const projectId of b.projectIds) scoped(current, projectId, state);
            const code = randomBytes(16).toString("base64url"), pairingId = id(); const expiresAt = iso(Date.now() + 600000);
            repo.put("remote_pairing", pairingId, { pairingId, codeDigest: sha256(code), displayName: b.displayName, projectIds: b.projectIds, expiresAt, consumed: false } satisfies PairingRecord);
            // Code is returned once and excluded from durable operation replay.
            value = { pairingId, expiresAt }; repo.put("remote_operation", operationId, { id: operationId, key, actorId: current.actor.id, sessionDigest: current.sessionDigest, payloadDigest, request: { displayName: b.displayName, projectIds: b.projectIds }, kind: "pairing", response: value, status: 200 } satisfies OperationRecord); return json({ ...value as object, code });
          }
          if (p.length === 3 && p[2] === "resolve-run" && method === "POST") value = resolveRun(state, repo, current, machine(repo, p[1]!), control("ResolveRunRequest", input));
          else if (p.length === 3 && p[2] === "revoke" && method === "POST") { const b = control("MachineRevoke", input); const target = machine(repo, p[1]!); for (const projectId of target.projectIds) scoped(current, projectId, state); version(target.version, b.expectedVersion); target.revoked = true; target.version++; target.notificationVersion=(target.notificationVersion??0)+1; repo.put("remote_machine", target.machineId, target); value = { machineId: target.machineId, version: target.version, revoked: true }; }
          else fail(404, "not-found", "Route not found");
        } else if (p[0] === "projects" && p[1]) {
          scoped(current, p[1], state);
          value = projectMutation(state, p, method, input, current, operationId);
        } else fail(404, "not-found", "Route not found");
        repo.put("remote_operation", operationId, { id: operationId, key, actorId: current.actor.id, sessionDigest: current.sessionDigest, projectId: p[0] === "projects" ? p[1] : undefined, sessionId: p[2] === "sessions" ? p[3] : undefined, payloadDigest, request: input, ...(validateControl("SessionOperationReceipt", value).ok && p[2] === "sessions" && p[3] && control("SessionOperationReceipt", value).sessionId !== p[3] ? { derivedSessionId: control("SessionOperationReceipt", value).sessionId } : {}), kind: p.slice(2).join("/"), response: value, status: 200 } satisfies OperationRecord, { projectId: p[0] === "projects" ? p[1] : undefined, sessionId: p[2] === "sessions" ? p[3] : undefined });
        return json(value);
      });
      for (const [machineId, socket] of machines) if (store.remote.get<MachineRecord>("remote_machine", machineId)?.revoked) socket.close(1008, "Authorization changed");
      if(p[0]==='machines'&&p[1]&&p[2]==='revoke'){const changed=store.remote.get<MachineRecord>('remote_machine',p[1]);if(changed)invalidateMachine(changed);}
      if(p[0]==='machines'&&p[1]&&p[2]==='resolve-run'){const runId=(input as {runId?:unknown}|undefined)?.runId;const changed=typeof runId==='string'?store.remote.get<RunRow>('remote_run',runId):undefined;if(changed&&changed.machineId===p[1])invalidate(changed.projectId,'run',changed.runId,changed.notificationVersion??0);}
      if (p[0] === "projects" && p[1]) { if (p[2] === "sessions" && p[3]) { const currentSession = store.remote.get<SessionRow>("remote_session", p[3]); if (currentSession) invalidate(p[1], p[4] === "controller" ? "controller" : p[4] === "queue" ? "queue" : p[4] === "config" || p[4] === "routing" ? "config" : "session", p[3], currentSession.notificationVersion??0); } else { const changedRun = p[2] === "runs" && p[3] ? store.remote.get<RunRow>("remote_run", p[3]) : undefined; invalidate(p[1], p[2] === "runs" ? p[4] === "approvals" ? "approval" : "run" : "session", p[3] ?? p[1], changedRun?.notificationVersion ?? 0); } }
      dispatch(); return response;
    });
  }
  function projectMutation(state: HubState, p: string[], method: string, input: unknown, auth: HumanAuthority, operationId: string): unknown {
    const projectId = p[1]!;
    if (p[2] === "sessions" && !p[3] && method === "POST") return createSession(state, store.remote, deps, auth, projectId, control("SessionCreate", input), operationId);
    if (p[2] === "runs" && !p[3] && method === "POST") {
      const b = control("StartTurnRequest", input); const row = session(store.remote, projectId, b.sessionId); version(row.record.historyVersion, b.expectedHistoryVersion); if (row.record.workspaceBaseline !== b.expectedWorkspaceBaseline) fail(409, "workspace-conflict", "Workspace baseline changed");
      return submitMessage(state, store.remote, deps, auth, row, { expectedSessionVersion: b.expectedSessionVersion, controller: b.controller, expectedConfigVersion: b.expectedConfigVersion, text: b.text, interpretation: "literal-message", association: b.association, busyPolicy: "reject" }, operationId);
    }
    if (p[2] === "runs" && p[3]) return runMutation(state, p, input, auth, operationId);
    if (p[2] !== "sessions" || !p[3]) fail(404, "not-found", "Route not found");
    const row = session(store.remote, projectId, p[3]);
    if (p[4] === "queue" && p[5]) { const b = p[6] === "reauthorize" ? control("QueueReauthorize", input) : method === "PATCH" ? control("QueueEdit", input) : control("QueueRemove", input); if (b.queueItemId !== p[5]) fail(400, "invalid-arguments", "Queue path/body identity mismatch"); }
    if (!["open"].includes(p[4] ?? "")) idleFence(row);
    if(row.closing&&(row.pendingClosure||row.record.state!=='closed')&&p[4]==='controller'&&p[5]==='claim')fail(409,'session-closed','Closing session cannot transfer control');
    if (p[4] === "controller" && p[5]) { const receipt = controllerMutation(store.remote, auth, row, p[5], input); sessionCommand(store.remote, machine(store.remote, row.record.machineId), row, auth, operationId, p[5] === "release" ? "release-controller" : "claim-controller", input); return receipt; }
    if (p[4] === "open") { const b = control("SessionOpen", input); version(row.record.version, b.expectedSessionVersion); return row.record; }
    if (p[4] === "messages") return submitMessage(state, store.remote, deps, auth, row, control("MessageSubmit", input), operationId);
    if ((p[4] === "config" || p[4] === "routing") && !p[5]) return configChange(store.remote, auth, row, control("ConfigChange", input), operationId);
    if (p[4] === "config" && p[5] === "confirm") return configConfirm(store.remote, auth, row, control("CommandConfirmation", input), operationId,ports.authorityValid);
    if (p[4] === "queue" && p[5]) return queueMutation(row, auth, p[5], method, input, operationId, p[6]);
    if (["resume", "fork", "close"].includes(p[4]!)) return lifecycle(row, auth, p[4]!, input, operationId);
    if (p[4] === "commands") return invoke(row, auth, p[5]!, input, operationId);
    fail(404, "not-found", "Route not found");
  }
  function runMutation(state: HubState, p: string[], input: unknown, auth: HumanAuthority, operationId: string): unknown {
    const run = store.remote.get<RunRow>("remote_run", p[3]!); if (!run || run.projectId !== p[1]) fail(404, "not-found", "Run not found");
    const row = session(store.remote, run.projectId, run.sessionId); const m = machine(store.remote, run.machineId);
    const controller = row.record.controller; if (!controller) fail(409, "controller-conflict", "Current controller required");
    held(row, auth, { controllerLeaseId: controller.controllerLeaseId, expectedControllerVersion: controller.version });
    if (p[4] === "cancel") {
      const b = control("CancelRequest", input); version(run.version, b.expectedRunVersion);
      if (["succeeded", "failed", "cancelled", "rejected", "lost"].includes(run.state)) fail(409, "cancel-too-late", "Run already terminal");
      run.cancelRequested = true; run.notificationVersion = (run.notificationVersion ?? 0) + 1; store.remote.put("remote_run", run.runId, run, { projectId: run.projectId, machineId: run.machineId, sessionId: run.sessionId, runId: run.runId });
      runCommand(store.remote, m, row, auth, operationId, run.runId, run.turnId, run.version, "cancel-run", { reason: b.reason }, { controllerLeaseId: controller.controllerLeaseId, expectedControllerVersion: controller.version }); return { runId: run.runId, version: run.version, status: "requested", confirmed: false };
    }
    if (p[4] === "approvals" && p[5] && p[6] === "answer") {
      const b = control("ApprovalAnswer", input);
      const question = store.remote.get<ApprovalRow>("remote_approval_projection", p[5]);
      // An unanswered waiter of this run that expired is refused as expired before the version check: stale-version would invite a retry that can never apply.
      if (question && !question.answer && question.runId === run.runId && (question.status !== "waiting" || Date.parse(question.expiresAt) <= Date.now())) fail(409, "approval-expired", "Approval binding or waiter is no longer current");
      version(run.version, b.expectedRunVersion);
      const answerDigest = canonicalDigest([p[5], b.actionFingerprint, b.policyDigest, b.decision]);
      if (question?.answer) { if (question.answer.digest !== answerDigest || question.answer.actorId !== auth.actor.id) fail(409, "payload-conflict", "Approval answer is already immutable"); return question.answer.receipt; }
      if (!question || question.runId !== run.runId || question.localRequired || question.status !== "waiting" || question.actionFingerprint !== b.actionFingerprint || question.policyDigest !== b.policyDigest || Date.parse(question.expiresAt) <= Date.now()) fail(409, "approval-expired", "Approval binding or waiter is no longer current");
      const command = runCommand(store.remote, m, row, auth, operationId, run.runId, run.turnId, run.version, "answer-approval", { approvalId: p[5], actionFingerprint: b.actionFingerprint, policyDigest: b.policyDigest, decision: b.decision }, { controllerLeaseId: controller.controllerLeaseId, expectedControllerVersion: controller.version });
      const receipt = { approvalId: p[5], receiptId: id(), status: "recorded" as const, decision: b.decision }; question.status = "recorded"; question.decision = b.decision; question.answer = { digest: answerDigest, actorId: auth.actor.id, commandId: command.envelope.commandId, receipt };
      store.remote.put("remote_approval_projection", p[5], question, { projectId: run.projectId, machineId: run.machineId, sessionId: run.sessionId, runId: run.runId }); run.notificationVersion = (run.notificationVersion ?? 0) + 1; store.remote.put("remote_run", run.runId, run, { projectId: run.projectId, machineId: run.machineId, sessionId: run.sessionId, runId: run.runId }); return receipt;
    }
    fail(404, "not-found", "Run action not found");
  }
  async function machineHttp(request: Request, p: string[], input: unknown, m: MachineRecord): Promise<Response> {
    if (request.headers.has("origin")) fail(403, "origin-denied", "Machine HTTP requires native credentials without browser Origin");
    if (request.method === "GET" && p[0] === "projects" && p[1] && p[2] === "sessions" && p[3]) {
      const row = session(store.remote, p[1], p[3]); if (row.record.machineId !== m.machineId || !m.projectIds.includes(p[1])) fail(404, "not-found", "Session not found");
      if (!p[4]) {
        const activeRunId = row.record.activeRunId;
        if (!activeRunId) {
          const response = json(row.record);
          const lease = row.record.controller;
          if (!lease || lease.state !== "held" || Date.parse(lease.expiresAt) <= Date.now()) return response;
          const applied = store.remote.all<StoredCommand>("remote_command", { machineId: m.machineId, projectId: p[1], sessionId: row.record.sessionId }).reverse().find((candidate) => {
            const envelope = candidate.envelope;
            if (candidate.frameType !== "session-command" || envelope.kind !== "claim-controller" || candidate.status !== "applied"
              || envelope.target.sessionId !== row.record.sessionId || envelope.checkoutId !== row.record.checkoutId
              || envelope.authorizedBy !== lease.actorId || envelope.commandDigest !== sessionCommandDigest(envelope)) return false;
            const operation = store.remote.get<OperationRecord>("remote_operation", candidate.operationId);
            const receipt = operation && validateControl("ControllerReceipt", operation.response);
            const delivery = parseMachineFrame(JSON.stringify({ v: 2, type: "session-command-receipt", messageId: "authority-check", epoch: 1, payload: candidate.receipt }), "machine-to-hub");
            return operation?.sessionId === row.record.sessionId && operation.projectId === p[1] && operation.actorId === lease.actorId
              && receipt?.ok === true && canonicalDigest(receipt.value.lease) === canonicalDigest(lease) && receipt.value.sessionVersion <= row.record.version
              && delivery.ok && delivery.value.type === "session-command-receipt" && delivery.value.payload.status === "applied"
              && delivery.value.payload.commandId === envelope.commandId && delivery.value.payload.sessionId === row.record.sessionId
              && delivery.value.payload.receiptId === receipt.value.receiptId;
          });
          if (!applied) return response;
          if (!ports.authorityValid(applied.authority, p[1])) fail(403, "forbidden", "Current applied controller authority required");
          operator(applied.authority); scoped(applied.authority, p[1], store.load());
          held(row, applied.authority, { controllerLeaseId: lease.controllerLeaseId, expectedControllerVersion: lease.version });
          response.headers.set("X-Keryx-Action-Authority", "checked-v2"); return response;
        }
        const run = store.remote.get<RunRow>("remote_run", activeRunId);
        const command = run && store.remote.get<StoredCommand>("remote_command", run.commandId);
        const binding = run && command && executionBinding(command, run);
        if (!run || !command || !binding || run.machineId !== m.machineId || run.projectId !== p[1] || run.sessionId !== row.record.sessionId || run.checkoutId !== row.record.checkoutId || run.turnId !== row.record.activeTurnId || !ports.authorityValid(command.authority, p[1])) fail(403, "forbidden", "Current run actor authority required");
        operator(command.authority); scoped(command.authority, p[1], store.load()); held(row, command.authority, binding.controller);
        if (run.snapshot.config.policyDigest !== row.record.config.policyDigest || run.snapshot.config.capabilityDigest !== row.record.config.capabilityDigest) fail(409, "stale-reference", "Active execution policy changed");
        try { checkAssociation(store.load(), run.association); }
        catch (cause) {
          // The run's pinned Flow is no longer current executable work: a final answer for this run, never a transient pause.
          if (!(cause instanceof HubFailure)) throw cause;
          const refused = json({ error: { code: cause.code, message: cause.message } }, cause.status); refused.headers.set("X-Keryx-Action-Authority", "association-stale"); return refused;
        }
        const response = json(row.record);
        response.headers.set("X-Keryx-Action-Authority", "checked-v2");
        return response;
      }
      if (p[4] === "operations" && p[5] && p.length === 6) {
        const release = releasedControllerAlias(store.remote, row, p[5]); if (release) return json(release);
        const direct = store.remote.get<OperationRecord>("remote_operation", p[5]);
        const command = store.remote.get<StoredCommand>("remote_command", p[5]);
        if (command && direct && command.operationId !== direct.id) fail(409, "payload-conflict", "Ambiguous operation alias");
        if (command && (command.machineId !== m.machineId || command.projectId !== p[1] || ("target" in command.envelope ? command.envelope.target.sessionId : command.envelope.sessionId) !== p[3])) fail(404, "not-found", "Operation not found");
        const operation = command ? store.remote.get<OperationRecord>("remote_operation", command.operationId) : direct;
        if (!operation || operation.projectId !== p[1] || operation.sessionId !== p[3]) fail(404, "not-found", "Operation not found");
        return json(operation.deliveryFailure ?? operation.response,operation.status);
      }
      fail(404, "not-found", "Machine session read unavailable");
    }
    if (p[0] === "projects" && p[1] && p[2] === "runs" && p[3] && p[4] === "result" && request.method === "POST") {
      const b = control("ResultUpload", input); const key = mutationKey(request);
      return ports.serialized(async () => {
        const response = store.writeTransaction((state, repo) => json(resultUpload(state, repo, machine(repo, m.machineId), p[1]!, p[3]!, b, key)));
        const changed = store.remote.get<RunRow>("remote_run", p[3]!); if (changed) invalidate(changed.projectId, "run", changed.runId, changed.notificationVersion ?? 0);
        return response;
      });
    }
    if (p[0] !== "machines" || p[1] !== m.machineId) fail(403, "forbidden", "Machine cannot perform human control actions");
    if (p[2] === "recovery" && request.method === "GET") {
      const after = Number(new URL(request.url).searchParams.get("after") ?? "0"); if (!Number.isSafeInteger(after) || after < 0) fail(400, "invalid-cursor", "Invalid recovery cursor");
      const all = store.remote.all<RunRow>("remote_run", { machineId: m.machineId }).filter((r) => m.projectIds.includes(r.projectId));
      const runs = all.slice(after, after + 100).map((r) => ({ runId: r.runId, projectId: r.projectId, checkoutId: r.checkoutId, version: r.version, state: r.state, lastLocalSeq: r.lastLocalSeq, commandDigest: r.commandDigest, sessionId: r.sessionId, turnId: r.turnId, association: r.association }));
      const allSessions = store.remote.all<SessionRow>("remote_session", { machineId: m.machineId }).filter((r) => m.projectIds.includes(r.record.projectId));
      const sessions = allSessions.slice(after, after + 100).map((r) => r.record);
      let count = 0, bytes = 2048;
      for (; count < Math.max(runs.length, sessions.length); count++) { const size = Buffer.byteLength(JSON.stringify(runs[count] ?? null)) + Buffer.byteLength(JSON.stringify(sessions[count] ?? null)) + 2; if (bytes + size > LIMITS.eventPageBytes) break; bytes += size; }
      const cursor = after + count;
      return json(control("RecoveryPage", { runs:runs.slice(0,count), sessions:sessions.slice(0,count), cursor, hasMore: Math.max(all.length,allSessions.length) > cursor, hubSequence: m.hubSequence }));
    }
    if (request.method !== "POST") fail(405, "method-not-allowed", "Unsupported machine method");
    const key = mutationKey(request);
    return ports.serialized(async () => store.writeTransaction((_state, repo) => {
      const current = machine(repo, m.machineId);
      if (p[2] === "commands" && p[3] && p[4] === "authorize") {
        const b = control("AuthorizeCommand", input); const command = repo.get<StoredCommand>("remote_command", p[3]);
        if (!command || command.machineId !== m.machineId || !current.projectIds.includes(command.projectId) || command.envelope.commandDigest !== b.commandDigest || Date.parse(command.envelope.expiresAt) <= Date.now() || !ports.authorityValid(command.authority, command.projectId)) fail(403, "forbidden", "Command authority expired or changed");
        const envelope = command.envelope;
        if (["applied", "admitted", "rejected", "not-applied", "unknown", "expired-unconfirmed"].includes(command.status)) fail(409, "stale-reference", "Command is already terminal or requires reconciliation");
        if (("target" in envelope ? sessionCommandDigest(envelope) : runCommandDigest(envelope)) !== envelope.commandDigest || envelope.authorizedBy !== command.authority.actor.id) fail(409, "payload-conflict", "Stored immutable command integrity changed");
        const expectedTarget: Control["CommandTarget"] = "target" in envelope ? envelope.target : { scope: "run", sessionId: envelope.sessionId, runId: envelope.runId, turnId: envelope.turnId, expectedRunVersion: envelope.expectedRunVersion, expectedSessionVersion: envelope.expectedSessionVersion };
        if (canonicalDigest(expectedTarget) !== canonicalDigest(b.target)) fail(409, "stale-reference", "Authorization target differs from immutable command");
        const row = session(repo, command.projectId, expectedTarget.sessionId);
        if (row.record.machineId !== current.machineId || row.record.checkoutId !== envelope.checkoutId) fail(403, "scope-denied", "Command checkout ownership changed");
        if (envelope.kind === "create-session") { if (expectedTarget.expectedSessionVersion !== 0 || row.record.state !== "opening") fail(409, "stale-reference", "Session creation already applied"); }
        else version(row.record.version, expectedTarget.expectedSessionVersion);
        if (expectedTarget.scope === "run") { const ownedRun = repo.get<RunRow>("remote_run", expectedTarget.runId); if (!ownedRun || ownedRun.sessionId !== row.record.sessionId || ownedRun.turnId !== expectedTarget.turnId || ownedRun.machineId !== current.machineId) fail(403, "scope-denied", "Run target ownership changed"); version(ownedRun.version, expectedTarget.expectedRunVersion); }
        if ("controller" in envelope.body && canonicalDigest(envelope.body.controller) !== canonicalDigest(b.controller)) fail(409, "controller-conflict", "Original operation controller differs from authorization");
        const stopOnly = envelope.kind === "cancel-run" || envelope.kind==='close-session' || ((envelope.kind==='answer-approval'||envelope.kind==='confirm-command')&&envelope.body.decision==='deny') || (envelope.kind === "invoke-command" && isStopOnlyCommand(envelope.body));
        if (current.recoveryRequired && !stopOnly) fail(409, "recovery-required", "Machine reconciliation required before application");
        if(!stopOnly&&['start-turn','submit-message','invoke-command','change-config','resume-session','fork-session','create-session'].includes(envelope.kind))completeProjection(repo,row);
        if (envelope.kind === "start-turn") checkAssociation(_state, envelope.body.request.association, command.projectId);
        if (envelope.kind === "submit-message") checkAssociation(_state, envelope.body.association, command.projectId);
        if (envelope.kind === "invoke-command") { validateOwnedControl(repo, row, envelope.body); if (envelope.body.association) checkAssociation(_state, envelope.body.association, command.projectId); }
        authorizeLifecycle(repo,row,command);
        authorizeConfirmation(repo,row,command,ports.authorityValid);

        if (b.controller) held(row, command.authority, b.controller);
        else if (envelope.kind !== "create-session" && envelope.kind !== "claim-controller") fail(409, "controller-conflict", "Controller binding required");
        if (!stopOnly && b.policyDigest !== command.policyDigest) fail(409, "stale-reference", "Pinned local policy changed");
        if ("controller" in envelope && canonicalDigest(envelope.controller) !== canonicalDigest(b.controller)) fail(409, "controller-conflict", "Command controller binding changed");
        if (envelope.kind === "answer-approval") { const question = repo.get<ApprovalRow>("remote_approval_projection", envelope.body.approvalId); if (!question || question.answer?.commandId !== envelope.commandId || !["recorded", "delivered"].includes(question.status) || question.localRequired || Date.parse(question.expiresAt) <= Date.now() || question.actionFingerprint !== envelope.body.actionFingerprint || question.policyDigest !== envelope.body.policyDigest) fail(409, "approval-expired", "Exact recorded approval is no longer applicable"); }
        if (envelope.kind === "answer-approval" && (b.actionFingerprint !== envelope.body.actionFingerprint)) fail(409, "stale-reference", "Approval action fingerprint changed");
        const grantId = sha256(JSON.stringify([m.machineId, p[3], key])); const old = repo.get<{ digest: string; grant: Control["AuthorizationGrant"] }>("remote_authorization_grant", grantId);
        if (old) { if (old.digest !== canonicalDigest(b) || Date.parse(old.grant.expiresAt) <= Date.now()) fail(409, "command-expired", "Authorization attempt expired or changed; renew with new identity"); return json(old.grant); }
        // One clock read: two reads straddling a millisecond issued a 5001 ms grant, which every machine correctly refuses as over the limit.
        const issuedAt = Date.now();
        const grant: Control["AuthorizationGrant"] = { grantId: id(), commandId: p[3], commandDigest: b.commandDigest, authorizedBy: command.authority.actor.id, authorizedAt: iso(issuedAt), expiresAt: iso(issuedAt + LIMITS.grantMs), policyDigest: b.policyDigest, target: b.target, controller: b.controller, ...(b.actionFingerprint ? { actionFingerprint: b.actionFingerprint } : {}) };
        repo.put("remote_authorization_grant", grantId, { digest: canonicalDigest(b), grant }, { projectId: command.projectId, machineId: m.machineId, sessionId: expectedTarget.sessionId }); return json(grant);
      }
      if (p[2] === "reconciliations") {
        const b = control("ReconciliationReport", input); const socket = machines.get(current.machineId); const daemon = socket?.data.kind === "machine" ? socket.data.daemonId : undefined;
        return json(reconcile(repo, current, b, sha256(JSON.stringify([current.machineId, "reconcile", key])), key, daemon));
      }
      fail(404, "not-found", "Machine route not found");
    }));
  }
  async function upgrade(request: Request, server: Server<RemoteSocketData>): Promise<Response | undefined> {
    if (transportsClosed) fail(503, "closed", "Hub transport is closing");
    if (!ports.transportAllowed(request)) fail(403, "forbidden", "Remote control requires TLS except explicit loopback access");
    const url = new URL(request.url);
    if (url.pathname === "/hub/v2/machines/socket") {
      if (request.headers.has("origin") || url.search || request.headers.has("cookie")) fail(403, "origin-denied", "Native machine upgrade required");
      if (request.headers.get("sec-websocket-protocol") !== MACHINE_SUBPROTOCOL) fail(400, "unsupported-version", "Exact machine v2 subprotocol required");
      return ports.serialized(async () => {
        const m = scopedMachine(request); if (machines.has(m.machineId) || pending.has(m.machineId)) fail(409, "machine-busy", "Machine already has a live connection");
        const epoch = store.writeTransaction((_state, repo) => { const current = machine(repo, m.machineId); current.epoch++; repo.put("remote_machine", current.machineId, current); return current.epoch; });
        pending.add(m.machineId);
        if (server.upgrade(request, { data: { kind: "machine", machineId: m.machineId, credentialDigest: m.credentialDigest, projectScopeDigest: canonicalDigest([...m.projectIds].sort()), epoch, daemonId: null, lastHeartbeat: Date.now() }, headers: { "Sec-WebSocket-Protocol": MACHINE_SUBPROTOCOL } })) return undefined;
        pending.delete(m.machineId); return json({ error: { code: "upgrade-failed", message: "Upgrade unavailable" } }, 400);
      });
    }
    if (url.pathname === "/hub/v2/events/socket") {
      if (request.headers.has("authorization") || request.headers.has("sec-websocket-protocol") || [...url.searchParams.keys()].some((key) => key !== "projectId")) fail(403, "forbidden", "Human browser event session required");
      ports.checkOrigin(request); const auth = await ports.human(request); const projectId = url.searchParams.get("projectId"); if (!projectId) fail(400, "scope-denied", "Explicit project subscription required"); scoped(auth, projectId, store.load());
      return server.upgrade(request, { data: { kind: "browser", authority: auth, request, projectId, lastHeartbeat: Date.now() } }) ? undefined : json({ error: { code: "upgrade-failed", message: "Upgrade unavailable" } }, 400);
    }
    return handle(request);
  }
  const websocket: WebSocketHandler<RemoteSocketData> = {
    maxPayloadLength: LIMITS.frameBytes, backpressureLimit: LIMITS.bufferBytes, closeOnBackpressureLimit: true,
    open(socket) { trackedTransports.add(socket); if (socket.data.kind === "machine") { pending.delete(socket.data.machineId); machines.set(socket.data.machineId, socket); } else browsers.add(socket); },
    close(socket,code,reason) {
      ports.observeTransport?.({peer:socket.data.kind,frameBytes:0,bufferedBytes:socket.getBufferedAmount(),result:0,closeReason:`closed:${code}:${reason}`});
      if (socket.readyState === 3) trackedTransports.delete(socket);
      if (socket.data.kind === "machine") {
        const closedMachine=socket.data;
        if(machines.get(closedMachine.machineId)===socket)machines.delete(closedMachine.machineId);
        pending.delete(closedMachine.machineId);
        if(!transportsClosed)void ports.serialized(async()=>{
          const updated=store.writeTransaction((_state,repo)=>{
            const current=repo.get<MachineRecord>("remote_machine",closedMachine.machineId);
            if(!current||current.epoch!==closedMachine.epoch)return undefined;
            delete current.connectedEpoch;current.notificationVersion=(current.notificationVersion??0)+1;repo.put("remote_machine",current.machineId,current);return current;
          });
          if(updated)invalidateMachine(updated);
        }).catch((error:unknown)=>console.error("Hub disconnect persistence failed",error instanceof Error?error.name:"UnknownError"));
      }else browsers.delete(socket);
    },
    message(socket, raw) {
      if (socket.data.kind !== "machine") { socket.close(1008, "Read-only subscription"); return; }
      const parsed = parseMachineFrame(typeof raw === "string" ? raw : new Uint8Array(raw), "machine-to-hub");
      if (!parsed.ok) { socket.close(parsed.error.code === "quota-exceeded" ? 1009 : 1008, "Invalid frame"); return; }
      const frame = parsed.value;
      void ports.serialized(async () => {
        if (transportsClosed || socket.data.kind !== "machine") return;
        const data = socket.data;
        const outgoing = store.writeTransaction((_state, repo) => {
          const m = machine(repo, data.machineId);
          if (!socketAuthorityCurrent(m, data)) fail(403, "scope-denied", "Authenticated machine credential or scope changed");
          if (m.epoch !== data.epoch || (frame.type !== "hello" && frame.epoch !== data.epoch)) fail(409, "stale-epoch", "Connection epoch changed");
          if (frame.type === "hello") {
            if (data.daemonId || frame.epoch !== 0) fail(409, "stale-epoch", "Hello already admitted");
            const mode = admitHello(repo, m, frame.payload);
            if (mode === "ledger-mismatch") { repo.put("remote_machine", m.machineId, m); return [{ v: 2, type: "error", messageId: id(), epoch: data.epoch, payload: { code: "recovery-required", relatedMessageId: frame.messageId } }]; }
            repo.clearCapabilityStaging(m.machineId); data.daemonId = frame.payload.daemonId; data.lastHeartbeat = Date.now(); m.connectedEpoch = data.epoch; m.lastSeenAt = iso(); m.notificationVersion=(m.notificationVersion??0)+1; repo.put("remote_machine", m.machineId, m);
            return [{ v: 2, type: "welcome", messageId: id(), epoch: data.epoch, payload: { machineId: m.machineId, heartbeatSeconds: 20, heartbeatTimeoutSeconds: 60, resumeMode: mode, hubSequence: m.hubSequence } }];
          }
          if (!data.daemonId) fail(409, "stale-epoch", "Hello required");
          m.lastSeenAt = iso();
          if (frame.type === "heartbeat") { if (frame.payload.daemonId !== data.daemonId) fail(403, "scope-denied", "Daemon identity mismatch"); data.lastHeartbeat = Date.now(); repo.put("remote_machine", m.machineId, m); return [{ v: 2, type: "heartbeat-ack", messageId: id(), epoch: data.epoch, payload: { serverTime: iso() } }]; }
          if (frame.type === "inventory") {
            if (new Set(frame.payload.checkouts.map((c) => `${c.projectId}:${c.checkoutId}`)).size !== frame.payload.checkouts.length || frame.payload.checkouts.some((c) => new Set(c.agentProfiles.map((profile) => profile.profileId)).size !== c.agentProfiles.length)) fail(400, "invalid-frame", "Inventory identities must be unique");
            if (frame.payload.checkouts.some((c) => !m.projectIds.includes(c.projectId))) fail(403, "scope-denied", "Inventory project denied");
            const existing = repo.get("remote_inventory", m.machineId);
            if (frame.payload.inventoryVersion < m.inventoryVersion || (frame.payload.inventoryVersion === m.inventoryVersion && existing && canonicalDigest(existing) !== canonicalDigest(frame.payload))) fail(409, "payload-conflict", "Inventory version changed on replay");
            m.inventoryVersion = frame.payload.inventoryVersion; m.inventoryEpoch = data.epoch; repo.put("remote_inventory", m.machineId, frame.payload, { machineId: m.machineId });
          } else if (frame.type === "capability-page") ingestCapabilities(repo, m, frame.payload);
          else if (frame.type === "session-command-receipt" || frame.type === "command-receipt") commandReceipt(repo, m, frame,ports.authorityValid);
          else if (frame.type === "session-event") { const seq = ingestSessionEvent(repo, m, frame.payload); completeCursorRecovery(repo, m); if (frame.payload.kind === "session-state") { drainSessionQueue(_state, repo, deps, frame.payload.sessionId); m.hubSequence = Math.max(m.hubSequence, repo.get<MachineRecord>("remote_machine", m.machineId)?.hubSequence ?? 0); } repo.put("remote_machine", m.machineId, m); return [{ v: 2, type: "session-event-ack", messageId: id(), epoch: data.epoch, payload: { sessionId: frame.payload.sessionId, sessionEventSeq: seq } }]; }
          else if (frame.type === "run-event") { const seq = ingestRunEvent(repo, m, frame.payload); if(typeof seq!=='number')return [{v:2,type:'error',messageId:id(),epoch:data.epoch,payload:{code:seq.error,relatedMessageId:frame.messageId}}]; completeCursorRecovery(repo, m); repo.put("remote_machine", m.machineId, m); return [{ v: 2, type: "run-event-ack", messageId: id(), epoch: data.epoch, payload: { runId: frame.payload.runId, localSeq: seq } }]; }
          if(frame.type==="inventory"||frame.type==="capability-page")m.notificationVersion=(m.notificationVersion??0)+1;
          if(frame.type==='inventory'||frame.type==='capability-page')for(const row of repo.all<SessionRow>('remote_session',{machineId:m.machineId}))if(frame.type==='inventory'||row.record.projectId===frame.payload.projectId&&row.record.checkoutId===frame.payload.checkoutId&&row.record.agentProfileId===frame.payload.agentProfileId)saveSession(repo,row);

          repo.put("remote_machine", m.machineId, m); return [];
        });
        for (const value of outgoing) send(socket, value);
        if(frame.type==="hello"||frame.type==="inventory"||frame.type==="capability-page") { const m=store.remote.get<MachineRecord>("remote_machine",data.machineId);if(m)invalidateMachine(m); if(frame.type==='inventory'||frame.type==='capability-page')for(const row of store.remote.all<SessionRow>('remote_session',{machineId:data.machineId}))if(frame.type==='inventory'||row.record.projectId===frame.payload.projectId&&row.record.checkoutId===frame.payload.checkoutId&&row.record.agentProfileId===frame.payload.agentProfileId)for(const resource of ['config','command-catalogue'] as const)invalidate(row.record.projectId,resource,row.record.sessionId,row.notificationVersion??0); }
        if (frame.type === "hello" && socket.data.kind === "machine" && !socket.data.daemonId) socket.close(1008, "Local ledger recovery required");
        if (frame.type === "session-event" || frame.type === "capability-page" || frame.type === "heartbeat") dispatch();
        if(frame.type==='command-receipt'||frame.type==='session-command-receipt'){
          const changedCommand=store.remote.get<StoredCommand>('remote_command',frame.payload.commandId);
          if(changedCommand){const envelope=changedCommand.envelope;const sessionId='target' in envelope?envelope.target.sessionId:envelope.sessionId;const row=store.remote.get<SessionRow>('remote_session',sessionId);if(row)for(const resource of ['session','queue'] as const)invalidate(changedCommand.projectId,resource,sessionId,row.notificationVersion??0);const runId='target' in envelope?envelope.target.scope==='run'?envelope.target.runId:undefined:envelope.runId;if(runId){const run=store.remote.get<RunRow>('remote_run',runId);if(run)invalidate(changedCommand.projectId,'run',runId,run.notificationVersion??0);}}
        }
        if (frame.type === "command-receipt") { const command = store.remote.get<StoredCommand>("remote_command", frame.payload.commandId); const run = store.remote.get<RunRow>("remote_run", frame.payload.runId); if (command?.envelope.kind === "answer-approval" && run) invalidate(run.projectId, "approval", run.runId, run.notificationVersion ?? run.lastLocalSeq); }
        if (frame.type === "session-event") { const row = store.remote.get<SessionRow>("remote_session", frame.payload.sessionId); if (row) invalidate(frame.payload.projectId, frame.payload.kind === "config-receipt" ? "config" : frame.payload.kind === "controller-changed" ? "controller" : frame.payload.kind === "message" ? "history" : frame.payload.kind === "queue-changed" ? "queue" : "session", row.record.sessionId, row.notificationVersion??0); }
        if (frame.type === "run-event") { const run = store.remote.get<RunRow>("remote_run", frame.payload.runId); if (run) invalidate(run.projectId, frame.payload.kind === "approval-request" || frame.payload.kind === "approval-outcome" ? "approval" : "run", run.runId, run.notificationVersion ?? frame.payload.localSeq); }
      }).catch((error: unknown) => {
        const code = error instanceof HubFailure ? error.code : "internal-error";
        const response = { v: 2, type: "error", messageId: id(), epoch: socket.data.kind === "machine" ? socket.data.epoch : 0, payload: { code, relatedMessageId: frame.messageId } };
        // HTTP domain errors are broader than the frozen native error union.
        // Keep that distinction without sending an unparseable machine frame.
        if (!parseMachineFrame(JSON.stringify(response), "hub-to-machine").ok) response.payload.code = error instanceof HubFailure && error.status < 500 ? "invalid-frame" : "internal-error";
        send(socket,response);
        if (["unauthorized", "scope-denied", "stale-epoch", "internal-error"].includes(response.payload.code)) socket.close(1008, "Authorization changed");
      });
    },
  };
  let maintenancePending = false;
  const timer = setInterval(() => {
    for (const socket of machines.values()) { const data = socket.data; if (data.kind !== "machine") continue; const m = store.remote.get<MachineRecord>("remote_machine", data.machineId); if (!m || !socketAuthorityCurrent(m, data) || Date.now() - data.lastHeartbeat > LIMITS.heartbeatTimeoutMs) socket.close(1008, "Authorization or heartbeat changed"); }
    for (const socket of browsers) { const data = socket.data; if (data.kind !== "browser") continue; void ports.human(data.request).then((auth) => { if (!ports.authorityValid(auth, data.projectId, true)) socket.close(1008, "Authorization changed"); }).catch(() => socket.close(1008, "Authorization changed")); }
    if (!maintenancePending && !transportsClosed) { maintenancePending = true; void ports.serialized(async () => { store.writeTransaction((state, repo) => { retireRunLogs(repo); for(const sessionId of repo.retryableSessions(Date.now()))drainSessionQueue(state,repo,deps,sessionId); }); dispatch(); }).catch((error: unknown) => console.error("Hub maintenance failed", error instanceof Error ? error.name : "UnknownError")).finally(() => { maintenancePending = false; }); }
  }, LIMITS.heartbeatMs); timer.unref();
  function machineRead(request: Request, path: string[], url: URL): Response | undefined {
    const m = resolveMachine(request); if (!m) return undefined;
    if (request.method !== "GET" || path[0] !== "projects" || !path[1] || !m.projectIds.includes(path[1]) || !["context", "documents", "flows"].includes(path[2] ?? "")) fail(403, "scope-denied", "Machine context read denied");
    return json(hubRead(store.load(), path, url));
  }
  return { handle, upgrade, websocket, machineRead, transportsClosed() { return (shutdownSnapshot ?? [...trackedTransports]).every((socket) => socket.readyState === 3); }, close() { shutdownSnapshot ??= [...trackedTransports]; transportsClosed = true; unsubscribeStore(); clearInterval(timer); for (const socket of trackedTransports) if (socket.readyState !== 3) socket.close(1012, "Hub restart"); machines.clear(); browsers.clear(); pending.clear(); } };
}
