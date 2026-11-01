import type { Principal } from '../contracts';
import type { GitObservation } from './git-observer';
import type { WorkReceipt, WorkState } from './model';

/** Commit a provider fact as immutable work history, sharing the domain sequence/receipt rules. */
export function commitGitObservation(state: WorkState, actor: Principal, observation: GitObservation, operation: {
    operationId: string; requestDigest: string; receiptId: string;
}, eventId: string): WorkReceipt {
    const sequence = (state.sequence ?? state.events.at(-1)?.sequence ?? 0) + 1;
    state.sequence = sequence;
    state.events.push({
        protocolVersion: 1, projectId: observation.projectId, sequence, eventId,
        operationId: operation.operationId, actorId: actor.id, actorKind: actor.kind,
        occurredAt: observation.observedAt, type: 'git-observed', entityType: 'git-observation',
        entityId: observation.id, entityVersion: null, contentDigest: observation.contentDigest, causationId: null,
    });
    const receipt: WorkReceipt = {
        operationId: operation.operationId, status: 'committed', receiptId: operation.receiptId,
        actorId: actor.id, projectId: observation.projectId, requestDigest: operation.requestDigest,
        result: { operationId: operation.operationId, observation, receiptId: operation.receiptId, eventCursor: sequence }, eventCursor: sequence,
    };
    state.operations[observation.projectId + ':' + actor.id + ':' + operation.operationId] = receipt;
    return receipt;
}
