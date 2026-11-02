import { randomUUID } from 'node:crypto';
import type { WorkTransaction } from './domain';
import { fail } from '../domain';
import type { WorkCommand } from './model';

export function executionBind(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'execution.bind' }>): unknown {
    const { state, actor, projectId, context, base, find, cas, add, change, editable, combineExecutionOutcomes, proofMatchesAttempt } = transaction;
    const p = command.payload, a = find(p.attemptId, 'attempt');
    cas(a);
    editable(a);
    if (!context.verifyExecution)
        fail(501, 'verified-bridge-unavailable', 'Execution binding requires an authorized current runtime lookup adapter');
    const proof = context.verifyExecution(actor, projectId, p);
    if (!proofMatchesAttempt(proof, a, p, actor.id, projectId))
        fail(403, 'execution-proof-mismatch', 'Current execution proof does not match original principal and exact Attempt pins');
    if (state.records.some(r => r.kind === 'execution-link' && r.runId === p.runId))
        fail(409, 'execution-already-bound', 'Run already belongs to an Attempt');
    const ctx = find(a.contextSnapshotId, 'context');
    if (proof.contextObservation === 'observed-match' && proof.observedContextDigest !== ctx.contentDigest)
        fail(409, 'context-drift', 'Runtime consumption does not match pinned context');
    const link = add({ ...base(), kind: 'execution-link' as const, ...p, contextObservation: proof.contextObservation, observedContextDigest: proof.observedContextDigest });
    const otherLinks = state.records.filter(r => r.kind === 'execution-link' && r.attemptId === a.id && r.id !== link.id);
    a.executionOutcome = combineExecutionOutcomes([...(otherLinks.length ? [a.executionOutcome] : []), proof.executionOutcome]);
    change(a);
    return link;
}

export function legacyPreview(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'legacy.preview' }>): unknown {
    const { actor, projectId, context } = transaction;
    if (!context.legacyConversion)
        fail(501, 'legacy-conversion-unavailable', 'Legacy conversion requires transactional legacy writer guards and runtime reconciliation');
    return context.legacyConversion.preview(actor, projectId, command.payload);
}

export function legacyConvert(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'legacy.convert' }>): unknown {
    const { state, actor, projectId, context, now, base, add, seal, unique, criteria, canonical } = transaction;
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
