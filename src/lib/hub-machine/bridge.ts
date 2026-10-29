import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { MachineContextSync } from './context';
import { canonicalDigest, parseMachineFrame, runCommandDigest, sessionCommandDigest, validateControl, type Control, type FrameOf, type MachineFrame, type MachineToHubFrame } from '../../remote-control/protocol';
import { createSessionHost } from '../../session/host';
import type { SessionLifecycleInput, NativeForkHistorySeed } from '../../session/host-lifecycle';
import type { NativeTurnObservation, SessionHostPort, SessionHostOptions, SessionHostReceipt } from '../../session/host-types';
import type { SessionLeaseOwner } from '../../session/lease';
import { redactSensitiveText } from '../../security/redact';
import { acquireMachineDaemon, loadEnrollment, machineStateDir, readMachineSecret, type MachineEnrollment, type CheckoutMapping } from './config';
import { captureBaseline, verifyBaseline, acquireCheckoutLease, currentCheckoutHead, observeCheckout, releaseRecoveredCheckoutLease } from './checkout-lease';
import { MachineConnection, readSessionSelectionAuthority, readSessionInspectionAuthority, readSessionActionAuthority, readScopedHubFlows, verifyScopedFlowAssociation, type GrantApplication } from './client';
import { createOwnedWorkspace, validateOwnedEffectPaths, type OwnedWorkspace } from './workspace';
import { readAllRecovery, verifyReconciliationReceipt } from './recovery';
import { applyStartingCommand } from './admission';
import { MachineCommandScope, MachineSelectionScope } from './authority';
import { MachineExecutionPool } from './pool';
import { MachineLedger } from './ledger';
import { MachineError, machineFailure, machineNoticeCode, type MachineResult } from './errors';
import { resolveProductionMachineProfile, type MachineProfile } from './production';
import { validLocalOwnerResult, type LocalOwnerRequest, type LocalOwnerResult, type LocalOwnerValue, type LocalRecoveryTarget } from './local-control';
import { currentProcessIdentity, processPresence, readProcessIdentity, type ProcessPresence } from './process-identity';
import type { DaemonRecord } from './ledger';
import type { NativeOwnedProcessEvent } from '../../session/native-runtime';
import { isOwnedControlCommand } from '../../remote-control/owned-controls';
const ownerRefusal = (code: string): LocalOwnerResult => ({ ok: false, error: { code, message: code } });
/** C0 controls and DEL, checked by code point so the pattern needs no control-character regex. */
const hasControlCharacter = (value: string): boolean => Array.from(value).some(char => { const code = char.charCodeAt(0); return code < 32 || code === 127; });
/** New work a full ledger refuses first: a turn, a run-scoped command, a queued message or a new/forked session. Controls of admitted work never are. */
const launchesWork = (frame: FrameOf<'command'> | FrameOf<'session-command'>): boolean => frame.type === 'command' ? frame.payload.kind === 'start-turn'
    : frame.payload.kind === 'submit-message' || frame.payload.kind === 'create-session' || frame.payload.kind === 'fork-session' || (frame.payload.kind === 'invoke-command' && frame.payload.target.scope === 'run');
/**
 * The receipt code of a host refusal. A busy refusal precedes every handler effect, and an owned control is authorized before
 * its effect, so both are known non-applications Hub may settle; every other refusal stays recovery-required.
 */
