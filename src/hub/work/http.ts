import { MAX_COMMAND_BYTES, pageLimit } from './limits';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { observeGitSubject, assertGitSubjectAcceptable, parseGitRepositoryConfig, type GitRepositoryConfig } from './git-observer';
import type { WorkObservationJob } from './storage';
import type { GitObservation } from './git-observer';
import { validateWorkCommand } from './validation';
import { commitGitObservation } from './observation';
import { createWorkExecution } from './execution';
import { createLegacyConversion } from './legacy';
import type { Principal } from '../contracts';
import { authorizeAgentRequest } from '../agent-credentials';
import { fail, HubFailure, object, sha256 } from '../domain';
import type { HubStore } from '../store';
import { allowedWorkCommands, workCommand, workDigest, workRead } from './domain';
import type { Attempt, ResultSubject, WorkReceipt, WorkRecord, WorkState } from './model';
export const workLimits = {
    maxCommandBytes: MAX_COMMAND_BYTES, defaultPageSize: 50, maxPageSize: 200, maxEventPageSize: 1000, maxEventBytes: 1024 * 1024, maxSnapshotBytes: 20 * 1024 * 1024, maxSnapshotCacheBytes: 64 * 1024 * 1024, maxSnapshots: 32, maxSnapshotsPerPrincipal: 4, maxSnapshotBytesPerPrincipal: 32 * 1024 * 1024, snapshotTtlMs: 5 * 60 * 1000, maxObservations: 8, maxObservationsPerPrincipal: 2
} as const;
type Identity = {
    actor: Principal;
    cookie: boolean;
};
export type WorkRepositoryConfig = GitRepositoryConfig;
export function validateWorkRepositories(input: unknown): WorkRepositoryConfig[] {
    if (!Array.isArray(input) || input.length > 128)
        throw new TypeError('Invalid work repository registry');
    const seen = new Set<string>();
    return input.map(value => {
        const config = parseGitRepositoryConfig(value), key = JSON.stringify([config.projectId, config.id]);
        if (seen.has(key))
            throw new TypeError('Duplicate work repository');
        seen.add(key);
        return config;
    });
}
type Dependencies = {
    repositories?: WorkRepositoryConfig[];
    protectedValues?: (request: Request) => string[];
    observerFetch?: (request: Request) => Promise<Response>;
    store: HubStore;
    enabled: boolean;
    authenticate: (request: Request) => Promise<Identity>;
    checkOrigin: (request: Request) => void;
    serialized: <T>(operation: () => Promise<T>) => Promise<T>;
    now: () => number;
};
type Snapshot = {
    scope: string;
    actorId: string;
    records: WorkRecord[];
    eventCursor: number;
    expiresAt: number;
    bytes: number;
};
function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function bodyJson(request: Request): Promise<unknown> {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
        fail(400, 'json-required', 'Expected application/json');
    if (Number(request.headers.get('content-length') ?? 0) > workLimits.maxCommandBytes)
        fail(413, 'quota-exceeded', 'Work command exceeds quota');
    if (!request.body)
        fail(400, 'invalid-json', 'JSON body required');
    const reader = request.body.getReader(), parts: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > workLimits.maxCommandBytes) {
                await reader.cancel();
                fail(413, 'quota-exceeded', 'Work command exceeds quota');
            }
            parts.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    try {
        return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
    }
    catch {
        fail(400, 'invalid-json', 'Invalid JSON body');
    }
}
function resultEntities(value: unknown): WorkRecord[] {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && 'kind' in value) return [value as WorkRecord];
    if (!value || typeof value !== 'object') return [];
    return Object.values(value).flatMap(item => Array.isArray(item) ? item : [item]).filter((item): item is WorkRecord => !!item && typeof item === 'object' && 'kind' in item);
}
function resultEnvelope(receipt: WorkReceipt, eventCursor: string) {
    const value = receipt.result;
    if (value && typeof value === 'object' && 'observation' in value)
        return { ...value, eventCursor };
    const entities = resultEntities(value);
    const preview = typeof value === 'object' && value !== null && 'status' in value && value.status === 'eligible' ? value : undefined;
    return {
        operationId: receipt.operationId, entities, eventCursor, receiptId: receipt.receiptId, ...(preview ? { preview } : {})
    };
}
/** HTTP only: current identity is re-evaluated inside the serialized command turn. */
export function createWorkHttp(deps: Dependencies) {
    const execution = createWorkExecution(deps.store);
    const snapshots = new Map<string, Snapshot>(), secret = deps.store.work.cursorSecret();
    let snapshotBytes = 0;
    const inFlightObservations = new Map<string, Promise<Response>>();
    const verifySubjectForAcceptance = (projectId: string, subject: ResultSubject) => assertGitSubjectAcceptable(projectId, subject, deps.store.work.gitObservations(projectId, subject.id), deps.repositories ?? [], deps.now());
    const scope = (actor: Principal, projectId: string) => workDigest({ actor, projectId });
    const sign = (body: string) => createHmac('sha256', secret).update(body).digest('base64url');
    const cursor = (value: unknown) => {
        const body = Buffer.from(JSON.stringify(value)).toString('base64url');
        return body + '.' + sign(body);
    };
    const eventCursor = (actor: Principal, projectId: string, sequence: number) => cursor({ type: 'events', scope: workDigest({ actorId: actor.id, projectId }), sequence });
    const decode = (token: string): unknown => {
        if (token.length > 2048)
            fail(410, 'resync-required', 'Cursor is invalid; start a new snapshot');
        const [body, sig, ...extra] = token.split('.');
        if (!body || !sig || extra.length || !/^[A-Za-z0-9_-]{43}$/.test(sig) || sig.length !== sign(body).length || !timingSafeEqual(Buffer.from(sig), Buffer.from(sign(body))))
            fail(410, 'resync-required', 'Cursor is invalid; start a new snapshot');
        try {
            return JSON.parse(Buffer.from(body, 'base64url').toString()) as unknown;
        }
        catch {
            fail(410, 'resync-required', 'Cursor is invalid; start a new snapshot');
        }
    };
    function authorize(actor: Principal, projectId: string, method: string) {
        authorizeAgentRequest(actor, ['projects', projectId], method);
        if (actor.projectIds && !actor.projectIds.includes(projectId))
            fail(403, 'project-scope-denied', 'Project access denied');
        if (!deps.store.project(projectId))
            fail(404, 'not-found', 'Project not found');
        if (method !== 'GET' && actor.readOnly)
            fail(403, 'read-only', 'Read-only principal');
    }
    function cleanup() {
        for (const [key, snapshot] of snapshots)
            if (snapshot.expiresAt <= deps.now()) {
                snapshotBytes -= snapshot.bytes;
                snapshots.delete(key);
            }
    }
    function snapshot(state: WorkState, actor: Principal, projectId: string, url: URL) {
        cleanup();
        const limit = pageLimit(url), currentScope = scope(actor, projectId), token = url.searchParams.get('cursor');
        let id: string, index = 0, exported: Snapshot;
        if (token) {
            const parsed = object(decode(token));
            if (typeof parsed.id !== 'string' || !Number.isSafeInteger(parsed.index) || Number(parsed.index) < 0)
                fail(410, 'resync-required', 'Invalid snapshot cursor');
            id = parsed.id;
            index = Number(parsed.index);
            const existing = snapshots.get(id);
            if (!existing || existing.scope !== currentScope)
                fail(410, 'resync-required', 'Snapshot expired; start a new snapshot');
            exported = existing;
        }
        else {
            const records = state.records;
            const bytes = Buffer.byteLength(JSON.stringify(records));
            if(bytes>workLimits.maxSnapshotBytes)fail(413,'quota-exceeded','Snapshot export exceeds quota; use scoped views');
            // A complete response has no continuation state to retain.
            if(records.length<=limit)return {records,nextCursor:null,eventCursor:eventCursor(actor,projectId,state.sequence ?? state.events.at(-1)?.sequence??0)};
            const principalSnapshots = [...snapshots.values()].filter(value => value.actorId === actor.id);
            if (principalSnapshots.length >= workLimits.maxSnapshotsPerPrincipal || principalSnapshots.reduce((total, value) => total + value.bytes, bytes) > workLimits.maxSnapshotBytesPerPrincipal)
                fail(413, 'quota-exceeded', 'Principal snapshot quota exceeded; finish or expire an existing export');
            if (snapshotBytes + bytes > workLimits.maxSnapshotCacheBytes || snapshots.size >= workLimits.maxSnapshots)
                fail(413, 'quota-exceeded', 'Snapshot export exceeds quota; use scoped views');
            id = randomBytes(24).toString('base64url');
            exported = {
                scope: currentScope, actorId: actor.id, records, eventCursor: state.sequence ?? state.events.at(-1)?.sequence ?? 0, expiresAt: deps.now() + workLimits.snapshotTtlMs, bytes
            };
            snapshots.set(id, exported);
            snapshotBytes += bytes;
        }
        const records = exported.records.slice(index, index + limit), nextIndex = index + records.length;
        const nextCursor=nextIndex<exported.records.length?cursor({id,index:nextIndex}):null;
        if(nextCursor===null){snapshots.delete(id);snapshotBytes-=exported.bytes;}
        return { records, nextCursor, eventCursor: eventCursor(actor, projectId, exported.eventCursor) };
    }
    function events(actor: Principal, projectId: string, url: URL) {
        const limit = pageLimit(url, workLimits.maxEventPageSize), token = url.searchParams.get('after'), currentScope = workDigest({ actorId: actor.id, projectId });
        let after = 0;
        if (token) {
            const parsed = object(decode(token));
            if (parsed.scope !== currentScope || parsed.type !== 'events' || !Number.isSafeInteger(parsed.sequence) || Number(parsed.sequence) < 0)
                fail(410, 'resync-required', 'Event cursor scope changed; start a new snapshot');
            after = Number(parsed.sequence);
        }
        const available = deps.store.work.eventsAfter(projectId, after, limit), page: import('./model').WorkEvent[] = [];
        let bytes = 0;
        for (const event of available) {
            const size = Buffer.byteLength(JSON.stringify(event));
            if (page.length >= limit || bytes + size > workLimits.maxEventBytes)
                break;
            bytes += size;
            page.push(event);
        }
        const sequence = page.at(-1)?.sequence ?? after;
        return { events: page, nextCursor: cursor({ type: 'events', scope: currentScope, sequence }) };
    }
    function observationSubject(projectId: string, subjectId: string, subjectDigest?: unknown, versions?: unknown) {
        const state = deps.store.work.recordState(projectId, subjectId), subject = state.records.find((r): r is ResultSubject => r.kind === 'subject' && r.id === subjectId), attempt = subject && state.records.find((r): r is Attempt => r.kind === 'attempt' && r.id === subject.attemptId);
        if (!subject || !attempt)
            fail(404, 'not-found', 'Subject not found');
        if (subjectDigest !== undefined && subject.contentDigest !== subjectDigest)
            fail(409, 'subject-drift', 'Exact immutable subject changed');
        if (versions !== undefined && object(versions)[attempt.id] !== attempt.version)
            fail(409, 'version-conflict', 'Attempt version changed');
        return { state, subject, attempt };
    }
    async function reserveObservation(request: Request, projectId: string, subjectId: string, payload: Record<string, unknown>, versions: Record<string, unknown>, operationId: string, requestDigest: string) {
        return deps.serialized(async () => {
            const current = await deps.authenticate(request);
            authorize(current.actor, projectId, 'POST');
            if (current.cookie || request.headers.has('origin'))
                deps.checkOrigin(request);
            return deps.store.workTransaction(() => {
                const receipt = deps.store.work.operation(projectId, current.actor.id, operationId);
                if (receipt) {
                    if (receipt.requestDigest !== requestDigest)
                        fail(409, 'idempotency-conflict', 'Operation ID already used');
                    return { actor: current.actor, receipt };
                }
                const { subject, attempt } = observationSubject(projectId, subjectId, payload.subjectDigest, versions);
                if (!subject.artifacts.some(a => a.kind === 'git'))
                    fail(400, 'git-subject-required', 'Subject has no Git artifacts');
                const previous = deps.store.work.observationJob(projectId, current.actor.id, operationId);
                if (previous && previous.requestDigest !== requestDigest)
                    fail(409, 'idempotency-conflict', 'Operation ID already used');
                if (!previous && [...inFlightObservations.keys()].filter(value => (JSON.parse(value) as string[])[1] === current.actor.id).length >= workLimits.maxObservationsPerPrincipal) fail(429, 'quota-exceeded', 'Principal concurrent observation quota exceeded');
                if (!previous && inFlightObservations.size >= workLimits.maxObservations) fail(413, 'quota-exceeded', 'Concurrent observation quota exceeded');
                const job: WorkObservationJob = previous ?? {
                    projectId, actorId: current.actor.id, operationId, requestDigest, receiptId: randomUUID(), observationId: randomUUID(), generation: deps.store.work.nextObservationGeneration(projectId, subjectId), subjectId, subjectDigest: subject.contentDigest, attemptId: attempt.id, expectedVersion: attempt.version
                };
                if (!previous)
                    deps.store.work.saveObservationJob(job);
                return { actor: current.actor, subject, job };
            });
        });
    }
    async function commitObservation(request: Request, projectId: string, subjectId: string, job: WorkObservationJob, observation: GitObservation) {
            return deps.serialized(async () => {
                const current = await deps.authenticate(request);
                authorize(current.actor, projectId, 'POST');
                if (current.actor.id !== job.actorId)
                    fail(403, 'identity-changed', 'Current identity changed');
                return deps.store.workTransaction(() => {
                    const { state } = observationSubject(projectId, subjectId, job.subjectDigest, { [job.attemptId]: job.expectedVersion });
                    const replay = deps.store.work.operation(projectId, job.actorId, job.operationId);
                    if (replay) {
                        if (replay.requestDigest !== job.requestDigest)
                            fail(409, 'idempotency-conflict', 'Operation ID already used');
                        return json(resultEnvelope(replay, eventCursor(current.actor, projectId, replay.eventCursor)));
                    }
                    deps.store.work.saveGitObservation(observation);
                    const receipt = commitGitObservation(state, current.actor, observation, job, randomUUID());
                    deps.store.work.save(projectId, state);
                    deps.store.work.deleteObservationJob(projectId, job.actorId, job.operationId);
                    return json(resultEnvelope(receipt, eventCursor(current.actor, projectId, receipt.eventCursor)));
                });
            });
    }
    async function observe(request: Request, projectId: string, subjectId: string, body: Record<string, unknown>): Promise<Response> {
        const payload = object(body.payload), versions = object(body.expectedVersions), operationId = body.operationId;
        if (typeof operationId !== 'string' || !operationId || operationId.length > 200 || Object.keys(body).some(k => !['operationId', 'expectedVersions', 'payload'].includes(k)) || Object.keys(payload).some(k => k !== 'subjectDigest') || typeof payload.subjectDigest !== 'string' || !/^[a-f0-9]{64}$/.test(payload.subjectDigest) || Object.values(versions).some(v => !Number.isSafeInteger(v) || Number(v) < 1))
            fail(400, 'invalid-body', 'Invalid observation request');
        const requestDigest = workDigest({ path: ['subjects', subjectId, 'observe'], body });
        const prepared = await reserveObservation(request, projectId, subjectId, payload, versions, operationId, requestDigest);
        if ('receipt' in prepared && prepared.receipt)
            return json(resultEnvelope(prepared.receipt, eventCursor(prepared.actor, projectId, prepared.receipt.eventCursor)));
        if (!('job' in prepared) || !prepared.job || !prepared.subject)
            fail(503, 'observation-unavailable', 'Observation reservation unavailable');
        const { job, subject } = prepared, key = JSON.stringify([projectId, prepared.actor.id, operationId]);
        const existing = inFlightObservations.get(key);
        if (existing)
            return (await existing).clone();
        if ([...inFlightObservations.keys()].filter(value => (JSON.parse(value) as string[])[1] === prepared.actor.id).length >= workLimits.maxObservationsPerPrincipal)
            fail(429, 'quota-exceeded', 'Principal concurrent observation quota exceeded');
        if (inFlightObservations.size >= workLimits.maxObservations)
            fail(413, 'quota-exceeded', 'Concurrent observation quota exceeded');
        const pending = (async () => {
            const observation = await observeGitSubject(subject, deps.repositories ?? [], {
                id: job.observationId, actorId: job.actorId, generation: job.generation, now: deps.now, ...(deps.observerFetch ? { fetch: deps.observerFetch } : {})
            });
            return commitObservation(request, projectId, subjectId, job, observation);
        })();
        inFlightObservations.set(key, pending);
        try {
            return (await pending).clone();
        }
        catch (error) {
            if (error instanceof HubFailure)
                deps.store.workTransaction(() => deps.store.work.deleteObservationJob(projectId, job.actorId, job.operationId));
            throw error;
        }
        finally {
            inFlightObservations.delete(key);
        }
    }
    function exactDocument(projectId: string, actor: Principal, suffix: string[], url: URL, sequence: number) {
                    const versionText=suffix[3]!,digest=url.searchParams.get('digest');
                    if(!/^[1-9][0-9]{0,15}$/.test(versionText)||!Number.isSafeInteger(Number(versionText))||!digest||url.searchParams.getAll('digest').length!==1||!/^[a-f0-9]{64}$/.test(digest)||[...url.searchParams.keys()].some(key=>key!=='digest'))fail(400,'invalid-document-reference','Exact version and digest are required');
                    const reference={documentId:suffix[1]!,version:Number(versionText),contentDigest:digest};
                    const archived=deps.store.work.documentVersion(projectId,reference);
                    const document=archived;
                    if(!document||document.projectId!==projectId||document.id!==reference.documentId||document.version!==reference.version||document.contentDigest!==digest||Buffer.byteLength(document.content)>1024*1024||sha256(document.content)!==digest)fail(404,'document-version-unavailable','Exact document content is unavailable');
                    const {id,path,kind,version,contentDigest,content}=document;
                    return json({document:{id,projectId,path,kind,version,contentDigest,content},eventCursor:eventCursor(actor,projectId,sequence)});
    }
    function capabilities(actor: Principal, projectId: string) {
        return json({
                    protocolVersion: 1, enabled: deps.enabled, allowedCommands: deps.enabled ? [...allowedWorkCommands(actor), ...(actor.kind === 'human' && !actor.readOnly ? ['legacy.preview', 'legacy.convert'] : []), ...(actor.kind === 'human' && actor.role === 'operator' && !actor.readOnly ? ['execution.bind'] : [])] : [], limits: workLimits, features: { managedExecution: deps.enabled, gitObserver: deps.enabled && !!deps.repositories?.some(r => r.projectId===projectId&&!!r.github), legacyConversion: deps.enabled }
                });
    }
    async function handle(request: Request): Promise<Response | undefined> {
        const url = new URL(request.url);
        if (!url.pathname.startsWith('/hub/work/v1/'))
            return;
        let operationId: string | undefined;
        try {
            let path: string[];
            try {
                path = url.pathname.slice('/hub/work/v1/'.length).split('/').map(decodeURIComponent);
            }
            catch {
                fail(400, 'invalid-path', 'Malformed work path');
            }
            if (path.some(p => !p || p.includes('/') || p.includes('\\')) || path[0] !== 'projects' || !path[1])
                fail(404, 'not-found', 'Unknown work route');
            const projectId = path[1], suffix = path.slice(2), identity = await deps.authenticate(request);
            authorize(identity.actor, projectId, request.method);
            if (suffix.length === 1 && suffix[0] === 'capabilities' && request.method === 'GET')
                return capabilities(identity.actor, projectId);
            if (!deps.enabled)
                fail(404, 'work-disabled', 'Managed work is disabled');
            if (request.method === 'GET') {
                const sequence = deps.store.work.currentSequence(projectId);
                if(suffix.length===4&&suffix[0]==='documents'&&suffix[2]==='versions'){
                    return exactDocument(projectId, identity.actor, suffix, url, sequence);
                }
                if (suffix.length === 1 && suffix[0] === 'snapshot')
                    return json(snapshot(url.searchParams.has('cursor') ? { records: [], events: [], operations: {} } : deps.store.work.snapshotState(projectId, workLimits.maxSnapshotBytes), identity.actor, projectId, url));
                if (suffix.length === 1 && suffix[0] === 'events')
                    return json(events(identity.actor, projectId, url));
                if (suffix.length === 2 && suffix[0] === 'operations') {
                    const receipt = deps.store.work.operation(projectId, identity.actor.id, suffix[1]!);
                    if (!receipt) {
                        const pending = deps.store.work.observationJob(projectId, identity.actor.id, suffix[1]!);
                        if (pending)
                            return json({
                                operationId: pending.operationId, status: 'pending', receiptId: null, result: null, eventCursor: null
                            }, 202);
                        fail(404, 'not-found', 'Operation not found');
                    }
                    return json({
                        operationId: receipt.operationId, status: receipt.status, receiptId: receipt.receiptId, result: resultEnvelope(receipt, eventCursor(identity.actor, projectId, receipt.eventCursor)), eventCursor: eventCursor(identity.actor, projectId, receipt.eventCursor)
                    });
                }
                if (suffix.length === 3 && suffix[0] === 'subjects' && suffix[2] === 'observations') {
                    observationSubject(projectId, suffix[1]!);
                    const all = deps.store.work.gitObservations(projectId, suffix[1]!), limit = pageLimit(url), after = url.searchParams.get('afterId');
                    let offset = 0;
                    if (after) {
                        const parsed = object(decode(after));
                        if (parsed.type !== 'observations' || parsed.scope !== scope(identity.actor, projectId) || parsed.subjectId !== suffix[1] || !Number.isSafeInteger(parsed.offset))
                            fail(410, 'resync-required', 'Observation cursor scope changed');
                        offset = Number(parsed.offset);
                    }
                    return json({ observations: all.slice(offset, offset + limit), nextCursor: offset + limit < all.length ? cursor({
                            type: 'observations', scope: scope(identity.actor, projectId), subjectId: suffix[1], offset: offset + limit
                        }) : null, eventCursor: eventCursor(identity.actor, projectId, sequence) });
                }
                if (suffix.length === 2 && suffix[0] === 'records') {
                    const record = deps.store.work.record(projectId, suffix[1]!);
                    if (!record) fail(404, 'not-found', 'Work record not found');
                    return json({ record, eventCursor: eventCursor(identity.actor, projectId, sequence) });
                }
                if (suffix.length === 1 && suffix[0] === 'attention') {
                    const page = deps.store.work.attentionPage(projectId, url);
                    return json({ ...page, eventCursor: eventCursor(identity.actor, projectId, page.eventCursor) });
                }
                const state = deps.store.work.readState(projectId, suffix, url);
                const projection = object(workRead(state, identity.actor, projectId, suffix, url, { verifySubjectForAcceptance }));
                return json({ ...projection, eventCursor: eventCursor(identity.actor, projectId, Number(projection.eventCursor)) });
            }
            const isObservation = suffix.length === 3 && suffix[0] === 'subjects' && suffix[2] === 'observe';
            if (request.method !== 'POST' || !isObservation && (suffix.length !== 1 || suffix[0] !== 'commands'))
                fail(405, 'method-not-allowed', 'Unsupported work method');
            if (identity.cookie || request.headers.has('origin'))
                deps.checkOrigin(request);
            const body = object(await bodyJson(request));
            const serializedBody = JSON.stringify(body);
            if (deps.protectedValues?.(request).some(value => value && serializedBody.includes(JSON.stringify(value).slice(1, -1))))
                fail(400, 'credential-in-input', 'Work metadata contains protected credential material');
            operationId = typeof body.operationId === 'string' ? body.operationId : undefined;
            const key = request.headers.get('idempotency-key');
            if (!key || key.length > 200 || [...key].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || key !== operationId)
                fail(400, 'idempotency-key-required', 'Idempotency-Key must match the operation ID');
            if (isObservation)
                return await observe(request, projectId, suffix[1]!, body);
            return await deps.serialized(async () => {
                const current = await deps.authenticate(request);
                authorize(current.actor, projectId, request.method);
                if (current.cookie || request.headers.has('origin'))
                    deps.checkOrigin(request);
                if (deps.store.work.observationJob(projectId, current.actor.id, operationId!))
                    fail(409, 'idempotency-conflict', 'Operation ID belongs to a pending observation');
                const receipt = deps.store.workTransaction(() => {
                    const command = validateWorkCommand(body);
                    const state = deps.store.work.commandState(projectId, command, current.actor.id);
                    const legacy = body.command === 'legacy.preview' || body.command === 'legacy.convert' ? deps.store.load() : deps.store.workLegacyContext(projectId, state.records, body.payload);
                    const receipt = workCommand(state, current.actor, projectId, body, {
                        legacy, nextRevisionNumber: (kind, targetId) => deps.store.work.nextRevisionNumber(projectId, kind, targetId), now: () => new Date(deps.now()).toISOString(), resolveRepository: (projectId, repositoryId) => deps.repositories?.find(r => r.projectId === projectId && r.id === repositoryId), ...(execution.verifyExecution ? { verifyExecution: execution.verifyExecution } : {}), ...(execution.inspectExecution ? { inspectExecution: execution.inspectExecution } : {}), ...(execution.hasPendingExecution ? { hasPendingExecution: execution.hasPendingExecution } : {}), verifySubjectForAcceptance, legacyConversion: createLegacyConversion(deps.store, legacy, () => new Date(deps.now()).toISOString()), resolveDocument: (projectId, reference) => {
                            const archived = deps.store.work.documentVersion(projectId, reference);
                            if (archived)
                                return archived;
                            const exact = [...legacy.documents, ...legacy.documentChanges.map(c => c.document)].find(doc => doc.projectId === projectId && doc.id === reference.documentId && doc.version === reference.version && doc.contentDigest === reference.contentDigest);
                            if (exact)
                                deps.store.work.archiveDocument(exact);
                            return exact;
                        }
                    });
                    deps.store.work.save(projectId, state);
                    return receipt;
                });
                return json(resultEnvelope(receipt, eventCursor(current.actor, projectId, receipt.eventCursor)));
            });
        }
        catch (error) {
            if (error instanceof HubFailure)
                return json({ error: { code: error.code, message: error.message, retryable: error.status === 503 }, ...(operationId ? { operationId } : {}) }, error.status);
            throw error;
        }
    }
    return { handle, close() {
            snapshots.clear();
            snapshotBytes = 0;
        } };
}
