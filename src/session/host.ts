import { createRewindRecorder } from "../rewind/recorder";
import { createNativeRewindPort, rewindCommands, type RewindEffectInput, type NativeRewindPort } from "./commands/rewind";
import { createNativeOwnedGit } from "./native-owned-git";
import { activeArchiveIndices, type NativeContextReset } from "./host-context";
import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalDigest, LIMITS, validateArguments, validateControl, type Control } from "../remote-control/protocol";
import { ensureKeryxSubdir, isDefiniteAbsence, keryxConfigDir, readTranscriptFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { redactSensitiveText } from "../security/service";
import { openLeasedSession, releaseSessionLease, type SessionLeaseOwner } from "./lease";
import { persistHistory, forkSession, loadArchive, loadContext } from "./store";
import { compactMessages } from "./compact";
import { createHostCommandCatalogue } from "./commands/catalogue";
import { deliverableCommandOutcome, executeSessionCommand } from "./commands/handlers";
import type { SessionCommandContext } from "./commands/handlers";
import type { SessionCommandEffect, SessionCommandInspection } from "./commands/effects";
import { executePlanCommand, sessionRestrictionDigest, type SessionRestriction } from "./commands/plan";
import { sessionConfigProposal, sessionConfigCommandResult } from "./commands/session-settings";
import { requestSessionInterrupt } from "./commands/session-control";
import { executeReasoningCommand } from "./commands/reasoning";
import { createTurnObservationLog, utf8Bounded } from "./host-turn-log";
import { fetchBoundedAnalysis } from "./native-analysis-transport";
import { OWNED_CONTROL_COMMANDS, type OwnedControlCommand } from "../remote-control/owned-controls";
import { lifecycleCommands, lifecycleMutationCommands, type SessionLifecycleInput } from "./host-lifecycle";
import { createSessionUserQuestions } from "./user-questions";
import { createNativeQuestionJournal } from "./question-journal";
import { hiddenInCard } from "../lib/card-safe";
import { createSessionApprovalService, type SessionApprovalQuestion, type SessionApprovalOutcome } from "./question-service";
import type { NativeCheckObservation, NativeTurnObservation, NativeTurnObservationPayload, QueuedAdmissionAuthority, SessionHostOptions, SessionHostOperation, SessionHostPort, SessionHostReceipt, SessionOwnedResource, SessionPageQuery } from "./host-types";
export type * from "./host-types";

export class SessionHostError extends Error { constructor(readonly code: string, options?: ErrorOptions) { super(code, options); this.name = "SessionHostError"; } }
function checked<K extends keyof Control>(name: K, value: unknown): Control[K] {
  const result = validateControl(name, value);
  if (!result.ok) throw new SessionHostError(`invalid-${name}`);
  return result.value;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function page<T>(items: T[], query: SessionPageQuery = {}) {
  const cursor = Math.max(0, query.cursor ?? 0); const limit = Math.max(1, Math.min(100, query.limit ?? 100));
  return { values: items.slice(cursor, cursor + limit), cursor: Math.min(items.length, cursor + limit), hasMore: cursor + limit < items.length };
}
/**
 * Native lease handles this process keeps because a stop, a settle or a service close was never proven.
 * A same-process re-open receives the very same handle (lease.ts), so the fence follows the handle, not the host.
 */
const fencedLeases = new WeakSet<object>();
/** Bound on each settle wait in disposal and recovery: a stalled classifier, run or inspection cannot hang serve shutdown. */
const SETTLE_BOUND_MS = 2000;
/** Above the production per-connection MCP close bound (5 s), so a hung close reads as unproven rather than hanging. */
const SERVICE_CLOSE_BOUND_MS = 6000;
/** The frozen native decision window: an approval or confirmation card stays answerable for 120 s. */
const DECISION_TTL_MS = 120_000;
/** Shown when the decision journal could not record a question; the question itself went on, exactly as without the journal. */
const DECISION_JOURNAL_NOTE = "The decision journal could not record this question; it was asked without a journal record.";
/** The human step after a turn stopped for a changed pinned Flow (frozen spec: drift is visible and the original pins stay). */
const FLOW_DRIFT_RECEIPT = "The pinned Flow changed during this turn, so it stopped before its next action. Review the change and start a new turn with the current Flow.";
async function within<T>(task: Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([task, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Long-lived application owner. No terminal input, renderer, HTTP or WebSocket dependencies. */
export async function createSessionHost(options: SessionHostOptions): Promise<SessionHostPort> {
  const now = options.now ?? Date.now;
  const decisionTtlMs = options.decisionTtlMs ?? DECISION_TTL_MS;
  if (!Number.isSafeInteger(decisionTtlMs) || decisionTtlMs <= 0 || decisionTtlMs > DECISION_TTL_MS) throw new SessionHostError("invalid-decision-ttl");
  // The private record sits below the shared config root (or the per-Hub control dir), owner-only at every level, written atomically and
  // read through the bounded content reader: it carries the session's public history, so it is content, not a few-hundred-byte config.
  const dir = ensureKeryxSubdir(["remote-sessions"], options.controlDir ?? options.dataDir);
  const statePath = join(dir, `${options.record.sessionId}.json`);
  let record = checked("SessionRecord", options.record);
  let nativeId: string | undefined = options.nativeSessionId;
  let historySeedDigest: string | undefined;
  const contextResets: NativeContextReset[] = [];
  let rewindPending = false;
  const nativeBoundaries = new Map<number, number>([[0, 0]]);
  const receipts = new Map<string, { digest: string; receipt: SessionHostReceipt }>();
  const eventLog: Control["SessionEvent"][] = [];
  const publicHistory: Control["SessionMessage"][] = [];
  const queueItems: Control["QueueItem"][] = [];
  const pendingQueueCount = () => queueItems.filter((item) => item.state === "queued" || item.state === "suspended").length;
  const queuedOperations = new Map<string, SessionHostOperation>();
  const queuedConfigurations = new Map<string, Control["ConfigChange"]>();
  const queuedCommands = new Map<string, Control["CommandInvoke"]>();
  const selectionDecisions = new Map<string, { subject: string; snapshot: Control["ConfigSnapshot"]; runId: string; usage: Control["BoundedJson"][] }>();
  const queuedMessages = new Map<string, Control["MessageSubmit"]>();
  const pendingConfigurations = new Map<string, { operation: Extract<SessionHostOperation, { kind: "config" }>; confirmation: Control["CommandConfirmationRequest"] }>();
  const pendingExecutions = new Map<string, { operation: Extract<SessionHostOperation, { kind: "command" }>; confirmation: Control["CommandConfirmationRequest"] }>();
  const confirmedExecutionDigests = new Map<string, string>();
  const restrictions = new Map<number, SessionRestriction>();
  const pendingPlans = new Map<string, { operation: Extract<SessionHostOperation, { kind: "command" }>; confirmation: Control["CommandConfirmationRequest"]; enabled: boolean }>();
  const restriction = (version = record.config.configVersion): SessionRestriction => {
    const existing = restrictions.get(version); if (existing !== undefined) return structuredClone(existing);
    throw new SessionHostError("restriction-version-unavailable");
  };
  const configCommandNames = new Map<string, string>();
  const confirmedConfigurations = new Set<string>();
  const controllerClaims = new Map<string, { commandDigest: string; receipt: Control["ControllerReceipt"] }>();
  /** The run a serve crash left in flight, once a human resolved it lost; persisted until an explicit resume clears it. */
  let lostRun: { runId: string; turnId: string } | undefined;
  /** This host restored exactly that resolution (options.crashRecovery) and nothing but a controller change applied since. */
  let lostResumable = false;
  const localState = readTranscriptFile(statePath);
  // Only a definite absence is a fresh session; a record that is there but unreadable, oversized or not a regular file is refused.
  if (!localState.ok && !isDefiniteAbsence(localState.reason)) throw new SessionHostError(`local-state-${localState.reason}`);
  const hadLocalState = localState.ok;
  if (options.crashRecovery !== undefined && !hadLocalState) throw new SessionHostError("crash-recovery-state-missing");
  if (localState.ok) {
    const saved: unknown = JSON.parse(localState.text);
    if (!object(saved) || typeof saved.nativeId !== "string") throw new SessionHostError("invalid-local-state");
    if (options.nativeSessionId !== undefined && options.nativeSessionId !== saved.nativeId) throw new SessionHostError("native-session-binding-conflict");
    if (Array.isArray(saved.nativeBoundaries)) for (const boundary of saved.nativeBoundaries) { if (!Array.isArray(boundary) || boundary.length !== 2 || !boundary.every((value) => Number.isSafeInteger(value) && value >= 0)) throw new SessionHostError("invalid-native-history-boundary"); nativeBoundaries.set(boundary[0], boundary[1]); }
    if (saved.historySeedDigest !== undefined) { if (typeof saved.historySeedDigest !== "string" || !/^[a-f0-9]{64}$/.test(saved.historySeedDigest)) throw new SessionHostError("invalid-history-seed-digest"); historySeedDigest = saved.historySeedDigest; }
    nativeId = saved.nativeId; record = checked("SessionRecord", saved.record);
    const crashed = { runId: record.activeRunId, turnId: record.activeTurnId, state: record.state };
    if (saved.lostRun !== undefined) {
      if (!object(saved.lostRun) || typeof saved.lostRun.runId !== "string" || typeof saved.lostRun.turnId !== "string") throw new SessionHostError("invalid-local-lost-run");
      lostRun = { runId: saved.lostRun.runId, turnId: saved.lostRun.turnId };
    }
    if (saved.rewindPending !== undefined && typeof saved.rewindPending !== "boolean") throw new SessionHostError("invalid-rewind-intent");
    if (saved.rewindPending === true) { rewindPending = true; record.state = "recovery-required"; }
    if (Array.isArray(saved.contextResets)) for (const reset of saved.contextResets) {
      if (!object(reset) || typeof reset.cursor !== "number" || typeof reset.archiveCount !== "number" || typeof reset.activeCount !== "number") throw new SessionHostError("invalid-context-window");
      contextResets.push({ cursor: reset.cursor, archiveCount: reset.archiveCount, activeCount: reset.activeCount });
    }
    if (Array.isArray(saved.selectionDecisions)) for (const value of saved.selectionDecisions) {
      if (!object(value) || typeof value.operationId !== "string" || typeof value.subject !== "string" || !/^[a-f0-9]{64}$/.test(value.subject) || typeof value.runId !== "string" || !Array.isArray(value.usage)) throw new SessionHostError("invalid-local-selection-decision");
      selectionDecisions.set(value.operationId, { subject: value.subject, snapshot: checked("ConfigSnapshot", value.snapshot), runId: value.runId, usage: value.usage.map((usage) => checked("BoundedJson", usage)) });
    }
    if (saved.selection !== undefined) {
      if (!object(saved.selection) || typeof saved.selection.operationId !== "string" || typeof saved.selection.runId !== "string" || typeof saved.selection.turnId !== "string"
        || typeof saved.selection.payloadDigest !== "string" || !/^[a-f0-9]{64}$/.test(saved.selection.payloadDigest)) throw new SessionHostError("invalid-local-selection-reservation");
      record.state = "recovery-required";
    }
    if (record.sessionId !== options.record.sessionId || record.projectId !== options.record.projectId || record.checkoutId !== options.record.checkoutId) throw new SessionHostError("session-binding-conflict");
    if (Array.isArray(saved.events)) eventLog.push(...saved.events.map((event) => checked("SessionEvent", event)));
    if (Array.isArray(saved.publicHistory)) publicHistory.push(...saved.publicHistory.map((message) => checked("SessionMessage", message)));
    if (Array.isArray(saved.controllerClaims)) for (const value of saved.controllerClaims) {
      if (!object(value) || typeof value.commandId !== "string" || typeof value.commandDigest !== "string") throw new SessionHostError("invalid-local-controller-receipt");
      controllerClaims.set(value.commandId, { commandDigest: value.commandDigest, receipt: checked("ControllerReceipt", value.receipt) });
    }
    if (Array.isArray(saved.restrictions)) for (const value of saved.restrictions) {
      if (!object(value) || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.configVersion) || !Number.isSafeInteger(value.effectiveFromTurnOrdinal) || (value.approvalMode !== undefined && value.approvalMode !== "ask")
        || value.restrictionDigest !== sessionRestrictionDigest({ enabled: value.enabled, ...(value.approvalMode === "ask" ? { approvalMode: "ask" } : {}) }, record.config.policyDigest)) throw new SessionHostError("invalid-local-session-restriction");
      restrictions.set(Number(value.configVersion), { enabled: value.enabled, configVersion: Number(value.configVersion), effectiveFromTurnOrdinal: Number(value.effectiveFromTurnOrdinal), restrictionDigest: String(value.restrictionDigest),
        ...(value.approvalMode === "ask" ? { approvalMode: "ask" as const } : {}) });
    }
    if (Array.isArray(saved.configCommandNames)) for (const value of saved.configCommandNames) {
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !["reasoning", "model", "connect.select", "route.set", "routing.configure"].includes(value[1])) throw new SessionHostError("invalid-local-config-command");
      configCommandNames.set(value[0], value[1]);
    }
    if (Array.isArray(saved.queue)) queueItems.push(...saved.queue.map((item) => checked("QueueItem", item)));
    if (Array.isArray(saved.queuedConfigurations)) for (const value of saved.queuedConfigurations) {
      if (!object(value) || typeof value.queueItemId !== "string") throw new SessionHostError("invalid-local-queued-config");
      queuedConfigurations.set(value.queueItemId, checked("ConfigChange", value.request));
    }
    if (Array.isArray(saved.queuedMessages)) for (const value of saved.queuedMessages) {
      if (!object(value) || typeof value.queueItemId !== "string") throw new SessionHostError("invalid-local-queued-message");
      queuedMessages.set(value.queueItemId, checked("MessageSubmit", value.request));
    }
    if (Array.isArray(saved.queuedCommands)) for (const value of saved.queuedCommands) {
      if (!object(value) || typeof value.queueItemId !== "string") throw new SessionHostError("invalid-local-queued-command");
      queuedCommands.set(value.queueItemId, checked("CommandInvoke", value.request));
    }
    // Queued messages are input, never restart authorization. Their reauthorization must be fresh.
    for (const item of queueItems) if (item.state === "queued") item.state = "suspended";
    if (record.activeRunId !== null || record.state === "busy") record.state = "recovery-required";
    // A run a serve crash left in flight is passed only once the bridge shows a human resolved exactly that run lost after the local
    // recovery. The lost run stays lost: nothing of it runs again, queued input stays suspended and the session waits for a resume.
    const inFlight = crashed.runId !== null && crashed.turnId !== null && (crashed.state === "busy" || crashed.state === "paused") ? { runId: crashed.runId, turnId: crashed.turnId } : undefined;
    const candidate = lostRun ?? inFlight;
    if (candidate !== undefined && saved.selection === undefined && saved.rewindPending !== true && (lostRun === undefined || (record.activeRunId === null && record.state === "recovery-required"))
      && options.crashRecovery?.lostRuns.some((run) => run.runId === candidate.runId && run.turnId === candidate.turnId) === true) {
      record.activeRunId = null; record.activeTurnId = null; lostRun = candidate; lostResumable = true;
    }
    if (Array.isArray(saved.receipts)) for (const value of saved.receipts) {
      if (!object(value) || typeof value.id !== "string" || typeof value.digest !== "string") throw new SessionHostError("invalid-local-receipt");
      const validated = validateControl("TurnReceipt", value.receipt);
      const command = validateControl("CommandOutcome", value.receipt);
      const config = validateControl("ConfigReceipt", value.receipt);
      const operation = validateControl("SessionOperationReceipt", value.receipt);
      const receipt = validated.ok ? validated.value : command.ok ? command.value : config.ok ? config.value : operation.ok ? operation.value : undefined;
      if (receipt === undefined) throw new SessionHostError("invalid-local-receipt");
      receipts.set(value.id, { digest: value.digest, receipt });
    }
  }
  if (!restrictions.has(record.config.configVersion)) {
    if (hadLocalState) { record.state = "recovery-required"; lostResumable = false; }
    const initial = hadLocalState ? undefined : options.initialRestriction;
    if (initial !== undefined && (initial.configVersion !== record.config.configVersion || (initial.approvalMode !== undefined && initial.approvalMode !== "ask")
      || initial.restrictionDigest !== sessionRestrictionDigest(initial, record.config.policyDigest))) throw new SessionHostError("invalid-initial-session-restriction");
    // A restriction lost from local state comes back at its narrowest.
    const enabled = hadLocalState || initial?.enabled === true;
    const approvalMode = hadLocalState || initial?.approvalMode === "ask" ? "ask" as const : undefined;
    restrictions.set(record.config.configVersion, { enabled, configVersion: record.config.configVersion, effectiveFromTurnOrdinal: initial?.effectiveFromTurnOrdinal ?? 1,
      ...(approvalMode === undefined ? {} : { approvalMode }), restrictionDigest: sessionRestrictionDigest({ enabled, approvalMode }, record.config.policyDigest) });
  }
  // The crashed daemon's native lease is taken over only on the bridge's identity proof for exactly the lost run, never on its age.
  const recovery = options.crashRecovery, crashedRun = lostResumable ? lostRun : undefined;
  let opened = openLeasedSession({ cwd: options.cwd, ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }), ...(nativeId === undefined ? {} : { resumeId: nativeId }),
    ...(recovery === undefined || crashedRun === undefined ? {} : { reclaimHolder: (holder: SessionLeaseOwner) => recovery.reclaimLease(holder, crashedRun) }) });
  // A handle another runtime of this process left unproven stays fenced: this host can neither run on it nor release it.
  if (fencedLeases.has(opened.lease)) { record.state = "recovery-required"; lostResumable = false; }
  let handle = opened.handle; nativeId = handle.summary.id;
  options.onNativeLease?.({ token: opened.lease.owner.token, nativeSessionId: handle.summary.id });
  const history = opened.history; const archive = opened.archive;
  if (!hadLocalState && options.initialHistory?.contextResets !== undefined) contextResets.push(...structuredClone(options.initialHistory.contextResets));
  const activeArchive = activeArchiveIndices(archive.length, record.historyCursor, contextResets).map(index => archive[index]!);
  let rewindPort: NativeRewindPort | undefined;
  let recorder: ReturnType<typeof createRewindRecorder> | undefined;
  type RewindScope = { kind: "run" | "inspection"; historyVersion?: number; signal: AbortSignal; beforeAction(toolName: string): Promise<void> };
  let rewindScope: RewindScope | undefined; let rewindSerial: Promise<unknown> = Promise.resolve();
  const scopedRewind = <T>(scope: RewindScope, invoke: () => Promise<T>): Promise<T> => { const task = rewindSerial.then(async () => { scope.signal.throwIfAborted(); rewindScope = scope; try { return await invoke(); } finally { rewindScope = undefined; } }); rewindSerial = task.catch(() => undefined); return task; };
  let archiveCursor = history.length;
  options.runtime.bindSessionDir(handle.dir);
  options.runtime.bindRestrictions((version) => restriction(version).enabled, (version) => restriction(version).approvalMode === "ask");
  options.runtime.bindWorkspace(options.workspace);
  options.runtime.bindProjectContext(options.projectContext, options.inspectionMode ?? "hub-remote");
  const routing = options.runtime.routing(record.config);
  const listeners = new Set<(event: Control["SessionEvent"]) => void>();
  const turnListeners = new Set<(event: NativeTurnObservation) => void>();
  const hostId = randomUUID();
  let connected = true; let disposed = false; let recovering = false;
  let serial: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: (release: () => void) => Promise<T>): Promise<T> => {
    const previous = serial; let release!: () => void; const unlocked = new Promise<void>((resolve) => { release = resolve; });
    serial = previous.then(() => unlocked).catch(() => undefined);
    return previous.then(() => task(release)).finally(release);
  };
  let active: { runId: string; turnId: string; historyVersionAtAdmission: number; abort: AbortController; done: Promise<void> } | undefined;
  let selecting: { operationId: string; payloadDigest: string; runId: string; turnId: string; abort: AbortController; done: Promise<SessionHostReceipt> } | undefined;
  /** An admitted when-idle close: new work is sealed and the close applies at the current turn's boundary (protocol "close when-idle", D15). */
  let pendingClose: Extract<SessionHostOperation, { kind: "close-session" }> | undefined;
  const reconnectWaiters = new Set<() => void>();
  const inspections = new Map<AbortController, Promise<void>>();
  const approvalOutcomeListeners = new Set<(outcome: SessionApprovalOutcome) => void>();
  const approvalListeners = new Set<(question: SessionApprovalQuestion) => void>();
  const approvals = createSessionApprovalService({ dir: join(handle.dir, "remote-control"), sessionId: record.sessionId, expirySeconds: decisionTtlMs / 1000,
    // Answers need the live control channel. A question raised during a disconnect still reaches the durable outbox: the turn holds at
    // this pre-tool boundary until reconnection, and the question's own deadline, never the disconnect, denies it.
    connected: () => connected && !disposed, deliverable: () => !disposed,
    onOutcome(outcome) { for (const sink of approvalOutcomeListeners) { try { sink(structuredClone(outcome)); } catch { approvalOutcomeListeners.delete(sink); } } },
    deliver(question) {
      const safe = { ...question, input: redactSensitiveText(question.input).slice(0, 8192), summary: redactSensitiveText(question.summary) };
      for (const sink of approvalListeners) sink(safe);
    },
  });
  const questions = createSessionUserQuestions({ dir: join(handle.dir, "remote-control"), sessionId: record.sessionId, now,
    context: () => active === undefined || record.controller === null ? undefined : { runId: active.runId, turnId: active.turnId, actorId: record.controller.actorId,
      policyDigest: record.config.policyDigest, controllerLeaseId: record.controller.controllerLeaseId, controllerVersion: record.controller.version,
      controllerExpiresAt: Date.parse(record.controller.expiresAt), signal: active.abort.signal },
    deliver: (question) => publishMessage("assistant", [question.question, ...question.options.map((option) => `${option.id}: ${option.label} — ${option.description}`),
      question.allowFreeform ? "You may give your own answer." : "", `Question ${question.questionId}`].filter(Boolean).join("\n"), question.runId, question.turnId),
  });
  // Every question is journaled as the TUI journals it (decisions journal, this session's id); the question service still shows and bounds it.
  const questionJournal = createNativeQuestionJournal({ cwd: options.cwd, session: record.sessionId, ask: questions.ask, admissible: questions.admissible,
    notify: (text) => publishMessage("system-receipt", text, active?.runId ?? null, active?.turnId ?? null),
    note: () => publishMessage("system-receipt", DECISION_JOURNAL_NOTE, active?.runId ?? null, active?.turnId ?? null) });
  options.runtime.bindAskUser(questionJournal.ask);
  const onLeaseLost = () => {
    options.runtime.detachSession();
    selecting?.abort.abort(new SessionHostError("native-lease-lost"));
    active?.abort.abort(new SessionHostError("native-lease-lost"));
    for (const abort of inspections.keys()) abort.abort(new SessionHostError("native-lease-lost"));
    questions.denyAll("question-scope-ended"); approvals.denyAll("native-lease-lost");
  };
  let unwatchLease = opened.lease.onLost(onLeaseLost);
  const persist = () => {
    const body = { record, nativeId, contextResets, rewindPending, lostRun, selectionDecisions: [...selectionDecisions].map(([operationId, value]) => ({ operationId, ...value })), selection: selecting === undefined ? undefined : { operationId: selecting.operationId, payloadDigest: selecting.payloadDigest, runId: selecting.runId, turnId: selecting.turnId }, historySeedDigest, restrictions: [...restrictions.values()], configCommandNames: [...configCommandNames], queuedCommands: [...queuedCommands].map(([queueItemId, request]) => ({ queueItemId, request })), nativeBoundaries: [...nativeBoundaries], publicHistory, queue: queueItems, queuedConfigurations: [...queuedConfigurations].map(([queueItemId, request]) => ({ queueItemId, request })),
      queuedMessages: [...queuedMessages].map(([queueItemId, request]) => ({ queueItemId, request })),
      controllerClaims: [...controllerClaims].map(([commandId, value]) => ({ commandId, ...value })),
      events: eventLog, receipts: [...receipts].map(([id, value]) => ({ id, ...value })) };
    writeOwnerOnlyFileAtomic(statePath, JSON.stringify(body));
  };
  const syncHistory = () => {
    if (opened.lease.checkLost()) { options.runtime.detachSession(); throw new SessionHostError("native-lease-lost"); }
    const appended = history.slice(archiveCursor); archive.push(...appended); activeArchive.push(...appended); archiveCursor = history.length;
    handle = persistHistory(handle, history, { archive }); persist();
  };
  options.runtime.bindContextCompaction(() => {
    // Each original message was archived before compaction. The replacement context
    // is persisted without appending its retained tail to the archive a second time.
    archiveCursor = history.length;
    handle = persistHistory(handle, history, { archive }); persist();
  });
  const emit = (body: object) => {
    const event = checked("SessionEvent", { sessionId: record.sessionId, projectId: record.projectId, checkoutId: record.checkoutId,
      sessionEventSeq: ++record.sessionEventCursor, observedAt: new Date(now()).toISOString(), ...body });
    eventLog.push(event); if (eventLog.length > 2000) eventLog.splice(0, eventLog.length - 2000);
    persist();
    for (const sink of listeners) { try { sink(structuredClone(event)); } catch { listeners.delete(sink); } }
  };
  const state = () => { record.version++; emit({ kind: "session-state", session: structuredClone(record) }); };
  const publishMessage = (role: Control["SessionMessage"]["role"], text: string, runId: string | null, turnId: string | null) => {
    const message = checked("SessionMessage", { messageId: randomUUID(), sessionId: record.sessionId, historyCursor: ++record.historyCursor,
      role, text: utf8Bounded(redactSensitiveText(text), 32768), createdAt: new Date(now()).toISOString(), runId, turnId });
    nativeBoundaries.set(message.historyCursor, archive.length + history.length - archiveCursor);
    record.historyVersion++; publicHistory.push(message); emit({ kind: "message", message });
  };
  const opReceipt = (operation: SessionHostOperation, status: "applied" | "rejected" | "recovery-required", reason: Control["SessionOperationReceipt"]["reason"] = "none"): SessionHostReceipt => {
    if (operation.kind === "message" || operation.kind === "submit-message") return checked("TurnReceipt", { operationId: operation.operationId,
      messageId: operation.kind === "message" ? operation.request.messageId : operation.operationId, sessionId: record.sessionId, sessionVersion: record.version,
      queueItemId: null, status: "rejected", runId: null, turnId: null, turnOrdinal: null });
    if (operation.kind === "command" || operation.kind === "confirm-command" || operation.kind === "cancel") return checked("CommandOutcome", { operationId: operation.operationId,
      sessionId: record.sessionId, commandName: operation.kind === "command" ? operation.request.commandName : operation.kind === "cancel" ? "interrupt" : "confirmation",
      status, sessionVersion: record.version, result: status === "applied" && operation.kind === "cancel" ? { status: "stopped" } : null, confirmationId: null,
      errorCode: status === "applied" ? null : reason === "busy" ? "busy" : reason === "stale-version" || reason === "policy-changed" ? "policy-changed" : "forbidden", confirmation: null, runId: null, turnId: null });
    if (operation.kind === "config") return checked("ConfigReceipt", { receiptId: randomUUID(), operationId: operation.operationId, sessionId: record.sessionId,
      sessionVersion: record.version, status: "rejected", configVersion: null, effectiveFromTurnOrdinal: null,
      reason: ["busy", "stale-version", "policy-changed"].includes(reason) ? reason : "policy-changed", confirmation: null });
    return checked("SessionOperationReceipt", { receiptId: randomUUID(), operationId: operation.operationId, sessionId: record.sessionId,
      kind: operation.kind, status, observedSessionVersion: record.version, session: structuredClone(record), reason });
  };
  const remember = (operation: SessionHostOperation, receipt: SessionHostReceipt) => {
    receipts.set(operation.operationId, { digest: operation.payloadDigest, receipt }); persist(); return structuredClone(receipt);
  };
  const authorized = (operation: { actorId: string; expiresAt?: string; request: { controller: Control["ControllerBinding"]; expectedSessionVersion: number } }) => {
    const controller = record.controller; const binding = operation.request.controller;
    return !disposed && connected && controller !== null && controller.state === "held" && controller.actorId === operation.actorId
      && Date.parse(controller.expiresAt) > now() && binding.controllerLeaseId === controller.controllerLeaseId
      && binding.expectedControllerVersion === controller.version && operation.request.expectedSessionVersion === record.version
      && (operation.expiresAt === undefined || Date.parse(operation.expiresAt) > now());
  };
  const controllerUsable = () => record.controller !== null && record.controller.state === "held" && Date.parse(record.controller.expiresAt) > now();
  const beforeAction = async (action: { kind: "model" | "tool"; toolName?: string; signal?: AbortSignal }) => {
    const { signal } = action;
    for (;;) {
      if (opened.lease.checkLost()) throw new SessionHostError("native-lease-lost");
      if (connected && controllerUsable() && active !== undefined && options.authorizeAction !== undefined) {
        const current = active; const version = record.version;
        const allowed = await options.authorizeAction({ session: structuredClone(record), runId: current.runId, turnId: current.turnId, ...action }).catch(() => false);
        signal?.throwIfAborted();
        if (typeof allowed === "object" && active === current) {
          // The turn's pinned Flow changed: it stops at this boundary, before any further action, and ends with the drift visible instead of pausing for good.
          current.abort.abort(new SessionHostError("flow-association-stale")); throw new SessionHostError("flow-association-stale");
        }
        if (allowed === true && connected && controllerUsable() && active === current && record.version === version) break;
      }
      if (record.state !== "paused") { options.runtime.invalidateApprovals(); record.state = "paused"; state(); }
      await new Promise<void>((resolve, reject) => {
        const finish = () => { reconnectWaiters.delete(finish); signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { reconnectWaiters.delete(finish); reject(signal?.reason ?? new SessionHostError("aborted")); };
        reconnectWaiters.add(finish); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      });
    }
    signal?.throwIfAborted();
    if (opened.lease.checkLost() || disposed) { options.runtime.detachSession(); throw new SessionHostError("native-lease-lost"); }
    if (active !== undefined && record.state === "paused") { record.state = "busy"; state(); }
  };
  const launchStart = async (operation: Extract<SessionHostOperation, { kind: "message" | "command" }> & { runId: string; turnId: string }, text: string, request: Control["StartTurnRequest"],
    command?: Control["CommandInvoke"], selectedSnapshot?: Control["ConfigSnapshot"], admissionGuard?: () => boolean) => {
    const workspace = await options.workspace.verify(record.workspaceBaseline);
    if (!workspace.ok || !routing.validate(record.config)) return remember(operation, opReceipt(operation, "rejected", workspace.ok ? "policy-changed" : "workspace-conflict"));
    if (admissionGuard !== undefined && !admissionGuard()) throw new SessionHostError("selection-final-guard-refused");
    const snapshot = selectedSnapshot ?? (command === undefined ? await routing.select(text, record.config) : checked("ConfigSnapshot", { config: structuredClone(record.config), configDigest: canonicalDigest(record.config),
      effectiveCandidateId: record.config.baselineCandidateId, routingDecision: "baseline", fallbackReason: "none", selectionReceiptId: randomUUID() }));
    const turnRestriction = restriction(snapshot.config.configVersion);
    const historyVersionAtAdmission = record.historyVersion;
    recorder?.beginTurn({ archiveIndex: activeArchive.length, prompt: text });
    const turnOrdinal = record.nextTurnOrdinal++;
    record.activeRunId = operation.runId; record.activeTurnId = operation.turnId; record.state = "busy"; record.version++;
    const abort = new AbortController();
    const executor = { hostId, nativeSessionId: handle.summary.id, generation: turnOrdinal };
    const existingTasks = new Set(options.runtime.jobs.list().map((task) => task.jobId));
    const turnLog = createTurnObservationLog(handle.dir, operation.runId);
    const observe = (body: NativeTurnObservationPayload) => {
      const observation: NativeTurnObservation = { sessionId: record.sessionId, runId: operation.runId, turnId: operation.turnId, executor,
        observedAt: new Date(now()).toISOString(), ...body };
      turnLog.append(observation);
      for (const sink of turnListeners) { try { sink(observation); } catch { turnListeners.delete(sink); } }
    };
    const progress = (value: string) => {
      let remaining = redactSensitiveText(value);
      while (remaining.length > 0) { const chunk = utf8Bounded(remaining, 8192); observe({ kind: "progress", text: chunk }); remaining = remaining.slice(chunk.length); }
    };
    const receipt = command === undefined ? checked("TurnReceipt", { operationId: operation.operationId, messageId: request.messageId, sessionId: record.sessionId,
      sessionVersion: record.version, queueItemId: null, status: "admitted", runId: operation.runId, turnId: operation.turnId, turnOrdinal })
      : checked("CommandOutcome", { operationId: operation.operationId, sessionId: record.sessionId, commandName: command.commandName, status: "queued",
        sessionVersion: record.version, result: null, confirmationId: null, errorCode: null, confirmation: null, runId: operation.runId, turnId: operation.turnId });
    const queuedItem = queueItems.find((item) => item.operationId === operation.operationId && item.state === "queued");
    if (queuedItem !== undefined) { queuedItem.state = "admitted"; queuedItem.version++; record.queueVersion++; }
    remember(operation, receipt);
    if (queuedItem !== undefined) emit({ kind: "queue-changed", queueVersion: record.queueVersion, item: queuedItem });
    emit({ kind: "turn-admitted", runId: operation.runId, turnId: operation.turnId, turnOrdinal, snapshot, association: request.association });
    emit({ kind: "session-state", session: structuredClone(record) });
    publishMessage("human", text, operation.runId, operation.turnId);
    // Start only after the durable admission marker, and return an admission receipt independently of completion.
    const done = options.runtime.withJobOwner({ kind: "run", identity: operation.runId }, () => Promise.resolve().then(async () => {
      let announcedRunning = false;
      let commandOwnershipUnknown = false;
      let completedCommand: Control["CommandOutcome"] | undefined;
      let terminal: { outcome: "succeeded" | "failed" | "cancelled" | "unknown"; reason: string; result?: import("../commands/agent").RunAgentTurnResult } = { outcome: "unknown", reason: "runtime-not-observed" };
      const deadline = setTimeout(() => { abort.abort(new SessionHostError("execution-timeout")); void options.runtime.stop(); }, 30 * 60_000);
      try {
        const io: import("../commands/agent").AgentIO = { write: progress, readOnly: () => turnRestriction.enabled,
          onHistoryChange: (kind) => {
            if (kind === "assistant_delta") return;
            syncHistory();
            const last = publicHistory.at(-1);
            if (last !== undefined && ((kind === "user" && last.role === "human") || (kind === "tool" && last.role === "tool-summary") || (kind === "assistant_final" && last.role === "assistant"))) nativeBoundaries.set(last.historyCursor, archive.length);
            persist();
          },
          onAssistantText: (text) => publishMessage("assistant", text, operation.runId, operation.turnId),
          onSystem: progress,
          beforeAction: async (action) => { if (commandOwnershipUnknown) throw new SessionHostError("workspace-conflict"); await beforeAction(action); if (!announcedRunning) { announcedRunning = true; observe({ kind: "running", snapshot }); } },
          beforeMutation: async () => {
            const before = await options.workspace.verify(record.workspaceBaseline); if (!before.ok) throw new SessionHostError("workspace-conflict");
            if (recorder !== undefined) { try { await scopedRewind({ kind: "run", signal: abort.signal, beforeAction: (toolName) => io.beforeAction!({ kind: "tool", toolName, signal: abort.signal }) }, () => recorder!.beforeMutation()); }
              catch (cause) { if (abort.signal.aborted) throw cause; if (options.runtime.jobs.list().some(task => task.visibility === "private" && task.status === "running")) { record.state = "recovery-required"; state(); throw new SessionHostError("checkpoint-stop-unconfirmed"); }
                // Only a code-shaped cause is shown: a raw Git message can carry local paths.
                const unavailable = cause instanceof Error && /^[a-z0-9-]{1,64}$/.test(cause.message) ? cause.message : "checkpoint-capture-failed";
                publishMessage("system-receipt", `A complete checkpoint is unavailable for this turn (${unavailable}); ordinary coding continues within its existing policy.`, operation.runId, operation.turnId); }
            } const verified = await options.workspace.verify(record.workspaceBaseline); if (!verified.ok) throw new SessionHostError("workspace-conflict"); },
          onToolCall: (toolName) => observe({ kind: "progress", text: `Tool: ${toolName}`, toolName }),
          onToolResult: (toolName, result) => { const refusal = result.isError ? /^workspace-refused:([a-z0-9-]{1,64})$/.exec(result.output)?.[1] : undefined;
            const summary = `${toolName}: ${refusal !== undefined ? `refused (${refusal})` : result.isError ? "failed" : "completed"}`;
            observe({ kind: "progress", text: summary, toolName }); publishMessage("tool-summary", summary, operation.runId, operation.turnId); },
          onUsage: (usage) => observe({ kind: "usage", usage, source: "agent", candidateId: snapshot.effectiveCandidateId }),
          requestApproval: (toolName, input, meta) => meta === undefined ? Promise.resolve(false) : approvals.request({ runId: operation.runId, turnId: operation.turnId,
            policyDigest: snapshot.config.policyDigest, toolName, input, fingerprint: meta.fingerprint, risk: meta.destructive ? "destructive" : meta.risk ?? "write",
            signal: meta.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, meta.signal]),
          }),
        };
        if (command === undefined) terminal = await options.runtime.run(io, history, text, snapshot, { signal: abort.signal, cacheKey: nativeId });
        else {
          const local = options.runtime.commandPolicy(snapshot.config.policyDigest);
          let calls = 0;
          let analysisSelectionRecorded = false;
          const analysis = local.analysis === undefined ? undefined : { ...local.analysis,
            readDiff: async (signal: AbortSignal) => { await io.beforeAction!({ kind: "tool", toolName: "analysis:git-diff", signal }); return local.analysis!.readDiff(signal); },
            ...(local.analysis.readReference === undefined ? {} : { readReference: async (relativePath: string, signal: AbortSignal) => {
              await io.beforeAction!({ kind: "tool", toolName: "analysis:reference-read", signal }); return local.analysis!.readReference!(relativePath, AbortSignal.any([abort.signal, signal]));
            } }),
            ...(local.analysis.ciSpawn === undefined ? {} : { ciSpawn: async (argv: string[], cwd: string, signal?: AbortSignal) => {
              const currentSignal = signal === undefined ? abort.signal : AbortSignal.any([abort.signal, signal]);
              await io.beforeAction!({ kind: "tool", toolName: "analysis:github-read", signal: currentSignal }); return local.analysis!.ciSpawn!(argv, cwd, currentSignal);
            } }),
            fetchFn: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
            await io.beforeAction!({ kind: "model", signal: abort.signal });
            const selected = options.runtime.analysisCandidate();
            const url = input instanceof Request ? input.url : String(input);
            let declaredModel: unknown;
            try { declaredModel = JSON.parse(String(init?.body)).model; } catch { throw new SessionHostError("analysis-model-not-declared"); }
            if (url !== "https://openrouter.ai/api/v1/systemone" || declaredModel !== local.analysis!.model || selected === undefined
              || local.analysis!.policyDigest !== snapshot.config.policyDigest || confirmedExecutionDigests.get(operation.operationId) !== operation.payloadDigest) throw new SessionHostError("analysis-policy-or-confirmation-mismatch");
            if (++calls > local.analysis!.maxCalls) throw new SessionHostError("analysis-budget-exceeded");
            if (!analysisSelectionRecorded) {
              const receipt = checked("SelectionReceipt", { selectionReceiptId: randomUUID(), sessionId: record.sessionId, runId: operation.runId, turnId: operation.turnId,
                configVersion: snapshot.config.configVersion, candidateId: selected.candidateId, reason: "provider-fallback", policyDigest: snapshot.config.policyDigest,
                confirmedOperationDigest: operation.payloadDigest, observedAt: new Date(now()).toISOString() });
              emit({ kind: "selection-receipt", receipt }); analysisSelectionRecorded = true;
            }
            return fetchBoundedAnalysis(local.analysis!.fetchFn, input, init ?? {}, init?.signal === undefined || init.signal === null ? abort.signal : AbortSignal.any([abort.signal, init.signal]));
          }, { preconnect() {} }) };
          const effect: SessionCommandEffect = { runId: operation.runId, turnId: operation.turnId, association: request.association, snapshot, signal: abort.signal,
            policy: local.policy, beforeAction: async (action) => io.beforeAction!({ ...action, signal: action.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, action.signal]) }),
            async rewind<T>(input: RewindEffectInput, write: () => Promise<T>): Promise<T> {
              if (input.paths.length > 0 && turnRestriction.enabled) throw new SessionHostError("readonly-session-restriction");
              await io.beforeAction!({ kind: "tool", toolName: "rewind_restore", signal: abort.signal });
              if (input.paths.length > 0 && (options.workspace.beforeEffect === undefined || options.workspace.afterEffect === undefined)) throw new SessionHostError("owned-mutation-port-required");
              let token: string | undefined;
              if (input.paths.length > 0) { const begun = await options.workspace.beforeEffect!("rewind_restore", { ...input }); if (!begun.ok) { commandOwnershipUnknown = true; throw new SessionHostError("workspace-conflict"); } token = begun.value.effectId; }
              rewindPending = true; persist();
              try {
                const value = await write();
                if (token !== undefined) { const completed = await options.workspace.afterEffect!(token, { isError: false }); token = undefined; if (!completed.ok) throw new SessionHostError("workspace-conflict"); }
                rewindPending = false; persist(); return value;
              } catch (cause) { commandOwnershipUnknown = true; if (token !== undefined) await options.workspace.afterEffect!(token, { isError: true }); persist(); throw cause; }
            },
            async mutate<T>(kind: "analysis-cache" | "project-record", paths: readonly string[], write: () => Promise<T>): Promise<T> {
              if (turnRestriction.enabled) throw new SessionHostError("readonly-session-restriction");
              const toolName = kind === "project-record" ? "project_record_write" : "analysis_cache_write";
              await io.beforeAction!({ kind: "tool", toolName, signal: abort.signal });
              if (paths.length === 0 || paths.length > 20 || paths.some((path) => path.length === 0 || path.length > 500 || path.startsWith("/") || path.split(/[\\/]/).some((part) => part === ".." || part === ".git"))
                || options.workspace.beforeEffect === undefined || options.workspace.afterEffect === undefined) throw new SessionHostError("owned-mutation-port-required");
              let begun: Awaited<ReturnType<NonNullable<SessionHostOptions["workspace"]["beforeEffect"]>>>;
              try { begun = await options.workspace.beforeEffect(toolName, { paths: [...paths] }); }
              catch (cause) { commandOwnershipUnknown = true; throw cause; }
              if (!begun.ok) { commandOwnershipUnknown = true; throw new SessionHostError("workspace-conflict"); }
              let value: T;
              try { value = await write(); }
              catch (cause) { commandOwnershipUnknown = true; await options.workspace.afterEffect(begun.value.effectId, { isError: true }); throw cause; }
              commandOwnershipUnknown = true;
              const completed = await options.workspace.afterEffect(begun.value.effectId, { isError: false });
              if (!completed.ok) { commandOwnershipUnknown = true; throw new SessionHostError("workspace-conflict"); }
              commandOwnershipUnknown = false;
              return value;
            },
            progress: io.write, usage: (usage) => observe({ kind: "usage", usage }), ...(analysis === undefined ? {} : { analysis }) };
          await effect.beforeAction({ kind: "tool", toolName: `command:${command.commandName}` });
          const outcome = await executeSessionCommand(commandContext(operation.operationId, effect), command);
          completedCommand = outcome;
          terminal = { outcome: commandOwnershipUnknown ? "unknown" : outcome.status === "applied" ? "succeeded" : "failed", reason: commandOwnershipUnknown ? "workspace-conflict" : outcome.errorCode ?? "command-completed" };
        }
        if (abort.signal.aborted) {
          // A stop for a drifted Flow is not a cancellation: once the run's own work provably stopped it ends failed, with the human step named.
          const drifted = abort.signal.reason instanceof SessionHostError && abort.signal.reason.code === "flow-association-stale";
          const stopped = await options.runtime.stop({ kind: "run", identity: operation.runId }); terminal.outcome = stopped.status === "stopped" ? drifted ? "failed" : "cancelled" : "unknown";
          terminal.reason = stopped.status === "stopped" ? drifted ? "flow-association-stale" : "owned-runtime-stopped" : "process-ownership-unconfirmed";
          if (drifted) publishMessage("system-receipt", FLOW_DRIFT_RECEIPT, operation.runId, operation.turnId);
        }
        syncHistory();
        if (terminal.outcome === "unknown") record.state = "recovery-required";
        else {
          const baseline = await options.workspace.checkpoint();
          if (!baseline.ok) record.state = "recovery-required";
          else { record.workspaceBaseline = "value" in baseline ? baseline.value.baseline : baseline.baseline; record.state = "idle"; }
        }
      } catch (cause) { terminal = { outcome: "unknown", reason: cause instanceof SessionHostError ? cause.code : "native-execution-failed" };
        publishMessage("system-receipt", terminal.reason, operation.runId, operation.turnId); record.state = "recovery-required"; }
      finally {
        clearTimeout(deadline);
        const unknownTasks = options.runtime.jobs.list().filter(task => !existingTasks.has(task.jobId) && task.owner === undefined && task.status === "running");
        const tasks = options.runtime.jobs.list().filter(task => task.owner?.kind === "run" && task.owner.identity === operation.runId);
        if (unknownTasks.length > 0 || tasks.some((task) => task.status === "running") || record.state === "recovery-required") terminal.outcome = "unknown";
        // A run whose owned work outlives it has no proven cessation: the session is fenced with it, never idle beside a live owned process.
        if (terminal.outcome === "unknown") record.state = "recovery-required";
        if (command !== undefined) {
          const outcome = sendable({ ...(completedCommand ?? { operationId: operation.operationId, sessionId: record.sessionId, commandName: command.commandName,
            result: null, confirmationId: null, confirmation: null, runId: operation.runId, turnId: operation.turnId, errorCode: "forbidden" }), sessionVersion: record.version,
            status: terminal.outcome === "unknown" ? "recovery-required" : terminal.outcome === "succeeded" ? "applied" : "rejected" });
          remember(operation, outcome); emit({ kind: "command-outcome", outcome });
        }
        observe({ kind: "terminal", ...terminal, workspaceBaseline: record.workspaceBaseline, partial: terminal.outcome !== "succeeded",
          checks: tasks.filter((task) => task.visibility !== "private").map((task) => { const output = options.runtime.jobs.readOutputSince(task.jobId, 0); return { taskId: task.jobId, command: redactSensitiveText(task.command), status: task.status,
            source: "native-supervised-shell", ...(output.ok ? { output: utf8Bounded(redactSensitiveText(output.output), 8192), outputTruncated: output.missed > 0 || Buffer.byteLength(output.output) > 8192 } : {}),
            ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }), startedAt: task.startedAt, ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }) } satisfies NativeCheckObservation; }) });
        record.activeRunId = null; record.activeTurnId = null; active = undefined; state();
        confirmedExecutionDigests.delete(operation.operationId);
        // Hub may automatically mint a fresh immutable command/grant at this idle boundary.
        // Retained queued input is never itself continuing execution authority.
        persist();
        // A pending when-idle close owns this boundary: it is the next serialized step, and every admission stays sealed until it settles.
        if (pendingClose !== undefined) void serialized(settlePendingClose);
      }
    }));
    active = { runId: operation.runId, turnId: operation.turnId, historyVersionAtAdmission, abort, done };
    return receipt;
  };
  const start = async (operation: Extract<SessionHostOperation, { kind: "message" | "command" }> & { runId: string; turnId: string }, text: string, request: Control["StartTurnRequest"],
    command?: Control["CommandInvoke"], releaseMutation: () => void = () => {}, originalRequest: Control["StartTurnRequest"] | Control["MessageSubmit"] | Control["CommandInvoke"] = operation.request): Promise<SessionHostReceipt> => {
    if (!record.config.routing.enabled || command !== undefined) return launchStart(operation, text, request, command);
    if (selecting !== undefined) return selecting.operationId === operation.operationId && selecting.payloadDigest === operation.payloadDigest ? selecting.done : opReceipt(operation, "rejected", "busy");
    const config = structuredClone(record.config); const abort = new AbortController(); const expiresAt = Math.min(now() + 5000, operation.expiresAt === undefined ? Infinity : Date.parse(operation.expiresAt));
    const pins = () => canonicalDigest({ version: record.version, config: record.config, historyVersion: record.historyVersion, historyCursor: record.historyCursor, workspaceBaseline: record.workspaceBaseline,
      controller: record.controller, state: record.state });
    const subject = () => canonicalDigest({ text, originalRequest, config: record.config, catalogue: catalogue().catalogueDigest,
      availability: routing.availability(), historyVersion: record.historyVersion, historyCursor: record.historyCursor, workspaceBaseline: record.workspaceBaseline,
      controller: record.controller === null ? null : { id: record.controller.controllerLeaseId, version: record.controller.version, actorId: record.controller.actorId, state: record.controller.state } });
    const capturedSubject = subject(); const cached = selectionDecisions.get(operation.operationId);
    const captured = pins(); let finish!: (receipt: SessionHostReceipt) => void; let fail!: (error: unknown) => void;
    const done = new Promise<SessionHostReceipt>((resolve, reject) => { finish = resolve; fail = reject; });
    const job = { operationId: operation.operationId, payloadDigest: operation.payloadDigest, runId: operation.runId, turnId: operation.turnId, abort, done }; selecting = job; persist();
    let hardFailure: string | undefined;
    let authorityFailure: "temporarily-unavailable" | "revoked-or-forbidden" | "stale-subject" | "expired-work" | "renewal-drift" | "unknown" | undefined;
    const reportedUsage: Control["BoundedJson"][] = [];
    const current = () => selecting === job && !disposed && connected && controllerUsable() && pins() === captured && now() < expiresAt && !opened.lease.checkLost() && !abort.signal.aborted;
    const authorize = async (phase: "classifier-io" | "admission", provider?: import("./native-classifier").NativeClassifierProvider) => {
      if (!current() || options.authorizeSelection === undefined) {
        authorityFailure = now() >= expiresAt ? "expired-work" : !connected ? "temporarily-unavailable" : subject() !== capturedSubject ? "stale-subject" : pins() !== captured && controllerUsable() ? "renewal-drift" : "unknown";
        hardFailure = "selection-authority-required"; throw new SessionHostError(hardFailure);
      }
      const allowed = await options.authorizeSelection({ session: structuredClone(record), operationId: operation.operationId, actorId: operation.actorId, payloadDigest: operation.payloadDigest,
        request: originalRequest, runId: operation.runId, turnId: operation.turnId, phase, ...(provider === undefined ? {} : { candidateId: provider.candidateId, providerId: provider.providerId, modelId: provider.modelId }), signal: abort.signal }).catch(() => undefined);
      const status = allowed === true ? "valid" : allowed === false || allowed === undefined ? "unknown" : allowed.status;
      if (status !== "valid" || !current()) {
        authorityFailure = status !== "valid" ? status : now() >= expiresAt ? "expired-work" : !connected ? "temporarily-unavailable" : subject() !== capturedSubject ? "stale-subject" : pins() !== captured && controllerUsable() ? "renewal-drift" : "unknown";
        hardFailure = "selection-authority-expired-or-changed"; throw new SessionHostError(hardFailure);
      }
    };
    const executor = { hostId, nativeSessionId: handle.summary.id, generation: record.nextTurnOrdinal };
    const log = createTurnObservationLog(handle.dir, operation.runId);
    const observe = (body: NativeTurnObservationPayload) => {
      const observation: NativeTurnObservation = { sessionId: record.sessionId, runId: operation.runId, turnId: operation.turnId, executor, observedAt: new Date(now()).toISOString(), ...body };
      log.append(observation); for (const sink of turnListeners) { try { sink(observation); } catch { turnListeners.delete(sink); } }
    };
    void (async () => {
      let snapshot: Control["ConfigSnapshot"] | undefined;
      const deadline = setTimeout(() => abort.abort(new SessionHostError("selection-window-expired")), Math.max(0, expiresAt - now())); deadline.unref();
      try {
        if (cached !== undefined && cached.subject === capturedSubject) {
          snapshot = { ...structuredClone(cached.snapshot), selectionReceiptId: randomUUID() };
          observe({ kind: "progress", text: `Reusing completed routing decision from ${cached.runId}; no classifier request or usage charged for this delivery.`, toolName: "routing-classifier" });
        } else {
        if (cached !== undefined) { authorityFailure = "stale-subject"; throw new SessionHostError("selection-subject-changed"); }
        await authorize("classifier-io");
        snapshot = await options.runtime.routing(config, { signal: abort.signal,
          onRefusal: (code) => { hardFailure = code; },
          beforeIo: async (provider) => { await authorize("classifier-io", provider);
            const receipt = checked("SelectionReceipt", { selectionReceiptId: randomUUID(), sessionId: record.sessionId, runId: operation.runId, turnId: operation.turnId, configVersion: config.configVersion,
              candidateId: provider.candidateId, reason: "provider-fallback", policyDigest: config.policyDigest, confirmedOperationDigest: null, observedAt: new Date(now()).toISOString() });
            emit({ kind: "selection-receipt", receipt }); observe({ kind: "progress", text: `Routing classifier: ${provider.actualProviderId ?? provider.providerId}/${provider.actualModelId ?? provider.modelId}`, toolName: "routing-classifier" });
          }, onUsage: (provider, usage) => { const boundedUsage = Object.fromEntries(Object.entries(usage).filter(([key, value]) => ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0 || key === "exact" && typeof value === "boolean"));
            reportedUsage.push(checked("BoundedJson", { provider, usage: boundedUsage })); observe({ kind: "usage", usage, source: "routing-classifier", ...provider }); },
        }).select(text, config, abort.signal);
        if (hardFailure !== undefined) throw new SessionHostError(hardFailure);
        if (queueItems.some((item) => item.operationId === operation.operationId && item.state === "queued")) selectionDecisions.set(operation.operationId, { subject: capturedSubject, snapshot: structuredClone(snapshot), runId: operation.runId, usage: reportedUsage }); persist();
        }
        await authorize("admission");
      } catch (cause) { hardFailure ??= cause instanceof SessionHostError ? cause.code : "selection-refused"; }
      try {
        const receipt = await serialized(async () => {
          const valid = hardFailure === undefined && snapshot !== undefined && current();
          const refuse = () => { selecting = undefined;
            if (hardFailure === "classifier-stop-unconfirmed") { record.state = "recovery-required"; record.version++; }
            const item = queueItems.find((item) => item.operationId === operation.operationId && item.state === "queued");
            const transient = item !== undefined && record.state !== "recovery-required" && subject() === capturedSubject
              && (authorityFailure === "expired-work" || authorityFailure === "temporarily-unavailable" || authorityFailure === "renewal-drift");
            if (transient) {
              const reason = authorityFailure === "expired-work" || authorityFailure === "temporarily-unavailable" ? authorityFailure : "renewal-drift";
              observe({ kind: "admission-refused", operationId: operation.operationId, reason, retainedQueue: true, selectionSettled: true, codingAdmitted: false }); persist();
              return structuredClone(receipts.get(operation.operationId)!.receipt);
            }
            if (authorityFailure !== undefined && authorityFailure !== "unknown" && hardFailure !== "classifier-stop-unconfirmed") observe({ kind: "admission-refused", operationId: operation.operationId, reason: authorityFailure, retainedQueue: false, selectionSettled: true, codingAdmitted: false });
            if (item !== undefined && authorityFailure !== "unknown") { item.state = "suspended"; item.version++; record.queueVersion++; record.version++; emit({ kind: "queue-changed", queueVersion: record.queueVersion, item }); }
            if (item !== undefined && authorityFailure === "unknown") { record.state = "recovery-required"; record.version++; persist(); emit({ kind: "session-state", session: structuredClone(record) }); return structuredClone(receipts.get(operation.operationId)!.receipt); }
            if (item !== undefined && authorityFailure !== undefined && hardFailure !== "classifier-stop-unconfirmed") { emit({ kind: "session-state", session: structuredClone(record) }); return structuredClone(receipts.get(operation.operationId)!.receipt); }
            publishMessage("system-receipt", `Routing admission refused: ${hardFailure ?? "selection-pins-changed"}`, operation.runId, operation.turnId);
            const rejected = remember(operation, opReceipt(operation, record.state === "recovery-required" ? "recovery-required" : "rejected", "forbidden")); emit({ kind: "session-state", session: structuredClone(record) }); return rejected;
          };
          if (!valid) return refuse();
          try {
            const admitted = await launchStart(operation, text, request, command, snapshot, current);
            if (admitted.status === "rejected") { publishMessage("system-receipt", "Routing admission no longer meets its original workspace and authority pins.", operation.runId, operation.turnId); emit({ kind: "session-state", session: structuredClone(record) }); }
            if (admitted.status === "admitted") selectionDecisions.delete(operation.operationId);
            return admitted;
          } catch (cause) {
            if (!(cause instanceof SessionHostError) || cause.code !== "selection-final-guard-refused") throw cause;
            authorityFailure = now() >= expiresAt ? "expired-work" : !connected ? "temporarily-unavailable" : subject() !== capturedSubject ? "stale-subject" : pins() !== captured && controllerUsable() ? "renewal-drift" : "unknown";
            hardFailure = cause.code; return refuse();
          } finally { if (selecting === job) selecting = undefined; persist(); }
        }); finish(receipt);
      } catch (cause) { if (selecting === job) selecting = undefined; fail(cause); }
      finally { clearTimeout(deadline); }
    })();
    releaseMutation(); return done;
  };
  const applyConfig = async (operation: Extract<SessionHostOperation, { kind: "config" }>, queued = false): Promise<Control["ConfigReceipt"]> => {
    const request = operation.request;
    let status: Control["ConfigReceipt"]["status"] = "applied"; let reason: Control["ConfigReceipt"]["reason"] = "none";
    let queuedItem: Control["QueueItem"] | undefined;
    const proposed = { ...record.config, ...request, configVersion: record.config.configVersion + 1 };
    const config = checked("SessionConfig", { configVersion: proposed.configVersion, baselineCandidateId: proposed.baselineCandidateId,
      reasoningEffort: proposed.reasoningEffort, routing: proposed.routing, policyDigest: record.config.policyDigest, capabilityDigest: record.config.capabilityDigest });
    if (request.expectedConfigVersion !== record.config.configVersion) { status = "rejected"; reason = "stale-version"; }
    else if (!routing.validate(config)) { status = "rejected"; reason = "candidate-unavailable"; }
    else if (!queued && request.busyPolicy === "queue-at-idle" && pendingQueueCount() >= LIMITS.pendingSessionItems) { status = "rejected"; reason = "busy"; publishMessage("system-receipt", "Queue limit reached: 100 pending items.", null, null); }
    else if (!confirmedConfigurations.has(operation.operationId) && (request.baselineCandidateId !== record.config.baselineCandidateId || canonicalDigest(request.routing) !== canonicalDigest(record.config.routing)
      || (request.reasoningEffort !== record.config.reasoningEffort && routing.availability().candidates.some((candidate) => config.routing.candidateIds.includes(candidate.candidateId) && candidate.costClass === "metered")))) {
      status = "confirmation-required"; reason = "confirmation-required";
    } else if ((active !== undefined || pendingQueueCount() > 0) && !queued) {
      if (request.busyPolicy === "queue-at-idle") { status = "queued"; queuedItem = addQueue(operation, "config", null, null); record.version++; }
      else { status = "rejected"; reason = "busy"; }
    } else {
      if (config.baselineCandidateId !== record.config.baselineCandidateId) await options.runtime.commitManualModel(config, history, syncHistory);
      const inheritedRestriction = restriction();
      const effort = executeReasoningCommand(config.reasoningEffort === "none" ? "off" : config.reasoningEffort, { current: record.config.reasoningEffort,
        commit: () => { record.config = config; } });
      if (!effort.ok) { status = "rejected"; reason = "policy-changed"; }
      else { record.config = config; record.version++; restrictions.set(config.configVersion, { ...inheritedRestriction, configVersion: config.configVersion, effectiveFromTurnOrdinal: record.nextTurnOrdinal }); }
    }
    let confirmation: Control["CommandConfirmationRequest"] | null = null;
    if (status === "confirmation-required") {
      confirmation = checked("CommandConfirmationRequest", { confirmationId: randomUUID(), sessionId: record.sessionId, operationId: operation.operationId,
        operationDigest: operation.payloadDigest, policyDigest: record.config.policyDigest, expectedConfigVersion: record.config.configVersion,
        proposedConfigDigest: canonicalDigest(config), controller: request.controller, actorId: operation.actorId,
        expiresAt: new Date(now() + decisionTtlMs).toISOString(), summary: "Change the session model, reasoning effort or routing for subsequent turns" + (config.routing.enabled && options.runtime.routingPolicy().configured ? ". Native routing adds at most one permitted classifier request: 16 output tokens and a 2000-character classifier preview; 2.5 s service plus at most 0.5 s cleanup (3 s total), within the original work grant. The original user input remains complete. Jev classification is disabled by this local profile." : ""),
        costEffect: "Subsequent admitted turns may use the selected locally permitted metered candidates", privacyEffect: "Subsequent admitted turns may send context to the selected locally permitted providers" });
      pendingConfigurations.set(confirmation.confirmationId, { operation, confirmation });
    }
    const receipt = checked("ConfigReceipt", { receiptId: randomUUID(), operationId: operation.operationId, sessionId: record.sessionId,
      sessionVersion: record.version, status, configVersion: status === "applied" ? record.config.configVersion : null,
      effectiveFromTurnOrdinal: status === "applied" ? record.nextTurnOrdinal : null, reason, confirmation });
    const changedQueue: Control["QueueItem"][] = [];
    if (status === "applied") {
      const appliedItem = queueItems.find((item) => item.operationId === operation.operationId && item.state === "queued");
      if (appliedItem !== undefined) { appliedItem.state = "applied"; appliedItem.version++; changedQueue.push(appliedItem); }
      for (const item of queueItems) if (item.state === "queued" && item.expectedConfigVersion !== record.config.configVersion) { item.state = "suspended"; item.version++; changedQueue.push(item); }
      if (changedQueue.length > 0) record.queueVersion++;
    }
    remember(operation, receipt);
    const configCommandName = configCommandNames.get(operation.operationId);
    if (configCommandName === undefined) emit({ kind: "config-receipt", receipt });
    else {
      const outcome = sendable({ operationId: operation.operationId, sessionId: record.sessionId, commandName: configCommandName, status: receipt.status,
        sessionVersion: record.version, result: receipt.status === "applied" ? sessionConfigCommandResult(configCommandName, record.config, routing.availability().candidates, record.nextTurnOrdinal) : null, confirmationId: receipt.confirmation?.confirmationId ?? null, errorCode: receipt.status === "rejected" ? "forbidden" : null,
        confirmation: receipt.confirmation, runId: null, turnId: null });
      remember(operation, outcome); emit({ kind: "command-outcome", outcome });
    }
    for (const item of changedQueue) emit({ kind: "queue-changed", queueVersion: record.queueVersion, item });
    if (queuedItem !== undefined) emit({ kind: "queue-changed", queueVersion: record.queueVersion, item: queuedItem });
    emit({ kind: "session-state", session: structuredClone(record) });
    return receipt;
  };
  const addQueue = (operation: SessionHostOperation, kind: Control["QueueItem"]["kind"], text: string | null, commandName: string | null) => {
    if (pendingQueueCount() >= LIMITS.pendingSessionItems) throw new SessionHostError("queue-full");
    const item = checked("QueueItem", { queueItemId: randomUUID(), version: 1, kind, operationId: operation.operationId, state: "queued", position: queueItems.length,
      text, commandName, expectedConfigVersion: record.config.configVersion, replacesOperationId: null });
    queueItems.push(item); queuedOperations.set(operation.operationId, operation);
    if (operation.kind === "command") queuedCommands.set(item.queueItemId, operation.request);
    if (operation.kind === "config") queuedConfigurations.set(item.queueItemId, operation.request);
    if (operation.kind === "submit-message") queuedMessages.set(item.queueItemId, operation.request);
    if (operation.kind === "message") queuedMessages.set(item.queueItemId, { expectedSessionVersion: operation.request.expectedSessionVersion,
      controller: operation.request.controller, expectedConfigVersion: operation.request.expectedConfigVersion, text: operation.request.text,
      interpretation: "literal-message", association: operation.request.association, busyPolicy: "enqueue" });
    record.queueVersion++; return item;
  };
  const contributions = () => [...options.runtime.commandContributions(), ...lifecycleCommands(options.lifecycle !== undefined), ...rewindCommands(rewindPort !== undefined)];
  const catalogue = () => createHostCommandCatalogue(record.config.capabilityDigest, { contributions: options.runtime.commandContributions(), lifecycle: options.lifecycle !== undefined, rewind: rewindPort !== undefined });
  /** Every command outcome the host builds passes the result check Hub applies before it is remembered or sent (handlers.ts deliverableCommandOutcome). */
  const sendable = (value: unknown): Control["CommandOutcome"] => deliverableCommandOutcome(checked("CommandOutcome", value), catalogue());
  const commandContext = (operationId: string, effect?: SessionCommandEffect, inspection?: SessionCommandInspection): SessionCommandContext => ({ cwd: options.cwd, nativeSessionDir: handle.dir,
    inspectionMode: options.inspectionMode ?? "hub-remote", ...(options.projectContext === undefined ? {} : { projectContext: options.projectContext }),
    ...((options.configDir ?? options.dataDir) === undefined ? {} : { configDir: options.configDir ?? options.dataDir }), ...(effect === undefined ? {} : { effect, runId: effect.runId, turnId: effect.turnId }),
    operationId, questions, decisionJournal: { session: questionJournal.session, lastDecisionId: questionJournal.lastDecisionId }, restriction, ...(rewindPort === undefined ? {} : { rewind: rewindPort }), close: closeForCommand, record, catalogue: catalogue(), runtime: options.runtime, contributions: contributions(), ...(inspection === undefined ? {} : { inspection }),
    history: () => history, publicHistory: () => structuredClone(publicHistory), compact: (compaction) => { const result = compactMessages(history, compaction?.focus === undefined ? {} : { focus: compaction.focus });
      history.splice(0, history.length, ...result.context); archiveCursor = history.length; syncHistory(); return { removed: result.removed, noop: result.noop }; },
  });
  const inspectCommand = (operation: Extract<SessionHostOperation, { kind: "command" }>) => {
    const abort = new AbortController(); let finish!: () => void;
    inspections.set(abort, new Promise<void>((resolve) => { finish = resolve; }));
    const controller = record.controller; const config = structuredClone(record.config);
    const deadline = setTimeout(() => abort.abort(new SessionHostError("inspection-scope-expired")), Math.max(0, Math.min(30_000, Date.parse(controller?.expiresAt ?? "") - now()))); deadline.unref();
    const current = () => connected && !disposed && controllerUsable() && record.state !== "closed" && record.controller?.actorId === operation.actorId
      && record.controller.controllerLeaseId === controller?.controllerLeaseId && record.controller.version === controller?.version
      && canonicalDigest(record.config) === canonicalDigest(config) && !opened.lease.checkLost();
    const beforeAction = async (toolName: string) => {
      abort.signal.throwIfAborted();
      if (!current() || options.authorizeInspection === undefined) throw new SessionHostError("inspection-authority-required");
      const allowed = await options.authorizeInspection({ session: structuredClone(record), operationId: operation.operationId, actorId: operation.actorId,
        command: operation.request, toolName, signal: abort.signal }).catch(() => false);
      abort.signal.throwIfAborted(); if (!allowed || !current()) throw new SessionHostError("inspection-authority-denied");
    };
    // Flow-free reads only: no model, environment, fetch or policy value reaches an inspection, Jev configured or not.
    const read = options.runtime.analysisReadPort();
    const context: SessionCommandInspection = { signal: abort.signal, beforeAction,
      analysisRead: { ciSpawn: async (argv: string[], cwd: string, signal?: AbortSignal) => { await beforeAction("analysis:github-read"); return read.ciSpawn(argv, cwd, signal === undefined ? abort.signal : AbortSignal.any([abort.signal, signal])); },
        ...(read.acCheckGit === undefined ? {} : { acCheckGit: async (argv: readonly string[], opts?: { signal?: AbortSignal; cwd?: string }) => { await beforeAction("ac-check:git-read");
          return read.acCheckGit!(argv, { ...opts, signal: opts?.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, opts.signal]) }); } }) },
    };
    return { context, current, close() { clearTimeout(deadline); inspections.delete(abort); finish(); } };
  };
  const ownedControlNames = new Set<string>(OWNED_CONTROL_COMMANDS);
  const prepareOwnedControl = (operation: Extract<SessionHostOperation, { kind: "command" }>, context: SessionCommandContext, scope: ReturnType<typeof inspectCommand>) => {
    const request = operation.request;
    context.actorId = operation.actorId;
    let last: { digest: string; at: number } | undefined;
    const resource = (command: OwnedControlCommand, args: Readonly<Record<string, Control["BoundedJson"] | undefined>>): SessionOwnedResource => {
      if (!ownedControlNames.has(command) || request.commandName !== command || canonicalDigest(args) !== canonicalDigest(request.arguments)
        || canonicalDigest(request) !== operation.payloadDigest || !scope.current()) throw new SessionHostError("owned-control-binding-mismatch");
      if (command === "tasks.kill" || command === "demote") {
        const taskId = String(args.taskId); const job = options.runtime.jobs.get(taskId); if (job === undefined || job.visibility === "private") throw new SessionHostError("owned-task-not-found");
        // A run's task is the resource of that run alone: a task of another, or an ended, run or of an inspection is never this control's target.
        if (job.owner !== undefined && !(job.owner.kind === "run" && job.owner.identity === active?.runId) && !(job.owner.kind === "session" && job.owner.identity === handle.summary.id)) throw new SessionHostError("owned-task-not-found");
        return { kind: "task", taskId, nativeSessionId: handle.summary.id, action: command === "demote" ? "demote" : "kill" };
      }
      if (command === "interrupt") {
        if (active === undefined) throw new SessionHostError("owned-turn-not-found");
        return { kind: "turn", runId: active.runId, turnId: active.turnId, action: "interrupt" };
      }
      if (command === "questions.answer") {
        const pending = questions.pending().find((entry) => entry.questionId === args.questionId && entry.runId === args.runId && entry.turnId === args.turnId
          && entry.fingerprint === args.fingerprint && entry.policyDigest === record.config.policyDigest && entry.runId === active?.runId && entry.turnId === active?.turnId);
        if (pending === undefined) throw new SessionHostError("owned-question-not-found");
        return { kind: "question", questionId: pending.questionId, runId: pending.runId, turnId: pending.turnId, fingerprint: pending.fingerprint, policyDigest: pending.policyDigest };
      }
      const pending = approvals.pending().find((entry) => entry.approvalId === args.approvalId && entry.runId === args.runId && entry.turnId === args.turnId
        && entry.fingerprint === args.fingerprint && entry.policyDigest === args.policyDigest && entry.policyDigest === record.config.policyDigest
        && entry.runId === active?.runId && entry.turnId === active?.turnId);
      if (pending === undefined) throw new SessionHostError("owned-approval-not-found");
      return { kind: "approval", ...pending, decision: command === "approvals.allow-once" ? "allow-once" : "deny" };
    };
    context.authorizeOwnedControl = async (command, args) => {
      scope.context.signal.throwIfAborted();
      const target = resource(command, args); const digest = canonicalDigest(target);
      if (last !== undefined && last.digest === digest && now() - last.at >= 0 && now() - last.at <= 5000) return;
      if (options.authorizeOwnedControl === undefined || !(await options.authorizeOwnedControl({ session: structuredClone(record), operationId: operation.operationId,
        actorId: operation.actorId, command: request, payloadDigest: operation.payloadDigest, resource: target, toolName: command, signal: scope.context.signal }).catch(() => false))) throw new SessionHostError("owned-control-authority-denied");
      scope.context.signal.throwIfAborted(); if (!scope.current() || canonicalDigest(resource(command, args)) !== digest) throw new SessionHostError("owned-control-changed");
      last = { digest, at: now() }; context.ownedControlPermit = { commandName: command, resourceDigest: digest };
    };
    context.interrupt = async () => {
      if (request.commandName !== "interrupt") throw new SessionHostError("wrong-control-command");
      await context.authorizeOwnedControl!("interrupt", {});
      return { status: await stopCurrentTurn() };
    };
    context.approvals = { pending: approvals.pending, answer: async (input) => {
      if (request.commandName !== "approvals.allow-once" && request.commandName !== "approvals.deny") return { status: "rejected", reason: "wrong-control-command" };
      if (input.decision !== (request.commandName === "approvals.allow-once" ? "allow-once" : "deny")) return { status: "rejected", reason: "wrong-control-decision" };
      await context.authorizeOwnedControl!(request.commandName, request.arguments as Record<string, string | number | undefined>);
      return approvals.answer({ ...input, actorId: operation.actorId });
    } };
  };
  const admitCommand = (operation: Extract<SessionHostOperation, { kind: "command" }>) => {
    const request = operation.request;
    if (active !== undefined || operation.runId === undefined || operation.turnId === undefined || operation.association === undefined) return Promise.resolve(remember(operation, opReceipt(operation, "rejected", active === undefined ? "forbidden" : "busy")));
    return start({ ...operation, runId: operation.runId, turnId: operation.turnId }, `/${request.commandName}`, { sessionId: record.sessionId,
      expectedSessionVersion: record.version, controller: request.controller, expectedConfigVersion: record.config.configVersion, expectedHistoryVersion: record.historyVersion,
      expectedWorkspaceBaseline: record.workspaceBaseline, association: operation.association, messageId: operation.operationId, text: `/${request.commandName}` }, request);
  };
  const executionConfirmation = (operation: Extract<SessionHostOperation, { kind: "command" }>) => {
    const confirmation = checked("CommandConfirmationRequest", { confirmationId: randomUUID(), sessionId: record.sessionId, operationId: operation.operationId,
      operationDigest: operation.payloadDigest, policyDigest: record.config.policyDigest, expectedConfigVersion: record.config.configVersion,
      proposedConfigDigest: canonicalDigest(record.config), controller: operation.request.controller, actorId: operation.actorId, expiresAt: new Date(now() + decisionTtlMs).toISOString(),
      summary: `Execute /${operation.request.commandName} with the current local policy and run association`, costEffect: "This command may consume the explicitly configured local analysis budget",
      privacyEffect: "The selected locally permitted service may receive bounded project context" });
    pendingExecutions.set(confirmation.confirmationId, { operation, confirmation });
    const outcome = checked("CommandOutcome", { operationId: operation.operationId, sessionId: record.sessionId, commandName: operation.request.commandName,
      status: "confirmation-required", sessionVersion: record.version, result: null, confirmationId: confirmation.confirmationId,
      errorCode: null, confirmation, runId: operation.runId ?? null, turnId: operation.turnId ?? null });
    remember(operation, outcome); emit({ kind: "command-outcome", outcome }); emit({ kind: "session-state", session: structuredClone(record) }); return outcome;
  };
  const stopCurrentTurn = async (): Promise<"stopped" | "unknown" | "too-late"> => {
    const current = active; if (current === undefined) return "too-late";
    requestSessionInterrupt({ isActive: true, cancel: () => current.abort.abort(new SessionHostError("cancelled")) });
    questions.denyAll("turn-cancelled"); approvals.denyAll("turn-cancelled");
    await options.runtime.stop({ kind: "run", identity: current.runId });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([current.done.then(() => true, () => false), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 2000); })]);
    if (timer !== undefined) clearTimeout(timer);
    const final = await options.runtime.stop({ kind: "run", identity: current.runId });
    if (!completed || final.status !== "stopped") { record.state = "recovery-required"; state(); return "unknown"; }
    return "stopped";
  };
  const resumeOwnedSession = async (request: Control["SessionResume"]): Promise<Control["SessionRecord"]> => {
    // A same-process re-open receives this process's own retained lease handle (lease.ts); unproven cessation stays fenced until explicit recovery.
    // The one exception is a re-hosted crash whose in-flight run a human resolved lost: its owned baseline is re-verified below.
    if ((record.state === "recovery-required" && !lostResumable) || recovering) throw new SessionHostError("recovery-required");
    if (active !== undefined || request.expectedSessionVersion !== record.version
      || request.expectedHistoryVersion !== record.historyVersion || request.expectedWorkspaceBaseline !== record.workspaceBaseline) throw new SessionHostError("stale-resume-pins");
    const verified = await options.workspace.verify(record.workspaceBaseline); if (!verified.ok) throw new SessionHostError("workspace-conflict");
    if (opened.lease.checkLost()) throw new SessionHostError("native-lease-lost");
    if (opened.lease.released) {
      const reopened = openLeasedSession({ cwd: options.cwd, resumeId: nativeId, ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }) });
      unwatchLease(); opened = reopened; handle = reopened.handle; options.onNativeLease?.({ token: opened.lease.owner.token, nativeSessionId: handle.summary.id });
      history.splice(0, history.length, ...reopened.history); archive.splice(0, archive.length, ...reopened.archive); archiveCursor = history.length;
      options.runtime.bindSessionDir(handle.dir); unwatchLease = opened.lease.onLost(onLeaseLost);
      // Close finalized the session services; the resumed owner binds fresh ones, or stays fenced.
      try { await attachSessionServices(); } catch { lostResumable = false; record.state = "recovery-required"; state(); throw new SessionHostError("recovery-required"); }
    }
    // The lost run is passed for good: it stays lost in history and the session continues from its re-verified baseline.
    lostRun = undefined; lostResumable = false;
    if (record.state !== "idle") { record.state = "idle"; state(); }
    return structuredClone(record);
  };
  /** True only when every session service (MCP, bus) confirmed its close within the bound. */
  const closeSessionServices = (): Promise<boolean> => within(options.runtime.closeServices().then((result) => result.stopped, () => false), false, SERVICE_CLOSE_BOUND_MS);
  /** Keeps the still-held native lease fenced for this whole process. */
  const fenceLease = () => { if (!opened.lease.released && !opened.lease.lost) fencedLeases.add(opened.lease); };
  const applyPlan = (operation: Extract<SessionHostOperation, { kind: "command" }>, enabled: boolean, confirmed = false): Control["CommandOutcome"] => {
    let status: Control["CommandOutcome"]["status"] = "applied"; let card: Control["CommandConfirmationRequest"] | null = null;
    if (active !== undefined || pendingQueueCount() > 0) status = "rejected";
    else if (!enabled && restriction().enabled && !confirmed) {
      status = "confirmation-required";
      card = checked("CommandConfirmationRequest", { confirmationId: randomUUID(), sessionId: record.sessionId, operationId: operation.operationId, operationDigest: operation.payloadDigest,
        policyDigest: record.config.policyDigest, expectedConfigVersion: record.config.configVersion, proposedConfigDigest: canonicalDigest({ ...record.config, configVersion: record.config.configVersion + 1 }),
        controller: operation.request.controller, actorId: operation.actorId, expiresAt: new Date(now() + decisionTtlMs).toISOString(), summary: "Disable the session readonly restriction; restore only the original local permission floor",
        costEffect: "The original locally permitted tools may be used on later turns", privacyEffect: "No provider, trust, budget or local permission floor is widened" });
      pendingPlans.set(card.confirmationId, { operation, enabled, confirmation: card });
    } else if (restriction().enabled !== enabled) {
      const applied = executePlanCommand(enabled ? "on" : "off", { current: restriction().enabled, commit() {} }); if (!applied.ok) throw new SessionHostError("invalid-plan-operation");
      // Plan toggles only readonly; an approval narrowing already in force carries over unchanged.
      const { approvalMode } = restriction();
      record.config = { ...record.config, configVersion: record.config.configVersion + 1 }; record.version++;
      restrictions.set(record.config.configVersion, { enabled: applied.enabled, configVersion: record.config.configVersion, effectiveFromTurnOrdinal: record.nextTurnOrdinal,
        ...(approvalMode === undefined ? {} : { approvalMode }), restrictionDigest: sessionRestrictionDigest({ enabled: applied.enabled, approvalMode }, record.config.policyDigest) });
      pendingConfigurations.clear(); pendingExecutions.clear(); pendingPlans.clear();
    }
    const outcome = sendable({ operationId: operation.operationId, sessionId: record.sessionId, commandName: "plan.set", status, sessionVersion: record.version,
      result: status === "applied" ? restriction() : null, confirmationId: card?.confirmationId ?? null, errorCode: status === "rejected" ? "busy" : null, confirmation: card, runId: null, turnId: null });
    remember(operation, outcome); emit({ kind: "command-outcome", outcome }); emit({ kind: "session-state", session: structuredClone(record) }); return outcome;
  };
  /**
   * `/mode ask`: the host-owned approval narrowing. Like plan readonly it is a new config version applied at an idle boundary, effective
   * from the next turn; unlike plan it is one-way: repeating it changes nothing, and no native command, config change or lifecycle child lifts it.
   */
  const applyApprovalMode = (operation: Extract<SessionHostOperation, { kind: "command" }>): Control["CommandOutcome"] => {
    const busy = active !== undefined || pendingQueueCount() > 0;
    if (!busy && restriction().approvalMode !== "ask") {
      const { enabled } = restriction();
      record.config = { ...record.config, configVersion: record.config.configVersion + 1 }; record.version++;
      restrictions.set(record.config.configVersion, { enabled, configVersion: record.config.configVersion, effectiveFromTurnOrdinal: record.nextTurnOrdinal, approvalMode: "ask",
        restrictionDigest: sessionRestrictionDigest({ enabled, approvalMode: "ask" }, record.config.policyDigest) });
      pendingConfigurations.clear(); pendingExecutions.clear(); pendingPlans.clear();
    }
    const outcome = sendable({ operationId: operation.operationId, sessionId: record.sessionId, commandName: "mode.ask", status: busy ? "rejected" : "applied", sessionVersion: record.version,
      result: busy ? null : restriction(), confirmationId: null, errorCode: busy ? "busy" : null, confirmation: null, runId: null, turnId: null });
    remember(operation, outcome); emit({ kind: "command-outcome", outcome }); emit({ kind: "session-state", session: structuredClone(record) }); return outcome;
  };
  const closeOwnedIdleSession = async (): Promise<{ status: "closed" | "recovery-required" }> => {
    if (active !== undefined || selecting !== undefined) throw new SessionHostError("busy");
    if (opened.lease.checkLost()) { options.runtime.detachSession(); record.state = "recovery-required"; state(); throw new SessionHostError("native-lease-lost"); }
    if (!opened.lease.released) {
      // An unproven service close keeps the native lease, exactly like an unproven job stop.
      if (!(await closeSessionServices())) { record.state = "recovery-required"; state(); fenceLease(); return { status: "recovery-required" }; }
      syncHistory(); await options.runtime.preserveSession(); releaseSessionLease(opened.lease);
    }
    // Old queued work never replays automatically after close: a later resume reauthorizes it with fresh grants.
    for (const item of queueItems) if (item.state === "queued") { item.state = "suspended"; item.version++; record.queueVersion++; record.version++; emit({ kind: "queue-changed", queueVersion: record.queueVersion, item: structuredClone(item) }); }
    if (record.state !== "closed") { record.state = "closed"; state(); }
    return { status: "closed" };
  };
  /** The SessionOperationReceipt of a close; `pending` is an admitted when-idle close still waiting for its turn boundary. */
  const closeReceipt = (operation: Extract<SessionHostOperation, { kind: "close-session" }>, status: "pending" | "applied" | "recovery-required") => checked("SessionOperationReceipt", {
    receiptId: randomUUID(), operationId: operation.operationId, sessionId: record.sessionId, kind: "close-session", status, observedSessionVersion: record.version,
    session: structuredClone(record), reason: status === "recovery-required" ? "recovery-required" : "none" });
  /**
   * Applies an admitted when-idle close at the boundary of the turn it waited for, before any queued admission.
   * A boundary without proven cessation never becomes a closed receipt: the close resolves recovery-required and the session stays fenced.
   */
  const settlePendingClose = async (): Promise<void> => {
    const operation = pendingClose; if (operation === undefined || active !== undefined || selecting !== undefined || disposed) return;
    pendingClose = undefined;
    let closed = false;
    if (record.state !== "recovery-required") { try { closed = (await closeOwnedIdleSession()).status === "closed"; } catch { closed = false; } }
    if (!closed && record.state !== "recovery-required") { record.state = "recovery-required"; state(); fenceLease(); }
    emit({ kind: "operation-receipt", receipt: remember(operation, closeReceipt(operation, closed ? "applied" : "recovery-required")) });
  };
  /** New work a pending when-idle close seals; renewal, cancellation, owned-resource controls, denials, queue edits and reads stay possible. */
  const sealedByPendingClose = (operation: SessionHostOperation): boolean => {
    if (pendingClose === undefined) return false;
    if (operation.kind === "message" || operation.kind === "submit-message" || operation.kind === "config" || operation.kind === "reauthorize-queue") return true;
    // Allowing a pending card would admit its execution or configuration; a denial only settles it.
    if (operation.kind === "confirm-command") return operation.request.decision !== "deny";
    if (operation.kind !== "command") return false;
    const entry = catalogue().entries.find((item) => item.commandName === operation.request.commandName);
    return entry?.mutationClass !== "read" && !ownedControlNames.has(operation.request.commandName);
  };
  /** The shared `exit` handler only reports a proven close; an unproven one is a typed refusal and the session stays fenced. */
  const closeForCommand = async (): Promise<{ status: "closed" }> => { const closed = await closeOwnedIdleSession(); if (closed.status !== "closed") throw new SessionHostError("recovery-required"); return { status: "closed" }; };
  const apply = async (operation: SessionHostOperation, releaseMutation: () => void = () => {}): Promise<SessionHostReceipt> => {
    const prior = receipts.get(operation.operationId);
    if (prior !== undefined) return prior.digest === operation.payloadDigest ? structuredClone(prior.receipt) : opReceipt(operation, "rejected", "stale-version");
    if (selecting?.operationId === operation.operationId) { releaseMutation(); return selecting.payloadDigest === operation.payloadDigest ? selecting.done : opReceipt(operation, "rejected", "stale-version"); }
    if (!authorized(operation)) return remember(operation, opReceipt(operation, "rejected", "forbidden"));
    if (selecting !== undefined && !(operation.kind === "command" && catalogue().entries.find((entry) => entry.commandName === operation.request.commandName)?.mutationClass === "read")) return remember(operation, opReceipt(operation, "rejected", "busy"));
    if (opened.lease.checkLost()) { options.runtime.detachSession(); record.state = "recovery-required"; lostResumable = false; state(); }
    if (record.state === "recovery-required" && !(lostResumable && operation.kind === "resume-session")) return remember(operation, opReceipt(operation, "recovery-required", "recovery-required"));
    if (operation.kind === "close-session") {
      const request = checked("SessionClose", operation.request);
      if (pendingClose !== undefined) return remember(operation, opReceipt(operation, "rejected", "busy"));
      if (active !== undefined) {
        // Recorded, never dropped: the queue is sealed now and the close applies when the current admitted turn ends.
        if (request.mode === "when-idle") { pendingClose = operation; return remember(operation, closeReceipt(operation, "pending")); }
        const stopped = await stopCurrentTurn();
        if (stopped !== "stopped") return remember(operation, opReceipt(operation, "recovery-required", "recovery-required"));
      }
      const closed = await closeOwnedIdleSession();
      return remember(operation, closed.status === "closed" ? opReceipt(operation, "applied") : opReceipt(operation, "recovery-required", "recovery-required"));
    }
    if (operation.kind === "resume-session") {
      const request = checked("SessionResume", operation.request);
      if (active !== undefined) return remember(operation, opReceipt(operation, "rejected", "busy"));
      if (request.expectedHistoryVersion !== record.historyVersion || request.expectedWorkspaceBaseline !== record.workspaceBaseline) return remember(operation, opReceipt(operation, "rejected", "stale-version"));
      try { await resumeOwnedSession(request); } catch { return remember(operation, opReceipt(operation, "rejected", "busy")); }
      return remember(operation, opReceipt(operation, "applied"));
    }

    if (record.state === "closed" && !(operation.kind === "command" && operation.request.commandName === "sessions.resume")) return remember(operation, opReceipt(operation, "rejected", "forbidden"));
    if (sealedByPendingClose(operation)) return remember(operation, opReceipt(operation, "rejected", "busy"));
    if (operation.kind === "submit-message") {
      const request = checked("MessageSubmit", operation.request);
      if (request.expectedConfigVersion !== record.config.configVersion || (active !== undefined && request.busyPolicy === "reject")) return remember(operation, opReceipt(operation, "rejected", active === undefined ? "stale-version" : "busy"));
      if (pendingQueueCount() >= LIMITS.pendingSessionItems) {
        publishMessage("system-receipt", "Queue limit reached: 100 pending items.", null, null);
        const receipt = checked("TurnReceipt", { operationId: operation.operationId, messageId: operation.operationId, sessionId: record.sessionId,
          sessionVersion: record.version, queueItemId: null, status: "rejected", runId: null, turnId: null, turnOrdinal: null });
        remember(operation, receipt); emit({ kind: "session-state", session: structuredClone(record) }); return receipt;
      }
      const item = addQueue(operation, "message", request.text, null); record.version++;
      const receipt = checked("TurnReceipt", { operationId: operation.operationId, messageId: operation.operationId, sessionId: record.sessionId, sessionVersion: record.version,
        queueItemId: item.queueItemId, status: "queued", runId: null, turnId: null, turnOrdinal: null });
      remember(operation, receipt); emit({ kind: "queue-changed", queueVersion: record.queueVersion, item }); emit({ kind: "session-state", session: structuredClone(record) }); return receipt;
    }
    if (operation.kind === "message") {
      const request = checked("StartTurnRequest", operation.request);
      if (request.sessionId !== record.sessionId || request.expectedConfigVersion !== record.config.configVersion || request.expectedHistoryVersion !== record.historyVersion
        || request.expectedWorkspaceBaseline !== record.workspaceBaseline) return remember(operation, opReceipt(operation, "rejected", "stale-version"));
      if (active !== undefined) {
        if (pendingQueueCount() >= LIMITS.pendingSessionItems) {
          publishMessage("system-receipt", "Queue limit reached: 100 pending items.", null, null);
          return remember(operation, checked("TurnReceipt", { operationId: operation.operationId, messageId: request.messageId, sessionId: record.sessionId,
            sessionVersion: record.version, queueItemId: null, status: "rejected", runId: null, turnId: null, turnOrdinal: null }));
        }
        const item = addQueue(operation, "message", request.text, null);
        record.version++;
        const receipt = checked("TurnReceipt", { operationId: operation.operationId, messageId: request.messageId, sessionId: record.sessionId,
          sessionVersion: record.version, queueItemId: item.queueItemId, status: "queued", runId: null, turnId: null, turnOrdinal: null });
        remember(operation, receipt); emit({ kind: "queue-changed", queueVersion: record.queueVersion, item }); emit({ kind: "session-state", session: structuredClone(record) }); return receipt;
      }
      // Still-queued work goes first (FIFO). A suspended item is not authorization (protocol: new admitted work follows FIFO among still-authorized
      // items), so it holds back no new turn Hub admitted, exactly as Hub's own admission treats it; only its explicit reauthorization runs it.
      if (queueItems.some((item) => item.state === "queued")) return remember(operation, opReceipt(operation, "rejected", "busy"));
      return start(operation, request.text, request, undefined, releaseMutation);
    }
    if (operation.kind === "config") return applyConfig(operation);
    if (operation.kind === "confirm-command") {
      const request = checked("CommandConfirmation", operation.request);
      const execution = pendingExecutions.get(request.confirmationId);
      const plan = pendingPlans.get(request.confirmationId);
      const pending = pendingConfigurations.get(request.confirmationId) ?? execution ?? plan;
      if (pending === undefined || pending.confirmation.operationDigest !== request.operationDigest
        || pending.confirmation.policyDigest !== request.policyDigest || pending.confirmation.policyDigest !== record.config.policyDigest
        || pending.confirmation.actorId !== operation.actorId || pending.confirmation.expectedConfigVersion !== record.config.configVersion
        || canonicalDigest(pending.confirmation.controller) !== canonicalDigest(request.controller) || Date.parse(pending.confirmation.expiresAt) <= now()) {
        return remember(operation, opReceipt(operation, "rejected", "policy-changed"));
      }
      if (request.decision === "deny") {
        pendingPlans.delete(request.confirmationId); pendingConfigurations.delete(request.confirmationId); pendingExecutions.delete(request.confirmationId);
        const original = pending.operation; const commandName = original.kind === "command" ? original.request.commandName : configCommandNames.get(original.operationId);
        let rejected: SessionHostReceipt;
        if (commandName !== undefined) {
          const outcome = checked("CommandOutcome", { operationId: original.operationId, sessionId: record.sessionId, commandName, status: "rejected", sessionVersion: record.version,
            result: null, confirmationId: null, errorCode: "forbidden", confirmation: null, runId: original.kind === "command" ? original.runId ?? null : null, turnId: original.kind === "command" ? original.turnId ?? null : null });
          rejected = remember(original, outcome); emit({ kind: "command-outcome", outcome });
        } else {
          const receipt = checked("ConfigReceipt", { receiptId: randomUUID(), operationId: original.operationId, sessionId: record.sessionId, sessionVersion: record.version,
            status: "rejected", configVersion: null, effectiveFromTurnOrdinal: null, reason: "confirmation-required", confirmation: null });
          rejected = remember(original, receipt); emit({ kind: "config-receipt", receipt });
        }
        emit({ kind: "session-state", session: structuredClone(record) }); return remember(operation, rejected);
      }
      if (plan !== undefined) { pendingPlans.delete(request.confirmationId); return remember(operation, applyPlan(plan.operation, plan.enabled, true)); }
      pendingConfigurations.delete(request.confirmationId);
      pendingExecutions.delete(request.confirmationId);
      if (execution !== undefined) { confirmedExecutionDigests.set(execution.operation.operationId, execution.operation.payloadDigest); return remember(operation, await admitCommand(execution.operation)); }
      confirmedConfigurations.add(pending.operation.operationId);
      if (pending.operation.kind !== "config") return remember(operation, opReceipt(operation, "rejected", "forbidden"));
      const queuedItem = queueItems.find((item) => item.operationId === pending.operation.operationId && item.state === "queued");
      if (queuedItem !== undefined && (active !== undefined || queueItems.filter((item) => item.state === "queued" || item.state === "suspended").sort((a, b) => a.position - b.position)[0] !== queuedItem)) return remember(operation, opReceipt(operation, "rejected", "busy"));
      const receipt = await applyConfig(pending.operation, queuedItem !== undefined);
      return remember(operation, receipt);
    }
    if (operation.kind === "edit-queue" || operation.kind === "remove-queue" || operation.kind === "reauthorize-queue") {
      const request = operation.request;
      const item = queueItems.find((entry) => entry.queueItemId === request.queueItemId);
      if (item === undefined || !["queued", "suspended"].includes(item.state) || request.expectedQueueVersion !== record.queueVersion
        || request.expectedItemVersion !== item.version) return remember(operation, opReceipt(operation, "rejected", "stale-version"));
      if (operation.kind === "edit-queue") {
        checked("QueueEdit", request);
        if (item.kind !== "message" || item.state !== "queued") return remember(operation, opReceipt(operation, "rejected", "forbidden"));
        item.text = operation.request.text; item.version++;
      } else if (operation.kind === "remove-queue") {
        checked("QueueRemove", request); if (item.state !== "queued") return remember(operation, opReceipt(operation, "rejected", "forbidden"));
        item.state = "removed"; item.version++; queuedOperations.delete(item.operationId);
      } else {
        checked("QueueReauthorize", request);
        if (item.state !== "suspended" || operation.request.originalOperationId !== item.operationId || operation.operationId === item.operationId
          || operation.request.expectedConfigVersion !== record.config.configVersion) return remember(operation, opReceipt(operation, "rejected", "stale-version"));
        const replacement = checked("QueueItem", { ...item, queueItemId: randomUUID(), version: 1, operationId: operation.operationId, state: "queued",
          expectedConfigVersion: record.config.configVersion, replacesOperationId: item.operationId });
        if (item.kind === "config") {
          const original = queuedConfigurations.get(item.queueItemId);
          if (original === undefined) return remember(operation, opReceipt(operation, "recovery-required", "recovery-required"));
          queuedConfigurations.set(replacement.queueItemId, checked("ConfigChange", { ...original, expectedSessionVersion: record.version + 1,
            controller: operation.request.controller, expectedConfigVersion: record.config.configVersion, busyPolicy: "queue-at-idle" }));
        } else if (item.kind === "message" && item.text !== null) {
          queuedMessages.set(replacement.queueItemId, checked("MessageSubmit", { expectedSessionVersion: record.version + 1, controller: operation.request.controller,
            expectedConfigVersion: record.config.configVersion, text: item.text, interpretation: "literal-message", association: operation.request.association, busyPolicy: "enqueue" }));
        } else if (item.kind === "command") {
          const original = queuedCommands.get(item.queueItemId);
          if (original === undefined) return remember(operation, opReceipt(operation, "recovery-required", "recovery-required"));
          queuedCommands.set(replacement.queueItemId, checked("CommandInvoke", { ...original, expectedSessionVersion: record.version + 1,
            controller: operation.request.controller, expectedConfigVersion: record.config.configVersion }));
        } else return remember(operation, opReceipt(operation, "rejected", "forbidden"));
        item.state = "removed"; item.version++; queueItems.push(replacement); queuedOperations.delete(item.operationId); queuedOperations.set(operation.operationId, operation);
        record.queueVersion++; record.version++;
        // Both sides of the replacement are durable before either projection event is emitted.
        const receipt = remember(operation, opReceipt(operation, "applied"));
        emit({ kind: "queue-changed", queueVersion: record.queueVersion, item }); emit({ kind: "queue-changed", queueVersion: record.queueVersion, item: replacement });
        emit({ kind: "operation-receipt", receipt });
        emit({ kind: "session-state", session: structuredClone(record) });
        return receipt;
      }
      record.queueVersion++; record.version++; const receipt = remember(operation, opReceipt(operation, "applied")); emit({ kind: "queue-changed", queueVersion: record.queueVersion, item });
      emit({ kind: "operation-receipt", receipt });
      emit({ kind: "session-state", session: structuredClone(record) });
      return receipt;
    }
    if (operation.kind === "command") {
      const request = checked("CommandInvoke", operation.request);
      const entry = catalogue().entries.find((item) => item.commandName === request.commandName);
      const lifecycleInput: SessionLifecycleInput = { operationId: operation.operationId, payloadDigest: operation.payloadDigest, actorId: operation.actorId, command: request,
        source: structuredClone(record), readonlyRestriction: restriction(),
        resumeSource: async () => {
          const args = request.arguments;
          if (!authorized(operation) || request.commandName !== "sessions.resume" || !object(args) || args.sessionId !== record.sessionId) throw new SessionHostError("native-resume-binding-mismatch");
          const { sessionId: _sessionId, ...target } = args;
          return resumeOwnedSession(checked("SessionResume", target));
        },
        releaseSource: async () => {
          if (active !== undefined || !authorized(operation) || opened.lease.checkLost()) throw new SessionHostError("lifecycle-source-authority-changed");
          const verified = await options.workspace.verify(record.workspaceBaseline); if (!verified.ok) throw new SessionHostError("workspace-conflict");
          if (!(await closeSessionServices())) { record.state = "recovery-required"; state(); fenceLease(); throw new SessionHostError("recovery-required"); }
          syncHistory(); await options.runtime.preserveSession(); releaseSessionLease(opened.lease); record.state = "closed"; state(); return structuredClone(record);
        },
        forkNative: async (input) => {
          const args = request.arguments;
          if (request.commandName !== "sessions.fork" || !object(args) || args.throughHistoryCursor !== input.throughHistoryCursor || args.expectedHistoryVersion !== input.expectedHistoryVersion
            || args.title !== input.title || input.expectedHistoryVersion !== record.historyVersion || active !== undefined || !authorized(operation) || opened.lease.checkLost()) throw new SessionHostError("native-fork-binding-mismatch");
          // The title is stored and printed by `keryx sessions list`: the same hidden-character rule as an approval card.
          if (hiddenInCard(input.title)) throw new SessionHostError("native-fork-title-unsafe");
          const through = nativeBoundaries.get(input.throughHistoryCursor); if (through === undefined) throw new SessionHostError("native-fork-boundary-unavailable");
          syncHistory();
          const fork = forkSession({ cwd: options.cwd, sourceIdOrPrefix: handle.summary.id, targetCwd: input.targetCwd, throughArchiveCount: through, contextArchiveIndices: activeArchiveIndices(through, input.throughHistoryCursor, contextResets), title: input.title,
            ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }) });
          // The fork's transcripts must read back exactly as written; an unreadable one is a typed refusal to the lifecycle caller, never an empty or partial seed.
          let copied: ReturnType<typeof loadArchive>; let forkContext: ReturnType<typeof loadContext>;
          try { copied = loadArchive(input.targetCwd, fork.handle.summary.id, options.dataDir); forkContext = loadContext(input.targetCwd, fork.handle.summary.id, options.dataDir); }
          catch (cause) {
            // The refused fork never becomes a session: its directory goes, or the failed cleanup is itself the typed refusal.
            try { rmSync(fork.handle.dir, { recursive: true, force: true }); } catch (cleanup) { throw new SessionHostError("native-fork-cleanup-failed", { cause: new AggregateError([cause, cleanup]) }); }
            throw new SessionHostError("native-fork-history-unreadable", { cause });
          }
          return { nativeSessionId: fork.handle.summary.id, archiveCount: fork.archiveCount, messageCount: fork.messageCount, historySeed: {
            sourceSessionId: record.sessionId, nativeSessionId: fork.handle.summary.id, throughHistoryCursor: input.throughHistoryCursor,
            nativeArchiveCount: copied.length, nativeArchiveDigest: canonicalDigest(copied), nativeContextDigest: canonicalDigest(forkContext), contextResets: structuredClone(contextResets.filter(reset => reset.cursor <= input.throughHistoryCursor)), messages: structuredClone(publicHistory.filter((message) => message.historyCursor <= input.throughHistoryCursor)),
            nativeBoundaries: [...nativeBoundaries].filter(([cursor]) => cursor <= input.throughHistoryCursor),
          } };
        }, sourceNativeSessionId: handle.summary.id, sourceCwd: options.cwd, ...(options.dataDir === undefined ? {} : { sourceDataDir: options.dataDir }) };
      if (lifecycleMutationCommands.has(request.commandName) && entry?.availability === "available" && request.catalogueDigest === catalogue().catalogueDigest
        && request.expectedConfigVersion === record.config.configVersion && canonicalDigest(request) === operation.payloadDigest && validateArguments(entry.inputSchema, request.arguments).ok) {
        if (active !== undefined || options.lifecycle === undefined) return remember(operation, opReceipt(operation, "rejected", "busy"));
        if (!opened.lease.released) syncHistory();
        const applied = await options.lifecycle.apply(lifecycleInput);
        if (!applied.ok) return remember(operation, opReceipt(operation, "rejected", "forbidden"));
        const receipt = checked("SessionOperationReceipt", applied.value);
        const expectedKind = request.commandName === "sessions.fork" ? "fork-session" : request.commandName === "sessions.resume" ? "resume-session" : "create-session";
        if (receipt.operationId !== operation.operationId || receipt.kind !== expectedKind || receipt.sessionId !== receipt.session?.sessionId
          || receipt.session?.projectId !== record.projectId || receipt.session?.machineId !== record.machineId
          || ((request.commandName === "new" || request.commandName === "clear" || request.commandName === "sessions.fork") && receipt.sessionId === record.sessionId)) throw new SessionHostError("lifecycle-receipt-binding-mismatch");
        remember(operation, receipt); emit({ kind: "operation-receipt", receipt }); emit({ kind: "session-state", session: structuredClone(record) }); return receipt;
      }
      if (request.commandName === "plan.set" && entry?.availability === "available" && request.catalogueDigest === catalogue().catalogueDigest && request.expectedConfigVersion === record.config.configVersion
        && canonicalDigest(request) === operation.payloadDigest && validateArguments(entry.inputSchema, request.arguments).ok) return applyPlan(operation, (request.arguments as { enabled: boolean }).enabled);
      if (request.commandName === "mode.ask" && entry?.availability === "available" && request.catalogueDigest === catalogue().catalogueDigest && request.expectedConfigVersion === record.config.configVersion
        && canonicalDigest(request) === operation.payloadDigest && validateArguments(entry.inputSchema, request.arguments).ok) return applyApprovalMode(operation);
      const proposedConfig = sessionConfigProposal(request, record.config);
      if ((request.commandName === "reasoning" || proposedConfig !== undefined) && entry?.availability === "available" && request.catalogueDigest === catalogue().catalogueDigest
        && request.expectedConfigVersion === record.config.configVersion && validateArguments(entry.inputSchema, request.arguments).ok) {
        const effort = request.commandName === "reasoning" ? (request.arguments as { effort: Control["SessionConfig"]["reasoningEffort"] }).effort : proposedConfig!.reasoningEffort;
        configCommandNames.set(operation.operationId, request.commandName);
        const configReceipt = await applyConfig({ ...operation, kind: "config", request: { expectedSessionVersion: request.expectedSessionVersion, controller: request.controller,
          expectedConfigVersion: request.expectedConfigVersion, baselineCandidateId: proposedConfig?.baselineCandidateId ?? record.config.baselineCandidateId, reasoningEffort: effort,
          routing: proposedConfig?.routing ?? record.config.routing, busyPolicy: request.busyPolicy === "queue-at-idle" ? "queue-at-idle" : "reject" } });
        const outcome = sendable({ operationId: operation.operationId, sessionId: record.sessionId, commandName: request.commandName,
          status: configReceipt.status, sessionVersion: record.version, result: configReceipt.status === "applied" ? sessionConfigCommandResult(request.commandName, record.config, routing.availability().candidates, record.nextTurnOrdinal) : null, confirmationId: configReceipt.confirmation?.confirmationId ?? null,
          errorCode: configReceipt.status === "rejected" ? "forbidden" : null, confirmation: configReceipt.confirmation, runId: null, turnId: null });
        return outcome;
      }
      if (entry?.mutationClass === "workspace" && entry.availability === "available" && request.catalogueDigest === catalogue().catalogueDigest
        && request.expectedConfigVersion === record.config.configVersion && validateArguments(entry.inputSchema, request.arguments).ok) {
        if (active !== undefined || pendingQueueCount() > 0 || operation.runId === undefined || operation.turnId === undefined) {
          if (request.busyPolicy !== "queue-at-idle" || entry.busyPolicy !== "queue-at-idle" || pendingQueueCount() >= LIMITS.pendingSessionItems) return remember(operation, opReceipt(operation, "rejected", "busy"));
          const item = addQueue(operation, "command", null, request.commandName); record.version++;
          const outcome = checked("CommandOutcome", { operationId: operation.operationId, sessionId: record.sessionId, commandName: request.commandName, status: "queued", sessionVersion: record.version,
            result: null, confirmationId: null, errorCode: null, confirmation: null, runId: null, turnId: null });
          remember(operation, outcome); emit({ kind: "queue-changed", queueVersion: record.queueVersion, item }); emit({ kind: "command-outcome", outcome }); emit({ kind: "session-state", session: structuredClone(record) }); return outcome;
        }
        if (entry.confirmation === "human") {
          if (active !== undefined) return remember(operation, opReceipt(operation, "rejected", "busy"));
          return executionConfirmation(operation);
        }
        return admitCommand(operation);
      }
      const inspection = inspectCommand(operation);
      let outcome: Control["CommandOutcome"];
      try {
        const context = commandContext(operation.operationId, undefined, inspection.context);
        if (options.lifecycle !== undefined) { context.lifecycle = options.lifecycle; context.lifecycleInput = lifecycleInput; }
        const integrations = options.runtime.integrationPort(); if (integrations !== undefined) context.integrations = integrations;
        context.approvals = { pending: approvals.pending, answer: async () => ({ status: "rejected", reason: "owned-control-required" }) };
        if (ownedControlNames.has(request.commandName) && entry?.availability === "available" && request.catalogueDigest === catalogue().catalogueDigest
          && request.expectedConfigVersion === record.config.configVersion && validateArguments(entry.inputSchema, request.arguments).ok) {
          prepareOwnedControl(operation, context, inspection);
          try { await context.authorizeOwnedControl!(request.commandName as OwnedControlCommand, request.arguments as Record<string, string | number | undefined>); } catch { /* No permit: normal busy rejection/handler denial remains. */ }
        }
        outcome = await options.runtime.withJobOwner({ kind: "inspection", identity: operation.operationId }, () => executeSessionCommand(context, request));
      }
      finally { inspection.close(); }
      remember(operation, outcome); emit({ kind: "command-outcome", outcome });
      emit({ kind: "session-state", session: structuredClone(record) });
      return outcome;
    }
    if (operation.kind === "cancel") {
      if (active === undefined) return remember(operation, opReceipt(operation, "rejected", "busy"));
      const stop = await stopCurrentTurn();
      return remember(operation, opReceipt(operation, stop === "stopped" ? "applied" : "recovery-required", stop === "stopped" ? "none" : "recovery-required"));
    }
    return remember(operation, opReceipt(operation, "rejected", "busy"));
  };
  const admitQueued = async (operationId: string, payloadDigest: string, authority: QueuedAdmissionAuthority, releaseMutation: () => void = () => {}): Promise<SessionHostReceipt> => {
    const prior = receipts.get(operationId);
    const item = queueItems.find((entry) => entry.operationId === operationId);
    const original = item?.kind === "config" ? queuedConfigurations.get(item.queueItemId) : item?.kind === "message" ? queuedMessages.get(item.queueItemId) : item?.kind === "command" ? queuedCommands.get(item.queueItemId) : undefined;
    const rejected = (): Control["SessionOperationReceipt"] => checked("SessionOperationReceipt", { receiptId: randomUUID(), operationId, sessionId: record.sessionId,
      kind: "reauthorize-queue", status: "rejected", observedSessionVersion: record.version, session: structuredClone(record), reason: "forbidden" });
    if (prior === undefined || prior.digest !== payloadDigest || original === undefined || item === undefined) return rejected();
    const replacementAwaitingAdmission = item.state === "queued" && "kind" in prior.receipt && prior.receipt.kind === "reauthorize-queue" && prior.receipt.status === "applied";
    if (prior.receipt.status !== "queued" && !replacementAwaitingAdmission) return structuredClone(prior.receipt);
    if (item.state !== "queued" || pendingClose !== undefined || active !== undefined || selecting !== undefined || queueItems.filter((entry) => entry.state === "queued" || entry.state === "suspended").sort((left, right) => left.position - right.position)[0] !== item
      || authority.expectedSessionVersion !== record.version || authority.expectedConfigVersion !== record.config.configVersion || item.expectedConfigVersion !== record.config.configVersion
      || canonicalDigest(original.controller) !== canonicalDigest(authority.controller) || !authorized({ actorId: authority.actorId, expiresAt: authority.expiresAt,
        request: { expectedSessionVersion: authority.expectedSessionVersion, controller: authority.controller } })
      || options.authorizeQueued === undefined || !(await options.authorizeQueued(operationId, payloadDigest, authority)) || record.version !== authority.expectedSessionVersion) return rejected();
    let receipt: SessionHostReceipt;
    if (item.kind === "config") {
      const config = queuedConfigurations.get(item.queueItemId);
      if (config === undefined) return rejected();
      receipt = await applyConfig({ kind: "config", operationId, payloadDigest, actorId: authority.actorId, request: config }, true);
    } else if (item.kind === "command") {
      const command = queuedCommands.get(item.queueItemId); const entry = catalogue().entries.find((entry) => entry.commandName === command?.commandName);
      if (command === undefined || authority.runId === undefined || authority.turnId === undefined || authority.association === undefined || entry?.availability !== "available"
        || entry.busyPolicy !== "queue-at-idle" || command.catalogueDigest !== catalogue().catalogueDigest || !validateArguments(entry.inputSchema, command.arguments).ok) return rejected();
      const operation: Extract<SessionHostOperation, { kind: "command" }> = { kind: "command", operationId, payloadDigest, actorId: authority.actorId, request: command,
        runId: authority.runId, turnId: authority.turnId, association: authority.association };
      receipt = entry.confirmation === "human" ? executionConfirmation(operation) : await admitCommand(operation);
    } else {
      const message = queuedMessages.get(item.queueItemId);
      if (message === undefined || item.text === null || authority.runId === undefined || authority.turnId === undefined) return rejected();
      receipt = await start({ kind: "message", operationId, payloadDigest, actorId: authority.actorId, runId: authority.runId, turnId: authority.turnId,
        request: { sessionId: record.sessionId, expectedSessionVersion: record.version, controller: authority.controller, expectedConfigVersion: record.config.configVersion,
          expectedHistoryVersion: record.historyVersion, expectedWorkspaceBaseline: record.workspaceBaseline, association: message.association, messageId: operationId, text: item.text } },
      item.text, { sessionId: record.sessionId, expectedSessionVersion: record.version, controller: authority.controller, expectedConfigVersion: record.config.configVersion,
        expectedHistoryVersion: record.historyVersion, expectedWorkspaceBaseline: record.workspaceBaseline, association: message.association, messageId: operationId, text: item.text }, undefined, releaseMutation, message);
    }
    if (item.state === "queued" && (receipt.status === "applied" || receipt.status === "admitted")) { item.state = receipt.status === "admitted" ? "admitted" : "applied"; item.version++; record.queueVersion++;
      emit({ kind: "queue-changed", queueVersion: record.queueVersion, item }); emit({ kind: "session-state", session: structuredClone(record) }); }
    return receipt;
  };
  const spawnOwnedGit = options.runtime.ownedGitSpawner();
  if (options.workspace.rewind !== undefined && spawnOwnedGit !== undefined) {
    const owner = options.workspace.rewind;
    const assertOwner = () => { if (disposed || opened.lease.checkLost() || opened.lease.released) throw new SessionHostError("native-lease-lost"); owner.ownership(); };
    const ownership = () => { assertOwner(); const held = owner.ownership(); return { sessionId: record.sessionId, nativeSessionId: handle.summary.id, checkoutId: record.checkoutId, nonce: held.nonce, gitHead: held.gitHead, workspaceBaseline: record.workspaceBaseline, historyVersion: rewindScope?.historyVersion ?? record.historyVersion }; };
    const ownedGit = createNativeOwnedGit({ cwd: options.cwd, sessionDir: handle.dir, jobs: options.runtime.jobs, assertOwnership: assertOwner, spawn: spawnOwnedGit,
      authorize: async request => { if (rewindScope === undefined || rewindScope.signal.aborted || rewindScope.kind === "inspection" && !request.readOnly) throw new SessionHostError("rewind-authority-required"); await rewindScope.beforeAction(request.readOnly ? "rewind:private-read" : "rewind:private-preparation"); } });
    // The owned Git boundary admits only the canonical shadow repository, so the recorder names it by the same resolved session dir.
    recorder = createRewindRecorder({ workTree: options.cwd, dir: () => join(realpathSync(handle.dir), "rewind"), enabled: () => true,
      native: { runGit: request => ownedGit.run(request), signal: () => { if (rewindScope === undefined) throw new SessionHostError("rewind-authority-required"); return rewindScope.signal; }, assertOwnership: assertOwner, validatePaths: owner.validatePaths,
        currentPaths: () => owner.ownership().paths, ownership } });
    const actual = createNativeRewindPort({ cwd: options.cwd, recorder, history, archive: activeArchive, ownership,
      canPersist: () => !disposed && !opened.lease.released && !opened.lease.checkLost(),
      persist: (nextHistory) => { handle = persistHistory(handle, nextHistory, { archive }); archiveCursor = nextHistory.length; persist(); },
      afterHistoryRewind: () => { record.historyVersion++; record.version++; contextResets.push({ cursor: record.historyCursor + 1, archiveCount: archive.length, activeCount: activeArchive.length });
        publishMessage("system-receipt", "The active conversation window was rewound. Executed audit history remains available.", active?.runId ?? null, active?.turnId ?? null); if (rewindScope !== undefined) rewindScope.historyVersion = record.historyVersion; },
      assertCurrent: async (expected, signal) => { signal.throwIfAborted(); assertOwner(); const verified = await options.workspace.verify(expected); if (!verified.ok) throw new SessionHostError("workspace-conflict"); },
    });
    rewindPort = {
      list: inspection => scopedRewind({ kind: "inspection", signal: inspection.signal, beforeAction: inspection.beforeAction }, () => actual.list(inspection)),
      preview: (args, inspection) => scopedRewind({ kind: "inspection", signal: inspection.signal, beforeAction: inspection.beforeAction }, () => actual.preview(args, inspection)),
      apply: (args, effect) => scopedRewind({ kind: "run", historyVersion: active?.historyVersionAtAdmission ?? record.historyVersion, signal: effect.signal, beforeAction: toolName => effect.beforeAction({ kind: "tool", toolName, signal: effect.signal }) }, () => actual.apply(args, effect)),
    };
  }
  if (options.initialHistory !== undefined) {
    const seed = options.initialHistory; const digest = canonicalDigest(seed);
    if (record.forkedFromSessionId !== seed.sourceSessionId || seed.nativeSessionId !== handle.summary.id || seed.nativeArchiveCount > archive.length
      || canonicalDigest(archive.slice(0, seed.nativeArchiveCount)) !== seed.nativeArchiveDigest || (historySeedDigest !== undefined && historySeedDigest !== digest)
      || (seed.nativeContextDigest !== undefined && seed.nativeContextDigest !== canonicalDigest(history)) || (hadLocalState && historySeedDigest === undefined) || seed.messages.some((message) => message.sessionId !== seed.sourceSessionId || message.historyCursor > seed.throughHistoryCursor)) throw new SessionHostError("native-fork-history-binding-mismatch");
    const boundaries = new Map(seed.nativeBoundaries);
    const copied = seed.messages.map((original, index) => checked("SessionMessage", { ...original, messageId: `fork-${canonicalDigest({ sessionId: record.sessionId, sourceMessageId: original.messageId })}`,
      sessionId: record.sessionId, historyCursor: index + 1, text: redactSensitiveText(original.text), runId: null, turnId: null }));
    if (publicHistory.slice(0, copied.length).some((message, index) => canonicalDigest(message) !== canonicalDigest(copied[index]))) throw new SessionHostError("native-fork-history-projection-conflict");
    historySeedDigest = digest;
    for (let index = publicHistory.length; index < copied.length; index++) {
      const message = copied[index]!; const nativeBoundary = boundaries.get(seed.messages[index]!.historyCursor);
      if (nativeBoundary === undefined || nativeBoundary < 0 || nativeBoundary > seed.nativeArchiveCount || !Number.isSafeInteger(nativeBoundary)) throw new SessionHostError("native-fork-history-boundary-missing");
      record.historyCursor = message.historyCursor; record.historyVersion++; publicHistory.push(message); nativeBoundaries.set(message.historyCursor, nativeBoundary); emit({ kind: "message", message });
    }
  }
  if (record.state === "opening") {
    const initial = await options.workspace.checkpoint();
    if (initial.ok) { record.workspaceBaseline = "value" in initial ? initial.value.baseline : initial.baseline; record.state = "idle"; }
    else record.state = "recovery-required";
    emit({ kind: "session-state", session: structuredClone(record) });
  }
  if (contextResets.some(reset => reset.cursor > record.historyCursor)) throw new SessionHostError("invalid-context-window");
  activeArchive.splice(0, activeArchive.length, ...activeArchiveIndices(archive.length, record.historyCursor, contextResets).map(index => archive[index]!));
  const attachSessionServices = () => options.runtime.attachServices({ configDir: options.configDir ?? options.dataDir ?? keryxConfigDir(), identity: () => ({ nativeSessionId: handle.summary.id, projectId: record.projectId, checkoutId: record.checkoutId }), sessionState: () => ({ config: structuredClone(record.config), restriction: restriction(), permissionMode: "ask", status: record.state }) });
  try { await attachSessionServices(); }
  catch { lostResumable = false; record.state = "recovery-required"; state(); }
  restriction(); persist();
  return {
    inspect: async () => structuredClone(record),
    resumableAfterLost: () => lostResumable,
    async history(query) { const result = page(publicHistory, query); return checked("HistoryPage", {
      messages: structuredClone(result.values),
      cursor: result.cursor, hasMore: result.hasMore, historyVersion: record.historyVersion, retainedFromCursor: 0, gap: false }); },
    async events(query) { const after = query?.cursor ?? 0; const values = eventLog.filter((event) => event.sessionEventSeq > after).slice(0, Math.min(100, query?.limit ?? 100)); return checked("SessionEventPage", {
      events: structuredClone(values), cursor: values.at(-1)?.sessionEventSeq ?? after, hasMore: eventLog.some((event) => event.sessionEventSeq > (values.at(-1)?.sessionEventSeq ?? after)), retainedFromCursor: eventLog[0]?.sessionEventSeq ?? 0, gap: eventLog.length > 0 && after + 1 < eventLog[0]!.sessionEventSeq }); },
    catalogue: async () => catalogue(), routingAvailability: async () => routing.availability(),
    async queue(query) { const result = page(queueItems, query); return { items: structuredClone(result.values), queueVersion: record.queueVersion, cursor: result.cursor, hasMore: result.hasMore }; },
    apply(operation) { const result = serialized(async (releaseMutation) => {
      const prior = receipts.has(operation.operationId) || selecting?.operationId === operation.operationId; const cursor = record.sessionEventCursor; const receipt = await apply(operation, releaseMutation);
      if (!prior) {
        const recent = eventLog.filter((event) => event.sessionEventSeq > cursor);
        let projected = false;
        if ("kind" in receipt && !recent.some((event) => event.kind === "operation-receipt" && event.receipt.receiptId === receipt.receiptId)) { emit({ kind: "operation-receipt", receipt }); projected = true; }
        else if ("commandName" in receipt && ["rejected", "recovery-required"].includes(receipt.status) && !recent.some((event) => event.kind === "command-outcome" && event.outcome.operationId === receipt.operationId)) { emit({ kind: "command-outcome", outcome: receipt }); projected = true; }
        else if ("configVersion" in receipt && receipt.status === "rejected" && !recent.some((event) => event.kind === "config-receipt" && event.receipt.operationId === receipt.operationId)) { emit({ kind: "config-receipt", receipt }); projected = true; }
        if (projected) emit({ kind: "session-state", session: structuredClone(record) });
      }
      return receipt;
    }); return result; },
    admitQueued(operationId, payloadDigest, authority) { return serialized((releaseMutation) => admitQueued(operationId, payloadDigest, authority, releaseMutation)); },
    nativeSessionId: () => handle.summary.id,
    recoverExpiredIdle(target) { return serialized(async () => {
      const refused = (code: string) => ({ ok: false as const, error: { code, message: code } });
      const controller = record.controller;
      // Every pin is checked before any effect, so each refusal below leaves the session exactly as it was.
      if (disposed) return refused("host-disposed");
      if (target.sessionId !== record.sessionId || target.nativeSessionId !== handle.summary.id || controller === null || controller.controllerLeaseId !== target.controllerLeaseId
        || controller.version !== target.controllerVersion || (target.expectedSessionVersion !== undefined && target.expectedSessionVersion !== record.version)
        || target.expectedHistoryVersion !== record.historyVersion || target.expectedWorkspaceBaseline !== record.workspaceBaseline) return refused("stale-reference");
      if ((controller.state !== "held" && controller.state !== "expired") || Date.parse(controller.expiresAt) > now()) return refused("controller-live");
      if (record.state !== "idle" || record.activeRunId !== null || active !== undefined || selecting !== undefined || inspections.size > 0) return refused("session-not-idle");
      if (opened.lease.released || opened.lease.checkLost()) return refused("native-lease-lost");
      recovering = true;
      try {
        // Expiry only selects the target. The proof is the same as dispose(): actual owned runtime cessation, measured now, and settled work.
        const stopped = await options.runtime.stop();
        const settled = await within(Promise.allSettled([...inspections.values()]).then(() => true), false, SETTLE_BOUND_MS);
        // Session services (MCP, bus) are owned resources too: a close that is not proven keeps the lease, as an unproven job stop does.
        const servicesClosed = stopped.status === "stopped" && settled && await closeSessionServices();
        if (!servicesClosed || disposed || active !== undefined || opened.lease.checkLost()) { record.state = "recovery-required"; state(); fenceLease(); return refused("recovery-required"); }
        syncHistory(); await options.runtime.preserveSession(); releaseSessionLease(opened.lease);
        // The closed snapshot keeps the lapsed lease unchanged; the release follows as the very next event, with no human operation or run.
        record.state = "closed"; state(); const closed = structuredClone(record);
        const receipt = checked("ControllerReceipt", { receiptId: randomUUID(), sessionVersion: record.version + 1, lease: { ...controller, version: controller.version + 1, state: "released" } });
        record.controller = structuredClone(receipt.lease); record.version = receipt.sessionVersion;
        pendingConfigurations.clear(); pendingExecutions.clear(); pendingPlans.clear();
        emit({ kind: "controller-changed", receipt });
        return { ok: true as const, value: { stopped: true as const, session: closed, controller: structuredClone(receipt) } };
      } catch {
        // Anything that fails after the stop began proves nothing about cessation: keep the session fenced.
        if (record.state !== "recovery-required") { record.state = "recovery-required"; state(); }
        fenceLease(); return refused("recovery-required");
      } finally { recovering = false; }
    }); },
    subscribe(after, sink) { for (const event of eventLog) if (event.sessionEventSeq > after) sink(structuredClone(event)); listeners.add(sink); return () => listeners.delete(sink); },
    subscribeTurnOutcome(sink) { turnListeners.add(sink); return () => { turnListeners.delete(sink); }; },
    async applyController(receipt, authority) {
      const parsed = validateControl("ControllerReceipt", receipt);
      const denied = (code: string) => ({ ok: false as const, error: { code, message: code } });
      if (!parsed.ok || disposed || !connected || receipt.lease.sessionId !== record.sessionId || receipt.lease.actorId !== authority.actorId
        || !/^[a-f0-9]{64}$/.test(authority.commandDigest) || authority.commandId.length === 0
        || options.authorizeController === undefined || !(await options.authorizeController(receipt, authority))) return denied("controller-authority-denied");
      const previous = controllerClaims.get(authority.commandId);
      if (previous !== undefined) return previous.commandDigest === authority.commandDigest && canonicalDigest(previous.receipt) === canonicalDigest(receipt)
        ? { ok: true, value: previous.receipt } : denied("controller-command-conflict");
      // No claim, renewal or takeover attaches to unproven cessation or races an in-flight local owner release.
      if (recovering) return denied("local-recovery-in-progress");
      // A re-hosted human-resolved lost crash runs nothing yet, so an explicit claim, renewal or verified takeover may precede its resume.
      if (record.state === "recovery-required" && receipt.lease.state === "held" && !lostResumable) return denied("recovery-required");
      if (receipt.sessionVersion === record.version && canonicalDigest(receipt.lease) === canonicalDigest(record.controller)) return { ok: true, value: receipt };
      const current = record.controller;
      const sameGenerationRenewal = current !== null && current.state === "held" && receipt.lease.state === "held"
        && receipt.lease.controllerLeaseId === current.controllerLeaseId && receipt.lease.version === current.version
        && receipt.lease.actorId === current.actorId && Date.parse(current.expiresAt) > now()
        && Date.parse(receipt.lease.expiresAt) >= Date.parse(current.expiresAt);
      if (receipt.sessionVersion <= record.version || (!sameGenerationRenewal && receipt.lease.version <= (current?.version ?? 0))) return denied("stale-controller-projection");
      const generationChanged = current?.actorId !== receipt.lease.actorId || current.controllerLeaseId !== receipt.lease.controllerLeaseId || current.version !== receipt.lease.version || receipt.lease.state !== "held";
      if (generationChanged) { questions.denyAll("question-scope-ended"); approvals.denyAll("controller-changed"); for (const abort of inspections.keys()) abort.abort(new SessionHostError("controller-changed")); }
      record.controller = structuredClone(receipt.lease); record.version = receipt.sessionVersion;
      const suspended = generationChanged ? queueItems.filter((item) => item.state === "queued") : [];
      if (suspended.length > 0) { record.queueVersion++; for (const item of suspended) { item.state = "suspended"; item.version++; } }
      controllerClaims.set(authority.commandId, { commandDigest: authority.commandDigest, receipt: parsed.value });
      if (generationChanged) { pendingConfigurations.clear(); pendingExecutions.clear(); pendingPlans.clear(); }
      emit({ kind: "controller-changed", receipt: parsed.value });
      for (const item of suspended) emit({ kind: "queue-changed", queueVersion: record.queueVersion, item });
      emit({ kind: "session-state", session: structuredClone(record) });
      for (const resume of [...reconnectWaiters]) resume();
      return { ok: true, value: parsed.value };
    },
    pendingApprovals: approvals.pending,
    subscribeApprovalOutcome(sink) { approvalOutcomeListeners.add(sink); return () => { approvalOutcomeListeners.delete(sink); }; },
    subscribeApprovals(sink) { approvalListeners.add(sink); return () => { approvalListeners.delete(sink); }; },
    async answerApproval(input) {
      if (!authorized(input) || active?.runId !== input.runId || active.turnId !== input.turnId) return { status: "rejected", reason: "authority-or-generation-mismatch" };
      return approvals.answer({ approvalId: input.approvalId, runId: input.runId, turnId: input.turnId, actorId: input.actorId,
        fingerprint: input.request.actionFingerprint, policyDigest: input.request.policyDigest, decision: input.request.decision });
    },
    async cancel(input) {
      const result = (status: "stopped" | "unknown" | "too-late" | "rejected", reason: string) => ({ status, runId: input.runId, turnId: input.turnId, reason });
      if (!authorized(input)) return result("rejected", "authority-mismatch");
      if (selecting !== undefined) {
        const current = selecting; if (current.runId !== input.runId || current.turnId !== input.turnId) return result("rejected", "selection-generation-mismatch");
        current.abort.abort(new SessionHostError("selection-cancelled")); await current.done;
        return result(record.state === "recovery-required" ? "unknown" : "stopped", "selection-cancelled-before-admission");
      }
      if (active === undefined) return result("too-late", "no-active-runtime");
      if (active.runId !== input.runId || active.turnId !== input.turnId) return result("rejected", "generation-mismatch");
      const stop = await stopCurrentTurn();
      return result(stop, stop === "stopped" ? "owned-runtime-stopped" : "process-ownership-unconfirmed");
    },
    setConnected(value) { connected = value; if (value) for (const resume of [...reconnectWaiters]) resume(); else for (const abort of inspections.keys()) abort.abort(new SessionHostError("machine-disconnected")); },
    async dispose() { if (disposed) return; const pendingSelection = selecting; pendingSelection?.abort.abort(new SessionHostError("session-closed"));
      // A classifier that never settles gets the same bound as a run: shutdown continues, and the unsettled selection keeps the session fenced.
      const selectionSettled = pendingSelection === undefined || await within(pendingSelection.done.then(() => true, () => true), false, SETTLE_BOUND_MS);
      active?.abort.abort(new SessionHostError("session-closed")); for (const abort of inspections.keys()) abort.abort(new SessionHostError("session-closed")); questions.denyAll("question-scope-ended"); approvals.denyAll("session-closed");
      // Ownership is released only once it is proven: a runtime that cannot confirm its stop, a run or selection that outlives the bound, or an unproven service close keeps the native lease and the session in recovery.
      const stopped = await options.runtime.stop();
      const settled = await within(Promise.allSettled([active?.done, ...inspections.values()]).then(() => true), false, SETTLE_BOUND_MS);
      const servicesClosed = await closeSessionServices();
      // A session already fenced, or a handle another runtime of this process left unproven, is never released by this runtime's own clean stop.
      // A re-hosted lost crash that ran nothing is no fence: its proven stop releases the lease it took, and the next re-host takes it again.
      const confirmed = stopped.status === "stopped" && settled && selectionSettled && servicesClosed && (record.state !== "recovery-required" || lostResumable) && !fencedLeases.has(opened.lease);
      if (!confirmed) { lostResumable = false; if (record.state !== "recovery-required") { record.state = "recovery-required"; state(); } fenceLease(); }
      if (!opened.lease.checkLost() && !opened.lease.released) { syncHistory(); await options.runtime.preserveSession(); }
      else options.runtime.detachSession();
      disposed = true; unwatchLease(); if (confirmed) releaseSessionLease(opened.lease); listeners.clear(); approvalListeners.clear(); approvalOutcomeListeners.clear(); },
  };
}
