import type { SessionSelectionAuthorityResult } from "../../session/host-types";
import { randomUUID } from 'node:crypto';
import { canonicalDigest, criteriaDigest, LIMITS, MACHINE_SUBPROTOCOL, parseClosedJson, parseMachineFrame, validateControl, type Control, type MachineFrame, type MachineToHubFrame } from '../../remote-control/protocol';
import { MachineError, machineFailure, type MachineResult } from './errors';
import { trustedHubUrl } from './config';
export async function enrollMachine(hubUrl: string, request: Control['EnrollmentRequest']): Promise<{
    machineId: string;
    secret: string;
}> {
    const checked = validateControl('EnrollmentRequest', request);
    if (!checked.ok)
        throw new MachineError('invalid-enrollment');
    const response = await fetch(`${trustedHubUrl(hubUrl)}/hub/v2/machines/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(checked.value), redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
        await response.body?.cancel();
        throw new MachineError('enrollment-rejected');
    }
    const text = await readBoundedResponse(response, LIMITS.frameBytes);
    const parsed = parseClosedJson(text);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object')
        throw new MachineError('invalid-enrollment');
    const v = parsed.value as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'machineId,secret' || typeof v.machineId !== 'string' || typeof v.secret !== 'string' || !/^[-_A-Za-z0-9]{43,256}$/.test(v.secret))
        throw new MachineError('invalid-enrollment');
    return { machineId: v.machineId, secret: v.secret };
}
export function verifyAuthorizationGrant(value: unknown, expected: Control['AuthorizeCommand'] & {
    commandId: string;
    authorizedBy: string;
}, now: number, elapsed: number): boolean {
    const checked = validateControl('AuthorizationGrant', value);
    if (!checked.ok)
        return false;
    const g = checked.value;
    const issued = Date.parse(g.authorizedAt), expires = Date.parse(g.expiresAt);
    return elapsed >= 0 && elapsed < LIMITS.grantMs && issued <= now && expires > now && expires - issued <= LIMITS.grantMs && g.commandId === expected.commandId && g.authorizedBy === expected.authorizedBy && g.commandDigest === expected.commandDigest && g.policyDigest === expected.policyDigest && g.actionFingerprint === expected.actionFingerprint && canonicalDigest(g.target) === canonicalDigest(expected.target) && canonicalDigest(g.controller) === canonicalDigest(expected.controller);
}
// lib.dom masks Bun's documented constructor options in this project.
const NativeWebSocket = WebSocket as unknown as {
    new (url: URL, options: Bun.WebSocketOptions): WebSocket;
};
export interface MachineConnectionOptions {
    hubUrl: string;
    machineId: string;
    secret: string;
    ledgerId: string;
    daemonId: string;
    agentVersion: string;
    lastHubSequence?: number;
    runCursors?: Array<{
        runId: string;
        lastLocalSeq: number;
    }>;
    sessionCursors?: Array<{
        sessionId: string;
        lastSessionEventSeq: number;
    }>;
    onFrame: (frame: MachineFrame) => void | Promise<void>;
    onDisconnect?: () => void;
}
/** Outbound connection only. Application callbacks must persist before acknowledging. */
export class MachineConnection {
    private socket: WebSocket | null = null;
    private epoch = 0;
    private timer: ReturnType<typeof setInterval> | undefined;
    private lastAck = 0;
    private generation = 0;
    private transportAbort = new AbortController();
    private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    private handshakeReject: ((cause: Error) => void) | undefined;
    constructor(private readonly options: MachineConnectionOptions) { trustedHubUrl(options.hubUrl); }
    get connected(): boolean { return this.epoch > 0 && this.socket?.readyState === WebSocket.OPEN; }
    async connect(): Promise<void> {
        if (this.socket)
            throw new MachineError('already-connected');
        this.transportAbort = new AbortController();
        const generation = ++this.generation;
        const u = new URL('/hub/v2/machines/socket', trustedHubUrl(this.options.hubUrl));
        u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new NativeWebSocket(u, { protocols: [MACHINE_SUBPROTOCOL], headers: { Authorization: `Bearer ${this.options.secret}` } });
        this.socket = ws;
        return new Promise((resolve, reject) => {
            this.handshakeReject = reject;
            const timeout = setTimeout(() => { this.close(); reject(new MachineError('machine-handshake-timeout')); }, 10000);
            this.handshakeTimer = timeout;
            const fail = () => {
                clearTimeout(timeout);
                if (generation !== this.generation)
                    return;
                this.handshakeReject = undefined;
                this.transportAbort.abort();
                this.epoch = 0;
                this.socket = null;
                if (this.timer)
                    clearInterval(this.timer);
                this.options.onDisconnect?.();
                reject(new MachineError('machine-disconnected'));
            };
            ws.onopen = () => ws.send(JSON.stringify({ v: 2, type: 'hello', messageId: randomUUID(), epoch: 0, payload: { machineId: this.options.machineId, ledgerId: this.options.ledgerId, daemonId: this.options.daemonId, agentVersion: this.options.agentVersion, capabilities: [], lastHubSequence: this.options.lastHubSequence ?? 0, runCursors: this.options.runCursors ?? [], sessionCursors: this.options.sessionCursors ?? [] } }));
            let chain = Promise.resolve();
            ws.onmessage = event => {
                chain = chain.then(async () => {
                    if (generation !== this.generation)
                        return;
                    const parsed = parseMachineFrame(typeof event.data === 'string' ? event.data : new Uint8Array(), 'hub-to-machine');
                    if (!parsed.ok) {
                        ws.close(1008, 'invalid-frame');
                        return;
                    }
                    const f = parsed.value;
                    if (this.epoch === 0) {
                        if (f.type !== 'welcome' || f.payload.machineId !== this.options.machineId) {
                            ws.close(1008, 'invalid-welcome');
                            return;
                        }
                        this.epoch = f.epoch;
                        this.lastAck = Date.now();
                        clearTimeout(timeout);
                        this.handshakeReject = undefined;
                        this.timer = setInterval(() => {
                            if (Date.now() - this.lastAck >= LIMITS.heartbeatTimeoutMs) {
                                ws.close(1008, 'heartbeat-timeout');
                                return;
                            }
                            this.sendFrame({ v: 2, type: 'heartbeat', messageId: randomUUID(), epoch: this.epoch, payload: { daemonId: this.options.daemonId } });
                        }, LIMITS.heartbeatMs);
                        resolve();
                        return;
                    }
                    if (f.type === 'welcome' || f.epoch !== this.epoch) {
                        ws.close(1008, 'stale-epoch');
                        return;
                    }
                    if (f.type === 'heartbeat-ack') {
                        this.lastAck = Date.now();
                        return;
                    }
                    await this.options.onFrame(f);
                }).catch(() => ws.close(1011, 'application-failed'));
            };
            ws.onerror = fail;
            ws.onclose = fail;
        });
    }
    sendFrame(frame: MachineToHubFrame): void {
        if (!this.connected || frame.epoch !== this.epoch)
            throw new MachineError('machine-offline');
        const raw = JSON.stringify(frame);
        const checked = parseMachineFrame(raw, 'machine-to-hub');
        if (!checked.ok)
            throw new MachineError(checked.error.code);
        if (this.socket!.bufferedAmount + Buffer.byteLength(raw) > LIMITS.bufferBytes)
            throw new MachineError('quota-exceeded');
        this.socket!.send(raw);
    }
    get currentEpoch(): number { return this.epoch; }
    async request(route: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
        if (idempotencyKey !== undefined && !/^[A-Za-z0-9:._-]{1,200}$/.test(idempotencyKey))
            throw new MachineError('invalid-idempotency-key');
        if (!route.startsWith('/hub/v2/') || route.includes('..') || (route.includes('?') && !/^\/hub\/v2\/machines\/[A-Za-z0-9._:-]+\/recovery\?after=\d+$/.test(route)))
            throw new MachineError('invalid-machine-route');
        const url = `${trustedHubUrl(this.options.hubUrl)}${route}`, payload = body === undefined ? {} : { body: JSON.stringify(body) };
        let response: Response;
        try {
            response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.options.secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey ?? randomUUID() }, ...payload, signal: AbortSignal.any([AbortSignal.timeout(30000), this.transportAbort.signal]), redirect: 'error' });
        }
        catch (cause) {
            // Fetch rejects with a TypeError only for a network error: the Hub refused, reset or dropped the connection, as when it
            // stops mid-request. That is a typed transport failure, never the generic state failure; an abort keeps its own class.
            if (cause instanceof TypeError)
                throw new MachineError('machine-request-failed', { cause });
            throw cause;
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new MachineError(`machine-http-${response.status}`);
        }
        const parsed = parseClosedJson(await readBoundedResponse(response, LIMITS.eventPageBytes), LIMITS.eventPageBytes);
        if (!parsed.ok)
            throw new MachineError(parsed.error.code);
        return parsed.value;
    }
    async authorize(commandId: string, request: Control['AuthorizeCommand'], authorizedBy: string): Promise<Control['AuthorizationGrant']> {
        if (!this.connected)
            throw new MachineError('machine-offline');
        const generation = this.generation, epoch = this.epoch, started = performance.now();
        const result = await this.request(`/hub/v2/machines/${encodeURIComponent(this.options.machineId)}/commands/${encodeURIComponent(commandId)}/authorize`, request);
        if (!this.connected || generation !== this.generation || epoch !== this.epoch || !verifyAuthorizationGrant(result, { ...request, commandId, authorizedBy }, Date.now(), performance.now() - started))
            throw new MachineError('authorization-not-applied');
        return (validateControl('AuthorizationGrant', result) as {
            ok: true;
            value: Control['AuthorizationGrant'];
        }).value;
    }
    async authorization(commandId: string, request: Control['AuthorizeCommand'], authorizedBy: string): Promise<GrantApplication> {
        const startedAt = performance.now(), generation = this.generation, epoch = this.epoch;
        const grant = await this.authorize(commandId, request, authorizedBy);
        const result = createGrantApplication(grant, { ...request, commandId, authorizedBy }, { startedAt, monotonic: () => performance.now(), wall: Date.now });
        const valid = () => this.connected && generation === this.generation && epoch === this.epoch && result.valid();
        return { grant, valid, async apply(effect) { if (!valid())
                return { ok: false, error: new MachineError('authorization-not-applied') }; return result.apply(effect); } };
    }
    close(): void {
        this.handshakeReject?.(new MachineError('machine-disconnected'));
        this.handshakeReject = undefined;
        if (this.handshakeTimer)
            clearTimeout(this.handshakeTimer);
        this.transportAbort.abort();
        this.generation++;
        this.epoch = 0;
        if (this.timer)
            clearInterval(this.timer);
        this.socket?.close(1000, 'closed');
        this.socket = null;
    }
}
/** Count encoded bytes before retaining any response chunks. */
export async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new MachineError('invalid-response-limit');
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
        await response.body?.cancel();
        throw new MachineError('quota-exceeded');
    }
    const reader = response.body?.getReader();
    if (!reader)
        return '';
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const item = await reader.read();
            if (item.done)
                break;
            bytes += item.value.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel();
                throw new MachineError('quota-exceeded');
            }
            chunks.push(item.value);
        }
        const buffer = new Uint8Array(bytes);
        let at = 0;
        for (const chunk of chunks) {
            buffer.set(chunk, at);
            at += chunk.length;
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    }
    finally {
        reader.releaseLock();
    }
}
export async function enrollMachineResult(hubUrl: string, request: Control['EnrollmentRequest']): Promise<MachineResult<{
    machineId: string;
    secret: string;
}>> { try {
    return { ok: true, value: await enrollMachine(hubUrl, request) };
}
catch (cause) {
    return { ok: false, error: machineFailure(cause, 'enrollment-unavailable') };
} }
export interface GrantApplication {
    grant: Control['AuthorizationGrant'];
    valid(): boolean;
    apply<T>(effect: (grant: Control['AuthorizationGrant']) => T | Promise<T>): Promise<MachineResult<T>>;
}
export function createGrantApplication(grant: Control['AuthorizationGrant'], expected: Control['AuthorizeCommand'] & {
    commandId: string;
    authorizedBy: string;
}, clock: {
    startedAt: number;
    monotonic(): number;
    wall(): number;
}): GrantApplication {
    let consumed = false;
    const valid = () => verifyAuthorizationGrant(grant, expected, clock.wall(), clock.monotonic() - clock.startedAt);
    return { grant, valid, async apply(effect) { if (consumed || !valid())
            return { ok: false, error: new MachineError('authorization-not-applied') }; consumed = true; try {
            return { ok: true, value: await effect(grant) };
        }
        catch (cause) {
            return { ok: false, error: machineFailure(cause, 'application-uncertain') };
        } } };
}
/** Read-only current authority check; never renews an old start or authorizes replay. Hub's explicit stale-association refusal is the one final answer. */
export async function readSessionActionAuthority(options: {
    hubUrl: string;
    secret: string;
    action: import('../../session/host-types').SessionActionAuthority;
}): Promise<import('../../session/host-types').SessionActionAuthorityResult> {
    const { action } = options;
    const expected = action.session;
    const controller = expected.controller;
    if (!controller || controller.state !== 'held' || Date.parse(controller.expiresAt) <= Date.now() || expected.activeRunId !== action.runId || expected.activeTurnId !== action.turnId)
        return false;
    const started = performance.now();
    const timeout = AbortSignal.timeout(5000);
    const signal = action.signal ? AbortSignal.any([action.signal, timeout]) : timeout;
    try {
        while (performance.now() - started < 5000) {
            const response = await fetch(`${trustedHubUrl(options.hubUrl)}/hub/v2/projects/${encodeURIComponent(expected.projectId)}/sessions/${encodeURIComponent(expected.sessionId)}`, { headers: { Authorization: `Bearer ${options.secret}` }, cache: 'no-store', redirect: 'error', signal });
            if (!response.ok) {
                await response.body?.cancel();
                return response.status === 409 && response.headers.get('X-Keryx-Action-Authority') === 'association-stale' && !signal.aborted ? { status: 'stale-subject' } : false;
            }
            const parsed = parseClosedJson(await readBoundedResponse(response, 65536));
            if (!parsed.ok)
                return false;
            const checked = validateControl('SessionRecord', parsed.value);
            if (!checked.ok)
                return false;
            const current = checked.value;
            if (current.sessionId !== expected.sessionId || current.machineId !== expected.machineId || current.projectId !== expected.projectId || current.checkoutId !== expected.checkoutId || current.agentProfileId !== expected.agentProfileId)
                return false;
            if (current.version < expected.version && current.activeRunId === null) {
                await Bun.sleep(10);
                continue;
            }
            return response.headers.get('X-Keryx-Action-Authority') === 'checked-v2' && response.headers.get('Cache-Control')?.toLowerCase().split(',').map(v => v.trim()).includes('no-store') === true
                && performance.now() - started < 5000 && current.version === expected.version && current.activeRunId === action.runId && current.activeTurnId === action.turnId
                && canonicalDigest(current.controller) === canonicalDigest(controller) && current.config.policyDigest === expected.config.policyDigest && current.config.capabilityDigest === expected.config.capabilityDigest
                && Date.parse(controller.expiresAt) > Date.now() && !signal.aborted;
        }
        return false;
    }
    catch {
        return false;
    }
}
/** Scope is bound by local composition; callers cannot provide an endpoint or local path. */
export async function readScopedHubFlows(options: {
    hubUrl: string;
    secret: string;
    projectId: string;
    flowId?: string;
}): Promise<unknown> {
    const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
    if (!id.test(options.projectId) || (options.flowId !== undefined && !id.test(options.flowId)))
        throw new MachineError('invalid-arguments');
    const response = await fetch(`${trustedHubUrl(options.hubUrl)}/hub/v1/projects/${encodeURIComponent(options.projectId)}/flows${options.flowId === undefined ? '' : `/${encodeURIComponent(options.flowId)}`}`, { headers: { Authorization: `Bearer ${options.secret}` }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
        await response.body?.cancel();
        throw new MachineError(response.status === 403 ? 'scope-denied' : 'project-read-failed');
    }
    const parsed = parseClosedJson(await readBoundedResponse(response, 524288), 524288);
    if (!parsed.ok)
        throw new MachineError(parsed.error.code);
    return parsed.value;
}
export function verifyScopedFlowAssociation(value: unknown, projectId: string, association: Extract<Control['FlowAssociation'], {
    mode: 'flow';
}>): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const flow = value as Record<string, unknown>;
    return flow.id === association.flowId && flow.projectId === projectId && flow.version === association.expectedFlowVersion && flow.status === 'in-progress' && flow.specContentDigest === association.specDigest
        && Array.isArray(flow.criteria) && flow.criteria.length <= 1000 && flow.criteria.every(v => typeof v === 'string') && criteriaDigest(flow.criteria) === association.criteriaDigest;
}
/** Fresh current-controller proof for one locally admitted read-only command; never a new launch grant. */
export async function readSessionInspectionAuthority(options: {
    hubUrl: string;
    secret: string;
    action: import('../../session/host-types').SessionInspectionAuthority;
}): Promise<boolean> {
    const { action } = options, expected = action.session, controller = expected.controller;
    if (!controller || controller.state !== 'held' || controller.actorId !== action.actorId || Date.parse(controller.expiresAt) <= Date.now() || action.command.expectedSessionVersion !== expected.version || action.command.expectedConfigVersion !== expected.config.configVersion || action.command.controller.controllerLeaseId !== controller.controllerLeaseId || action.command.controller.expectedControllerVersion !== controller.version)
        return false;
    return readCurrentControllerAuthority(options.hubUrl, options.secret, expected, action.actorId, action.signal);
}
/** Current-role proof is necessary but cannot renew the original work grant. */
export async function readSessionSelectionAuthority(options: {
    hubUrl: string; secret: string; action: import('../../session/host-types').SessionSelectionAuthority;
}): Promise<SessionSelectionAuthorityResult> {
    const proof = await readCurrentControllerAuthorityResult(options.hubUrl, options.secret, options.action.session, options.action.actorId, options.action.signal);
    if (proof.status !== 'valid') return proof;
    const association = options.action.request.association;
    if (association?.mode !== 'flow') return proof;
    try { return { status: verifyScopedFlowAssociation(await readScopedHubFlows({hubUrl:options.hubUrl,secret:options.secret,projectId:options.action.session.projectId,flowId:association.flowId}),options.action.session.projectId,association) ? 'valid' : 'stale-subject' }; }
    catch (cause) { return selectionReadFailure(cause, options.action.signal); }
}
function selectionReadFailure(cause: unknown, signal?: AbortSignal): SessionSelectionAuthorityResult {
    if (signal?.aborted) return {status:'unknown'};
    if (cause instanceof MachineError) {
        if (['machine-http-401','machine-http-403'].includes(cause.code)) return {status:'revoked-or-forbidden'};
        if (['machine-http-404','machine-http-409'].includes(cause.code)) return {status:'stale-subject'};
        if (/^machine-http-(408|429|5[0-9]{2})$/.test(cause.code)) return {status:'temporarily-unavailable'};
    }
    return {status: cause instanceof TypeError || cause instanceof DOMException && ['TimeoutError','AbortError'].includes(cause.name) ? 'temporarily-unavailable' : 'unknown'};
}
async function readCurrentControllerAuthority(hubUrl: string, secret: string, expected: Control['SessionRecord'], actorId: string, actionSignal?: AbortSignal): Promise<boolean> {
    return (await readCurrentControllerAuthorityResult(hubUrl,secret,expected,actorId,actionSignal)).status === 'valid';
}
async function readCurrentControllerAuthorityResult(hubUrl: string, secret: string, expected: Control['SessionRecord'], actorId: string, actionSignal?: AbortSignal): Promise<SessionSelectionAuthorityResult> {
    const controller = expected.controller;
    if (!controller || controller.state !== 'held' || controller.actorId !== actorId || Date.parse(controller.expiresAt) <= Date.now()) return {status:'revoked-or-forbidden'};
    const started = performance.now(), signal = actionSignal ? AbortSignal.any([actionSignal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    try {
        const response = await fetch(`${trustedHubUrl(hubUrl)}/hub/v2/projects/${encodeURIComponent(expected.projectId)}/sessions/${encodeURIComponent(expected.sessionId)}`, { headers: { Authorization: `Bearer ${secret}` }, cache: 'no-store', redirect: 'error', signal });
        if (!response.ok) { await response.body?.cancel(); return selectionReadFailure(new MachineError(`machine-http-${response.status}`), actionSignal); }
        const parsed = parseClosedJson(await readBoundedResponse(response, 65536));
        if (!parsed.ok) return {status:'unknown'};
        const checked = validateControl('SessionRecord', parsed.value);
        if (!checked.ok) return {status:'unknown'};
        const current = checked.value;
        if (response.headers.get('X-Keryx-Action-Authority') !== 'checked-v2' || response.headers.get('Cache-Control')?.toLowerCase().split(',').map(v => v.trim()).includes('no-store') !== true) return {status:'unknown'};
        if (performance.now() - started >= 5000 || signal.aborted) return {status:'temporarily-unavailable'};
        if (Date.parse(controller.expiresAt) <= Date.now()) return {status:'revoked-or-forbidden'};
        return {status: current.sessionId === expected.sessionId && current.projectId === expected.projectId && current.machineId === expected.machineId && current.checkoutId === expected.checkoutId && current.agentProfileId === expected.agentProfileId
            && current.version === expected.version && current.state === expected.state && current.activeRunId === expected.activeRunId && current.activeTurnId === expected.activeTurnId
            && canonicalDigest(current.controller) === canonicalDigest(controller) && canonicalDigest(current.config) === canonicalDigest(expected.config) ? 'valid' : 'stale-subject'};
    } catch (cause) { return selectionReadFailure(cause, actionSignal); }
}
