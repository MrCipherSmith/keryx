
import type { WorkTransaction } from './domain';
import { fail } from '../domain';
import type { WorkCommand, WorkIntent, Attempt } from './model';

export function reviewDecide(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'review.decide' }>): unknown {
    const { state, projectId, context, find, cas, change, pin, pending, current, decision, coverage, workDigest, acceptanceManifest, assertObservedForAcceptance, hasLateEvidence } = transaction;
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
        if (p.decision === 'accept' && hasLateEvidence(state.records, s))
            fail(409, 'late-evidence', 'Late Evidence requires withdrawal and a successor Attempt');
        if (p.decision === 'accept') {
            if (a.executionOutcome === 'active' || a.executionOutcome === 'unknown')
                fail(409, 'execution-uncertain', 'Linked execution must be known terminal before acceptance');
            const subject = find(s.subjectId, 'subject');
            assertObservedForAcceptance(projectId, subject, context.verifySubjectForAcceptance);
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

export function flowSubmit(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'flow.submit' }>): unknown {
    const { state, projectId, context, base, find, cas, add, change, pin, unique, pending, canonical, workDigest, acceptanceManifest } = transaction;
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

export function workCancel(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'work.cancel' }>): unknown {
    const { state, find, cas, change, open, refreshExecution } = transaction;
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
