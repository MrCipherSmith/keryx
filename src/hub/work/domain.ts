import { randomUUID } from 'node:crypto';
import type { Principal, HubDocument, HubFlow } from '../contracts';
import type { HubState } from '../store';
import { fail, sha256 } from '../domain';
import { validateWorkCommand, validateWorkRecord } from './validation';
import type { WorkState, WorkRecord, WorkReceipt, WorkCommand, WorkFlow, WorkIntent, Attempt, FlowRevision, IntentRevision, ReviewSubmission, FlowSubmission, Decision, Criterion, Coverage, ExecutionLink, ResultSubject, EvidenceRecord } from './model';
export type ExecutionBindingInput = Extract<WorkCommand, {
    command: 'execution.bind';
}>['payload'];
export type VerifiedExecution = {
    originalOperatorId: string;
    projectId: string;
    sessionId: string;
    runId: string;
    turnId: string;
    machineId: string;
    checkoutId: string;
    associationDigest: string;
    contextObservation: 'unverified' | 'observed-match' | 'observed-drift';
    observedContextDigest: string | null;
    executionOutcome: 'active' | 'known-terminal' | 'unknown';
    flowRevisionId: string;
    intentRevisionId: string;
    contextSnapshotId: string;
};
export type WorkContext = {
    legacy: HubState;
    now: () => string;
    nextRevisionNumber?: (kind: 'flow-revision' | 'intent-revision', targetId: string) => number;
    resolveDocument?: (projectId: string, reference: {
        documentId: string;
        version: number;
        contentDigest: string;
    }) => HubDocument | undefined;
    verifyExecution?: (actor: Principal, projectId: string, input: ExecutionBindingInput) => VerifiedExecution;
    hasPendingExecution?: (projectId: string, attemptId: string) => boolean;
    verifySubjectForAcceptance?: (projectId: string, subject: ResultSubject) => void;
    inspectExecution?: (projectId: string, link: ExecutionLink) => {
        executionOutcome: 'active' | 'known-terminal' | 'unknown';
        contextObservation: 'unverified' | 'observed-match' | 'observed-drift';
        observedContextDigest: string | null;
    };
    resolveRepository?: (projectId: string, repositoryId: string) => {
        id: string;
        projectId: string;
        objectFormat: 'sha1' | 'sha256';
    } | undefined;
    legacyConversion?: {
        preview(actor: Principal, projectId: string, payload: Extract<WorkCommand, {
            command: 'legacy.preview';
        }>['payload']): unknown;
        convert(actor: Principal, projectId: string, payload: Extract<WorkCommand, {
            command: 'legacy.convert';
        }>['payload']): {
            flow: HubFlow;
            document: HubDocument;
        };
        converted?(legacyFlowId: string, managedFlowId: string): void;
    };
};
export function createWorkState(): WorkState { return { records: [], events: [], operations: {} }; }
function canonical(value: unknown): string {
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
        return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
    return JSON.stringify(value);
}
export function workDigest(value: unknown): string { return sha256(canonical(value)); }
const humanCommands = new Set(['requirements.approve', 'requirements.amend', 'requirements.resolve-amendment', 'attempt.select', 'review.decide', 'work.cancel', 'legacy.preview', 'legacy.convert']);
export const supportedWorkCommands = ['flow.create', 'flow.start', 'intent.create', 'revision.propose', 'requirements.approve', 'requirements.amend', 'requirements.resolve-amendment', 'context.create', 'attempt.create', 'attempt.start', 'attempt.report', 'subject.create', 'evidence.record', 'attempt.submit', 'attempt.withdraw', 'attempt.select', 'review.decide', 'flow.submit', 'work.cancel'] as const;
export function allowedWorkCommands(actor: Principal): string[] { return actor.readOnly ? [] : supportedWorkCommands.filter(c => !humanCommands.has(c) || (actor.kind === 'human' && (actor.role === 'operator' || actor.role === 'reviewer'))); }
function authorize(actor: Principal, projectId: string, context: WorkContext, write: boolean) {
    if (!context.legacy.projects.some(p => p.id === projectId) || actor.projectIds && !actor.projectIds.includes(projectId))
        fail(404, 'not-found', 'Project not found');
    if (write && actor.readOnly)
        fail(403, 'read-only', 'Read-only principal');
}
/** Work mutations are staged so even direct callers never see partially failed commands. */
export function workCommand(state: WorkState, actor: Principal, projectId: string, input: unknown, context: WorkContext): WorkReceipt {
    authorize(actor, projectId, context, true);
    const command = validateWorkCommand(input);
    if (humanCommands.has(command.command) && (actor.kind !== 'human' || !['operator', 'reviewer'].includes(actor.role)))
        fail(403, 'human-required', 'Authorized human decision required');
    const requestDigest = workDigest(command), key = projectId + ':' + actor.id + ':' + command.operationId, previous = state.operations[key];
    if (previous) {
        if (previous.requestDigest !== requestDigest)
            fail(409, 'idempotency-conflict', 'Operation ID already used with another command');
        return structuredClone(previous);
    }
    const staged = structuredClone(state);
    const result = execute(staged, actor, projectId, command, context);
    const receipt: WorkReceipt = { operationId: command.operationId, status: 'committed', receiptId: randomUUID(), actorId: actor.id, projectId, requestDigest, result: structuredClone(result), eventCursor: staged.sequence ?? staged.events.filter(e => e.projectId === projectId).at(-1)?.sequence ?? 0 };
    staged.operations[key] = receipt;
    if (staged.sequence !== undefined) state.sequence = staged.sequence;
    state.records = staged.records;
    state.events = staged.events;
    state.operations = staged.operations;
    return structuredClone(receipt);
}
/** Append order is durable: proposals introduced after the first Flow approval need membership amendment. */
function introducedAfterFlowApproval(records: WorkRecord[], intent: WorkIntent, flow: WorkFlow): boolean {
    const intentIndex = records.findIndex(r => r.id === intent.id);
    const approvalIndex = records.findIndex(r => r.kind === 'decision' && r.targetType === 'flow-revision' && r.decision === 'approve' && records.some(fr => fr.kind === 'flow-revision' && fr.id === r.targetId && fr.flowId === flow.id));
    return approvalIndex >= 0 && intentIndex > approvalIndex;
}
function execute(state: WorkState, actor: Principal, projectId: string, command: WorkCommand, context: WorkContext): unknown {
    const resolveDocument = (reference: {
        documentId: string;
        version: number;
        contentDigest: string;
    }) => {
        const doc = context.resolveDocument?.(projectId, reference) ?? [...context.legacy.documents, ...context.legacy.documentChanges.map(c => c.document)].find(d => d.projectId === projectId && d.id === reference.documentId && d.version === reference.version && d.contentDigest === reference.contentDigest);
        if (doc && (doc.projectId !== projectId || doc.id !== reference.documentId || doc.version !== reference.version || doc.contentDigest !== reference.contentDigest || sha256(doc.content) !== reference.contentDigest))
            fail(409, 'document-integrity', 'Archived document does not match exact content reference');
        return doc;
    };
    const repository = (id: string, oid: string) => {
        const repo = context.resolveRepository?.(projectId, id);
        if (!repo || repo.id !== id || repo.projectId !== projectId)
            fail(404, 'repository-not-found', 'Repository is not configured for this project');
        if (oid.length !== (repo.objectFormat === 'sha1' ? 40 : 64))
            fail(400, 'object-format-mismatch', 'Object ID does not match configured repository format');
        return repo;
    };
    const now = context.now(), base = () => ({ id: randomUUID(), projectId, createdBy: actor.id, createdAt: now });
    const find = <K extends WorkRecord['kind']>(id: string, kind: K): Extract<WorkRecord, {
        kind: K;
    }> => {
        const r = state.records.find(r => r.id === id && r.projectId === projectId && r.kind === kind);
        if (!r)
            fail(404, 'not-found', 'Work record not found');
        return r as Extract<WorkRecord, {
            kind: K;
        }>;
    };
    const cas = (r: WorkFlow | WorkIntent | Attempt) => {
        if (command.expectedVersions[r.id] !== r.version)
            fail(409, 'version-conflict', 'Expected current entity version');
    };
    const emit = (r: WorkRecord) => {
        const mutable = 'version' in r;
        const entityType = r.kind === 'flow-revision' ? 'flow' : r.kind === 'intent-revision' ? 'intent' : r.kind === 'flow-submission' ? 'submission' : r.kind === 'amendment' ? 'flow' : r.kind;
        const type = entityType === 'flow' ? 'flow-changed' : entityType === 'intent' ? 'intent-changed' : entityType === 'attempt' ? 'attempt-changed' : entityType === 'context' ? 'context-created' : entityType === 'execution-link' ? 'execution-linked' : entityType === 'subject' ? 'subject-created' : entityType === 'evidence' ? 'evidence-recorded' : entityType === 'decision' ? 'decision-recorded' : 'submission-created';
        state.events.push({ protocolVersion: 1, projectId, sequence: (state.sequence = (state.sequence ?? state.events.filter(e => e.projectId === projectId).at(-1)?.sequence ?? 0) + 1), eventId: randomUUID(), operationId: command.operationId, actorId: actor.id, actorKind: actor.kind, occurredAt: now, type, entityType, entityId: r.id, entityVersion: mutable ? r.version : null, contentDigest: 'contentDigest' in r ? r.contentDigest : null, causationId: null });
    };
    const add = <T extends WorkRecord>(r: T): T => { validateWorkRecord(r); state.records.push(r); emit(r); return r; };
    const seal = <T extends object>(r: T) => { const payload = Object.fromEntries(Object.entries(r).filter(([key]) => !['id', 'projectId', 'createdBy', 'createdAt'].includes(key))); return { ...r, contentDigest: workDigest(payload) }; };
    const change = (r: WorkFlow | WorkIntent | Attempt) => { r.version++; r.updatedAt = now; emit(r); };
    const pin = (actual: string, expected: string) => {
        if (actual !== expected)
            fail(409, 'digest-conflict', 'Exact immutable digest mismatch');
    };
    const unique = (ids: string[]) => {
        if (new Set(ids).size !== ids.length)
            fail(400, 'duplicate-reference', 'Duplicate reference');
    };
    const criteria = (cs: Criterion[]) => {
        unique(cs.map(c => c.criterionId));
        if (!cs.length)
            fail(400, 'criteria-required', 'At least one criterion required');
    };
    const open = (r: WorkFlow | WorkIntent) => {
        if (['accepted', 'cancelled'].includes(r.state))
            fail(409, 'terminal-work', 'Work is terminal');
    };
    const pending = (flowId: string, intentId?: string) => {
        if (state.records.some(r => r.projectId === projectId && r.kind === 'amendment' && r.flowId === flowId && (!intentId || r.affectedIntentIds.includes(intentId)) && !state.records.some(d => d.kind === 'decision' && d.targetType === 'amendment' && d.targetId === r.id && ['approve', 'withdraw'].includes(d.decision))))
            fail(409, 'pending-amendment', 'Resolve pending requirements amendment first');
    };
    const refreshExecution = (a: Attempt) => {
        const links = state.records.filter((r): r is ExecutionLink => r.kind === 'execution-link' && r.attemptId === a.id);
        const observations = links.map(link => context.inspectExecution?.(projectId, link) ?? { executionOutcome: 'unknown' as const, contextObservation: 'unverified' as const, observedContextDigest: null });
        const outcome = context.hasPendingExecution?.(projectId, a.id) ? 'unknown' : observations.length === 0 ? 'none' : observations.some(o => o.executionOutcome === 'unknown') ? 'unknown' : observations.some(o => o.executionOutcome === 'active') ? 'active' : 'known-terminal';
        if (a.executionOutcome !== outcome) {
            a.executionOutcome = outcome;
            change(a);
        }
        return observations;
    };
    const current = (a: Attempt) => {
        const i = find(a.intentId, 'intent'), f = find(a.flowId, 'flow');
        open(i);
        open(f);
        pending(f.id, i.id);
        refreshExecution(a);
        if (i.approvedRevisionId !== a.intentRevisionId || f.approvedRevisionId !== a.flowRevisionId)
            fail(409, 'requirements-stale', 'Attempt pins are no longer current');
        return { i, f };
    };
    const editable = (a: Attempt) => {
        if (!['draft', 'running', 'blocked'].includes(a.state))
            fail(409, 'sealed-attempt', 'Create a successor Attempt for new work');
        current(a);
    };
    const decision = (targetType: Decision['targetType'], targetId: string, targetDigest: string, value: Decision['decision'], reason: string) => add(seal({ ...base(), kind: 'decision' as const, targetType, targetId, targetDigest, decision: value, reason, actorKind: 'human' as const, operationId: command.operationId }));
    const mappings = (r: Pick<IntentRevision, 'criteria' | 'flowCriterionIds' | 'criterionMappings'>, fr: FlowRevision) => {
        criteria(r.criteria);
        unique(r.flowCriterionIds);
        unique(r.criterionMappings.map(m => m.intentCriterionId + ':' + m.flowCriterionId));
        for (const m of r.criterionMappings)
            if (!r.criteria.some(c => c.criterionId === m.intentCriterionId) || !fr.criteria.some(c => c.criterionId === m.flowCriterionId) || !r.flowCriterionIds.includes(m.flowCriterionId))
                fail(400, 'invalid-mapping', 'Criterion mapping outside exact revisions');
        if (r.flowCriterionIds.some(id => !r.criterionMappings.some(m => m.flowCriterionId === id)))
            fail(400, 'incomplete-mapping', 'Missing explicit criterion mapping');
    };
    const coverage = (submission: ReviewSubmission, cs: Criterion[], waivers: {
        criterionId: string;
        reason: string;
    }[] = []) => {
        unique(waivers.map(w => w.criterionId));
        for (const w of waivers)
            if (!cs.some(c => c.criterionId === w.criterionId && c.waivable))
                fail(409, 'unwaivable-criterion', 'Waiver is not permitted');
        for (const c of cs) {
            const cov = submission.coverage.find(x => x.criterionId === c.criterionId);
            if ((!cov || cov.result !== 'pass') && !waivers.some(w => w.criterionId === c.criterionId))
                fail(409, 'coverage-incomplete', 'All criteria require passing coverage or exact waiver');
        }
    };
    const validateCoverage = (cov: Coverage, cs: Criterion[], evidenceIds: string[], attemptId: string, subjectId: string) => {
        unique(cov.map(c => c.criterionId));
        unique(evidenceIds);
        if (cov.length !== cs.length || cs.some(c => !cov.some(v => v.criterionId === c.criterionId)))
            fail(400, 'coverage-incomplete', 'Coverage must name every exact Intent criterion');
        const ev = evidenceIds.map(id => find(id, 'evidence'));
        if (ev.some(e => e.attemptId !== attemptId || e.subjectId !== subjectId))
            fail(404, 'not-found', 'Evidence relationship mismatch');
        const existing = state.records.filter(r => r.kind === 'evidence' && r.attemptId === attemptId && r.subjectId === subjectId);
        if (existing.some(e => !evidenceIds.includes(e.id)))
            fail(409, 'omitted-evidence', 'Seal every recorded Evidence item for the exact subject');
        for (const c of cov) {
            unique(c.evidenceIds);
            const applicable = ev.filter(e => e.criterionIds.includes(c.criterionId)).map(e => e.id).sort();
            if (canonical(applicable) !== canonical([...c.evidenceIds].sort()))
                fail(400, 'invalid-coverage', 'Coverage must include every sealed Evidence item for its criterion');
            const records = c.evidenceIds.map(id => ev.find(e => e.id === id));
            if (records.some(e => !e || !e.criterionIds.includes(c.criterionId)))
                fail(400, 'invalid-coverage', 'Coverage references unrelated evidence');
            const result = records.length === 0 ? 'missing' : records.some(e => e?.result === 'fail') ? 'fail' : records.some(e => e?.result === 'inconclusive') ? 'inconclusive' : 'pass';
            if (c.result !== result)
                fail(400, 'invalid-coverage', 'Coverage contradicts immutable Evidence');
        }
        return ev;
    };
    switch (command.command) {
        case 'flow.create': {
            const p = command.payload;
            criteria(p.criteria);
            const id = randomUUID(), r = add(seal({ ...base(), kind: 'flow-revision' as const, flowId: id, revision: 1, problem: p.problem, expectedOutcome: p.expectedOutcome, scope: p.scope, outOfScope: p.outOfScope, specification: p.specification, criteria: p.criteria, requiredIntentIds: [] }));
            return add({ ...base(), id, kind: 'flow', title: p.title, ownerId: p.ownerId, version: 1, state: 'draft', currentRevisionId: r.id, approvedRevisionId: null, acceptanceDecisionId: null, legacyFlowId: null, updatedAt: now });
        }
        case 'intent.create': {
            const p = command.payload, f = find(p.flowId, 'flow');
            cas(f);
            open(f);
            const fr = find(f.currentRevisionId, 'flow-revision');
            mappings(p, fr);
            const id = randomUUID(), r = add(seal({ ...base(), kind: 'intent-revision' as const, intentId: id, revision: 1, flowRevisionId: fr.id, deliverable: p.deliverable, approach: p.approach, outOfScope: p.outOfScope, criteria: p.criteria, flowCriterionIds: p.flowCriterionIds, criterionMappings: p.criterionMappings }));
            const i = add({ ...base(), id, kind: 'intent' as const, flowId: f.id, title: p.title, ownerId: p.ownerId, required: p.required, version: 1, state: 'draft' as const, currentRevisionId: r.id, approvedRevisionId: null, selectedSubmissionId: null, acceptanceDecisionId: null, updatedAt: now });
            change(f);
            return i;
        }
        case 'revision.propose': {
            const p = command.payload;
            if (p.targetType === 'flow') {
                const f = find(p.flowId, 'flow');
                cas(f);
                open(f);
                criteria(p.criteria);
                unique(p.requiredIntentIds);
                for (const id of p.requiredIntentIds)
                    if (find(id, 'intent').flowId !== f.id)
                        fail(404, 'not-found', 'Intent does not belong to Flow');
                const { targetType: _, ...fields } = p;
                const r = add(seal({ ...base(), ...fields, kind: 'flow-revision' as const, revision: context.nextRevisionNumber?.('flow-revision', f.id) ?? state.records.filter(r => r.kind === 'flow-revision' && r.flowId === f.id).length + 1 }));
                f.currentRevisionId = r.id;
                change(f);
                return r;
            }
            const i = find(p.intentId, 'intent'), f = find(i.flowId, 'flow');
            cas(i);
            cas(f);
            open(f);
            if (i.state === 'cancelled')
                fail(409, 'terminal-work', 'Cancelled Intent cannot receive proposed requirements');
            const fr = find(p.flowRevisionId, 'flow-revision');
            if (fr.flowId !== f.id)
                fail(404, 'not-found', 'Foreign Flow revision');
            mappings(p, fr);
            const { targetType: _, ...fields } = p;
            const r = add(seal({ ...base(), ...fields, kind: 'intent-revision' as const, revision: context.nextRevisionNumber?.('intent-revision', i.id) ?? state.records.filter(r => r.kind === 'intent-revision' && r.intentId === i.id).length + 1 }));
            i.currentRevisionId = r.id;
            change(i);
            return r;
        }
        case 'requirements.approve': {
            const p = command.payload, r = find(p.revisionId, p.targetType);
            pin(r.contentDigest, p.revisionDigest);
            if (r.kind === 'flow-revision') {
                const f = find(r.flowId, 'flow');
                cas(f);
                open(f);
                if (f.approvedRevisionId || f.currentRevisionId !== r.id)
                    fail(409, 'amendment-required', 'Existing approval requires amendment');
                if (p.flowRevisionId !== r.id)
                    fail(409, 'revision-conflict', 'Flow revision mismatch');
                const required = state.records.filter((i): i is WorkIntent => i.kind === 'intent' && i.flowId === f.id && i.required).map(i => i.id);
                if (canonical([...required].sort()) !== canonical([...r.requiredIntentIds].sort()))
                    fail(409, 'required-intents-mismatch', 'Freeze exact required Intent set in Flow revision');
                f.approvedRevisionId = r.id;
                f.state = 'ready';
                change(f);
            }
            else {
                const i = find(r.intentId, 'intent'), f = find(i.flowId, 'flow');
                cas(i);
                cas(f);
                open(i);
                pending(f.id, i.id);
                if (introducedAfterFlowApproval(state.records, i, f))
                    fail(409, 'amendment-required', 'An Intent introduced after Flow approval requires a human membership amendment');
                if (i.approvedRevisionId || i.currentRevisionId !== r.id)
                    fail(409, 'amendment-required', 'Existing approval requires amendment');
                if (f.approvedRevisionId !== r.flowRevisionId || p.flowRevisionId !== r.flowRevisionId)
                    fail(409, 'revision-conflict', 'Parent Flow approval differs');
                i.approvedRevisionId = r.id;
                i.state = 'ready';
                change(i);
            }
            return decision(r.kind, r.id, r.contentDigest, 'approve', p.reason);
        }
        case 'flow.start': {
            const p = command.payload, f = find(p.flowId, 'flow');
            cas(f);
            pending(f.id);
            if (f.state !== 'ready' || !f.approvedRevisionId)
                fail(409, 'invalid-state', 'Flow must be ready');
            const fr = find(f.approvedRevisionId, 'flow-revision');
            pin(fr.contentDigest, p.flowRevisionDigest);
            if (fr.requiredIntentIds.length === 0)
                fail(409, 'required-intents-missing', 'Flow start requires at least one approved required Intent');
            const required = fr.requiredIntentIds.map(id => {
                const i = find(id, 'intent');
                if (i.flowId !== f.id)
                    fail(409, 'required-intents-mismatch', 'Approved membership references another Flow');
                return i;
            });
            const mapped = new Set<string>();
            for (const i of required) {
                cas(i);
                if (!i.approvedRevisionId || i.state === 'draft' || i.state === 'cancelled')
                    fail(409, 'required-intent-unapproved', 'Every required Intent must have approved requirements before starting');
                const ir = find(i.approvedRevisionId, 'intent-revision');
                if (ir.flowRevisionId !== fr.id)
                    fail(409, 'required-intent-stale', 'Required Intent approval differs from approved Flow revision');
                mappings(ir, fr);
                for (const m of ir.criterionMappings)
                    mapped.add(m.flowCriterionId);
            }
            if (fr.criteria.some(c => !mapped.has(c.criterionId)))
                fail(409, 'flow-coverage-incomplete', 'Required Intents must map every Flow criterion before starting');
            f.state = 'in-progress';
            change(f);
            return f;
        }
        case 'context.create': {
            const p = command.payload, ir = find(p.intentRevisionId, 'intent-revision'), fr = find(p.flowRevisionId, 'flow-revision'), i = find(ir.intentId, 'intent');
            cas(i);
            if (ir.flowRevisionId !== fr.id || find(i.flowId, 'flow').id !== fr.flowId)
                fail(404, 'not-found', 'Context revision relationship mismatch');
            unique(p.entries.map(e => e.entryId));
            for (const git of p.gitBases)
                repository(git.repositoryId, git.commitOid);
            const declaredEntries = structuredClone(p.entries);
            if (fr.specification) {
                const spec = fr.specification;
                const exact = declaredEntries.find(e => e.reference?.documentId === spec.documentId && e.reference.version === spec.version && e.reference.contentDigest === spec.contentDigest);
                if (exact) {
                    exact.required = true;
                    exact.contentDigest = spec.contentDigest;
                }
                else {
                    if (declaredEntries.some(e => e.entryId === 'flow-specification'))
                        fail(400, 'reserved-context-entry', 'Flow specification entry ID is reserved');
                    declaredEntries.push({ entryId: 'flow-specification', role: 'spec', reference: spec, required: true, contentDigest: spec.contentDigest });
                }
            }
            const entries = declaredEntries.map(e => {
                const doc = e.reference && resolveDocument(e.reference);
                if (e.reference && e.contentDigest !== e.reference.contentDigest)
                    fail(400, 'digest-conflict', 'Context entry digest differs from document reference');
                return { ...e, resolution: doc ? 'resolved' as const : 'unavailable' as const, provenance: 'hub' as const };
            });
            return add(seal({ ...base(), kind: 'context' as const, flowRevisionId: fr.id, intentRevisionId: ir.id, entries, gitBases: p.gitBases.map(g => ({ ...g, verification: 'claimed' as const })) }));
        }
        case 'attempt.create': {
            const p = command.payload;
            if (p.participantId !== actor.id)
                fail(403, 'participant-mismatch', 'Attempt participant must match the authenticated contributor');
            if (actor.kind === 'agent' && p.method === 'human')
                fail(403, 'method-mismatch', 'An agent cannot claim human work');
            const ir = find(p.intentRevisionId, 'intent-revision'), i = find(ir.intentId, 'intent'), f = find(i.flowId, 'flow'), ctx = find(p.contextSnapshotId, 'context');
            cas(i);
            open(i);
            open(f);
            pending(f.id, i.id);
            if (i.approvedRevisionId !== ir.id || f.approvedRevisionId !== ir.flowRevisionId || ctx.intentRevisionId !== ir.id || ctx.flowRevisionId !== ir.flowRevisionId)
                fail(409, 'revision-conflict', 'Attempt requires current approved pins');
            if (p.supersedesAttemptId) {
                const old = find(p.supersedesAttemptId, 'attempt');
                if (old.intentId !== i.id || !['failed', 'cancelled', 'changes-requested', 'rejected', 'withdrawn'].includes(old.state))
                    fail(409, 'invalid-predecessor', 'Predecessor must be a closed Attempt of this Intent');
            }
            const a = add({ ...base(), kind: 'attempt' as const, flowId: f.id, intentId: i.id, flowRevisionId: ir.flowRevisionId, intentRevisionId: ir.id, contextSnapshotId: ctx.id, participantId: p.participantId, method: p.method, summary: p.summary, supersedesAttemptId: p.supersedesAttemptId, version: 1, state: 'draft' as const, executionOutcome: 'none' as const, submissionId: null, updatedAt: now });
            i.state = 'in-progress';
            change(i);
            return a;
        }
        case 'attempt.start': {
            const p = command.payload, a = find(p.attemptId, 'attempt');
            cas(a);
            editable(a);
            if (a.state !== 'draft')
                fail(409, 'invalid-state', 'Attempt already started');
            const ctx = find(a.contextSnapshotId, 'context');
            pin(ctx.contentDigest, p.contextDigest);
            pin(find(a.flowRevisionId, 'flow-revision').contentDigest, p.flowRevisionDigest);
            pin(find(a.intentRevisionId, 'intent-revision').contentDigest, p.intentRevisionDigest);
            if (state.records.some(r => r.kind === 'execution-link' && r.attemptId === a.id && r.contextObservation === 'observed-drift'))
                fail(409, 'context-drift', 'Observed runtime context differs from pinned context');
            if (ctx.entries.some(e => e.required && e.resolution !== 'resolved'))
                fail(409, 'context-unavailable', 'Required context is unavailable');
            a.state = 'running';
            change(a);
            return a;
        }
        case 'attempt.report': {
            const p = command.payload, a = find(p.attemptId, 'attempt');
            cas(a);
            editable(a);
            if (a.state === 'draft' && (p.event === 'progress' || p.event === 'blocked' || p.event === 'cancel-request'))
                fail(409, 'attempt-not-started', 'Start with exact requirement and context digests before reporting progress');
            if (p.event === 'cancel-confirmed' && a.executionOutcome !== 'none' && a.executionOutcome !== 'known-terminal')
                fail(409, 'execution-uncertain', 'Execution is not known terminal');
            a.state = p.event === 'blocked' || p.event === 'cancel-request' ? 'blocked' : p.event === 'failed' ? 'failed' : p.event === 'cancel-confirmed' ? 'cancelled' : 'running';
            change(a);
            return { attempt: a, report: p.report, event: p.event };
        }
        case 'subject.create': {
            const p = command.payload, a = find(p.attemptId, 'attempt');
            cas(a);
            editable(a);
            const artifacts = p.artifacts.map(v => {
                if (v.kind === 'git') {
                    repository(v.repositoryId, v.commitOid);
                    if (v.treeOid)
                        repository(v.repositoryId, v.treeOid);
                    return { kind: 'git' as const, repositoryId: v.repositoryId, commitOid: v.commitOid, treeOid: v.treeOid, pullRequest: v.pullRequestNumber ? { number: v.pullRequestNumber, observedHeadOid: v.commitOid } : null, verification: 'claimed' as const, observedAt: null };
                }
                if (v.kind === 'report') {
                    pin(sha256(v.text), v.contentDigest);
                    return v;
                }
                if (v.kind === 'document') {
                    const doc = resolveDocument(v.reference);
                    if (!doc)
                        fail(404, 'not-found', 'Document artifact version unavailable');
                }
                if (v.kind === 'legacy') {
                    const r = context.legacy.revisions.find(r => r.id === v.revisionId && r.projectId === projectId && r.treeDigest === v.treeDigest);
                    if (!r)
                        fail(404, 'not-found', 'Legacy revision unavailable');
                }
                return v;
            });
            return add(seal({ ...base(), kind: 'subject' as const, attemptId: a.id, artifacts, report: p.report }));
        }
        case 'evidence.record': {
            const p = command.payload, a = find(p.attemptId, 'attempt'), s = find(p.subjectId, 'subject');
            cas(a);
            if (s.attemptId !== a.id)
                fail(404, 'not-found', 'Subject outside Attempt');
            if (a.state === 'cancelled' || find(a.flowId, 'flow').state === 'cancelled' || find(a.intentId, 'intent').state === 'cancelled')
                fail(409, 'terminal-work', 'Cancelled work cannot receive new Evidence');
            pin(s.contentDigest, p.subjectDigest);
            if (p.sourceRunId || p.sourceObservationId)
                fail(403, 'verified-bridge-required', 'External provenance requires verified bridge');
            unique(p.criterionIds);
            const ir = find(a.intentRevisionId, 'intent-revision');
            if (p.criterionIds.some(id => !ir.criteria.some(c => c.criterionId === id)))
                fail(400, 'invalid-criterion', 'Evidence criterion outside pinned revision');
            return add(seal({ ...base(), kind: 'evidence' as const, ...p, source: 'contributor-report' as const }));
        }
        case 'attempt.submit': {
            const p = command.payload, a = find(p.attemptId, 'attempt');
            cas(a);
            editable(a);
            if (!['running', 'blocked'].includes(a.state))
                fail(409, 'invalid-state', 'Start Attempt before submission');
            const { i } = current(a);
            if (a.executionOutcome === 'active' || a.executionOutcome === 'unknown')
                fail(409, 'execution-uncertain', 'All linked execution must be known terminal before submission');
            const observations = refreshExecution(a);
            if (observations.some(o => o.contextObservation === 'observed-drift' || o.contextObservation === 'observed-match' && o.observedContextDigest !== find(a.contextSnapshotId, 'context').contentDigest))
                fail(409, 'context-drift', 'Current runtime context differs from pinned context');
            if (state.records.some(r => r.kind === 'execution-link' && r.attemptId === a.id && r.contextObservation === 'observed-drift'))
                fail(409, 'context-drift', 'Observed runtime context differs from pinned context');
            cas(i);
            const s = find(p.subjectId, 'subject');
            if (s.attemptId !== a.id)
                fail(404, 'not-found', 'Subject outside Attempt');
            pin(s.contentDigest, p.subjectDigest);
            validateCoverage(p.coverage, find(a.intentRevisionId, 'intent-revision').criteria, p.evidenceIds, a.id, s.id);
            if (!p.knowledgeFollowup.proposalIds.length && !p.knowledgeFollowup.noUpdateReason)
                fail(400, 'knowledge-followup-required', 'Record proposal or no-update reason');
            for (const id of p.knowledgeFollowup.proposalIds)
                if (!context.legacy.proposals.some(v => v.id === id && v.projectId === projectId))
                    fail(404, 'not-found', 'Knowledge proposal unavailable');
            const r = add(seal({ ...base(), kind: 'submission' as const, ...p, flowRevisionId: a.flowRevisionId, intentRevisionId: a.intentRevisionId, contextSnapshotId: a.contextSnapshotId }));
            a.submissionId = r.id;
            a.state = 'submitted';
            i.state = 'in-review';
            change(a);
            change(i);
            return r;
        }
        case 'attempt.withdraw': {
            const p = command.payload, a = find(p.attemptId, 'attempt'), s = find(p.submissionId, 'submission'), i = find(a.intentId, 'intent');
            cas(a);
            cas(i);
            if (a.state !== 'submitted' || a.submissionId !== s.id || s.attemptId !== a.id || i.acceptanceDecisionId)
                fail(409, 'invalid-state', 'Only current unaccepted submission may be withdrawn');
            pin(s.contentDigest, p.submissionDigest);
            a.state = 'withdrawn';
            if (i.selectedSubmissionId === s.id)
                i.selectedSubmissionId = null;
            i.state = 'in-progress';
            change(a);
            change(i);
            return a;
        }
        case 'attempt.select': {
            const p = command.payload, i = find(p.intentId, 'intent'), a = find(p.attemptId, 'attempt'), s = find(p.submissionId, 'submission');
            cas(i);
            cas(a);
            current(a);
            if (a.intentId !== i.id || s.attemptId !== a.id || a.state !== 'submitted' || a.submissionId !== s.id)
                fail(409, 'invalid-selection', 'Only current submitted Attempt can be selected');
            pin(s.contentDigest, p.submissionDigest);
            i.selectedSubmissionId = s.id;
            change(i);
            return decision('attempt-selection', i.id, s.contentDigest, 'select', p.reason);
        }
        case 'review.decide': {
            const p = command.payload;
            if (p.targetType === 'intent-review') {
                const i = find(p.targetId, 'intent'), s = find(p.submissionId, 'submission'), a = find(s.attemptId, 'attempt');
                cas(i);
                cas(a);
                const { f } = current(a);
                cas(f);
                if (a.intentId !== i.id || i.selectedSubmissionId !== s.id || a.state !== 'submitted')
                    fail(409, 'invalid-review', 'Review requires exact selected submitted Attempt');
                pin(s.contentDigest, p.submissionDigest);
                // Evidence received after sealing must be acknowledged through withdrawal and a new Attempt.
                if (p.decision === 'accept' && state.records.some(e => e.kind === 'evidence' && e.attemptId === a.id && e.subjectId === s.subjectId && !s.evidenceIds.includes(e.id)))
                    fail(409, 'late-evidence', 'Late Evidence requires withdrawal and a successor Attempt');
                if (p.decision === 'accept') {
                    if (a.executionOutcome === 'active' || a.executionOutcome === 'unknown')
                        fail(409, 'execution-uncertain', 'Linked execution must be known terminal before acceptance');
                    const subject = find(s.subjectId, 'subject');
                    if (subject.artifacts.some(v => v.kind === 'git' && v.pullRequest !== null) && !context.verifySubjectForAcceptance)
                        fail(409, 'observer-unavailable', 'Current PR acceptance requires configured fresh Git observation');
                    context.verifySubjectForAcceptance?.(projectId, subject);
                    coverage(s, find(a.intentRevisionId, 'intent-revision').criteria, p.waivers);
                }
                else if (p.waivers.length)
                    fail(400, 'invalid-waiver', 'Waivers apply only to acceptance');
                for (const w of p.waivers)
                    decision('criterion-waiver', w.criterionId, s.contentDigest, 'waive', w.reason);
                const d = decision('intent-review', i.id, s.contentDigest, p.decision, p.reason);
                i.state = p.decision === 'accept' ? 'accepted' : 'in-progress';
                i.acceptanceDecisionId = p.decision === 'accept' ? d.id : null;
                a.state = p.decision === 'accept' ? 'accepted' : p.decision === 'reject' ? 'rejected' : 'changes-requested';
                change(i);
                change(a);
                return d;
            }
            const f = find(p.targetId, 'flow'), s = find(p.submissionId, 'flow-submission');
            cas(f);
            pending(f.id);
            if (f.state !== 'in-review' || s.flowId !== f.id || f.approvedRevisionId !== s.flowRevisionId)
                fail(409, 'invalid-review', 'Flow requires current sealed aggregate');
            pin(s.contentDigest, p.submissionDigest);
            const manifest = acceptanceManifest(state, projectId, f.id, context.verifySubjectForAcceptance);
            pin(workDigest(manifest), s.contentDigest);
            for (const e of s.acceptedIntents)
                cas(find(e.intentId, 'intent'));
            if (p.waivers.length)
                fail(409, 'unwaivable-aggregate', 'Flow coverage must derive from accepted Intent decisions');
            const d = decision('flow-review', f.id, s.contentDigest, p.decision, p.reason);
            f.state = p.decision === 'accept' ? 'accepted' : 'in-progress';
            f.acceptanceDecisionId = p.decision === 'accept' ? d.id : null;
            change(f);
            return d;
        }
        case 'flow.submit': {
            const p = command.payload, f = find(p.flowId, 'flow');
            cas(f);
            pending(f.id);
            if (f.state !== 'in-progress' || p.flowRevisionId !== f.approvedRevisionId)
                fail(409, 'invalid-state', 'Flow must be running on exact revision');
            const manifest = acceptanceManifest(state, projectId, f.id, context.verifySubjectForAcceptance);
            unique(p.acceptedIntentDecisionIds);
            if (canonical([...p.acceptedIntentDecisionIds].sort()) !== canonical(manifest.acceptedIntents.map(i => i.decisionId).sort()))
                fail(409, 'decision-set-mismatch', 'Exact accepted Intent decision set required');
            for (const i of manifest.acceptedIntents)
                cas(find(i.intentId, 'intent'));
            pin(workDigest(manifest), p.acceptanceManifestDigest);
            const r = add({ ...base(), kind: 'flow-submission' as const, ...manifest, contentDigest: workDigest(manifest) });
            f.state = 'in-review';
            change(f);
            return r;
        }
        case 'requirements.amend': {
            const p = command.payload, f = find(p.flowId, 'flow');
            cas(f);
            open(f);
            pending(f.id);
            if (f.approvedRevisionId !== p.sourceFlowRevisionId)
                fail(409, 'revision-conflict', 'Amendment source no longer approved');
            unique(p.affectedIntentIds);
            unique(p.replacements.map(r => r.targetId));
            for (const id of p.affectedIntentIds) {
                const i = find(id, 'intent');
                if (i.flowId !== f.id)
                    fail(404, 'not-found', 'Foreign affected Intent');
                cas(i);
                if (!p.replacements.some(r => r.targetType === 'intent' && r.targetId === id))
                    fail(400, 'incomplete-amendment', 'Each affected Intent requires exact replacement');
                if (i.required && !find(p.sourceFlowRevisionId, 'flow-revision').requiredIntentIds.includes(i.id)) {
                    const replacement = p.replacements.find(r => r.targetType === 'flow' && r.targetId === f.id);
                    if (!replacement || !find(replacement.revisionId, 'flow-revision').requiredIntentIds.includes(i.id))
                        fail(409, 'membership-amendment-required', 'A new required Intent needs an exact Flow membership replacement in the same amendment');
                }
            }
            for (const e of p.replacements) {
                const r = find(e.revisionId, e.targetType === 'flow' ? 'flow-revision' : 'intent-revision');
                pin(r.contentDigest, e.contentDigest);
                if (e.targetType === 'flow') {
                    if (r.kind !== 'flow-revision' || r.flowId !== f.id || e.targetId !== f.id || f.currentRevisionId !== r.id)
                        fail(409, 'invalid-replacement', 'Flow replacement mismatch');
                }
                else {
                    const i = find(e.targetId, 'intent');
                    if (r.kind !== 'intent-revision' || r.intentId !== i.id || i.flowId !== f.id || !p.affectedIntentIds.includes(i.id) || i.currentRevisionId !== r.id)
                        fail(409, 'invalid-replacement', 'Intent replacement mismatch');
                }
            }
            return add(seal({ ...base(), kind: 'amendment' as const, ...p }));
        }
        case 'requirements.resolve-amendment': {
            const p = command.payload, m = find(p.amendmentId, 'amendment'), f = find(m.flowId, 'flow');
            cas(f);
            open(f);
            pin(m.contentDigest, p.manifestDigest);
            if (f.approvedRevisionId !== m.sourceFlowRevisionId || state.records.some(d => d.kind === 'decision' && d.targetType === 'amendment' && d.targetId === m.id && ['approve', 'withdraw'].includes(d.decision)))
                fail(409, 'amendment-resolved', 'Amendment is stale or resolved');
            for (const id of m.affectedIntentIds)
                cas(find(id, 'intent'));
            if (p.decision === 'approve') {
                const flowReplacement = m.replacements.find(r => r.targetType === 'flow');
                const nextFr = flowReplacement ? find(flowReplacement.revisionId, 'flow-revision') : find(m.sourceFlowRevisionId, 'flow-revision');
                if (flowReplacement) {
                    pin(nextFr.contentDigest, flowReplacement.contentDigest);
                    if (f.currentRevisionId !== nextFr.id)
                        fail(409, 'stale-proposal', 'Flow proposal changed');
                    const all = state.records.filter((r): r is WorkIntent => r.kind === 'intent' && r.flowId === f.id);
                    if (all.some(i => i.approvedRevisionId && !m.affectedIntentIds.includes(i.id)))
                        fail(409, 'incomplete-amendment', 'Flow pin change must include all approved dependent Intents');
                }
                for (const e of m.replacements.filter(r => r.targetType === 'intent')) {
                    const i = find(e.targetId, 'intent'), r = find(e.revisionId, 'intent-revision');
                    pin(r.contentDigest, e.contentDigest);
                    if (i.currentRevisionId !== r.id || r.flowRevisionId !== nextFr.id)
                        fail(409, 'stale-proposal', 'Replacement Intent revision mismatch');
                    mappings(r, nextFr);
                    i.approvedRevisionId = r.id;
                    i.selectedSubmissionId = null;
                    i.acceptanceDecisionId = null;
                    i.state = 'ready';
                    change(i);
                }
                f.approvedRevisionId = nextFr.id;
                f.acceptanceDecisionId = null;
                f.state = 'ready';
                change(f);
            }
            return decision('amendment', m.id, m.contentDigest, p.decision, p.reason);
        }
        case 'work.cancel': {
            const p = command.payload, r = find(p.targetId, p.targetType);
            cas(r);
            open(r);
            const intents = r.kind === 'flow' ? state.records.filter((i): i is WorkIntent => i.kind === 'intent' && i.flowId === r.id) : [r];
            for (const i of intents) {
                cas(i);
                for (const a of state.records.filter((a): a is Attempt => a.kind === 'attempt' && a.intentId === i.id)) {
                    cas(a);
                    refreshExecution(a);
                    if (a.executionOutcome !== 'none' && a.executionOutcome !== 'known-terminal')
                        fail(409, 'execution-uncertain', 'Coordinate linked execution cancellation first');
                    if (['draft', 'running', 'blocked', 'submitted'].includes(a.state)) {
                        a.state = 'cancelled';
                        change(a);
                    }
                }
                i.state = 'cancelled';
                change(i);
            }
            if (r.kind === 'flow') {
                r.state = 'cancelled';
                change(r);
            }
            return r;
        }
        case 'execution.bind': {
            const p = command.payload, a = find(p.attemptId, 'attempt');
            cas(a);
            editable(a);
            if (!context.verifyExecution)
                fail(501, 'verified-bridge-unavailable', 'Execution binding requires an authorized current runtime lookup adapter');
            const proof = context.verifyExecution(actor, projectId, p);
            if (proof.originalOperatorId !== actor.id || proof.projectId !== projectId || ['sessionId', 'runId', 'turnId', 'machineId', 'checkoutId', 'associationDigest'].some(k => proof[k as keyof VerifiedExecution] !== p[k as keyof ExecutionBindingInput]) || proof.flowRevisionId !== a.flowRevisionId || proof.intentRevisionId !== a.intentRevisionId || proof.contextSnapshotId !== a.contextSnapshotId)
                fail(403, 'execution-proof-mismatch', 'Current execution proof does not match original principal and exact Attempt pins');
            if (state.records.some(r => r.kind === 'execution-link' && r.runId === p.runId))
                fail(409, 'execution-already-bound', 'Run already belongs to an Attempt');
            const ctx = find(a.contextSnapshotId, 'context');
            if (proof.contextObservation === 'observed-match' && proof.observedContextDigest !== ctx.contentDigest)
                fail(409, 'context-drift', 'Runtime consumption does not match pinned context');
            const link = add({ ...base(), kind: 'execution-link' as const, ...p, contextObservation: proof.contextObservation, observedContextDigest: proof.observedContextDigest });
            const otherLinks = state.records.filter(r => r.kind === 'execution-link' && r.attemptId === a.id && r.id !== link.id);
            a.executionOutcome = otherLinks.length && a.executionOutcome !== 'none' && a.executionOutcome !== 'known-terminal' ? (a.executionOutcome === 'unknown' || proof.executionOutcome === 'unknown' ? 'unknown' : 'active') : proof.executionOutcome;
            change(a);
            return link;
        }
        case 'legacy.preview': {
            if (!context.legacyConversion)
                fail(501, 'legacy-conversion-unavailable', 'Legacy conversion requires transactional legacy writer guards and runtime reconciliation');
            return context.legacyConversion.preview(actor, projectId, command.payload);
        }
        case 'legacy.convert': {
            if (!context.legacyConversion)
                fail(501, 'legacy-conversion-unavailable', 'Legacy conversion requires transactional legacy writer guards and runtime reconciliation');
            const p = command.payload, source = context.legacyConversion.convert(actor, projectId, p);
            if (source.flow.projectId !== projectId || source.document.projectId !== projectId || source.flow.id !== p.legacyFlowId || source.flow.version !== p.sourceVersion || source.document.id !== source.flow.specDocumentId || source.document.contentDigest !== source.flow.specContentDigest)
                fail(409, 'legacy-source-conflict', 'Exact conversion source changed');
            if (state.records.some(r => r.kind === 'flow' && r.projectId === projectId && r.legacyFlowId === source.flow.id))
                fail(409, 'already-converted', 'Legacy Flow already has managed work');
            const cs = source.flow.criteria.map((text, index) => ({ criterionId: 'legacy-' + (index + 1), text, waivable: false }));
            criteria(cs);
            criteria(p.intent.criteria);
            unique(p.intent.flowCriterionIds);
            if (canonical([...p.intent.flowCriterionIds].sort()) !== canonical(cs.map(c => c.criterionId).sort()))
                fail(400, 'incomplete-legacy-coverage', 'Conversion Intent must map every legacy Flow criterion');
            if (p.intent.criteria.length !== 1 && p.intent.criteria.length !== p.intent.flowCriterionIds.length)
                fail(400, 'ambiguous-legacy-mapping', 'Provide one Intent criterion or one per Flow criterion');
            const flowId = randomUUID(), intentId = randomUUID(), specification = { documentId: source.document.id, version: source.document.version, contentDigest: source.document.contentDigest };
            const fr = add(seal({ ...base(), kind: 'flow-revision' as const, flowId, revision: 1, problem: 'Converted legacy Flow: ' + source.flow.title, expectedOutcome: source.flow.title, scope: p.intent.deliverable, outOfScope: p.intent.outOfScope, specification, criteria: cs, requiredIntentIds: p.intent.required ? [intentId] : [] }));
            const ir = add(seal({ ...base(), kind: 'intent-revision' as const, intentId, revision: 1, flowRevisionId: fr.id, deliverable: p.intent.deliverable, approach: p.intent.approach, outOfScope: p.intent.outOfScope, criteria: p.intent.criteria, flowCriterionIds: p.intent.flowCriterionIds, criterionMappings: p.intent.flowCriterionIds.map((id, index) => ({ flowCriterionId: id, intentCriterionId: p.intent.criteria[p.intent.criteria.length === 1 ? 0 : index]!.criterionId })) }));
            const f = add({ ...base(), id: flowId, kind: 'flow' as const, title: source.flow.title, ownerId: p.intent.ownerId, version: 1, state: 'draft' as const, currentRevisionId: fr.id, approvedRevisionId: null, acceptanceDecisionId: null, legacyFlowId: source.flow.id, updatedAt: now });
            const i = add({ ...base(), id: intentId, kind: 'intent' as const, flowId, title: p.intent.title, ownerId: p.intent.ownerId, required: p.intent.required, version: 1, state: 'draft' as const, currentRevisionId: ir.id, approvedRevisionId: null, selectedSubmissionId: null, acceptanceDecisionId: null, updatedAt: now });
            context.legacyConversion.converted?.(source.flow.id, f.id);
            return { records: [f, fr, i, ir], legacyFlowId: source.flow.id };
        }
    }
}
/** Deterministic manifest contains semantic pins only, so a read preview can be submitted exactly. */
function acceptanceManifest(state: WorkState, projectId: string, flowId: string, verifySubject?: WorkContext['verifySubjectForAcceptance']) {
    const records = state.records.filter(r => r.projectId === projectId), f = records.find((r): r is WorkFlow => r.id === flowId && r.kind === 'flow');
    if (!f?.approvedRevisionId)
        fail(409, 'unapproved-flow', 'Flow is not approved');
    const fr = records.find((r): r is FlowRevision => r.id === f.approvedRevisionId && r.kind === 'flow-revision')!;
    const intents = records.filter((r): r is WorkIntent => r.kind === 'intent' && r.flowId === flowId);
    if (fr.requiredIntentIds.some(id => !intents.some(i => i.id === id)))
        fail(409, 'required-intents-mismatch', 'Frozen Flow membership references unavailable Intent');
    const selected = intents.filter(i => fr.requiredIntentIds.includes(i.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (!selected.length)
        fail(409, 'empty-acceptance', 'At least one accepted Intent required');
    const criterionCoverage: FlowSubmission['criterionCoverage'] = [], knowledgeProposalIds: string[] = [];
    const acceptedIntents = selected.map(i => {
        if (i.state !== 'accepted' || !i.acceptanceDecisionId || !i.selectedSubmissionId)
            fail(409, 'intent-not-accepted', 'Required Intent is not accepted');
        const ir = records.find((r): r is IntentRevision => r.kind === 'intent-revision' && r.id === i.approvedRevisionId), d = records.find((r): r is Decision => r.kind === 'decision' && r.id === i.acceptanceDecisionId), s = records.find((r): r is ReviewSubmission => r.kind === 'submission' && r.id === i.selectedSubmissionId);
        if (!ir || !d || !s || ir.flowRevisionId !== fr.id || s.intentRevisionId !== ir.id || d.decision !== 'accept' || d.targetDigest !== s.contentDigest)
            fail(409, 'stale-acceptance', 'Intent accepted pins differ');
        const subject = records.find((r): r is ResultSubject => r.kind === 'subject' && r.id === s.subjectId);
        if (!subject)
            fail(409, 'subject-unavailable', 'Accepted subject is unavailable');
        if (subject.artifacts.some(v => v.kind === 'git' && v.pullRequest !== null) && !verifySubject)
            fail(409, 'observer-unavailable', 'Current PR acceptance requires configured fresh Git observation');
        verifySubject?.(projectId, subject);
        if (records.some(e => e.kind === 'evidence' && e.attemptId === s.attemptId && e.subjectId === s.subjectId && !s.evidenceIds.includes(e.id)))
            fail(409, 'late-evidence', 'Late evidence requires new Attempt and current acceptance');
        for (const m of ir.criterionMappings) {
            const cov = s.coverage.find(c => c.criterionId === m.intentCriterionId);
            const waived = records.some(w => w.kind === 'decision' && w.targetType === 'criterion-waiver' && w.targetId === m.intentCriterionId && w.targetDigest === s.contentDigest && w.operationId === d.operationId);
            if (cov?.result === 'pass' || waived && fr.criteria.some(c => c.criterionId === m.flowCriterionId && c.waivable) && ir.criteria.some(c => c.criterionId === m.intentCriterionId && c.waivable))
                criterionCoverage.push({ flowCriterionId: m.flowCriterionId, intentId: i.id, intentCriterionId: m.intentCriterionId, submissionId: s.id, decisionId: d.id });
        }
        knowledgeProposalIds.push(...s.knowledgeFollowup.proposalIds);
        return { intentId: i.id, intentRevisionId: ir.id, decisionId: d.id, submissionId: s.id, subjectDigest: s.subjectDigest };
    });
    if (fr.criteria.some(c => !criterionCoverage.some(v => v.flowCriterionId === c.criterionId)))
        fail(409, 'flow-coverage-incomplete', 'Every Flow criterion requires explicit accepted Intent coverage');
    return { flowId, flowRevisionId: fr.id, acceptedIntents, knowledgeProposalIds: [...new Set(knowledgeProposalIds)].sort(), criterionCoverage };
}
/** Incidents are projections of immutable observations; historical human decisions remain untouched. */
function contradictoryAcceptedEvidence(records: WorkRecord[]): EvidenceRecord[] {
    return records.filter((e): e is EvidenceRecord => {
        if (e.kind !== 'evidence' || e.result === 'pass')
            return false;
        const attempt = records.find((r): r is Attempt => r.kind === 'attempt' && r.id === e.attemptId);
        if (!attempt)
            return false;
        const intent = records.find((r): r is WorkIntent => r.kind === 'intent' && r.id === attempt.intentId);
        if (!intent)
            return false;
        return records.some(s => {
            if (s.kind !== 'submission' || s.attemptId !== attempt.id || s.subjectId !== e.subjectId || s.subjectDigest !== e.subjectDigest || s.evidenceIds.includes(e.id))
                return false;
            const accepted = records.some(d => d.kind === 'decision' && d.targetType === 'intent-review' && d.targetId === intent.id && d.targetDigest === s.contentDigest && d.decision === 'accept');
            if (!accepted)
                return false;
            const replacement = intent.acceptanceDecisionId && records.find((d): d is Decision => d.kind === 'decision' && d.id === intent.acceptanceDecisionId && d.targetType === 'intent-review' && d.targetId === intent.id && d.decision === 'accept');
            const selected = intent.selectedSubmissionId && records.find((r): r is ReviewSubmission => r.kind === 'submission' && r.id === intent.selectedSubmissionId);
            return !(replacement && selected && selected.id !== s.id && replacement.targetDigest === selected.contentDigest);
        });
    });
}
export function workRead(state: WorkState, actor: Principal, projectId: string, path: string[], url: URL, context?: Pick<WorkContext, 'verifySubjectForAcceptance'>): unknown {
    if (actor.projectIds && !actor.projectIds.includes(projectId))
        fail(404, 'not-found', 'Project not found');
    const records = state.records.filter(r => r.projectId === projectId), eventCursor = state.sequence ?? state.events.filter(e => e.projectId === projectId).at(-1)?.sequence ?? 0;
    const table: Record<string, WorkRecord['kind']> = { flows: 'flow', intents: 'intent', attempts: 'attempt', contexts: 'context', subjects: 'subject', submissions: 'submission', 'flow-submissions': 'flow-submission', decisions: 'decision', amendments: 'amendment' };
    const find = (id: string, kind?: WorkRecord['kind']) => {
        const r = records.find(r => r.id === id && (!kind || r.kind === kind));
        if (!r)
            fail(404, 'not-found', 'Work record not found');
        return r;
    };
    const list = (rs: WorkRecord[]) => {
        const limitValue = url.searchParams.get('limit'), n = limitValue === null ? 50 : Number(limitValue);
        if (!Number.isInteger(n) || n < 1 || n > 200)
            fail(400, 'invalid-limit', 'Limit must be 1 through 200');
        const after = url.searchParams.get('afterId');
        let start = 0;
        if (after) {
            let cursor: unknown;
            try {
                cursor = JSON.parse(Buffer.from(after, 'base64url').toString());
            }
            catch {
                fail(400, 'invalid-cursor', 'Invalid cursor');
            }
            if (!Array.isArray(cursor) || cursor.length !== 2)
                fail(400, 'invalid-cursor', 'Invalid cursor');
            const [p, id] = cursor;
            if (p !== projectId)
                fail(400, 'invalid-cursor', 'Cursor belongs to another project');
            const index = rs.findIndex(r => r.id === id);
            if (index < 0)
                fail(400, 'invalid-cursor', 'Cursor not found');
            start = index + 1;
        }
        const page = rs.slice(start, start + n);
        return { records: page, nextCursor: start + n < rs.length ? Buffer.from(JSON.stringify([projectId, page.at(-1)!.id])).toString('base64url') : null, eventCursor };
    };
    if (path[0] === 'attention') {
        const incidentIds = new Set(contradictoryAcceptedEvidence(records).map(e => e.id));
        return list(records.filter(r => (r.kind === 'flow' || r.kind === 'intent') && r.state === 'in-review' || r.kind === 'attempt' && r.state === 'blocked' || incidentIds.has(r.id)));
    }
    if (path[0] === 'flows' && path[2] === 'acceptance-preview') {
        find(path[1]!, 'flow');
        const manifest = acceptanceManifest(state, projectId, path[1]!, context?.verifySubjectForAcceptance);
        return { ...manifest, acceptanceManifestDigest: workDigest(manifest), eventCursor };
    }
    if (path[0] === 'flows' && path[2] === 'intents') {
        const parent = find(path[1]!, 'flow');
        return list(records.filter(r => r.kind === 'intent' && r.flowId === parent.id));
    }
    if (path[0] === 'intents' && path[2] === 'attempts') {
        const parent = find(path[1]!, 'intent');
        return list(records.filter(r => r.kind === 'attempt' && r.intentId === parent.id));
    }
    if (path[0] === 'attempts' && path[2] === 'evidence') {
        const parent = find(path[1]!, 'attempt');
        return list(records.filter(r => r.kind === 'evidence' && r.attemptId === parent.id));
    }
    if ((path[0] === 'flows' || path[0] === 'intents') && path[2] === 'revisions') {
        const parent = find(path[1]!, table[path[0]]);
        const revision = find(path[3]!, path[0] === 'flows' ? 'flow-revision' : 'intent-revision');
        if (revision.kind === 'flow-revision' ? revision.flowId !== parent.id : revision.kind === 'intent-revision' && revision.intentId !== parent.id)
            fail(404, 'not-found', 'Revision outside entity');
        return { record: revision, eventCursor };
    }
    const kind = table[path[0] ?? ''];
    if (!kind)
        fail(404, 'not-found', 'Unknown work projection');
    if (!path[1])
        return list(records.filter(r => r.kind === kind && (!url.searchParams.get('targetId') || 'targetId' in r && r.targetId === url.searchParams.get('targetId'))));
    const r = find(path[1], kind);
    if (['flow', 'intent', 'attempt'].includes(kind)) {
        const related = records.filter(x => x.id === r.id || r.kind === 'flow' && ('flowId' in x && x.flowId === r.id) || r.kind === 'intent' && ('intentId' in x && x.intentId === r.id) || r.kind === 'attempt' && ('attemptId' in x && x.attemptId === r.id));
        const ids = new Set(related.map(r => r.id));
        for (const evidence of contradictoryAcceptedEvidence(records)) {
            const attempt = records.find((x): x is Attempt => x.kind === 'attempt' && x.id === evidence.attemptId);
            if (attempt && (r.kind === 'flow' && attempt.flowId === r.id || r.kind === 'intent' && attempt.intentId === r.id || r.kind === 'attempt' && attempt.id === r.id))
                ids.add(evidence.id);
        }
        for (let pass = 0; pass < 8; pass++) {
            const before = ids.size;
            for (const item of records.filter(v => ids.has(v.id))) {
                for (const [key, value] of Object.entries(item))
                    if (key.endsWith('Id') && typeof value === 'string' && records.some(v => v.id === value))
                        ids.add(value);
            }
            if (ids.size === before)
                break;
        }
        const result = records.filter(v => ids.has(v.id));
        if (result.length > 200)
            fail(413, 'projection-too-large', 'Use scoped history pages for this aggregate');
        const relevant = r.kind === 'flow' ? ['intent.create', 'revision.propose', 'requirements.approve', 'flow.start', 'flow.submit', 'review.decide', 'requirements.amend', 'work.cancel'] : r.kind === 'intent' ? ['revision.propose', 'requirements.approve', 'context.create', 'attempt.create', 'attempt.select', 'review.decide', 'work.cancel'] : ['attempt.start', 'attempt.report', 'subject.create', 'evidence.record', 'attempt.submit', 'attempt.withdraw'];
        const terminal = 'state' in r && ['accepted', 'cancelled'].includes(r.state);
        const canProposeRemediation = r.kind === 'intent' && r.state === 'accepted' && records.some(f => f.kind === 'flow' && f.id === r.flowId && !['accepted', 'cancelled'].includes(f.state));
        return { records: result, actions: relevant.map(command => { const eligible = !terminal || canProposeRemediation && command === 'revision.propose'; return { command, allowed: allowedWorkCommands(actor).includes(command) && eligible, reasonCode: !eligible ? 'terminal-work' : allowedWorkCommands(actor).includes(command) ? 'exact-command-guards-required' : 'authority-required' }; }), eventCursor };
    }
    return { record: r, eventCursor };
}
