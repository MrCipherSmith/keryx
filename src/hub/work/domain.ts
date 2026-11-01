import { pageLimit } from './limits';
import { randomUUID } from 'node:crypto';
import type { Principal, HubDocument, HubFlow } from '../contracts';
import type { HubState } from '../store';
import { fail, sha256 } from '../domain';
import { validateWorkCommand, validateWorkRecord } from './validation';
import type { WorkState, WorkRecord, WorkEvent, WorkReceipt, WorkCommand, WorkFlow, WorkIntent, Attempt, FlowRevision, IntentRevision, ReviewSubmission, FlowSubmission, Decision, Criterion, Coverage, ExecutionLink, ResultSubject, EvidenceRecord } from './model';
import * as requirementsHandlers from './handlers-requirements';
import * as attemptsHandlers from './handlers-attempts';
import * as reviewsHandlers from './handlers-reviews';
import * as integrationsHandlers from './handlers-integrations';
const handlers = { ...requirementsHandlers, ...attemptsHandlers, ...reviewsHandlers, ...integrationsHandlers };
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
function proofMatchesAttempt(proof: VerifiedExecution, attempt: Attempt, input: ExecutionBindingInput, actorId: string, projectId: string) {
    const sameAuthority = proof.originalOperatorId === actorId && proof.projectId === projectId;
    const keys = ['sessionId', 'runId', 'turnId', 'machineId', 'checkoutId', 'associationDigest'] as const;
    const sameAllocation = keys.every(key => proof[key] === input[key]);
    const samePins = proof.flowRevisionId === attempt.flowRevisionId && proof.intentRevisionId === attempt.intentRevisionId && proof.contextSnapshotId === attempt.contextSnapshotId;
    return sameAuthority && sameAllocation && samePins;
}
const entityTypes = { flow: 'flow', 'flow-revision': 'flow', intent: 'intent', 'intent-revision': 'intent', attempt: 'attempt', context: 'context', 'execution-link': 'execution-link', subject: 'subject', evidence: 'evidence', decision: 'decision', submission: 'submission', 'flow-submission': 'submission', amendment: 'flow' } satisfies Record<WorkRecord['kind'], WorkEvent['entityType']>;
const eventTypes = { flow: 'flow-changed', intent: 'intent-changed', attempt: 'attempt-changed', context: 'context-created', 'execution-link': 'execution-linked', subject: 'subject-created', evidence: 'evidence-recorded', decision: 'decision-recorded', submission: 'submission-created' } satisfies Record<(typeof entityTypes)[WorkRecord['kind']], WorkEvent['type']>;
export function pendingAmendments(records: WorkRecord[], flowId: string, intentId?: string) {
    const resolved = new Set(records.filter((r): r is Decision => r.kind === 'decision' && r.targetType === 'amendment' && ['approve', 'withdraw'].includes(r.decision)).map(r => r.targetId));
    return records.filter(r => r.kind === 'amendment' && r.flowId === flowId && (!intentId || r.affectedIntentIds.includes(intentId)) && !resolved.has(r.id));
}
function assertObservedForAcceptance(projectId: string, subject: ResultSubject, verify?: WorkContext['verifySubjectForAcceptance']) {
    if (subject.artifacts.some(v => v.kind === 'git' && v.pullRequest !== null) && !verify)
        fail(409, 'observer-unavailable', 'Current PR acceptance requires configured fresh Git observation');
    verify?.(projectId, subject);
}
function hasLateEvidence(records: WorkRecord[], submission: ReviewSubmission) {
    return records.some(e => e.kind === 'evidence' && e.attemptId === submission.attemptId && e.subjectId === submission.subjectId && !submission.evidenceIds.includes(e.id));
}
function evidenceCoverageResult(records: (EvidenceRecord | undefined)[]): Coverage[number]['result'] {
    if (records.length === 0) return 'missing';
    if (records.some(e => e?.result === 'fail')) return 'fail';
    if (records.some(e => e?.result === 'inconclusive')) return 'inconclusive';
    return 'pass';
}

export function combineExecutionOutcomes(outcomes: Attempt['executionOutcome'][]): Attempt['executionOutcome'] {
    if (outcomes.includes('unknown')) return 'unknown';
    if (outcomes.includes('active')) return 'active';
    if (outcomes.includes('known-terminal')) return 'known-terminal';
    return 'none';
}

