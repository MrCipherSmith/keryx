import { randomUUID } from 'node:crypto';
import type { WorkTransaction } from './domain';
import { fail } from '../domain';
import type { WorkCommand, WorkIntent } from './model';

export function flowCreate(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'flow.create' }>): unknown {
    const { now, base, add, seal, criteria } = transaction;
    const p = command.payload;
    criteria(p.criteria);
    const id = randomUUID(), r = add(seal({ ...base(), kind: 'flow-revision' as const, flowId: id, revision: 1, problem: p.problem, expectedOutcome: p.expectedOutcome, scope: p.scope, outOfScope: p.outOfScope, specification: p.specification, criteria: p.criteria, requiredIntentIds: [] }));
    return add({ ...base(), id, kind: 'flow', title: p.title, ownerId: p.ownerId, version: 1, state: 'draft', currentRevisionId: r.id, approvedRevisionId: null, acceptanceDecisionId: null, legacyFlowId: null, updatedAt: now });
}

export function intentCreate(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'intent.create' }>): unknown {
    const { now, base, find, cas, add, seal, change, open, mappings } = transaction;
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

export function revisionPropose(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'revision.propose' }>): unknown {
    const { state, context, base, find, cas, add, seal, change, unique, criteria, open, mappings } = transaction;
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

export function requirementsApprove(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'requirements.approve' }>): unknown {
    const { state, find, cas, change, pin, open, pending, decision, canonical, introducedAfterFlowApproval } = transaction;
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
        const required = state.records.filter((i): i is WorkIntent => i.kind === 'intent' && i.flowId === f.id && i.required && i.state !== 'cancelled').map(i => i.id);
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

export function flowStart(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'flow.start' }>): unknown {
    const { find, cas, change, pin, pending, mappings } = transaction;
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

export function requirementsAmend(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'requirements.amend' }>): unknown {
    const { base, find, cas, add, seal, pin, unique, open, pending } = transaction;
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

export function requirementsResolveAmendment(transaction: WorkTransaction, command: Extract<WorkCommand, { command: 'requirements.resolve-amendment' }>): unknown {
    const { state, find, cas, change, pin, open, decision, mappings } = transaction;
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
            if (all.some(i => i.state !== 'cancelled' && i.approvedRevisionId && !m.affectedIntentIds.includes(i.id)))
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