const knownRefusal = (command: SessionCommand, receipt: SessionHostReceipt): FrameOf<'session-command-receipt'>['payload']['errorCode'] => {
    if (receipt.status !== 'rejected' || !('errorCode' in receipt))
        return 'recovery-required';
    if (receipt.errorCode === 'busy')
        return 'session-busy';
    return command.kind === 'invoke-command' && isOwnedControlCommand(command.body.commandName) && receipt.errorCode === 'forbidden' ? 'scope-denied' : 'recovery-required';
};
const TERMINAL_RUN_STATES = new Set(['succeeded', 'failed', 'cancelled', 'rejected', 'lost']);
/** Local log GC cadence; the first pass runs on every (re)connect once Hub cursors are reconciled. */
const RETENTION_INTERVAL_MS = 3600000;
/** How often mapped checkouts are re-measured while connected (HEAD, cleanliness, Git operation; never file content). Publication follows only a change. */
const INVENTORY_REMEASURE_MS = 10000;
type RemoteRun = Control['RecoveryPage']['runs'][number];
/** A capability page before its publication version is assigned (distributes over the catalogue and routing page kinds). */
type UnversionedCapabilityPage = Control['CapabilityPage'] extends infer Page ? Page extends unknown ? Omit<Page, 'projectionVersion' | 'inventoryVersion'> : never : never;
type Command = FrameOf<'command'>['payload'];
type SessionCommand = FrameOf<'session-command'>['payload'];
type ExecutionIdentity = Pick<Command, 'sessionId' | 'turnId' | 'projectId' | 'checkoutId' | 'runId' | 'commandDigest'> & {
    association: Control['FlowAssociation'];
};
interface Hosted {
    host: SessionHostPort;
    mapping: CheckoutMapping;
    profile: MachineProfile;
    workspace: OwnedWorkspace;
    leaseReleased?: boolean;
    lease: ReturnType<typeof acquireCheckoutLease>;
}
export interface MachineBridgeOptions {
    configDir: string;
    enrollment: MachineEnrollment;
    policy: Control['LocalMachinePolicy'];
    resolveProfile?: (mapping: CheckoutMapping) => Promise<MachineResult<MachineProfile>>;
    onNotice?: (code: string) => void;
    runLogByteLimit?: number;
    /** Shortens how long hosted approvals and confirmation cards stay answerable; absent keeps the frozen 120 s. */
    decisionTtlMs?: number;
    /** How often mapped checkouts are re-measured while connected, 100 ms to 60 s; absent keeps 10 s. */
    inventoryIntervalMs?: number;
}
/** Outbound transport/application composition. Local factories and mapping paths never come from frames. */
export class MachineBridge {
    private readonly daemonId = randomUUID();
    private context: MachineContextSync | undefined;
    private pool: MachineExecutionPool | undefined;
    private ledger: MachineLedger | undefined;
    private connection: MachineConnection | undefined;
    private lock: ReturnType<typeof acquireMachineDaemon> | undefined;
    private readonly selectionAuthority = new Map<string, MachineSelectionScope>();
    private readonly lifecycleAuthority = new Map<string, {
        application: GrantApplication;
        command: Extract<SessionCommand, {
            kind: 'invoke-command';
        }>;
        receipt?: Control['SessionOperationReceipt'];
    }>();
    private readonly inspectionAuthority = new Map<string, MachineCommandScope>();
    private readonly hosted = new Map<string, Hosted>();
    private readonly profiles = new Map<string, MachineProfile>();
    private readonly errors = new Map<string, string>();
    private readonly queuedAuthority = new Map<string, {
        application: GrantApplication;
        digest: string;
    }>();
    private readonly controllerAuthority = new Map<string, {
        application: GrantApplication;
        receiptDigest: string;
    }>();
    private readonly runs = new Map<string, {
        command: ExecutionIdentity;
        started?: boolean;
        cancelling?: boolean;
        operationId?: string;
        hosted: Hosted;
        nativeIdentity?: {
            sessionId: string;
            turnId: string;
            daemonId: string;
            supervisorHandleId: string;
        };
        logBytes: number;
        nonAdmission?: Extract<NativeTurnObservation, { kind: "admission-refused" }>;
        poolNonce?: string;
        terminal?: Extract<NativeTurnObservation, {
            kind: 'terminal';
        }>;
        terminalSeq?: number;
        publishing?: boolean;
    }>();
    private stopped = false;
    private ready = false;
    private readonly background = new Set<Promise<unknown>>();
    private readonly ownerTasks = new Set<Promise<unknown>>();
    private readonly pendingFrames: Array<FrameOf<'command'> | FrameOf<'session-command'>> = [];
    private pendingBytes = 0;
    private pumping = false;
    private pumpTask: Promise<void> | undefined;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private reconnectAttempts = 0;
    private outboxTimer: ReturnType<typeof setTimeout> | undefined;
    private retentionTimer: ReturnType<typeof setInterval> | undefined;
    private inventoryTimer: ReturnType<typeof setInterval> | undefined;
    /** What the last complete inventory publication measured (observeCheckout per mapping) and published; undefined forces the next one. */
    private inventoryObserved: string | undefined;
    private inventoryContent: string | undefined;
    private flushingOutbox = false;
    private congested = false;
    constructor(private readonly options: MachineBridgeOptions) { if (options.runLogByteLimit !== undefined && (!Number.isSafeInteger(options.runLogByteLimit) || options.runLogByteLimit < 8192 || options.runLogByteLimit > 10 * 1024 * 1024))
        throw new MachineError('invalid-log-quota'); if (options.inventoryIntervalMs !== undefined && (!Number.isSafeInteger(options.inventoryIntervalMs) || options.inventoryIntervalMs < 100 || options.inventoryIntervalMs > 60000))
        throw new MachineError('invalid-inventory-interval'); }
    baseline(sessionId: string): string | undefined { return this.hosted.get(sessionId)?.workspace.baseline().digest; }
    get connected(): boolean { return this.ready && this.connection?.connected === true; }
    get hubId(): string { return this.options.enrollment.hubId; }
    private notice(cause: unknown): void { this.options.onNotice?.(machineNoticeCode(cause, this.stopped)); }
    async start(): Promise<void> {
        const e = this.options.enrollment;
        const checked = validateControl('LocalMachinePolicy', this.options.policy);
        if (!checked.ok || checked.value.hubId !== e.hubId || !checked.value.enabled)
            throw new MachineError('local-policy');
        this.lock = acquireMachineDaemon(this.options.configDir, e.hubId);
        try {
            const current = loadEnrollment(this.options.configDir, e.hubId);
            if (canonicalDigest(current) !== canonicalDigest(e))
                throw new MachineError('local-policy-changed');
            this.ledger = new MachineLedger(path.join(machineStateDir(this.options.configDir, e.hubId), 'control.sqlite'));
            // Identity evidence beyond the PID, durable before this daemon can launch anything: a later crash is judged by it, never by the lock's age.
            this.ledger.recordDaemon({ daemonId: this.daemonId, lockNonce: this.lock.nonce, ...currentProcessIdentity() });
            this.pool = new MachineExecutionPool(path.join(this.options.configDir, 'hub-machines', 'executions.sqlite'));
            for (const mapping of e.mappings) {
                const policy = this.options.policy;
                const allowed = policy.checkouts.find(c => c.projectId === mapping.projectId && c.checkoutId === mapping.checkoutId && c.path === mapping.cwd && c.profileIds.includes(mapping.profileId));
                if (!allowed) {
                    this.errors.set(mapping.checkoutId, 'local-policy');
                    continue;
                }
                const ids = policy.profiles.find(p => p.profileId === mapping.profileId)?.allowedCandidateIds ?? [];
                const result = await (this.options.resolveProfile?.(mapping) ?? resolveProductionMachineProfile(mapping, { configDir: this.options.configDir, allowedCandidateIds: ids.filter(v => policy.allowedCandidateIds.includes(v)) }));
                if (result.ok)
                    this.profiles.set(mapping.checkoutId, result.value);
                else
                    this.errors.set(mapping.checkoutId, result.error.code);
            }
            this.context = new MachineContextSync({ hubUrl: e.hubUrl, token: readMachineSecret(e), cacheRoot: path.join(machineStateDir(this.options.configDir, e.hubId), 'context'), mappings: e.mappings.filter(m => existsSync(path.join(m.cwd, '.metaproject', 'index.md'))) });
            this.retentionTimer = setInterval(() => this.retireExpiredLogs(), RETENTION_INTERVAL_MS);
            this.retentionTimer.unref?.();
            this.inventoryTimer = setInterval(() => this.refreshInventory(), this.options.inventoryIntervalMs ?? INVENTORY_REMEASURE_MS);
            this.inventoryTimer.unref?.();
            try {
                await this.connect();
            }
            catch (cause) {
                this.notice(cause);
                this.scheduleReconnect();
            }
        }
        catch (cause) {
            await this.stop();
            throw cause;
        }
    }
    private async connect(): Promise<void> {
        this.ready = false;
        if (this.pumpTask)
            await Promise.allSettled([this.pumpTask]);
        this.connection?.close();
        if (this.stopped)
            return;
        const ledger = this.ledger!;
        const e = this.options.enrollment;
        const cursors = ledger.cursors();
        this.connection = new MachineConnection({ hubUrl: e.hubUrl, machineId: e.machineId, secret: readMachineSecret(e), ledgerId: ledger.ledgerId, daemonId: this.daemonId, agentVersion: 'keryx-native-v1', lastHubSequence: ledger.lastHubSequence,
            runCursors: cursors.filter(c => c.stream.startsWith('run:')).map(c => ({ runId: c.stream.slice(4), lastLocalSeq: c.ack })), sessionCursors: cursors.filter(c => c.stream.startsWith('session:')).map(c => ({ sessionId: c.stream.slice(8), lastSessionEventSeq: c.ack })),
            onFrame: f => this.receive(f), onDisconnect: () => { this.options.onNotice?.('machine-disconnected'); this.ready = false; for (const { host } of this.hosted.values())
                host.setConnected(false); this.scheduleReconnect(); } });
        await this.connection.connect();
        // Recovery is observational. Any uncertain local start remains blocked and is never replayed as an effect.
        const recovered = await readAllRecovery(cursor => this.connection!.request(`/hub/v2/machines/${e.machineId}/recovery?after=${cursor}`));
        for (const run of recovered.runs)
            this.ledger!.reconcileCursor(`run:${run.runId}`, run.lastLocalSeq);
        for (const session of recovered.sessions)
            this.ledger!.reconcileCursor(`session:${session.sessionId}`, session.sessionEventCursor);
        await this.context?.initialize();
        this.publishInventory();
        this.replay();
        const deadline = performance.now() + 5000;
        while (this.ledger!.cursors().some(c => this.ledger!.pendingEvents(c.stream).length) && performance.now() < deadline) {
            if (!this.connection.connected)
                throw new MachineError('machine-offline');
            await Bun.sleep(10);
        }
        if (this.ledger!.cursors().some(c => this.ledger!.pendingEvents(c.stream).length))
            throw new MachineError('replay-gap');
        for (const hosted of this.hosted.values()) {
            const current = await hosted.host.inspect();
            if (current.activeRunId && current.activeTurnId) {
                const allowed = await readSessionActionAuthority({ hubUrl: e.hubUrl, secret: readMachineSecret(e), action: { session: current, runId: current.activeRunId, turnId: current.activeTurnId, kind: 'model' } });
                // A drifted Flow still reconnects the host: its next action boundary ends the turn visibly instead of leaving it paused for good.
                hosted.host.setConnected(allowed !== false);
            }
            else
                hosted.host.setConnected(true);
        }
        await this.reconcileActiveRuns();
        // Hub cursors are reconciled now, so only content Hub actually acknowledged can be retired.
        this.retireExpiredLogs();
        this.ready = true;
        this.reconnectAttempts = 0;
        this.kick();
        for (const result of this.ledger!.pendingResults()) {
            const run = this.runs.get(result.runId);
            if (run && !run.publishing) {
                run.publishing = true;
                const task = this.publishResult(result.runId).catch(cause => { run.publishing = false; this.notice(cause); }).finally(() => this.background.delete(task));
                this.background.add(task);
            }
        }
    }
    private async reconcileActiveRuns(): Promise<void> {
        const e = this.options.enrollment, read = () => readAllRecovery(cursor => this.connection!.request(`/hub/v2/machines/${e.machineId}/recovery?after=${cursor}`));
        let snapshot = await read();
        // Spec section 7: a run this daemon cannot prove it owns shows unknown, never last-known running. That is every non-terminal
        // run whose start marker another daemon of this installation left (a crash): only the explicit local recovery and a human
        // resolution settle it. Publishing the state releases nothing and restates only the native identity already published.
        const inherited = snapshot.runs.filter(remote => !TERMINAL_RUN_STATES.has(remote.state) && remote.state !== 'unknown' && this.inheritedLaunch(remote));
        for (const remote of inherited)
            await this.publishUnknown(remote);
        if (inherited.length > 0)
            snapshot = await read();
        for (const remote of snapshot.runs) {
            if (['succeeded', 'failed', 'cancelled', 'rejected', 'lost'].includes(remote.state))
                continue;
            const local = this.runs.get(remote.runId);
            let observation: Control['ReconciliationReport']['observation'] = 'unknown';
            let identity: Control['ReconciliationReport']['nativeIdentity'];
            if (local) {
                if (local.command.commandDigest !== remote.commandDigest || local.command.sessionId !== remote.sessionId || local.command.turnId !== remote.turnId)
                    throw new MachineError('recovery-required');
                if (local.terminal && local.terminal.outcome !== 'unknown')
                    observation = 'confirmed-stopped';
                else if (local.nativeIdentity) {
                    local.hosted.lease.assertOwnership();
                    const current = await local.hosted.host.inspect();
                    if (current.activeRunId === remote.runId && current.activeTurnId === remote.turnId) {
                        observation = 'owned-running';
                        identity = local.nativeIdentity;
                    }
                }
            }
            const report: Control['ReconciliationReport'] = { runId: remote.runId, sessionId: remote.sessionId, turnId: remote.turnId, projectId: remote.projectId, checkoutId: remote.checkoutId, ledgerId: this.ledger!.ledgerId, daemonId: this.daemonId, commandDigest: remote.commandDigest, expectedRunVersion: remote.version, observation, observedAt: new Date().toISOString(), ...(identity ? { nativeIdentity: identity } : {}) };
            const receipt = await this.connection!.request(`/hub/v2/machines/${e.machineId}/reconciliations`, report, `reconcile:${canonicalDigest(report)}`);
            if (!verifyReconciliationReceipt(receipt, report, e.machineId, Date.now()))
                throw new MachineError('invalid-reconciliation');
            this.ledger!.recordReconciliation(report, receipt);
        }
    }
    private scheduleReconnect(): void { if (this.stopped || this.reconnectTimer)
        return; const delay = Math.min(60000, 1000 * 2 ** Math.min(this.reconnectAttempts++, 6)) + Math.floor(Math.random() * 250); this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; const task = this.connect().catch(cause => { this.notice(cause); this.scheduleReconnect(); }).finally(() => this.background.delete(task)); this.background.add(task); }, delay); }
    private send(frame: MachineToHubFrame): void { this.connection!.sendFrame(frame); }
    private envelope<T extends MachineToHubFrame['type']>(type: T, payload: Extract<MachineToHubFrame, {
        type: T;
    }>['payload']): Extract<MachineToHubFrame, {
        type: T;
    }> {
        const checked = parseMachineFrame(JSON.stringify({ v: 2, type, messageId: randomUUID(), epoch: this.connection!.currentEpoch, payload }), 'machine-to-hub');
        if (!checked.ok)
            throw new MachineError(checked.error.code);
        return checked.value as Extract<MachineToHubFrame, {
            type: T;
        }>;
    }
    /** The inventory-visible state of every mapped checkout, measured without reading content; an unobservable one is its error code. */
    private observeCheckouts(): string {
        return canonicalDigest(this.options.enrollment.mappings.map(m => { try {
            return observeCheckout(m.cwd);
        }
        catch (cause) {
            return { unobservable: machineFailure(cause).code };
        } }));
    }
    /**
     * Re-measures the mapped checkouts while connected, at a bounded cadence and at session create/close and run-end boundaries,
     * and publishes the complete projection again only when what Hub sees changed (a commit, a dirtied or cleaned checkout), at
     * the durable content-keyed version. An unchanged projection is never sent twice on one connection.
     */
    private refreshInventory(): void {
        if (!this.ready || this.stopped || !this.connection?.connected)
            return;
        try {
            if (this.observeCheckouts() !== this.inventoryObserved)
                this.publishInventory(false);
        }
        catch (cause) {
            // A publication cut short (a full send buffer) is repeated whole at the next re-measure; Hub accepts the identical replay.
            this.inventoryObserved = undefined;
            this.inventoryContent = undefined;
            this.notice(cause);
        }
    }
    /** `force`: every (re)connect publishes the complete projection, changed or not. */
    private publishInventory(force = true): void {
        const observed = this.observeCheckouts();
        this.inventoryObserved = undefined;
        const checkouts: FrameOf<'inventory'>['payload']['checkouts'] = [];
        for (const m of this.options.enrollment.mappings) {
            const profile = this.profiles.get(m.checkoutId);
            let headSha = '0'.repeat(40), clean = false, available = true;
            try {
                const b = captureBaseline(m.cwd, { requireClean: true });
                headSha = b.head;
                clean = true;
            }
            catch (cause) {
                const failure = machineFailure(cause);
                // Uncommitted changes (a session's own work, or a crash's leftovers) make a checkout dirty, not unusable: Hub refuses a
                // clean start on it, while the session owning that work still finds its HEAD and profile after a reconnect.
                if (failure.code === 'checkout-dirty')
                    headSha = currentCheckoutHead(m.cwd);
                else {
                    available = false;
                    this.errors.set(m.checkoutId, failure.code);
                }
            }
            const reason = this.errors.get(m.checkoutId);
            checkouts.push({ projectId: m.projectId, checkoutId: m.checkoutId, localBindingId: canonicalDigest([this.options.enrollment.hubId, m.checkoutId]), label: m.checkoutId, headSha, clean, available, busy: false, agentProfiles: [{ profileId: m.profileId, adapter: 'keryx-native-v1', readiness: profile && available ? 'ready' : 'setup-required', reason: profile && available ? 'none' : reason === 'containment-missing' ? 'containment-missing' : reason === 'local-policy' ? 'local-policy' : reason === 'provider-setup' ? 'provider-setup' : available ? 'adapter-unsupported' : 'checkout-unavailable', capabilityDigest: profile?.capabilityDigest ?? canonicalDigest([]), policyDigest: profile?.policyDigest ?? canonicalDigest(this.options.policy) }] });
        }
        const pages: UnversionedCapabilityPage[] = [];
        for (const m of this.options.enrollment.mappings) {
            const p = this.profiles.get(m.checkoutId);
            if (!p)
                continue;
            const common = { projectId: m.projectId, checkoutId: m.checkoutId, agentProfileId: m.profileId, policyDigest: p.policyDigest, capabilityDigest: p.capabilityDigest, catalogueVersion: p.catalogue.catalogueVersion, catalogueDigest: p.catalogue.catalogueDigest };
            for (const kind of ['catalogue', 'routing'] as const) {
                const entries = kind === 'catalogue' ? p.catalogue.entries : p.routing.candidates;
                const count = Math.max(1, Math.ceil(entries.length / 16));
                for (let i = 0; i < count; i++)
                    pages.push(kind === 'catalogue' ? { ...common, kind, totalEntries: entries.length, cursor: i * 16, nextCursor: i + 1 < count ? (i + 1) * 16 : null, entries: p.catalogue.entries.slice(i * 16, i * 16 + 16) } : { ...common, kind, totalEntries: entries.length, cursor: i * 16, nextCursor: i + 1 < count ? (i + 1) * 16 : null, profileIds: p.routing.profileIds, entries: p.routing.candidates.slice(i * 16, i * 16 + 16) });
            }
        }
        // Protocol: inventory is a versioned complete projection. The version is durable and content-keyed, so a reconnect or a
        // daemon restart replays an unchanged projection at its version and publishes any change (a commit, a dirty checkout) as the next one.
        const content = canonicalDigest({ checkouts, pages });
        if (!force && content === this.inventoryContent) {
            this.inventoryObserved = observed;
            return;
        }
        this.inventoryContent = undefined;
        const version = this.ledger!.publicationVersion(content);
        const valid = pages.map(page => validateControl('CapabilityPage', { ...page, projectionVersion: version, inventoryVersion: version }));
        if (valid.some(page => !page.ok))
            throw new MachineError('setup-required');
        this.send(this.envelope('inventory', { inventoryVersion: version, checkouts }));
        for (const page of valid)
            if (page.ok)
                this.send(this.envelope('capability-page', page.value));
        this.inventoryContent = content;
        this.inventoryObserved = observed;
    }
    private persistSession(event: Control['SessionEvent']): void {
        this.ledger!.persistEvent(`session:${event.sessionId}`, event.sessionEventSeq, event);
        if (event.kind === 'command-outcome' && event.outcome.status === 'rejected' && event.outcome.runId && event.outcome.turnId) {
            const run = this.runs.get(event.outcome.runId);
            if (run && run.operationId === event.outcome.operationId && run.command.sessionId === event.sessionId && run.command.turnId === event.outcome.turnId && !run.started && !run.nativeIdentity && !run.terminal) {
                this.runEvent(run.command.runId, { kind: 'state', state: 'rejected', reasonCode: 'none' });
                if (run.poolNonce)
                    this.pool!.release(this.options.enrollment.hubId, run.command.runId, run.poolNonce);
                this.runs.delete(run.command.runId);
            }
        }
        this.flushOutbox();
    }
    private replay(): void { for (const cursor of this.ledger!.cursors())
        this.ledger!.resetUnackedForReplay(cursor.stream); this.flushOutbox(); }
    private flushOutbox(): void {
        if (this.flushingOutbox || this.stopped || !this.connection?.connected || this.congested && this.outboxTimer !== undefined)
            return;
        this.flushingOutbox = true;
        let pending = false;
        try {
            for (const cursor of this.ledger!.cursors()) {
                const events = this.ledger!.unsentEvents(cursor.stream);
                for (const item of events) {
                    const frame = cursor.stream.startsWith('session:') ? this.envelope('session-event', item.payload as Control['SessionEvent']) : this.envelope('run-event', item.payload as FrameOf<'run-event'>['payload']);
                    try {
                        this.send(frame);
                    }
                    catch (cause) {
                        if (cause instanceof MachineError && ['quota-exceeded', 'machine-offline'].includes(cause.code)) {
                            pending = true;
                            break;
                        }
                        throw cause;
                    }
                    this.ledger!.markSent(cursor.stream, item.seq);
                }
                if (events.length === 500)
                    pending = true;
                if (pending)
                    break;
            }
        }
        catch (cause) {
            this.notice(cause);
            this.connection?.close();
            pending = true;
        }
        finally {
            this.flushingOutbox = false;
        }
        if (pending) {
            if (!this.congested) {
                this.congested = true;
                for (const { host } of this.hosted.values())
                    host.setConnected(false);
            }
            if (!this.outboxTimer)
                this.outboxTimer = setTimeout(() => { this.outboxTimer = undefined; this.flushOutbox(); }, 10);
        }
        else if (this.congested) {
            this.congested = false;
            for (const { host } of this.hosted.values())
                host.setConnected(true);
        }
    }
    private async receive(frame: MachineFrame): Promise<void> {
        if (frame.type === 'error') {
            this.options.onNotice?.(/^[a-z][a-z0-9-]{0,63}$/.test(frame.payload.code) ? `hub-${frame.payload.code}` : 'hub-invalid-error');
            return;
        }
        if (frame.type === 'context-changed') {
            if (!this.options.enrollment.mappings.some(m => m.projectId === frame.payload.projectId))
                throw new MachineError('scope-denied');
            if (this.context?.hasProject(frame.payload.projectId))
                await this.context.invalidate(frame.payload.projectId, frame.payload.contextRevision);
            else
                this.options.onNotice?.('project-context-setup-required');
            return;
        }
        if (frame.type === 'session-event-ack') {
            this.ledger!.ackEvents(`session:${frame.payload.sessionId}`, frame.payload.sessionEventSeq);
            this.flushOutbox();
            if (this.ready && !this.congested && this.connection?.connected)
                this.hosted.get(frame.payload.sessionId)?.host.setConnected(true);
            return;
        }
        if (frame.type === 'run-event-ack') {
            this.flushOutbox();
            this.ledger!.ackEvents(`run:${frame.payload.runId}`, frame.payload.localSeq);
            const run = this.runs.get(frame.payload.runId);
            if (run?.terminalSeq && frame.payload.localSeq >= run.terminalSeq && !run.publishing) {
                run.publishing = true;
                const task = this.publishResult(frame.payload.runId).catch(cause => { run.publishing = false; this.notice(cause); }).finally(() => this.background.delete(task));
                this.background.add(task);
            }
            return;
        }
        if (frame.type === 'session-command' || frame.type === 'command') {
            const size = Buffer.byteLength(JSON.stringify(frame));
            if (this.pendingFrames.length >= 1000 || this.pendingBytes + size > 262144)
                throw new MachineError('quota-exceeded');
            this.pendingFrames.push(frame);
            this.pendingBytes += size;
            this.kick();
        }
    }
    private kick(): void { if (this.pumping || !this.ready || this.stopped)
        return; const task = this.pump(); this.pumpTask = task; void task.catch(cause => { this.notice(cause); this.ready = false; this.connection?.close(); }); }
    private async pump(): Promise<void> {
        if (this.pumping || !this.ready || this.stopped)
            return;
        this.pumping = true;
        try {
            while (this.ready && !this.stopped && this.pendingFrames.length) {
                const frame = this.pendingFrames.shift()!;
                this.pendingBytes -= Buffer.byteLength(JSON.stringify(frame));
                try {
                    await this.command(frame);
                }
                catch (cause) {
                    await this.commandFailure(frame, cause);
                }
            }
        }
        finally {
            this.pumping = false;
        }
    }
    private async commandFailure(frame: FrameOf<'command'> | FrameOf<'session-command'>, cause: unknown): Promise<void> {
        const error = machineFailure(cause);
        const c = frame.payload;
        this.ledger!.recordDiagnostic(c.commandId, error.code, error.detail);
        this.notice(error);
        const row = this.ledger!.unresolved().find(r => r.id === c.commandId && r.digest === c.commandDigest);
        if (!row) {
            this.connection?.close();
            return;
        }
        const sessionId = frame.type === 'command' ? frame.payload.sessionId : frame.payload.target.sessionId;
        const hosted = this.hosted.get(sessionId);
        const actual = await hosted?.host.inspect();
        if (row.phase === 'received') {
            if (frame.type === 'session-command' && frame.payload.target.scope === 'run') {
                const run = this.runs.get(frame.payload.target.runId);
                if (run && !run.started && !run.nativeIdentity && run.command.commandDigest === c.commandDigest) {
                    if (run.poolNonce)
                        this.pool!.release(this.options.enrollment.hubId, run.command.runId, run.poolNonce);
                    this.runs.delete(run.command.runId);
                }
            }
            if (frame.type === 'session-command') {
                const code: FrameOf<'session-command-receipt'>['payload']['errorCode'] = error.code === 'command-expired' ? 'command-expired' : error.code === 'payload-conflict' ? 'payload-conflict' : error.code === 'stale-reference' ? 'stale-version' : error.code === 'machine-busy' || error.code === 'quota-exceeded' ? 'session-busy' : error.code === 'checkout-dirty' || error.code === 'workspace-conflict' ? 'workspace-conflict' : error.code === 'scope-denied' || error.code === 'authorization-not-applied' || error.code === 'machine-http-403' ? 'scope-denied' : 'recovery-required';
                const receipt: FrameOf<'session-command-receipt'>['payload'] = { commandId: c.commandId, hubSequence: c.hubSequence, sessionId, observedSessionVersion: actual?.version ?? Math.max(1, frame.payload.target.expectedSessionVersion), status: 'rejected', receiptId: randomUUID(), errorCode: code };
                this.ledger!.finish(this.options.enrollment.hubId, c.commandId, 'rejected', receipt);
                if (this.connection?.connected)
                    this.send(this.envelope('session-command-receipt', receipt));
            }
            else {
                const run = this.runs.get(frame.payload.runId);
                if (run?.poolNonce) {
                    this.pool!.release(this.options.enrollment.hubId, frame.payload.runId, run.poolNonce);
                    delete run.poolNonce;
                }
                const receipt: FrameOf<'command-receipt'>['payload'] = { commandId: c.commandId, hubSequence: c.hubSequence, sessionId, runId: frame.payload.runId, observedRunVersion: frame.payload.expectedRunVersion, status: 'rejected', errorCode: error.code === 'command-expired' ? 'command-expired' : error.code === 'machine-busy' ? 'machine-busy' : error.code === 'quota-exceeded' ? 'quota-exceeded' : error.code === 'checkout-dirty' ? 'checkout-dirty' : error.code === 'payload-conflict' ? 'payload-conflict' : 'stale-reference' };
                this.ledger!.finish(this.options.enrollment.hubId, c.commandId, 'rejected', receipt);
                if (this.connection?.connected)
                    this.send(this.envelope('command-receipt', receipt));
            }
        }
        else {
            hosted?.host.setConnected(false);
            if (frame.type === 'session-command') {
                const receipt: FrameOf<'session-command-receipt'>['payload'] = { commandId: c.commandId, hubSequence: c.hubSequence, sessionId, observedSessionVersion: actual?.version ?? Math.max(1, frame.payload.target.expectedSessionVersion), status: 'unknown', receiptId: randomUUID(), errorCode: 'recovery-required' };
                this.ledger!.recordReceipt(this.options.enrollment.hubId, c.commandId, receipt);
                if (this.connection?.connected)
                    this.send(this.envelope('session-command-receipt', receipt));
            }
        }
    }
    private async withSelection<T>(binding: {
        operationId: string;
        payloadDigest: string;
        request: unknown;
        runId: string;
        turnId: string;
    }, application: GrantApplication, apply: () => Promise<T>): Promise<T> {
        if (this.selectionAuthority.has(binding.operationId) || !application.valid())
            throw new MachineError('authorization-not-applied');
        const grant = application.grant;
        const scope = new MachineSelectionScope({ ...binding, actorId: grant.authorizedBy, requestDigest: canonicalDigest(binding.request), sessionId: grant.target.sessionId, sessionVersion: grant.target.expectedSessionVersion }, () => application.valid(), action => readSessionSelectionAuthority({ hubUrl: this.options.enrollment.hubUrl, secret: readMachineSecret(this.options.enrollment), action }));
        this.selectionAuthority.set(binding.operationId, scope);
        try {
            return await apply();
        }
        finally {
            scope.close();
            this.selectionAuthority.delete(binding.operationId);
        }
    }
    private async command(frame: FrameOf<'session-command'> | FrameOf<'command'>): Promise<void> {
        const c = frame.payload;
        const e = this.options.enrollment;
        const digest = frame.type === 'command' ? runCommandDigest(frame.payload) : sessionCommandDigest(frame.payload);
        if (c.commandDigest !== digest)
            throw new MachineError('payload-conflict');
        const claim = this.ledger!.claim({ hubId: e.hubId, commandId: c.commandId, digest: c.commandDigest, runId: frame.type === 'command' ? frame.payload.runId : null, checkoutId: c.checkoutId, hubSequence: c.hubSequence, envelope: frame, daemonId: this.daemonId, launch: launchesWork(frame) });
        if (claim.status === 'replay') {
            const receipt = this.ledger!.commandReceipt(e.hubId, c.commandId);
            if (receipt) {
                this.send(this.envelope(frame.type === 'command' ? 'command-receipt' : 'session-command-receipt', receipt as never));
                return;
            }
            if (claim.phase === 'unknown' || claim.phase === 'lost')
                throw new MachineError('recovery-required');
        }
        if (Date.parse(c.expiresAt) <= Date.now())
            throw new MachineError('command-expired');
        const mapping = e.mappings.find(m => m.projectId === c.projectId && m.checkoutId === c.checkoutId);
        const profile = mapping && this.profiles.get(mapping.checkoutId);
        if (!mapping || !profile)
            throw new MachineError('setup-required');
        if (frame.type === 'session-command' && frame.payload.kind === 'create-session') {
            await this.create(frame.payload, mapping, profile);
            return;
        }
        const sessionId = frame.type === 'command' ? frame.payload.sessionId : frame.payload.target.sessionId;
        // Only an explicit controller change or resume brings back a session a crash left, and only after the human lost resolution.
        const recoverable = frame.type === 'session-command' && (frame.payload.kind === 'claim-controller' || frame.payload.kind === 'resume-session');
        const hosted = this.hosted.get(sessionId) ?? (recoverable ? await this.rehostAfterLost(sessionId, mapping, profile, c.commandId) : undefined);
        if (!hosted)
            throw new MachineError('recovery-required', { detail: 'session-not-hosted' });
        const current = await hosted.host.inspect();
        if (frame.type === 'session-command' && (frame.payload.kind === 'claim-controller' || frame.payload.kind === 'release-controller')) {
            const command = frame.payload;
            const receipt = validateControl('ControllerReceipt', await this.connection!.request(`/hub/v2/projects/${command.projectId}/sessions/${sessionId}/operations/${command.commandId}`));
            if (!receipt.ok)
                throw new MachineError('invalid-frame');
            if (current.version !== command.target.expectedSessionVersion || receipt.value.lease.actorId !== command.authorizedBy)
                throw new MachineError('stale-reference');
            const controller = command.kind === 'release-controller' ? command.body.controller : null;
            const application = await this.connection!.authorization(command.commandId, { commandDigest: command.commandDigest, policyDigest: profile.policyDigest, target: command.target, controller }, command.authorizedBy);
            this.controllerAuthority.set(sessionId, { application, receiptDigest: canonicalDigest(receipt.value) });
            try {
                this.ledger!.markStarting(e.hubId, command.commandId, this.daemonId);
                const result = await application.apply(grant => hosted.host.applyController(receipt.value, { actorId: grant.authorizedBy, commandId: command.commandId, commandDigest: command.commandDigest }));
                if (!result.ok)
                    throw result.error;
                if (!result.value.ok) {
                    const actual = await hosted.host.inspect();
                    const rejected: FrameOf<'session-command-receipt'>['payload'] = { commandId: command.commandId, hubSequence: command.hubSequence, sessionId, observedSessionVersion: actual.version, status: 'not-applied', receiptId: randomUUID(), errorCode: 'controller-conflict' };
                    this.ledger!.finish(e.hubId, command.commandId, 'rejected', rejected);
                    this.send(this.envelope('session-command-receipt', rejected));
                    return;
                }
                const actual = await hosted.host.inspect();
                const response: FrameOf<'session-command-receipt'>['payload'] = { commandId: command.commandId, hubSequence: command.hubSequence, sessionId, observedSessionVersion: actual.version, status: 'applied', receiptId: receipt.value.receiptId, errorCode: null };
                this.ledger!.finish(e.hubId, command.commandId, 'applied', response);
                this.send(this.envelope('session-command-receipt', response));
            }
            finally {
                this.controllerAuthority.delete(sessionId);
            }
            return;
        }
        if (frame.type === 'command' && (frame.payload.kind === 'answer-approval' || frame.payload.kind === 'cancel-run')) {
            const command = frame.payload;
            const target: Control['CommandTarget'] = { scope: 'run', sessionId, runId: command.runId, turnId: command.turnId, expectedRunVersion: command.expectedRunVersion, expectedSessionVersion: command.expectedSessionVersion };
            const request: Control['AuthorizeCommand'] = { commandDigest: command.commandDigest, policyDigest: profile.policyDigest, target, controller: command.controller, ...(command.kind === 'answer-approval' ? { actionFingerprint: command.body.actionFingerprint } : {}) };
            const application = await this.connection!.authorization(command.commandId, request, command.authorizedBy);
            this.ledger!.markStarting(e.hubId, command.commandId, this.daemonId);
            let applied: boolean;
            let finishedFirst = false;
            if (command.kind === 'answer-approval') {
                const result = await application.apply(grant => hosted.host.answerApproval({ approvalId: command.body.approvalId, runId: command.runId, turnId: command.turnId, actorId: grant.authorizedBy, request: { expectedRunVersion: command.expectedRunVersion, expectedSessionVersion: command.expectedSessionVersion, controller: command.controller, actionFingerprint: command.body.actionFingerprint, policyDigest: command.body.policyDigest, decision: command.body.decision } }));
                if (!result.ok)
                    throw result.error;
                applied = result.value.status === 'applied';
            }
            else {
                const run = this.runs.get(command.runId);
                if (run)
                    run.cancelling = true;
                if (run && !run.terminal)
                    this.runEvent(command.runId, { kind: 'state', state: 'cancelling', reasonCode: 'none', ...(run.nativeIdentity ? { nativeIdentity: run.nativeIdentity } : {}) });
                const result = await application.apply(grant => hosted.host.cancel({ runId: command.runId, turnId: command.turnId, actorId: grant.authorizedBy, request: { expectedRunVersion: command.expectedRunVersion, expectedSessionVersion: command.expectedSessionVersion, controller: command.controller, reason: command.body.reason } }));
                if (!result.ok)
                    throw result.error;
                applied = result.value.status === 'stopped';
                // The run already ended with a known outcome before the stop applied (its session moved on): too late to cancel, nothing to recover.
                const ended = this.runs.get(command.runId)?.terminal;
                finishedFirst = (result.value.status === 'too-late' || result.value.status === 'rejected') && ended !== undefined && ended.outcome !== 'unknown';
            }
            const receipt: FrameOf<'command-receipt'>['payload'] = { commandId: command.commandId, hubSequence: command.hubSequence, sessionId, runId: command.runId, status: applied ? 'applied' : 'not-applied', observedRunVersion: command.expectedRunVersion, errorCode: applied ? 'none' : command.kind === 'answer-approval' ? 'approval-not-applied' : finishedFirst ? 'stale-reference' : 'recovery-required' };
            this.ledger!.finish(e.hubId, command.commandId, applied ? 'applied' : 'rejected', receipt);
            this.send(this.envelope('command-receipt', receipt));
            return;
        }
        if (frame.type === 'command' && frame.payload.kind === 'start-turn') {
            const command = frame.payload;
            const req = command.body.request;
            const policy = this.options.policy;
            const allowed = policy.profiles.find(p => p.profileId === mapping.profileId);
            if (req.association.mode === 'flow') {
                const flow = await readScopedHubFlows({ hubUrl: e.hubUrl, secret: readMachineSecret(e), projectId: command.projectId, flowId: req.association.flowId });
                if (!verifyScopedFlowAssociation(flow, command.projectId, req.association))
                    throw new MachineError('stale-reference');
            }
            if (req.association.mode === 'ad-hoc' && (!policy.allowAdHocSessions || !allowed?.allowAdHocTurns || req.association.profileConsentVersion !== allowed.consentVersion))
                throw new MachineError('local-policy');
            if (current.version !== command.expectedSessionVersion || req.expectedSessionVersion !== current.version || current.config.policyDigest !== profile.policyDigest || current.config.capabilityDigest !== profile.capabilityDigest || canonicalDigest(command.body.snapshot.config) !== canonicalDigest(current.config) || !verifyBaseline(mapping.cwd, hosted.workspace.baseline()))
                throw new MachineError('stale-reference');
            if ([...this.runs.values()].filter(r => r.hosted === hosted && !r.terminal && !r.nonAdmission).length > 0 || [...this.runs.values()].filter(r => !r.terminal && !r.nonAdmission).length >= this.options.policy.maxConcurrentRuns)
                throw new MachineError('machine-busy');
            const operation = validateControl('TurnReceipt', await this.connection!.request(`/hub/v2/projects/${command.projectId}/sessions/${sessionId}/operations/${command.commandId}`));
            if (!operation.ok)
                throw new MachineError('invalid-frame');
            hosted.workspace.beginTurn();
            const slot = this.pool!.claim({ hubId: e.hubId, runId: command.runId, daemonId: this.daemonId, limit: this.options.policy.maxConcurrentRuns });
            this.runs.set(command.runId, { command: { ...command, association: req.association }, started: true, hosted, logBytes: 0, poolNonce: slot.nonce });
            const application = await this.connection!.authorization(command.commandId, { commandDigest: command.commandDigest, policyDigest: profile.policyDigest, target: { scope: 'run', sessionId, runId: command.runId, turnId: command.turnId, expectedSessionVersion: command.expectedSessionVersion, expectedRunVersion: command.expectedRunVersion }, controller: command.controller }, command.authorizedBy);
            this.ledger!.markStarting(e.hubId, command.commandId, this.daemonId);
            const publishStart = () => { this.runEvent(command.runId, { kind: 'state', state: 'received', reasonCode: 'none' }); this.runEvent(command.runId, { kind: 'state', state: 'starting', reasonCode: 'none' }); };
            const queued = (await hosted.host.queue()).items.find(item => item.operationId === req.messageId && item.state === 'queued');
            let result;
            if (queued) {
                const original = this.ledger!.operation(req.messageId, sessionId);
                const message = original && validateControl('MessageSubmit', original.body);
                if (!original || original.kind !== 'submit-message' || !message || !message.ok || queued.text !== req.text || canonicalDigest(message.value.association) !== canonicalDigest(req.association) || canonicalDigest(message.value.controller) !== canonicalDigest(req.controller))
                    throw new MachineError('payload-conflict');
                this.queuedAuthority.set(req.messageId, { application, digest: original.digest });
                try {
                    result = await application.apply(grant => { publishStart(); return this.withSelection({ operationId: req.messageId, payloadDigest: original.digest, request: original.body, runId: command.runId, turnId: command.turnId }, application, () => hosted.host.admitQueued(req.messageId, original.digest, { actorId: grant.authorizedBy, commandId: command.commandId, commandDigest: command.commandDigest, expectedSessionVersion: command.expectedSessionVersion, expectedConfigVersion: req.expectedConfigVersion, controller: command.controller, expiresAt: command.expiresAt, runId: command.runId, turnId: command.turnId })); });
                }
                finally {
                    this.queuedAuthority.delete(req.messageId);
                }
            }
            else {
                this.ledger!.rememberOperation(operation.value.operationId, { sessionId, digest: command.commandDigest, kind: 'start-turn', body: req });
                result = await application.apply(grant => { publishStart(); return this.withSelection({ operationId: operation.value.operationId, payloadDigest: command.commandDigest, request: req, runId: command.runId, turnId: command.turnId }, application, () => hosted.host.apply({ kind: 'message', operationId: operation.value.operationId, payloadDigest: command.commandDigest, actorId: grant.authorizedBy, expiresAt: command.expiresAt, request: req, runId: command.runId, turnId: command.turnId })); });
            }
            if (!result.ok)
                throw result.error;
            await this.releaseRefusedAttempt(hosted, command.runId, command.turnId, result.value);
            const nonAdmission = this.runs.get(command.runId)?.nonAdmission;
            const receipt: FrameOf<'command-receipt'>['payload'] = { commandId: command.commandId, hubSequence: command.hubSequence, sessionId, runId: command.runId, observedRunVersion: command.expectedRunVersion, status: result.value.status === 'admitted' ? 'admitted' : 'not-applied', errorCode: result.value.status === 'admitted' ? 'none' : nonAdmission?.reason === 'expired-work' ? 'command-expired' : nonAdmission?.reason === 'temporarily-unavailable' ? 'machine-offline' : nonAdmission?.reason === 'revoked-or-forbidden' ? 'scope-denied' : 'stale-reference' };
            this.ledger!.finish(e.hubId, command.commandId, result.value.status === 'admitted' ? 'applied' : 'rejected', receipt);
            this.send(this.envelope('command-receipt', receipt));
            return;
        }
        if (frame.type === 'session-command') {
            const command = frame.payload;
            const operation = await this.connection!.request(`/hub/v2/projects/${command.projectId}/sessions/${sessionId}/operations/${command.commandId}`);
            const turn = validateControl('TurnReceipt', operation);
            const typed = validateControl('ConfigReceipt', operation);
            const outcome = validateControl('CommandOutcome', operation);
            const ordinary = validateControl('SessionOperationReceipt', operation);
            const operationId = command.kind === 'confirm-command' ? command.commandId : typed.ok ? typed.value.operationId : outcome.ok ? outcome.value.operationId : ordinary.ok ? ordinary.value.operationId : turn.ok ? turn.value.operationId : null;
            if (!operationId)
                throw new MachineError('invalid-frame');
            const base = { operationId, payloadDigest: canonicalDigest(command.body), actorId: command.authorizedBy, expiresAt: command.expiresAt };
            const op = command.kind === 'submit-message' ? { ...base, kind: 'submit-message' as const, request: command.body } : command.kind === 'change-config' ? { ...base, kind: 'config' as const, request: command.body } : command.kind === 'invoke-command' ? { ...base, kind: 'command' as const, request: command.body } : command.kind === 'confirm-command' ? { ...base, kind: 'confirm-command' as const, request: command.body } : command.kind === 'edit-queue' ? { ...base, kind: 'edit-queue' as const, request: command.body } : command.kind === 'remove-queue' ? { ...base, kind: 'remove-queue' as const, request: command.body } : command.kind === 'reauthorize-queue' ? { ...base, kind: 'reauthorize-queue' as const, request: command.body } : command.kind === 'close-session' ? { ...base, kind: 'close-session' as const, request: command.body } : command.kind === 'resume-session' ? { ...base, kind: 'resume-session' as const, request: command.body } : null;
            if (!op)
                throw new MachineError('setup-required');
            // `/sessions resume` of a session a serve crash left reaches the same guarded re-host as a direct resume, on frame arrival.
            if (command.kind === 'invoke-command' && command.body.commandName === 'sessions.resume' && ordinary.ok && ordinary.value.kind === 'resume-session' && !this.hosted.has(ordinary.value.sessionId))
                await this.rehostResumeTarget(ordinary.value, command.commandId);
            let replacementOperation: {
                sessionId: string;
                digest: string;
                kind: string;
                body: unknown;
            } | undefined;
            if (command.kind === 'reauthorize-queue') {
                const item = (await hosted.host.queue()).items.find(item => item.queueItemId === command.body.queueItemId && item.operationId === command.body.originalOperationId && item.state === 'suspended');
                const source = item && this.ledger!.operation(item.operationId, sessionId);
                if (!item || !source)
                    throw new MachineError('recovery-required');
                const pins = { expectedSessionVersion: current.version + 1, expectedConfigVersion: command.body.expectedConfigVersion, controller: command.body.controller };
                const derived = item.kind === 'message' ? validateControl('MessageSubmit', { ...pins, text: item.text, interpretation: 'literal-message', busyPolicy: 'enqueue', association: command.body.association }) : item.kind === 'config' ? validateControl('ConfigChange', { ...(validateControl('ConfigChange', source.body).ok ? source.body as object : {}), ...pins, busyPolicy: 'queue-at-idle' }) : validateControl('CommandInvoke', { ...(validateControl('CommandInvoke', source.body).ok ? source.body as object : {}), ...pins, association: command.body.association });
                if (!derived.ok)
                    throw new MachineError('payload-conflict');
                replacementOperation = { sessionId, digest: canonicalDigest(command.body), kind: item.kind === 'message' ? 'submit-message' : item.kind === 'config' ? 'change-config' : 'invoke-command', body: derived.value };
            }
            if (command.kind === 'invoke-command' && command.target.scope === 'run') {
                const target = command.target, association = command.body.association;
                const consent = this.options.policy.profiles.find(p => p.profileId === mapping.profileId);
                if (!outcome.ok || outcome.value.runId !== target.runId || outcome.value.turnId !== target.turnId || !association || current.version !== target.expectedSessionVersion || command.body.expectedSessionVersion !== current.version || current.config.configVersion !== command.body.expectedConfigVersion || !verifyBaseline(mapping.cwd, hosted.workspace.baseline()))
                    throw new MachineError('stale-reference');
                if (association.mode === 'ad-hoc' && (!this.options.policy.allowAdHocSessions || !consent?.allowAdHocTurns || association.profileConsentVersion !== consent.consentVersion))
                    throw new MachineError('local-policy');
                if (association.mode === 'flow' && !verifyScopedFlowAssociation(await readScopedHubFlows({ hubUrl: e.hubUrl, secret: readMachineSecret(e), projectId: command.projectId, flowId: association.flowId }), command.projectId, association))
                    throw new MachineError('stale-reference');
                hosted.workspace.beginTurn();
                const slot = this.pool!.claim({ hubId: e.hubId, runId: target.runId, daemonId: this.daemonId, limit: this.options.policy.maxConcurrentRuns });
                this.runs.set(target.runId, { command: { sessionId, runId: target.runId, turnId: target.turnId, projectId: command.projectId, checkoutId: command.checkoutId, commandDigest: command.commandDigest, association }, hosted, operationId, logBytes: 0, poolNonce: slot.nonce });
            }
            const application = await this.connection!.authorization(command.commandId, { commandDigest: command.commandDigest, policyDigest: profile.policyDigest, target: command.target, controller: op.request.controller }, command.authorizedBy);
            const queuedWork = op.kind === 'config' || op.kind === 'command' ? (await hosted.host.queue()).items.find(item => item.operationId === operationId && item.kind === (op.kind === 'config' ? 'config' : 'command') && item.state === 'queued') : undefined;
            const originalWork = queuedWork ? this.ledger!.operation(operationId, sessionId) : null;
            if (queuedWork) {
                const original = originalWork && validateControl(op.kind === 'config' ? 'ConfigChange' : 'CommandInvoke', originalWork.body);
                if (!originalWork || originalWork.kind !== command.kind || !original || !original.ok || canonicalDigest({ ...original.value, expectedSessionVersion: current.version }) !== canonicalDigest(command.body))
                    throw new MachineError('payload-conflict');
            }
            this.ledger!.markStarting(e.hubId, command.commandId, this.daemonId);
            if (!queuedWork)
                this.ledger!.rememberOperation(operationId, replacementOperation ?? { sessionId, digest: canonicalDigest(command.body), kind: command.kind, body: command.body });
            const runForSelection = command.kind === 'invoke-command' && command.target.scope === 'run' ? this.runs.get(command.target.runId) : command.kind === 'confirm-command' && outcome.ok ? [...this.runs.values()].find(run => run.hosted === hosted && run.operationId === outcome.value.operationId && !run.started) : undefined;
            const selectionOperation = runForSelection?.operationId ? this.ledger!.operation(runForSelection.operationId, sessionId) : null;
            const execute = async (grant: GrantApplication['grant']) => {
                if (queuedWork && originalWork && (op.kind === 'config' || op.kind === 'command')) {
                    this.queuedAuthority.set(operationId, { application, digest: originalWork.digest });
                    try {
                        return await hosted.host.admitQueued(operationId, originalWork.digest, { actorId: grant.authorizedBy, commandId: command.commandId, commandDigest: command.commandDigest, expectedSessionVersion: command.target.expectedSessionVersion, expectedConfigVersion: op.request.expectedConfigVersion, controller: op.request.controller, expiresAt: command.expiresAt, ...(command.kind === 'invoke-command' && command.target.scope === 'run' ? { runId: command.target.runId, turnId: command.target.turnId, association: command.body.association } : {}) });
                    }
                    finally {
                        this.queuedAuthority.delete(operationId);
                    }
                }
                if (op.kind === 'command' && command.kind === 'invoke-command')
                    this.lifecycleAuthority.set(operationId, { application, command, ...(ordinary.ok ? { receipt: ordinary.value } : {}) });
                if (op.kind === 'command')
                    this.inspectionAuthority.set(operationId, new MachineCommandScope({ operationId, actorId: grant.authorizedBy, requestDigest: canonicalDigest(op.request), payloadDigest: op.payloadDigest }, action => readSessionInspectionAuthority({ hubUrl: e.hubUrl, secret: readMachineSecret(e), action })));
                try {
                    return await hosted.host.apply({ ...op, actorId: grant.authorizedBy, ...(op.kind === 'command' && command.kind === 'invoke-command' && command.target.scope === 'run' ? { runId: command.target.runId, turnId: command.target.turnId, association: command.body.association } : {}) });
                }
                finally {
                    this.lifecycleAuthority.delete(operationId);
                    this.inspectionAuthority.get(operationId)?.close();
                    this.inspectionAuthority.delete(operationId);
                }
            };
            const applied = await application.apply(grant => runForSelection && selectionOperation && runForSelection.operationId ? this.withSelection({ operationId: runForSelection.operationId, payloadDigest: selectionOperation.digest, request: selectionOperation.body, runId: runForSelection.command.runId, turnId: runForSelection.command.turnId }, application, () => execute(grant)) : execute(grant));
            if (!applied.ok)
                throw applied.error;
            if (command.kind === 'invoke-command' && command.target.scope === 'run')
                await this.releaseRefusedAttempt(hosted, command.target.runId, command.target.turnId, applied.value);
            const actual = await hosted.host.inspect();
            const rejected = applied.value.status === 'rejected' || applied.value.status === 'recovery-required';
            // An admitted when-idle close is still pending its turn boundary: it is accepted, not yet applied.
            const pending = 'kind' in applied.value && applied.value.status === 'pending';
            const response: FrameOf<'session-command-receipt'>['payload'] = { commandId: command.commandId, hubSequence: command.hubSequence, sessionId, observedSessionVersion: actual.version, status: rejected ? 'not-applied' : pending ? 'admitted' : 'applied', receiptId: 'receiptId' in applied.value ? applied.value.receiptId : randomUUID(), errorCode: rejected ? knownRefusal(command, applied.value) : null };
            this.ledger!.finish(e.hubId, command.commandId, rejected ? 'rejected' : 'applied', response);
            this.send(this.envelope('session-command-receipt', response));
            // A session boundary: re-measure what Hub sees of the checkouts.
            if (command.kind === 'close-session')
                this.refreshInventory();
            return;
        }
        throw new MachineError('setup-required');
    }
    private async create(c: Extract<SessionCommand, {
        kind: 'create-session';
    }>, mapping: CheckoutMapping, profile: MachineProfile): Promise<void> {
        const record = validateControl('SessionRecord', await this.connection!.request(`/hub/v2/projects/${c.projectId}/sessions/${c.target.sessionId}`));
        if (!record.ok)
            throw new MachineError('invalid-frame');
        const r = record.value;
        if (c.target.scope !== 'session' || c.target.expectedSessionVersion !== 0 || r.state !== 'opening' || r.machineId !== this.options.enrollment.machineId || r.projectId !== mapping.projectId || r.checkoutId !== mapping.checkoutId || r.agentProfileId !== mapping.profileId || r.config.policyDigest !== profile.policyDigest || r.config.capabilityDigest !== profile.capabilityDigest || c.body.expectedHeadSha !== captureBaseline(mapping.cwd, { requireClean: true }).head)
            throw new MachineError('stale-reference');
        const lease = acquireCheckoutLease(mapping.cwd, { hubId: this.options.enrollment.hubId, runId: r.sessionId, daemonId: this.daemonId });
        let marked = false;
        try {
            const workspace = createOwnedWorkspace(mapping.cwd, () => lease.assertOwnership());
            const application = await this.connection!.authorization(c.commandId, { commandDigest: c.commandDigest, policyDigest: profile.policyDigest, target: c.target, controller: null }, c.authorizedBy);
            const created = await applyStartingCommand(application, () => { this.ledger!.markStarting(this.options.enrollment.hubId, c.commandId, this.daemonId); marked = true; }, () => this.materializeRecord(r, mapping, profile, workspace, lease, undefined, () => application.valid()));
            if (!created.ok)
                throw created.error;
            const host = created.value.host;
            const actual = await host.inspect();
            if (actual.state !== 'idle' || actual.workspaceBaseline !== workspace.baseline().digest)
                throw new MachineError('recovery-required');
            const receipt: FrameOf<'session-command-receipt'>['payload'] = { commandId: c.commandId, hubSequence: c.hubSequence, sessionId: r.sessionId, observedSessionVersion: actual.version, status: 'applied', receiptId: randomUUID(), errorCode: null };
            this.ledger!.finish(this.options.enrollment.hubId, c.commandId, 'applied', receipt);
            this.send(this.envelope('session-command-receipt', receipt));
            this.refreshInventory();
        }
        catch (cause) {
            if (!marked)
                lease.release(lease.nonce);
            throw cause;
        }
    }
    /**
     * The restarted daemon hosts again a session a serve crash left with its run in flight, only once that run went through the
     * explicit local recovery and the human `lost` resolution (recovery-runbook.md "After a serve crash"): Hub shows the run lost
     * one version after this ledger's own confirmed-stopped receipt and release-resolved-run marked its launch lost. The session comes
     * back from its durable host state on its re-verified owned baseline, recovery-required until an explicit resume. The crashed
     * daemon's native lease is taken over only when its recorded token names that daemon and the daemon plus every process it recorded
     * for the checkout are absent by recorded identity (process group and start time), never by PID or lease age. Anything else stays
     * unhosted and refuses with recovery-required, naming the guard that refused in its detail for this machine's ledger diagnostics.
     */
    private async rehostAfterLost(sessionId: string, mapping: CheckoutMapping, profile: MachineProfile, commandId: string): Promise<Hosted> {
        const e = this.options.enrollment, ledger = this.ledger!;
        const refused = (detail: string, cause?: unknown) => new MachineError('recovery-required', { detail: `rehost-${detail}`, ...(cause === undefined ? {} : { cause }) });
        if (this.stopped)
            throw refused('machine-stopping');
        if (!existsSync(path.join(machineStateDir(this.options.configDir, e.hubId), 'remote-sessions', `${sessionId}.json`)))
            throw refused('local-state-missing');
        const fetched = validateControl('SessionRecord', await this.connection!.request(`/hub/v2/projects/${mapping.projectId}/sessions/${sessionId}`));
        if (!fetched.ok)
            throw refused('hub-session-invalid');
        const r = fetched.value;
        if (r.machineId !== e.machineId || r.projectId !== mapping.projectId || r.checkoutId !== mapping.checkoutId || r.agentProfileId !== mapping.profileId || r.config.policyDigest !== profile.policyDigest || r.config.capabilityDigest !== profile.capabilityDigest)
            throw refused('session-binding-changed');
        if (r.state !== 'recovery-required' || r.activeRunId !== null)
            throw refused('hub-session-not-recovering');
        const own = (await readAllRecovery(cursor => this.connection!.request(`/hub/v2/machines/${e.machineId}/recovery?after=${cursor}`))).runs.filter(run => run.sessionId === sessionId);
        // A run of the session still open in Hub, or uncertain local work of its checkout besides this very command, keeps it fenced.
        if (own.some(run => !TERMINAL_RUN_STATES.has(run.state)))
            throw refused('hub-run-open');
        const unresolved = ledger.unresolved();
        if (unresolved.length >= 1000 || unresolved.some(row => row.checkout === mapping.checkoutId && row.id !== commandId))
            throw refused('uncertain-local-work');
        const lost = own.flatMap(run => {
            const resolution = run.state === 'lost' && run.checkoutId === mapping.checkoutId ? ledger.lostResolution(e.hubId, run.runId, run.commandDigest) : null;
            return resolution !== null && resolution.daemon !== this.daemonId && run.version === resolution.expectedRunVersion + 1 ? [{ run, daemonId: resolution.daemon }] : [];
        });
        if (lost.length === 0)
            throw refused('lost-resolution-missing');
        const crashedDaemon = new Map(lost.map(({ run, daemonId }) => [run.runId, daemonId]));
        // The last takeover refusal, so a host that comes up fenced names which piece of lease evidence was missing.
        let leaseRefusal: string | undefined;
        const reclaimLease = (holder: SessionLeaseOwner, run: { runId: string }): boolean => {
            const daemonId = crashedDaemon.get(run.runId), daemon = daemonId === undefined ? null : ledger.daemonRecord(daemonId), bound = ledger.nativeLease(holder.token);
            const presence = daemon === null || bound === null || bound.daemonId !== daemon.daemonId || bound.sessionId !== sessionId || holder.pid !== daemon.pid || holder.host !== hostname() ? undefined : this.ownedPresence(daemon, mapping.checkoutId);
            leaseRefusal = daemon === null ? 'daemon-unrecorded' : bound === null || bound.daemonId !== daemon.daemonId || bound.sessionId !== sessionId ? 'native-lease-unbound' : presence === undefined ? 'holder-mismatch' : presence === 'absent' ? undefined : `owned-process-${presence}`;
            return presence === 'absent';
        };
        const baseline = captureBaseline(mapping.cwd, { requireClean: false });
        if (baseline.digest !== r.workspaceBaseline)
            throw new MachineError('workspace-conflict');
        const lease = acquireCheckoutLease(mapping.cwd, { hubId: e.hubId, runId: sessionId, daemonId: this.daemonId });
        try {
            const workspace = createOwnedWorkspace(mapping.cwd, () => lease.assertOwnership(), baseline);
            return await this.materializeRecord(r, mapping, profile, workspace, lease, undefined, () => !this.stopped, { crashRecovery: { lostRuns: lost.map(({ run }) => ({ runId: run.runId, turnId: run.turnId })), reclaimLease } });
        }
        catch (cause) {
            // A host that came up keeps its leases, fenced like any recovery-required session; one that never came up releases the checkout.
            if (!this.hosted.has(sessionId))
                lease.release(lease.nonce);
            throw cause instanceof MachineError && cause.code === 'recovery-required' && cause.detail === undefined ? refused(leaseRefusal === undefined ? 'host-not-resumable' : `lease-${leaseRefusal}`, cause) : cause;
        }
    }
    /**
     * The target of a `/sessions resume` this daemon does not host comes back only through rehostAfterLost and its guards (operator
     * step, Hub's lost resolution of exactly that run, baseline match, lease evidence). A target that stays unhosted refuses the command
     * before it starts, so nothing is applied and Hub settles the source session at once instead of after an attempted application.
     */
    private async rehostResumeTarget(receipt: Control['SessionOperationReceipt'], commandId: string): Promise<void> {
        const target = receipt.session;
        const mapping = target ? this.options.enrollment.mappings.find(m => m.projectId === target.projectId && m.checkoutId === target.checkoutId && m.profileId === target.agentProfileId) : undefined;
        const profile = mapping && this.profiles.get(mapping.checkoutId);
        if (!target || target.sessionId !== receipt.sessionId || !mapping || !profile)
            throw new MachineError('recovery-required', { detail: 'rehost-target-unmapped' });
        await this.rehostAfterLost(receipt.sessionId, mapping, profile, commandId);
    }
    private lifecycleContext(input: SessionLifecycleInput) {
        const context = this.lifecycleAuthority.get(input.operationId);
        if (!context || !context.application.valid() || context.command.authorizedBy !== input.actorId || context.command.target.sessionId !== input.source.sessionId || context.command.target.expectedSessionVersion !== input.source.version || input.payloadDigest !== canonicalDigest(context.command.body) || canonicalDigest(input.command) !== canonicalDigest(context.command.body))
            throw new MachineError('authorization-not-applied');
        return context;
    }
    private async listLifecycle(input: SessionLifecycleInput) {
        try {
            this.lifecycleContext(input);
            const action = { session: input.source, operationId: input.operationId, actorId: input.actorId, command: input.command, toolName: 'sessions', signal: AbortSignal.timeout(5000) };
            if (!await this.inspectionAuthority.get(input.operationId)?.inspection(action))
                throw new MachineError('scope-denied');
            const snapshot = await readAllRecovery(cursor => this.connection!.request(`/hub/v2/machines/${this.options.enrollment.machineId}/recovery?after=${cursor}`));
            return { ok: true as const, value: snapshot.sessions.filter(record => record.projectId === input.source.projectId && record.machineId === input.source.machineId).slice(0, 100) };
        }
        catch (cause) {
            const error = machineFailure(cause);
            return { ok: false as const, error: { code: error.code, message: error.code } };
        }
    }
    private async openLifecycle(input: SessionLifecycleInput) {
        try {
            this.lifecycleContext(input);
            const args = input.command.arguments;
            if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.sessionId !== 'string' || typeof args.expectedSessionVersion !== 'number')
                throw new MachineError('invalid-arguments');
            const action = { session: input.source, operationId: input.operationId, actorId: input.actorId, command: input.command, toolName: 'sessions.open', signal: AbortSignal.timeout(5000) };
            if (!await this.inspectionAuthority.get(input.operationId)?.inspection(action))
                throw new MachineError('scope-denied');
            const target = validateControl('SessionRecord', await this.connection!.request(`/hub/v2/projects/${input.source.projectId}/sessions/${encodeURIComponent(args.sessionId)}`));
            if (!target.ok || target.value.version !== args.expectedSessionVersion || target.value.machineId !== input.source.machineId || !this.options.enrollment.mappings.some(mapping => mapping.projectId === target.value.projectId && mapping.checkoutId === target.value.checkoutId))
                throw new MachineError('stale-reference');
            return { ok: true as const, value: target.value };
        }
        catch (cause) {
            const error = machineFailure(cause);
            return { ok: false as const, error: { code: error.code, message: error.code } };
        }
    }
    private async applyLifecycle(input: SessionLifecycleInput) {
        try {
            const context = this.lifecycleContext(input), receipt = context.receipt;
            if (!receipt || receipt.operationId !== input.operationId || !receipt.session)
                throw new MachineError('invalid-frame');
            const expectedKind = input.command.commandName === 'sessions.fork' ? 'fork-session' : input.command.commandName === 'sessions.resume' ? 'resume-session' : 'create-session';
            if (receipt.kind !== expectedKind)
                throw new MachineError('invalid-frame');
            const target = validateControl('SessionRecord', await this.connection!.request(`/hub/v2/projects/${input.source.projectId}/sessions/${receipt.sessionId}`));
            if (!target.ok)
                throw new MachineError('invalid-frame');
            const record = target.value;
            const mapping = this.options.enrollment.mappings.find(item => item.projectId === record.projectId && item.checkoutId === record.checkoutId && item.profileId === record.agentProfileId), profile = mapping && this.profiles.get(mapping.checkoutId), source = this.hosted.get(input.source.sessionId);
            if (!mapping || !profile || !source || record.machineId !== input.source.machineId || record.projectId !== input.source.projectId || record.config.policyDigest !== profile.policyDigest || record.config.capabilityDigest !== profile.capabilityDigest)
                throw new MachineError('scope-denied');
            if (expectedKind === 'resume-session') {
                const hosted = this.hosted.get(record.sessionId), args = input.command.arguments;
                if (!hosted || !args || typeof args !== 'object' || Array.isArray(args))
                    throw new MachineError('recovery-required');
                const request = validateControl('SessionResume', Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'sessionId')));
                if (!request.ok || !verifyBaseline(mapping.cwd, hosted.workspace.baseline()))
                    throw new MachineError('workspace-conflict');
                if (hosted.leaseReleased) {
                    if (source !== hosted && source.mapping.cwd === mapping.cwd && !source.leaseReleased) {
                        const closed = await input.releaseSource();
                        if (closed.state !== 'closed')
                            throw new MachineError('recovery-required');
                        source.lease.release(source.lease.nonce);
                        source.leaseReleased = true;
                    }
                    this.lifecycleContext(input);
                    hosted.lease.reacquire();
                    hosted.leaseReleased = false;
                }
                this.lifecycleContext(input);
                let actual: Control['SessionRecord'];
                if (source === hosted)
                    actual = await input.resumeSource();
                else {
                    const result = await hosted.host.apply({ kind: 'resume-session', operationId: input.operationId, payloadDigest: input.payloadDigest, actorId: input.actorId, request: request.value, expiresAt: context.application.grant.expiresAt });
                    if (result.status !== 'applied')
                        throw new MachineError('recovery-required');
                    actual = await hosted.host.inspect();
                }
                return { ok: true as const, value: { ...receipt, status: 'applied' as const, observedSessionVersion: actual.version, session: actual } };
            }
            if (record.state !== 'opening' || record.sessionId === input.source.sessionId)
                throw new MachineError('stale-reference');
            source.lease.assertOwnership();
            const verified = await source.workspace.verify(input.source.workspaceBaseline);
            if (!verified.ok)
                throw new MachineError('workspace-conflict');
            let nativeSessionId: string | undefined;
            let initialHistory: NativeForkHistorySeed | undefined;
            const same = mapping.cwd === source.mapping.cwd;
            if (expectedKind === 'fork-session') {
                captureBaseline(mapping.cwd, { requireClean: true });
                const args = input.command.arguments;
                if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.throughHistoryCursor !== 'number' || typeof args.expectedHistoryVersion !== 'number' || typeof args.title !== 'string')
                    throw new MachineError('invalid-arguments');
                const fork = await input.forkNative({ throughHistoryCursor: args.throughHistoryCursor, expectedHistoryVersion: args.expectedHistoryVersion, targetCwd: mapping.cwd, title: args.title });
                nativeSessionId = fork.nativeSessionId;
                initialHistory = fork.historySeed;
            }
            const baseline = same ? source.workspace.baseline() : captureBaseline(mapping.cwd, { requireClean: true });
            if (same) {
                const closed = await input.releaseSource();
                if (closed.state !== 'closed')
                    throw new MachineError('recovery-required');
                this.lifecycleContext(input);
                source.lease.release(source.lease.nonce);
                source.leaseReleased = true;
            }
            this.lifecycleContext(input);
            const lease = acquireCheckoutLease(mapping.cwd, { hubId: this.options.enrollment.hubId, runId: record.sessionId, daemonId: this.daemonId });
            const workspace = createOwnedWorkspace(mapping.cwd, () => lease.assertOwnership(), baseline);
            const hosted = await this.materializeRecord(record, mapping, profile, workspace, lease, nativeSessionId, () => context.application.valid(), { ...(initialHistory ? { initialHistory } : {}), initialRestriction: { ...input.readonlyRestriction, configVersion: record.config.configVersion, effectiveFromTurnOrdinal: 1 } });
            const actual = await hosted.host.inspect();
            return { ok: true as const, value: { ...receipt, status: 'applied' as const, observedSessionVersion: actual.version, session: actual } };
        }
        catch (cause) {
            const error = machineFailure(cause);
            return { ok: false as const, error: { code: error.code, message: error.code } };
        }
    }
    private async materializeRecord(r: Control['SessionRecord'], mapping: CheckoutMapping, profile: MachineProfile, workspace: OwnedWorkspace, lease: Hosted['lease'], nativeSessionId?: string, guard: () => boolean = () => false, initial: Pick<SessionHostOptions, 'initialHistory' | 'initialRestriction' | 'crashRecovery'> = {}): Promise<Hosted> {
        if (!guard())
            throw new MachineError('authorization-not-applied');
        const runtime = await profile.createRuntime(r.sessionId);
        if (!runtime.ok)
            throw runtime.error;
        // Every owned process spawn is durable before it may exist, so a serve crash leaves identity to judge, never only a PID.
        runtime.value.observeOwnedProcesses(event => this.ownedProcess(event, mapping.checkoutId, r.sessionId));
        if (!guard())
            throw new MachineError('authorization-not-applied');
        const host = await createSessionHost({ cwd: mapping.cwd, dataDir: process.env.KERYX_DATA_DIR !== undefined && process.env.KERYX_DATA_DIR.length > 0 ? process.env.KERYX_DATA_DIR : this.options.configDir, controlDir: machineStateDir(this.options.configDir, this.options.enrollment.hubId), configDir: this.options.configDir, record: r, runtime: runtime.value, ...(this.options.decisionTtlMs === undefined ? {} : { decisionTtlMs: this.options.decisionTtlMs }),
            inspectionMode: 'hub-remote', ...initial, ...(nativeSessionId ? { nativeSessionId } : {}), lifecycle: { apply: input => this.applyLifecycle(input), list: input => this.listLifecycle(input), open: input => this.openLifecycle(input) },
            // The lease token binds the native session to this daemon before anything runs on it: the only evidence a later crash recovery takes it over on.
            onNativeLease: nativeLease => this.ledger!.recordNativeLease({ token: nativeLease.token, daemonId: this.daemonId, sessionId: r.sessionId }),
            projectContext: { source: 'hub-canonical', listFlows: () => readScopedHubFlows({ hubUrl: this.options.enrollment.hubUrl, secret: readMachineSecret(this.options.enrollment), projectId: mapping.projectId }), readFlow: flowId => readScopedHubFlows({ hubUrl: this.options.enrollment.hubUrl, secret: readMachineSecret(this.options.enrollment), projectId: mapping.projectId, flowId }), readContext: documentId => this.context?.read(mapping.projectId, documentId) ?? Promise.reject(new MachineError('context-setup-required')) },
            authorizeSelection: action => { try {
                lease.assertOwnership();
            }
            catch {
                return Promise.resolve({status:'stale-subject' as const});
            } return this.connection?.connected ? this.selectionAuthority.get(action.operationId)?.check(action) ?? Promise.resolve({status:'unknown' as const}) : Promise.resolve({status:'temporarily-unavailable' as const}); },
            authorizeQueued: async (operationId, digest, authority) => {
                const allowed = this.queuedAuthority.get(operationId);
                if (!allowed || allowed.digest !== digest || !allowed.application.valid())
                    return false;
                const grant = allowed.application.grant;
                return grant.commandId === authority.commandId && grant.commandDigest === authority.commandDigest && grant.authorizedBy === authority.actorId && grant.target.sessionId === r.sessionId && grant.target.expectedSessionVersion === authority.expectedSessionVersion && canonicalDigest(grant.controller) === canonicalDigest(authority.controller) && Date.parse(authority.expiresAt) > Date.now() && (grant.target.scope !== 'run' || (grant.target.runId === authority.runId && grant.target.turnId === authority.turnId));
            },
            authorizeController: async (receipt, authority) => { const allowed = this.controllerAuthority.get(r.sessionId); return allowed !== undefined && allowed.application.valid() && allowed.application.grant.commandId === authority.commandId && allowed.application.grant.commandDigest === authority.commandDigest && allowed.application.grant.authorizedBy === authority.actorId && allowed.receiptDigest === canonicalDigest(receipt); },
            authorizeInspection: action => {
                try {
                    lease.assertOwnership();
                }
                catch {
                    return Promise.resolve(false);
                }
                if (!this.connection?.connected)
                    return Promise.resolve(false);
                return this.inspectionAuthority.get(action.operationId)?.inspection(action) ?? Promise.resolve(false);
            },
            authorizeOwnedControl: action => {
                try {
                    lease.assertOwnership();
                }
                catch {
                    return Promise.resolve(false);
                }
                if (!this.connection?.connected)
                    return Promise.resolve(false);
                return this.inspectionAuthority.get(action.operationId)?.owned(action) ?? Promise.resolve(false);
            },
            authorizeAction: action => { try {
                lease.assertOwnership();
            }
            catch {
                return Promise.resolve(false);
            } return this.connection?.connected ? readSessionActionAuthority({ hubUrl: this.options.enrollment.hubUrl, secret: readMachineSecret(this.options.enrollment), action }) : Promise.resolve(false); },
            workspace: { ...workspace, rewind: {
                ownership: () => { lease.assertOwnership(); const baseline = workspace.baseline(); const head = currentCheckoutHead(mapping.cwd); if (head !== baseline.head) throw new MachineError('workspace-conflict'); return { nonce: lease.nonce, gitHead: head, paths: Object.keys(baseline.files) }; },
                validatePaths: async (paths, signal) => { signal.throwIfAborted(); lease.assertOwnership(); if (currentCheckoutHead(mapping.cwd) !== workspace.baseline().head) throw new MachineError('workspace-conflict'); validateOwnedEffectPaths(mapping.cwd, paths); signal.throwIfAborted(); },
            } } });
        const hosted = { host, mapping, profile, workspace, lease };
        this.hosted.set(r.sessionId, hosted);
        host.subscribe(0, event => { try {
            this.persistSession(event);
        }
        catch (cause) {
            host.setConnected(false);
            this.notice(cause);
        } });
        host.subscribeTurnOutcome(observation => this.turnObservation(hosted, observation));
        host.subscribeApprovalOutcome(outcome => { try {
            const run = this.runs.get(outcome.runId);
            if (!run)
                throw new MachineError('recovery-required');
            this.runEvent(outcome.runId, { kind: 'approval-outcome', approvalId: outcome.approvalId, decision: outcome.decision, application: outcome.application });
            // Every outcome is a durably resolved waiter and the native turn resumes, also after an expiry or a denial that no human answer caused.
            if (run.nativeIdentity && !run.terminal && !run.cancelling)
                this.runEvent(outcome.runId, { kind: 'state', state: 'running', reasonCode: 'none', nativeIdentity: run.nativeIdentity });
        }
        catch (cause) {
            host.setConnected(false);
            this.notice(cause);
        } });
        host.subscribeApprovals(question => { try {
            const run = this.runs.get(question.runId);
            if (!run)
                throw new MachineError('recovery-required');
            this.runEvent(question.runId, { kind: 'approval-request', approvalId: question.approvalId, actionFingerprint: question.fingerprint, policyDigest: question.policyDigest, expiresAt: question.expiresAt, summary: redactSensitiveText(question.summary), localRequired: false });
            this.runEvent(question.runId, { kind: 'state', state: 'waiting-approval', reasonCode: 'none', ...(run.nativeIdentity ? { nativeIdentity: run.nativeIdentity } : {}) });
        }
        catch (cause) {
            host.setConnected(false);
            this.notice(cause);
        } });
        const actual = await host.inspect();
        // A re-hosted lost crash comes back recovery-required without the lost run, waiting for its explicit resume; anything else starts idle.
        const ready = initial.crashRecovery === undefined ? actual.state === 'idle' : actual.state === 'recovery-required' && actual.activeRunId === null && host.resumableAfterLost();
        if (!ready || actual.workspaceBaseline !== workspace.baseline().digest)
            throw new MachineError('recovery-required');
        return hosted;
    }
    /** Releases exactly one refused attempt's run capacity: its own refusal plus an actual host with no live work for it. Unknown keeps capacity and nonce; the ledger tombstone and checkout lease stay. */
    private async releaseRefusedAttempt(hosted: Hosted, runId: string, turnId: string, receipt: SessionHostReceipt): Promise<void> {
        const attempt = this.runs.get(runId);
        if (!attempt?.poolNonce || attempt.hosted !== hosted || attempt.nonAdmission || receipt.status === 'admitted')
            return;
        const evidence = { runId, turnId, receipt: { status: receipt.status, runId: 'runId' in receipt ? receipt.runId : null }, session: await hosted.host.inspect(), nativeObserved: attempt.nativeIdentity !== undefined || attempt.terminal !== undefined };
        if (!this.pool!.releaseNonadmitted(this.options.enrollment.hubId, runId, attempt.poolNonce, evidence))
            return;
        delete attempt.poolNonce;
        // Hub run convention (queue-retry): an attempt that reached starting ends failed, otherwise rejected.
        attempt.terminalSeq = this.runEvent(runId, attempt.started ? { kind: 'state', state: 'failed', reasonCode: 'native-failure' } : { kind: 'state', state: 'rejected', reasonCode: 'none' });
        this.runs.delete(runId);
    }
    private runEvent(runId: string, body: object): number {
        const run = this.runs.get(runId);
        if (!run)
            throw new MachineError('recovery-required');
        const c = run.command, stream = `run:${runId}`;
        const payload = (localSeq: number, fields: object) => ({ runId, sessionId: c.sessionId, turnId: c.turnId, projectId: c.projectId, checkoutId: c.checkoutId, localSeq, observedAt: new Date().toISOString(), ...fields });
        if ('kind' in body && body.kind === 'log' && 'text' in body && typeof body.text === 'string') {
            const logged = this.ledger!.appendRunLog(stream, (seq: number) => payload(seq, body), this.options.runLogByteLimit);
            if (logged.retained)
                this.flushOutbox();
            return logged.seq;
        }
        else
            this.ledger!.flushDiscardedLogs(stream, (seq, fromSeq, toSeq) => payload(seq, { kind: 'log-gap', fromSeq, toSeq }));
        const seq = this.ledger!.appendEvent(stream, (localSeq: number) => payload(localSeq, body));
        this.flushOutbox();
        return seq;
    }
    private turnObservation(hosted: Hosted, observation: NativeTurnObservation): void {
        try {
            const run = this.runs.get(observation.runId);
            if (!run || run.hosted !== hosted)
                throw new MachineError('recovery-required');
            if (observation.kind === 'admission-refused') {
                if (run.nativeIdentity || run.terminal || run.command.turnId !== observation.turnId || !observation.selectionSettled || observation.codingAdmitted || !this.selectionAuthority.has(observation.operationId)) throw new MachineError('recovery-required');
                run.nonAdmission = observation;
                if (run.poolNonce) { this.pool!.release(this.options.enrollment.hubId, observation.runId, run.poolNonce); delete run.poolNonce; }
                run.terminalSeq = this.runEvent(observation.runId, {kind:'state',state:'failed',reasonCode:'native-failure'});
            }
            else if (observation.kind === 'running') {
                if (!run.started) {
                    this.runEvent(observation.runId, { kind: 'state', state: 'received', reasonCode: 'none' });
                    this.runEvent(observation.runId, { kind: 'state', state: 'starting', reasonCode: 'none' });
                    run.started = true;
                }
                run.nativeIdentity = { sessionId: observation.sessionId, turnId: observation.turnId, daemonId: this.daemonId, supervisorHandleId: canonicalDigest(observation.executor) };
                this.runEvent(observation.runId, { kind: 'state', state: 'running', reasonCode: 'none', nativeIdentity: run.nativeIdentity });
            }
            else if (observation.kind === 'progress') {
                const text = Buffer.from(Array.from(redactSensitiveText(observation.text)).filter(char => { const code = char.charCodeAt(0); return code >= 32 && code !== 127 || code === 9 || code === 10 || code === 13; }).join('')).subarray(0, 8192).toString('utf8');
                this.runEvent(observation.runId, { kind: 'log', stream: observation.toolName ? 'tool-summary' : 'assistant', text });
            }
            else if (observation.kind === 'usage') {
                const usage = Object.fromEntries(Object.entries(observation.usage).filter(([key,value])=>['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens'].includes(key)&&typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER));
                const metadata = Object.fromEntries(['candidateId','providerId','modelId','actualProviderId','actualModelId'].flatMap(key => {
                    const value = observation[key as 'candidateId'|'providerId'|'modelId'|'actualProviderId'|'actualModelId'];
                    return typeof value === 'string' && Buffer.byteLength(value) <= 256 && redactSensitiveText(value) === value && !hasControlCharacter(value) ? [[key,value]] : [];
                }));
                this.runEvent(observation.runId,{kind:'log',stream:'tool-summary',text:JSON.stringify({kind:'usage',source:observation.source??'native-runtime',...metadata,usage,...(typeof observation.usage.exact==='boolean'?{exact:observation.usage.exact}:{})})});
            }
            else if (observation.kind === 'terminal') {
                // A run stopped by its own interrupt control was cancelled without a Hub cancel: Hub accepts cancelled only after cancelling.
                if (observation.outcome === 'cancelled' && !run.cancelling && !run.terminal) {
                    run.cancelling = true;
                    this.runEvent(observation.runId, { kind: 'state', state: 'cancelling', reasonCode: 'none', ...(run.nativeIdentity ? { nativeIdentity: run.nativeIdentity } : {}) });
                }
                run.terminal = observation;
                const drifted = observation.outcome === 'failed' && observation.reason === 'flow-association-stale';
                if (drifted)
                    this.runEvent(observation.runId, { kind: 'log', stream: 'diagnostic', text: 'Run stopped before its next action: its pinned Flow changed during execution. The original pins and any partial result stay; start a new turn with the current Flow.' });
                if (observation.outcome !== 'unknown' && run.poolNonce) {
                    this.pool!.release(this.options.enrollment.hubId, observation.runId, run.poolNonce);
                    delete run.poolNonce;
                }
                let changes: ReturnType<OwnedWorkspace['resultChanges']> | undefined;
                if (observation.outcome !== 'unknown') {
                    try {
                        changes = hosted.workspace.resultChanges();
                    }
                    catch (cause) {
                        // A result the machine refuses to upload (secret screening, quota, unsafe path) stays local; the run still ends truthfully and says why.
                        this.runEvent(observation.runId, { kind: 'log', stream: 'diagnostic', text: `Result not uploaded: ${machineFailure(cause).code}. The changes stay only in the local checkout.` });
                        this.notice(cause);
                    }
                }
                if (observation.outcome !== 'unknown' && changes !== undefined) {
                    const checks: Control['ResultUpload']['checks'] = observation.checks.flatMap(check => { if (check.exitCode === undefined || check.endedAt === undefined || !('output' in check) || typeof check.output !== 'string')
                        return []; return [{ checkId: check.taskId, command: redactSensitiveText(check.command), exitCode: check.exitCode, output: redactSensitiveText(check.output).slice(0, 1048576) }]; });
                    this.ledger!.stageResultDraft(observation.runId, { sessionId: observation.sessionId, turnId: observation.turnId, association: run.command.association, gitBaseSha: hosted.workspace.baseline().head, workspaceBaseline: observation.workspaceBaseline, outcome: observation.outcome, partial: observation.partial, changes, checks });
                }
                run.terminalSeq = this.runEvent(observation.runId, { kind: 'state', state: observation.outcome, reasonCode: observation.outcome === 'unknown' ? 'recovery-required' : drifted ? 'stale-reference' : observation.outcome === 'failed' ? 'native-failure' : 'none', ...(run.nativeIdentity ? { nativeIdentity: run.nativeIdentity } : {}) });
                // A run-end boundary, before the session reports idle: Hub sees a checkout the run dirtied before any next admission.
                this.refreshInventory();
            }
        }
        catch (cause) {
            hosted.host.setConnected(false);
            this.notice(cause);
        }
    }
    private async publishResult(runId: string): Promise<void> {
        const pending = this.ledger!.pendingResults().find(p => p.runId === runId);
        if (!pending)
            return;
        const run = this.runs.get(runId);
        if (!run || !run.terminal || run.terminal.outcome === 'unknown')
            return;
        let after = 0;
        let remote: Control['RecoveryPage']['runs'][number] | undefined;
        do {
            const response = validateControl('RecoveryPage', await this.connection!.request(`/hub/v2/machines/${this.options.enrollment.machineId}/recovery?after=${after}`));
            if (!response.ok)
                throw new MachineError('recovery-required');
            remote = response.value.runs.find(r => r.runId === runId);
            if (remote || !response.value.hasMore)
                break;
            if (response.value.cursor <= after)
                throw new MachineError('replay-gap');
            after = response.value.cursor;
        } while (after <= 100000);
        if (!remote || remote.sessionId !== pending.draft.sessionId || remote.turnId !== pending.draft.turnId || remote.state !== pending.draft.outcome || canonicalDigest(remote.association) !== canonicalDigest(pending.draft.association))
            throw new MachineError('stale-reference');
        const upload = this.ledger!.sealResultVersion(runId, remote.version);
        const result = validateControl('ResultReceipt', await this.connection!.request(`/hub/v2/projects/${remote.projectId}/runs/${runId}/result`, upload));
        if (!result.ok)
            throw new MachineError('invalid-result');
        const receipt = result.value;
        if (receipt.sessionId !== upload.sessionId || receipt.turnId !== upload.turnId || receipt.runId !== runId || (upload.association.mode === 'ad-hoc' ? (receipt.checksKind !== 'RunChecks' || receipt.flowId !== null || receipt.evidenceId !== null) : (receipt.checksKind !== 'FlowEvidence' || receipt.flowId !== upload.association.flowId || receipt.evidenceId === null)))
            throw new MachineError('invalid-result');
        this.ledger!.completeResult(runId, receipt);
        this.runEvent(runId, { kind: 'result-ready', revisionId: receipt.revisionId, partial: receipt.partial });
    }
    /** Protected local owner channel only, never a Hub frame or route. Its authority is the owner-only Unix socket, not a machine or Hub credential. */
    async localOwnerControl(request: LocalOwnerRequest): Promise<LocalOwnerResult> {
        if (request.hubId !== this.options.enrollment.hubId)
            return ownerRefusal('scope-denied');
        if (this.stopped || !this.ledger)
            return ownerRefusal('local-control-unavailable');
        const task = (request.operation === 'inspect' ? this.ownerInspection(request.sessionId)
            : request.operation === 'release-expired-idle' ? this.releaseExpiredIdle(request.requestId, request.target)
            : request.operation === 'confirm-run-absence' ? this.confirmRunAbsence(request.requestId, request.target)
            : this.releaseResolvedRun(request.requestId, request.target)).catch(cause => ownerRefusal(machineFailure(cause, 'local-control-failed').code));
        this.ownerTasks.add(task);
        try {
            return await task;
        }
        finally {
            this.ownerTasks.delete(task);
        }
    }
    /** Evidence only: actual host, checkout and ledger state. It never attaches, retries, unlocks or replays anything. */
    private async ownerInspection(sessionId?: string): Promise<LocalOwnerResult> {
        const e = this.options.enrollment, ledger = this.ledger!;
        const value: Extract<LocalOwnerValue, { kind: 'inspection' }> = { kind: 'inspection', hubId: e.hubId, machineId: e.machineId, ledgerId: ledger.ledgerId, daemonId: this.daemonId, sessions: [], unresolved: [], recoveryClaims: [], uncertainRuns: [], truncated: false };
        // The reply is bounded; whatever does not fit is reported as truncated, never silently dropped.
        let bytes = Buffer.byteLength(JSON.stringify(value));
        const fits = (item: unknown, count: number, limit: number): boolean => { const size = Buffer.byteLength(JSON.stringify(item)) + 1; if (count >= limit || bytes + size > 60000) {
            value.truncated = true;
            return false;
        } bytes += size; return true; };
        for (const [id, hosted] of this.hosted) {
            if (sessionId !== undefined && id !== sessionId)
                continue;
            let checkoutOwned = hosted.leaseReleased !== true;
            try {
                if (checkoutOwned)
                    hosted.lease.assertOwnership();
            }
            catch {
                checkoutOwned = false;
            }
            const entry = { session: await hosted.host.inspect(), nativeSessionId: hosted.host.nativeSessionId(), checkoutOwned };
            if (!fits(entry, value.sessions.length, 100))
                break;
            value.sessions.push(entry);
        }
        const unresolved = ledger.unresolved(), claims = ledger.localRecoveryClaims();
        if (unresolved.length >= 1000 || claims.length >= 1000)
            value.truncated = true;
        for (const row of unresolved) {
            const item = { commandId: row.id, runId: row.run, checkoutId: row.checkout, phase: row.phase === 'received' ? 'received' as const : 'unknown' as const };
            if (!fits(item, value.unresolved.length, 1000))
                break;
            value.unresolved.push(item);
        }
        for (const claim of claims.filter(item => sessionId === undefined || item.sessionId === sessionId)) {
            if (!fits(claim, value.recoveryClaims.length, 1000))
                break;
            value.recoveryClaims.push(claim);
        }
        // Run capacity still reserved by another daemon of this installation: the runs a crash (or an unproven stop) left uncertain.
        for (const reservation of this.pool!.reservations(e.hubId).filter(row => row.daemonId !== this.daemonId)) {
            if (!fits(reservation, value.uncertainRuns.length, 1000))
                break;
            value.uncertainRuns.push(reservation);
        }
        return { ok: true, value };
    }
    /** Records a spawn intent before the process may exist (a throw refuses the spawn), then its identity, or drops an intent that created nothing. */
    private ownedProcess(event: NativeOwnedProcessEvent, checkoutId: string, sessionId: string): void {
        const ledger = this.ledger;
        if (!ledger || this.stopped)
            throw new MachineError('machine-stopping');
        if (event.phase === 'intent') {
            ledger.beginOwnedProcess({ id: event.intentId, daemonId: this.daemonId, checkoutId, sessionId });
            return;
        }
        try {
            if (event.phase === 'failed')
                ledger.abandonOwnedProcess(event.intentId);
            else {
                const pid = event.pid ?? 0, identity = readProcessIdentity(pid);
                // An unreadable start time is recorded empty: that record then stays uncertain while its PID or group exists.
                ledger.recordOwnedProcess(event.intentId, identity ?? { pid, pgid: pid, startedAt: '' });
            }
        }
        catch (cause) {
            // The intent row stays, so the process is uncertain rather than unrecorded.
            this.notice(cause);
        }
    }
    private retireExpiredLogs(): void { try {
        this.ledger?.retireExpiredLogs();
    }
    catch (cause) {
        this.notice(cause);
    } }
    /** All of Hub's recovery pages, plus the exact run. Hub state alone never proves anything about the local process. */
    private async remoteRun(runId: string): Promise<{ run: RemoteRun | undefined; runs: RemoteRun[] }> {
        const snapshot = await readAllRecovery(cursor => this.connection!.request(`/hub/v2/machines/${this.options.enrollment.machineId}/recovery?after=${cursor}`));
        return { run: snapshot.runs.find(run => run.runId === runId), runs: snapshot.runs };
    }
    /** Identity evidence only: the launching daemon and every process it recorded for the checkout, each judged by PID plus start time and group. */
    private ownedPresence(daemon: DaemonRecord, checkoutId: string): ProcessPresence {
        const records = this.ledger!.ownedProcesses(daemon.daemonId, checkoutId);
        // A spawn whose identity was never recorded is exactly the uncertainty that stays fenced.
        if (records.some(record => record.phase !== 'recorded' || record.pid === null || record.pgid === null))
            return 'uncertain';
        const states = [processPresence(daemon), ...records.map(record => processPresence({ pid: record.pid!, pgid: record.pgid!, startedAt: record.startedAt ?? '' }))];
        return states.includes('live') ? 'live' : states.includes('uncertain') ? 'uncertain' : 'absent';
    }
    /** The local facts a crash-uncertain run must have: a Hub run that is not terminal, held by no live run of this daemon, and a launch tombstone naming another daemon whose identity was recorded. */
    private crashEvidence(remote: RemoteRun | undefined): { ok: false; code: string } | { ok: true; remote: RemoteRun; launch: { id: string; daemon: string }; daemon: DaemonRecord; mapping: CheckoutMapping } {
        const e = this.options.enrollment;
        if (!remote)
            return { ok: false, code: 'stale-reference' };
        if (this.runs.has(remote.runId))
            return { ok: false, code: 'session-busy' };
        const launch = this.ledger!.launchCommand(e.hubId, remote.runId, remote.commandDigest);
        const mapping = e.mappings.find(m => m.projectId === remote.projectId && m.checkoutId === remote.checkoutId);
        if (!launch || launch.checkout !== remote.checkoutId || !mapping)
            return { ok: false, code: 'stale-reference' };
        // A launch without a recorded owning daemon, or one this live daemon made, has no crash identity to judge.
        const daemon = launch.daemon === null || launch.daemon === this.daemonId ? null : this.ledger!.daemonRecord(launch.daemon);
        if (!daemon)
            return { ok: false, code: 'recovery-required' };
        return { ok: true, remote, launch: { id: launch.id, daemon: daemon.daemonId }, daemon, mapping };
    }
    /**
     * A run whose start marker another daemon of this installation recorded, held by no run of this daemon: nothing here can prove
     * its ownership. A claim that never reached its start marker stays redeliverable and is not one of these.
     */
    private inheritedLaunch(remote: RemoteRun): boolean {
        if (this.runs.has(remote.runId))
            return false;
        const launch = this.ledger!.launchCommand(this.options.enrollment.hubId, remote.runId, remote.commandDigest);
        return launch !== null && launch.daemon !== this.daemonId && (launch.phase === 'unknown' || launch.phase === 'applied');
    }
    /** Hub resolve-run needs the run unknown. The recovering daemon re-states only the native identity this ledger already published; it never invents one. */
    private async publishUnknown(remote: RemoteRun): Promise<void> {
        const stream = `run:${remote.runId}`, ledger = this.ledger!, published = ledger.publishedNativeIdentity(stream);
        const identity = published !== null && typeof published === 'object' && ['sessionId', 'turnId', 'daemonId', 'supervisorHandleId'].every(key => typeof (published as Record<string, unknown>)[key] === 'string') ? published as Control['ReconciliationReport']['nativeIdentity'] : undefined;
        const payload = (localSeq: number, fields: object) => ({ runId: remote.runId, sessionId: remote.sessionId, turnId: remote.turnId, projectId: remote.projectId, checkoutId: remote.checkoutId, localSeq, observedAt: new Date().toISOString(), ...fields });
        ledger.flushDiscardedLogs(stream, (seq, fromSeq, toSeq) => payload(seq, { kind: 'log-gap', fromSeq, toSeq }));
        ledger.appendEvent(stream, (localSeq: number) => payload(localSeq, { kind: 'state', state: 'unknown', reasonCode: 'recovery-required', ...(identity ? { nativeIdentity: identity } : {}) }));
        this.flushOutbox();
        for (const deadline = performance.now() + 5000; ledger.pendingEvents(stream).length > 0;) {
            if (performance.now() >= deadline || !this.connection?.connected)
                throw new MachineError('replay-gap');
            await Bun.sleep(10);
        }
    }
    /**
     * Crash-uncertain run, step 1 of 2. Observation only: proves the launching daemon and every process it recorded for
     * the checkout are gone (PID plus start time and process group, never a PID or a lock's age), shows the run unknown in
     * Hub and submits a confirmed-stopped report. It releases nothing; a human then resolves the run in Hub.
     */
    private async confirmRunAbsence(requestId: string, target: { runId: string }): Promise<LocalOwnerResult> {
        const e = this.options.enrollment, ledger = this.ledger!, digest = canonicalDigest({ hubId: e.hubId, operation: 'confirm-run-absence', target });
        const claim = ledger.claimRunRecovery(requestId, digest, target.runId, 'confirm-run-absence');
        if (claim.status === 'replay')
            return validLocalOwnerResult(claim.result) ? claim.result : ownerRefusal('recovery-required');
        // Each refusal is recorded complete and replays exactly; a transient failure (offline, Hub error) leaves the claim to resume with the same id.
        const settle = (result: LocalOwnerResult): LocalOwnerResult => { ledger.finishRunRecovery(requestId, digest, result); return result; };
        if (!this.connection?.connected)
            throw new MachineError('machine-offline');
        const first = await this.remoteRun(target.runId);
        if (first.run && TERMINAL_RUN_STATES.has(first.run.state))
            return settle(ownerRefusal('stale-reference'));
        const evidence = this.crashEvidence(first.run);
        if (!evidence.ok)
            return settle(ownerRefusal(evidence.code));
        const presence = () => this.ownedPresence(evidence.daemon, evidence.remote.checkoutId);
        const before = presence();
        if (before !== 'absent')
            return settle(ownerRefusal(before === 'live' ? 'owned-process-live' : 'recovery-required'));
        let remote = evidence.remote;
        if (remote.state !== 'unknown') {
            await this.publishUnknown(remote);
            const refreshed = (await this.remoteRun(target.runId)).run;
            if (!refreshed || refreshed.state !== 'unknown' || refreshed.commandDigest !== remote.commandDigest)
                return settle(ownerRefusal('recovery-required'));
            remote = refreshed;
        }
        // A fresh observation right before the report: the process may not reappear in between unnoticed.
        const now = presence();
        if (now !== 'absent')
            return settle(ownerRefusal(now === 'live' ? 'owned-process-live' : 'recovery-required'));
        const report: Control['ReconciliationReport'] = { runId: remote.runId, sessionId: remote.sessionId, turnId: remote.turnId, projectId: remote.projectId, checkoutId: remote.checkoutId, ledgerId: ledger.ledgerId, daemonId: this.daemonId, commandDigest: remote.commandDigest, expectedRunVersion: remote.version, observation: 'confirmed-stopped', observedAt: new Date().toISOString() };
        const receipt = await this.connection.request(`/hub/v2/machines/${e.machineId}/reconciliations`, report, `reconcile:${canonicalDigest(report)}`);
        if (!verifyReconciliationReceipt(receipt, report, e.machineId, Date.now()))
            throw new MachineError('invalid-reconciliation');
        ledger.recordReconciliation(report, receipt);
        return settle({ ok: true, value: { kind: 'run-absence-confirmed', runId: remote.runId, sessionId: remote.sessionId, reconciliationId: receipt.reconciliationId, expectedRunVersion: receipt.expectedRunVersion, receivedAt: receipt.receivedAt } });
    }
    /**
     * Crash-uncertain run, step 2 of 2. Only after Hub shows the exact human resolution of this local confirmed-stopped
     * receipt (`lost`, one version later): keeps the launch tombstone marked lost, then releases the crashed daemon's exact
     * pool reservation and checkout lease. Each release is exact-owner and idempotent, so an interrupted claim resumes.
     */
    private async releaseResolvedRun(requestId: string, target: { runId: string; reconciliationId: string }): Promise<LocalOwnerResult> {
        const e = this.options.enrollment, ledger = this.ledger!, digest = canonicalDigest({ hubId: e.hubId, operation: 'release-resolved-run', target });
        const claim = ledger.claimRunRecovery(requestId, digest, target.runId, 'release-resolved-run');
        if (claim.status === 'replay')
            return validLocalOwnerResult(claim.result) ? claim.result : ownerRefusal('recovery-required');
        const settle = (result: LocalOwnerResult): LocalOwnerResult => { ledger.finishRunRecovery(requestId, digest, result); return result; };
        if (!this.connection?.connected)
            throw new MachineError('machine-offline');
        const local = ledger.reconciliation(target.reconciliationId);
        if (!local || local.receipt.runId !== target.runId || local.receipt.observation !== 'confirmed-stopped' || local.receipt.machineId !== e.machineId || local.receipt.ledgerId !== ledger.ledgerId || local.report.commandDigest === undefined)
            return settle(ownerRefusal('stale-reference'));
        const { run: remote, runs } = await this.remoteRun(target.runId);
        if (!remote || remote.commandDigest !== local.report.commandDigest || remote.sessionId !== local.receipt.sessionId || remote.checkoutId !== local.receipt.checkoutId)
            return settle(ownerRefusal('stale-reference'));
        // Only the exact human resolution of this very receipt unfences: lost, exactly one version after the receipt.
        if (remote.state !== 'lost' || remote.version !== local.receipt.expectedRunVersion + 1)
            return settle(ownerRefusal('recovery-required'));
        const launch = ledger.launchCommand(e.hubId, remote.runId, remote.commandDigest);
        const mapping = e.mappings.find(m => m.projectId === remote.projectId && m.checkoutId === remote.checkoutId);
        if (!launch || launch.daemon === null || launch.daemon === this.daemonId || !mapping)
            return settle(ownerRefusal('stale-reference'));
        // The checkout lease is per session: another uncertain run of the same session keeps it fenced.
        if (runs.some(run => run.runId !== remote.runId && run.sessionId === remote.sessionId && !TERMINAL_RUN_STATES.has(run.state)))
            return settle(ownerRefusal('recovery-required'));
        ledger.resolveLostRun(e.hubId, launch.id, remote.runId, target.reconciliationId);
        const capacityReleased = this.pool!.releaseRecovered(e.hubId, remote.runId, launch.daemon);
        const checkoutLeaseReleased = releaseRecoveredCheckoutLease(mapping.cwd, { hubId: e.hubId, runId: remote.sessionId, daemonId: launch.daemon }) === 'released';
        return settle({ ok: true, value: { kind: 'released-resolved-run', runId: remote.runId, sessionId: remote.sessionId, reconciliationId: target.reconciliationId, capacityReleased, checkoutLeaseReleased } });
    }
    /** Durable request identity before any effect. A claim interrupted once the host began its stop stays unknown and is never re-executed. */
    private async releaseExpiredIdle(requestId: string, target: LocalRecoveryTarget): Promise<LocalOwnerResult> {
        const ledger = this.ledger!, digest = canonicalDigest({ hubId: this.options.enrollment.hubId, operation: 'release-expired-idle', target });
        const claim = ledger.claimLocalRecovery(requestId, digest, target.sessionId);
        if (claim.status === 'replay')
            return validLocalOwnerResult(claim.result) ? claim.result : ownerRefusal('recovery-required');
        if (claim.status === 'unknown')
            return ownerRefusal('recovery-required');
        // Refusals before the host call change nothing, so they are recorded complete and replay exactly.
        const settle = (result: LocalOwnerResult, confirmed: boolean): LocalOwnerResult => { try {
            ledger.finishLocalRecovery(requestId, digest, result, confirmed);
            return result;
        }
        catch (cause) {
            this.notice(cause);
            return ownerRefusal('recovery-required');
        } };
        const hosted = this.hosted.get(target.sessionId);
        if (!hosted || this.stopped)
            return settle(ownerRefusal('stale-reference'), true);
        const runs = [...this.runs.values()].filter(run => run.hosted === hosted);
        if (runs.some(run => !run.terminal && !run.nonAdmission))
            return settle(ownerRefusal('session-busy'), true);
        // A full unresolved page may hide this checkout's row, so it counts as uncertain work too.
        const unresolved = ledger.unresolved();
        if (runs.some(run => run.terminal?.outcome === 'unknown') || unresolved.length >= 1000 || unresolved.some(row => row.checkout === hosted.mapping.checkoutId))
            return settle(ownerRefusal('recovery-required'), true);
        try {
            if (hosted.leaseReleased)
                throw new MachineError('lease-owner-mismatch');
            hosted.lease.assertOwnership();
        }
        catch (cause) {
            return settle(ownerRefusal(machineFailure(cause, 'lease-owner-mismatch').code), true);
        }
        let result: Awaited<ReturnType<SessionHostPort['recoverExpiredIdle']>>;
        try {
            result = await hosted.host.recoverExpiredIdle(target);
        }
        catch (cause) {
            this.notice(cause);
            return settle(ownerRefusal('recovery-required'), false);
        }
        // `recovery-required` means the host attempted its stop without proof: the claim stays unknown.
        if (!result.ok)
            return settle(ownerRefusal(result.error.code), result.error.code !== 'recovery-required');
        return settle({ ok: true, value: { kind: 'released-expired-idle', ...result.value } }, true);
    }
    async stop(): Promise<void> { if (this.stopped)
        return; this.stopped = true; this.ready = false; if (this.reconnectTimer)
        clearTimeout(this.reconnectTimer); if (this.outboxTimer)
        clearTimeout(this.outboxTimer); if (this.retentionTimer)
        clearInterval(this.retentionTimer); if (this.inventoryTimer)
        clearInterval(this.inventoryTimer); this.connection?.close(); if (this.pumpTask)
        await Promise.allSettled([this.pumpTask]); await Promise.allSettled([...this.ownerTasks]); let provenStop = true; for (const hosted of this.hosted.values()) {
        hosted.host.setConnected(false);
        await hosted.host.dispose('machine-stop');
        const state = await hosted.host.inspect();
        // A re-hosted lost crash that was never resumed ran nothing, and its dispose proved the stop: it fences nothing, so the next daemon re-hosts it.
        if (!hosted.leaseReleased && (state.state === 'idle' || state.state === 'closed' || hosted.host.resumableAfterLost()))
            hosted.lease.release(hosted.lease.nonce);
        else if (!hosted.leaseReleased)
            provenStop = false;
    } this.hosted.clear(); await Promise.allSettled([...this.background]); this.forgetCleanDaemon(provenStop); this.ledger?.close(); this.pool?.close(); this.lock?.release(); this.lock = undefined; }
    /** A daemon whose every owned stop was proven and that keeps no run capacity or uncertain command leaves no identity to recover. */
    private forgetCleanDaemon(provenStop: boolean): void {
        const ledger = this.ledger, pool = this.pool;
        if (!ledger || !pool || !provenStop || [...this.runs.values()].some(run => run.terminal ? run.terminal.outcome === 'unknown' : !run.nonAdmission))
            return;
        try {
            if (pool.reservations(this.options.enrollment.hubId).some(row => row.daemonId === this.daemonId) || ledger.unresolved().length >= 1000 || ledger.unresolved().some(row => row.daemon === this.daemonId))
                return;
            ledger.forgetDaemon(this.daemonId);
        }
        catch (cause) {
            this.notice(cause);
        }
    }
}