export type WorkTransaction = ReturnType<typeof createWorkTransaction>;
function createWorkTransaction(state: WorkState, actor: Principal, projectId: string, command: WorkCommand, context: WorkContext) {
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
    const recordIndex = new Map(state.records.map(record => [record.id, record]));
    const find = <K extends WorkRecord['kind']>(id: string, kind: K): Extract<WorkRecord, {
        kind: K;
    }> => {
        const r = recordIndex.get(id);
        if (!r || r.projectId !== projectId || r.kind !== kind)
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
        const entityType = entityTypes[r.kind], type = eventTypes[entityType];
        state.events.push({ protocolVersion: 1, projectId, sequence: (state.sequence = (state.sequence ?? state.events.filter(e => e.projectId === projectId).at(-1)?.sequence ?? 0) + 1), eventId: randomUUID(), operationId: command.operationId, actorId: actor.id, actorKind: actor.kind, occurredAt: now, type, entityType, entityId: r.id, entityVersion: mutable ? r.version : null, contentDigest: 'contentDigest' in r ? r.contentDigest : null, causationId: null });
    };
    const add = <T extends WorkRecord>(r: T): T => { validateWorkRecord(r); state.records.push(r); recordIndex.set(r.id, r); emit(r); return r; };
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
        if (pendingAmendments(state.records, flowId, intentId).length)
            fail(409, 'pending-amendment', 'Resolve pending requirements amendment first');
    };
    const refreshExecution = (a: Attempt) => {
        const links = state.records.filter((r): r is ExecutionLink => r.kind === 'execution-link' && r.attemptId === a.id);
        const observations = links.map(link => context.inspectExecution?.(projectId, link) ?? { executionOutcome: 'unknown' as const, contextObservation: 'unverified' as const, observedContextDigest: null });
        const outcome = context.hasPendingExecution?.(projectId, a.id) ? 'unknown' : combineExecutionOutcomes(observations.map(o => o.executionOutcome));
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
        const observations = refreshExecution(a);
        if (i.approvedRevisionId !== a.intentRevisionId || f.approvedRevisionId !== a.flowRevisionId)
            fail(409, 'requirements-stale', 'Attempt pins are no longer current');
        return { i, f, observations };
    };
    const editable = (a: Attempt) => {
        if (!['draft', 'running', 'blocked'].includes(a.state))
            fail(409, 'sealed-attempt', 'Create a successor Attempt for new work');
        return current(a);
    };
    const assertNoContextDrift = (a: Attempt, observations: ReturnType<typeof refreshExecution>) => {
        const digest = find(a.contextSnapshotId, 'context').contentDigest;
        const observedDrift = observations.some(o => o.contextObservation === 'observed-drift' || o.contextObservation === 'observed-match' && o.observedContextDigest !== digest);
        const retainedDrift = state.records.some(r => r.kind === 'execution-link' && r.attemptId === a.id && r.contextObservation === 'observed-drift');
        if (observedDrift || retainedDrift) fail(409, 'context-drift', 'Observed runtime context differs from pinned context');
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
            const result = evidenceCoverageResult(records);
            if (c.result !== result)
                fail(400, 'invalid-coverage', 'Coverage contradicts immutable Evidence');
        }
        return ev;
    };
        return { state, actor, projectId, context, now, base, find, cas, emit, add, seal, change, pin, unique, criteria, open, pending, refreshExecution, current, editable, decision, mappings, coverage, validateCoverage, resolveDocument, repository, canonical, workDigest, acceptanceManifest, introducedAfterFlowApproval, assertNoContextDrift, combineExecutionOutcomes, assertObservedForAcceptance, hasLateEvidence, proofMatchesAttempt };
}
function execute(state: WorkState, actor: Principal, projectId: string, command: WorkCommand, context: WorkContext): unknown {
    const transaction = createWorkTransaction(state, actor, projectId, command, context);
    switch (command.command) {
        case 'flow.create': return handlers.flowCreate(transaction, command);
        case 'intent.create': return handlers.intentCreate(transaction, command);
        case 'revision.propose': return handlers.revisionPropose(transaction, command);
        case 'requirements.approve': return handlers.requirementsApprove(transaction, command);
        case 'flow.start': return handlers.flowStart(transaction, command);
        case 'context.create': return handlers.contextCreate(transaction, command);
        case 'attempt.create': return handlers.attemptCreate(transaction, command);
        case 'attempt.start': return handlers.attemptStart(transaction, command);
        case 'attempt.report': return handlers.attemptReport(transaction, command);
        case 'subject.create': return handlers.subjectCreate(transaction, command);
        case 'evidence.record': return handlers.evidenceRecord(transaction, command);
        case 'attempt.submit': return handlers.attemptSubmit(transaction, command);
        case 'attempt.withdraw': return handlers.attemptWithdraw(transaction, command);
        case 'attempt.select': return handlers.attemptSelect(transaction, command);
        case 'review.decide': return handlers.reviewDecide(transaction, command);
        case 'flow.submit': return handlers.flowSubmit(transaction, command);
        case 'requirements.amend': return handlers.requirementsAmend(transaction, command);
        case 'requirements.resolve-amendment': return handlers.requirementsResolveAmendment(transaction, command);
        case 'work.cancel': return handlers.workCancel(transaction, command);
        case 'execution.bind': return handlers.executionBind(transaction, command);
        case 'legacy.preview': return handlers.legacyPreview(transaction, command);
        case 'legacy.convert': return handlers.legacyConvert(transaction, command);
    }
}

