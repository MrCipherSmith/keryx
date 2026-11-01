
import type { WorkTransaction } from './domain';
import { fail, sha256 } from '../domain';
import type { WorkCommand } from './model';

export function contextCreate(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'context.create' }>): unknown {
    const { base, find, cas, add, seal, unique, resolveDocument, repository } = transaction;
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

export function attemptCreate(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'attempt.create' }>): unknown {
    const { actor, now, base, find, cas, add, change, open, pending } = transaction;
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

export function attemptStart(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'attempt.start' }>): unknown {
    const { state, find, cas, change, pin, editable } = transaction;
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

export function attemptReport(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'attempt.report' }>): unknown {
    const { find, cas, change, editable } = transaction;
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

export function subjectCreate(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'subject.create' }>): unknown {
    const { projectId, context, base, find, cas, add, seal, pin, editable, resolveDocument, repository } = transaction;
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

export function evidenceRecord(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'evidence.record' }>): unknown {
    const { base, find, cas, add, seal, pin, unique } = transaction;
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

export function attemptSubmit(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'attempt.submit' }>): unknown {
    const { projectId, context, base, find, cas, add, seal, change, pin, assertNoContextDrift, editable, validateCoverage } = transaction;
    const p = command.payload, a = find(p.attemptId, 'attempt');
    cas(a);
    const { i, observations } = editable(a);
    if (!['running', 'blocked'].includes(a.state))
        fail(409, 'invalid-state', 'Start Attempt before submission');
    if (a.executionOutcome === 'active' || a.executionOutcome === 'unknown')
        fail(409, 'execution-uncertain', 'All linked execution must be known terminal before submission');
    assertNoContextDrift(a, observations);
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

export function attemptWithdraw(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'attempt.withdraw' }>): unknown {
    const { find, cas, change, pin } = transaction;
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

export function attemptSelect(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'attempt.select' }>): unknown {
    const { find, cas, change, pin, current, decision } = transaction;
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
