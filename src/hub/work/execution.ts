import type { Principal } from '../contracts';
import type { HubStore, HubState } from '../store';
import { fail } from '../domain';
import { executionBinding } from '../remote-v2/execution';
import type { HumanAuthority, MachineRecord, RunRow, SessionRow, StoredCommand } from '../remote-v2/model';
import type { Control } from '../../remote-control/protocol';
import { canonicalDigest } from '../../remote-control/protocol';
import { workCommand, workDigest, type ExecutionBindingInput, type VerifiedExecution, type WorkContext } from './domain';
import type { Attempt, ContextSnapshot, ExecutionLink, WorkFlow, WorkIntent, WorkState } from './model';
/** Server-owned association recorded in the same transaction as original v2 admission. Never a machine input. */
export type WorkExecutionReservation = {
    operationId: string;
    projectId: string;
    actorId: string;
    sessionDigest: string;
    sessionId: string;
    machineId: string;
    checkoutId: string;
    attemptId: string;
    flowId: string;
    intentId: string;
    flowRevisionId: string;
    intentRevisionId: string;
    contextSnapshotId: string;
    flowRevisionDigest: string;
    intentRevisionDigest: string;
    contextDigest: string;
    associationDigest: string;
    wireAssociationDigest: string;
    createdAt: string;
    state: 'reserved' | 'bound';
    runId: string | null;
    turnId: string | null;
};
export type WorkExecutionHint = {
    attemptId: string;
    expectedVersion: number;
};
export function workExecutionHint(request: Request): WorkExecutionHint | undefined {
    const attemptId = request.headers.get('x-keryx-work-attempt'), version = request.headers.get('x-keryx-work-version');
    if (attemptId === null && version === null)
        return;
    if (!attemptId || attemptId.length > 200 || !version || !/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version)))
        fail(400, 'invalid-work-binding', 'Both bounded Attempt ID and current positive version headers are required');
    return { attemptId, expectedVersion: Number(version) };
}
export function createWorkExecution(store: HubStore) {
    const attempt = (projectId: string, attemptId: string) => {
        const state = store.work.load(projectId);
        const a = state.records.find((r): r is Attempt => r.kind === 'attempt' && r.id === attemptId);
        if (!a)
            fail(404, 'not-found', 'Attempt not found');
        return { state, a };
    };
    const guard = (legacy: HubState, projectId: string, a: Attempt) => {
        const state = store.work.load(projectId), f = state.records.find((r): r is WorkFlow => r.kind === 'flow' && r.id === a.flowId), i = state.records.find((r): r is WorkIntent => r.kind === 'intent' && r.id === a.intentId), ctx = state.records.find((r): r is ContextSnapshot => r.kind === 'context' && r.id === a.contextSnapshotId);
        if (!legacy.projects.some(p => p.id === projectId) || !f || !i || !ctx)
            fail(404, 'not-found', 'Work association not found');
        if (!['running', 'blocked'].includes(a.state) || f.state !== 'in-progress' || !['in-progress', 'in-review'].includes(i.state) || f.approvedRevisionId !== a.flowRevisionId || i.approvedRevisionId !== a.intentRevisionId || ctx.flowRevisionId !== a.flowRevisionId || ctx.intentRevisionId !== a.intentRevisionId)
            fail(409, 'work-association-stale', 'Execution requires current started Attempt and approved work pins');
        if (ctx.entries.some(e => e.required && e.resolution !== 'resolved'))
            fail(409, 'context-unavailable', 'Required immutable context is unavailable');
        if (state.records.some(r => r.kind === 'amendment' && r.flowId === f.id && r.affectedIntentIds.includes(i.id) && !state.records.some(d => d.kind === 'decision' && d.targetType === 'amendment' && d.targetId === r.id && ['approve', 'withdraw'].includes(d.decision))))
            fail(409, 'pending-amendment', 'Resolve requirements amendment before dispatch');
        return { state, f, i, ctx };
    };
    const reserve = (auth: HumanAuthority, legacy: HubState, projectId: string, row: SessionRow, hint: WorkExecutionHint, operationId: string, association: Control['FlowAssociation']) => {
        if (auth.actor.kind !== 'human' || auth.actor.role !== 'operator' || auth.actor.readOnly || auth.actor.projectIds && !auth.actor.projectIds.includes(projectId))
            fail(403, 'human-operator-required', 'Current original human operator is required');
        if (association.mode !== 'ad-hoc')
            fail(409, 'conflicting-association', 'Managed Attempt uses server association alongside explicit ad-hoc wire consent');
        const { a } = attempt(projectId, hint.attemptId);
        if (a.version !== hint.expectedVersion)
            fail(409, 'version-conflict', 'Attempt version changed');
        const { state, ctx } = guard(legacy, projectId, a);
        assertKnownExecutions(projectId, a.id, state);
        if (store.work.reservationsForAttempt(projectId, a.id).some(r => r.state === 'reserved'))
            fail(409, 'execution-allocation-uncertain', 'An existing execution reservation must reconcile before another dispatch');
        const fr = state.records.find(r => r.id === a.flowRevisionId && r.kind === 'flow-revision'), ir = state.records.find(r => r.id === a.intentRevisionId && r.kind === 'intent-revision');
        if (!fr || !ir || !('contentDigest' in fr) || !('contentDigest' in ir))
            fail(409, 'missing-pins', 'Approved work revision unavailable');
        const pins = { attemptId: a.id, flowId: a.flowId, intentId: a.intentId, flowRevisionId: a.flowRevisionId, intentRevisionId: a.intentRevisionId, contextSnapshotId: a.contextSnapshotId, flowRevisionDigest: fr.contentDigest, intentRevisionDigest: ir.contentDigest, contextDigest: ctx.contentDigest };
        const reservation: WorkExecutionReservation = { ...pins, operationId, projectId, actorId: auth.actor.id, sessionDigest: auth.sessionDigest, sessionId: row.record.sessionId, machineId: row.record.machineId, checkoutId: row.record.checkoutId, associationDigest: workDigest(pins), wireAssociationDigest: canonicalDigest(association), createdAt: new Date().toISOString(), state: 'reserved', runId: null, turnId: null };
        store.work.saveExecutionReservation(reservation);
        return reservation;
    };
    const beforeAdmission = (auth: HumanAuthority, row: SessionRow, operationId: string) => {
        const reservation = store.work.executionReservation(operationId);
        if (!reservation)
            return;
        if (reservation.state === 'bound')
            fail(409, 'execution-already-allocated', 'Original reservation already has an immutable run');
        if (reservation.actorId !== auth.actor.id || reservation.sessionDigest !== auth.sessionDigest || reservation.sessionId !== row.record.sessionId || reservation.projectId !== row.record.projectId || reservation.machineId !== row.record.machineId || reservation.checkoutId !== row.record.checkoutId)
            fail(403, 'work-binding-authority', 'Reservation belongs to a different original authority');
        const { a } = attempt(reservation.projectId, reservation.attemptId);
        const { state } = guard(store.load(), reservation.projectId, a);
        assertKnownExecutions(reservation.projectId, a.id, state);
        if (store.work.reservationsForAttempt(reservation.projectId, a.id).some(r => r.state === 'reserved' && r.operationId !== operationId))
            fail(409, 'execution-allocation-uncertain', 'Another execution reservation must reconcile before delayed admission');
        if (a.flowRevisionId !== reservation.flowRevisionId || a.intentRevisionId !== reservation.intentRevisionId || a.contextSnapshotId !== reservation.contextSnapshotId)
            fail(409, 'work-association-stale', 'Reserved pins changed');
    };
    const facts = (projectId: string, input: ExecutionBindingInput, requireActor?: Principal): VerifiedExecution => {
        const reservation = store.work.reservationForRun(input.runId), run = store.remote.get<RunRow>('remote_run', input.runId);
        if (!reservation || !run || reservation.projectId !== projectId || run.projectId !== projectId || reservation.state !== 'bound' || reservation.attemptId !== input.attemptId)
            fail(404, 'not-found', 'Original managed execution association not found');
        const command = store.remote.get<StoredCommand>('remote_command', run.commandId), session = store.remote.get<SessionRow>('remote_session', run.sessionId), machine = store.remote.get<MachineRecord>('remote_machine', run.machineId);
        if (!command || !session || !machine || command.operationId !== reservation.operationId || command.authority.actor.id !== reservation.actorId || command.authority.sessionDigest !== reservation.sessionDigest || !executionBinding(command, run) || canonicalDigest(run.association) !== reservation.wireAssociationDigest || reservation.sessionId !== run.sessionId || reservation.machineId !== run.machineId || reservation.checkoutId !== run.checkoutId || reservation.runId !== run.runId || reservation.turnId !== run.turnId || session.record.projectId !== projectId || session.record.machineId !== machine.machineId)
            fail(409, 'execution-proof-mismatch', 'Immutable original execution proof is unavailable');
        if (requireActor && (requireActor.kind !== 'human' || requireActor.role !== 'operator' || requireActor.id !== reservation.actorId || requireActor.readOnly))
            fail(403, 'original-operator-required', 'Only the original human operator can bind this run');
        if (input.sessionId !== run.sessionId || input.turnId !== run.turnId || input.machineId !== run.machineId || input.checkoutId !== run.checkoutId || input.associationDigest !== reservation.associationDigest)
            fail(409, 'execution-proof-mismatch', 'Execution references differ from original allocation');
        const terminal = ['succeeded', 'failed', 'cancelled', 'rejected'].includes(run.state) && !!run.terminalAt;
        const unavailable = machine.revoked || machine.recoveryRequired || !machine.projectIds.includes(projectId) || ['unknown', 'lost'].includes(run.state);
        return { originalOperatorId: reservation.actorId, projectId, sessionId: run.sessionId, runId: run.runId, turnId: run.turnId, machineId: run.machineId, checkoutId: run.checkoutId, associationDigest: reservation.associationDigest, flowRevisionId: reservation.flowRevisionId, intentRevisionId: reservation.intentRevisionId, contextSnapshotId: reservation.contextSnapshotId, contextObservation: 'unverified', observedContextDigest: null, executionOutcome: terminal ? 'known-terminal' : unavailable ? 'unknown' : 'active' };
    };
    const assertKnownExecutions = (projectId: string, attemptId: string, state: WorkState) => {
        for (const link of state.records.filter((r): r is ExecutionLink => r.kind === 'execution-link' && r.attemptId === attemptId))
            if (facts(projectId, link).executionOutcome === 'unknown')
                fail(409, 'execution-allocation-uncertain', 'Reconcile existing unknown execution before another managed admission');
    };
    const verifyExecution = (actor: Principal, projectId: string, input: ExecutionBindingInput) => facts(projectId, input, actor);
    const inspectExecution = (projectId: string, link: ExecutionLink) => facts(projectId, link);
    const admitted = (run: RunRow, operationId: string) => {
        const reservation = store.work.executionReservation(operationId);
        if (!reservation)
            return;
        if (reservation.state === 'bound' && reservation.runId !== run.runId)
            fail(409, 'execution-already-allocated', 'Reservation already owns another run');
        if (reservation.projectId !== run.projectId || reservation.sessionId !== run.sessionId || canonicalDigest(run.association) !== reservation.wireAssociationDigest)
            fail(409, 'execution-proof-mismatch', 'Allocated run differs from reservation');
        reservation.state = 'bound';
        reservation.runId = run.runId;
        reservation.turnId = run.turnId;
        store.work.saveExecutionReservation(reservation);
        const { state, a } = attempt(run.projectId, reservation.attemptId), command = store.remote.get<StoredCommand>('remote_command', run.commandId);
        if (!command)
            fail(409, 'execution-proof-missing', 'Original execution command missing');
        workCommand(state, command.authority.actor, run.projectId, { operationId: 'execution-bind:' + operationId, expectedVersions: { [a.id]: a.version }, command: 'execution.bind', payload: { attemptId: a.id, sessionId: run.sessionId, runId: run.runId, turnId: run.turnId, machineId: run.machineId, checkoutId: run.checkoutId, associationDigest: reservation.associationDigest } }, { legacy: store.load(), now: () => new Date().toISOString(), verifyExecution, inspectExecution });
        store.work.save(run.projectId, state);
    };
    const hasPendingExecution = (projectId: string, attemptId: string) => store.work.reservationsForAttempt(projectId, attemptId).some(r => r.state === 'reserved');
    const context: Pick<WorkContext, 'verifyExecution' | 'inspectExecution' | 'hasPendingExecution'> = { verifyExecution, inspectExecution, hasPendingExecution };
    return { reserve, beforeAdmission, admitted, ...context };
}