export function assertAcceptanceBounds(proposalIds: string[], coverage: FlowSubmission['criterionCoverage']) {
    if (new Set(proposalIds).size > 200 || coverage.length > 2000)
        fail(409, 'aggregate-limit', 'Flow submission exceeds aggregate knowledge or criterion coverage limits');
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
        assertObservedForAcceptance(projectId, subject, verifySubject);
        if (hasLateEvidence(records, s)) fail(409, 'late-evidence', 'Late evidence requires new Attempt and current acceptance');
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
    const proposals = [...new Set(knowledgeProposalIds)].sort();
    assertAcceptanceBounds(proposals, criterionCoverage);
    return { flowId, flowRevisionId: fr.id, acceptedIntents, knowledgeProposalIds: proposals, criterionCoverage };
}
/** Incidents are projections of immutable observations; historical human decisions remain untouched. */
function contradictoryAcceptedEvidence(records: WorkRecord[], byId = new Map(records.map(r => [r.id, r]))): EvidenceRecord[] {
    const acceptedDigests = new Set(records.filter((r): r is Decision => r.kind === 'decision' && r.targetType === 'intent-review' && r.decision === 'accept').map(d => d.targetId + ':' + d.targetDigest));
    const submissions = new Map<string, ReviewSubmission[]>();
    for (const r of records) if (r.kind === 'submission') {
        const values = submissions.get(r.attemptId) ?? []; values.push(r); submissions.set(r.attemptId, values);
    }
    return records.filter((e): e is EvidenceRecord => {
        if (e.kind !== 'evidence' || e.result === 'pass') return false;
        const attempt = byId.get(e.attemptId);
        if (attempt?.kind !== 'attempt') return false;
        const intent = byId.get(attempt.intentId);
        if (intent?.kind !== 'intent') return false;
        return (submissions.get(attempt.id) ?? []).some(s => {
            if (s.subjectId !== e.subjectId || s.subjectDigest !== e.subjectDigest || s.evidenceIds.includes(e.id) || !acceptedDigests.has(intent.id + ':' + s.contentDigest)) return false;
            const replacement = intent.acceptanceDecisionId ? byId.get(intent.acceptanceDecisionId) : undefined;
            const selected = intent.selectedSubmissionId ? byId.get(intent.selectedSubmissionId) : undefined;
            const acceptedReplacement = replacement?.kind === 'decision' && replacement.targetType === 'intent-review' && replacement.targetId === intent.id && replacement.decision === 'accept';
            return !(acceptedReplacement && selected?.kind === 'submission' && selected.id !== s.id && replacement.targetDigest === selected.contentDigest);
        });
    });
}
export function workRead(state: WorkState, actor: Principal, projectId: string, path: string[], url: URL, context?: Pick<WorkContext, 'verifySubjectForAcceptance'>): unknown {
    if (actor.projectIds && !actor.projectIds.includes(projectId))
        fail(404, 'not-found', 'Project not found');
    const records = state.records.filter(r => r.projectId === projectId), eventCursor = state.sequence ?? state.events.filter(e => e.projectId === projectId).at(-1)?.sequence ?? 0;
    const byId = new Map(records.map(record => [record.id, record]));
    const incidents = contradictoryAcceptedEvidence(records, byId);
    const table: Record<string, WorkRecord['kind']> = { flows: 'flow', intents: 'intent', attempts: 'attempt', contexts: 'context', subjects: 'subject', submissions: 'submission', 'flow-submissions': 'flow-submission', decisions: 'decision', amendments: 'amendment' };
    const find = (id: string, kind?: WorkRecord['kind']) => {
        const r = byId.get(id);
        if (!r || kind && r.kind !== kind)
            fail(404, 'not-found', 'Work record not found');
        return r;
    };
    const list = (rs: WorkRecord[]) => {
        const n = pageLimit(url);
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
        const incidentIds = new Set(incidents.map(e => e.id));
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
        for (const evidence of incidents) {
            const candidate = byId.get(evidence.attemptId);
            const attempt = candidate?.kind === 'attempt' ? candidate : undefined;
            if (attempt && (r.kind === 'flow' && attempt.flowId === r.id || r.kind === 'intent' && attempt.intentId === r.id || r.kind === 'attempt' && attempt.id === r.id))
                ids.add(evidence.id);
        }
        for (let pass = 0; pass < 8; pass++) {
            const before = ids.size;
            if (ids.size > 200) fail(413, 'projection-too-large', 'Use scoped history pages for this aggregate');
            for (const id of [...ids]) {
                const item = byId.get(id);
                if (!item) continue;
                for (const [key, value] of Object.entries(item))
                    if (key.endsWith('Id') && typeof value === 'string' && byId.has(value))
                        ids.add(value);
                if (ids.size > 200) fail(413, 'projection-too-large', 'Use scoped history pages for this aggregate');
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
