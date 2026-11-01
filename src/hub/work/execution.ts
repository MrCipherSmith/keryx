import type { Principal } from '../contracts';
import type { HubStore, HubState } from '../store';
import { fail } from '../domain';
import { executionBinding } from '../remote-v2/execution';
import type { HumanAuthority, MachineRecord, RunRow, SessionRow, StoredCommand, QueueRow, OperationRecord } from '../remote-v2/model';
import type { Control } from '../../remote-control/protocol';
import { canonicalDigest, validateControl } from '../../remote-control/protocol';
import { workCommand, workDigest, pendingAmendments, type ExecutionBindingInput, type VerifiedExecution, type WorkContext } from './domain';
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
    state: 'reserved' | 'bound' | 'released';
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
        const state = store.work.recordState(projectId, attemptId);
        const a = state.records.find((r): r is Attempt => r.kind === 'attempt' && r.id === attemptId);
        if (!a)
            fail(404, 'not-found', 'Attempt not found');
        return { state, a };
    };
    const guard = (legacy: HubState, projectId: string, a: Attempt, state: WorkState) => {
        const f = state.records.find((r): r is WorkFlow => r.kind === 'flow' && r.id === a.flowId), i = state.records.find((r): r is WorkIntent => r.kind === 'intent' && r.id === a.intentId), ctx = state.records.find((r): r is ContextSnapshot => r.kind === 'context' && r.id === a.contextSnapshotId);
        if (!legacy.projects.some(p => p.id === projectId) || !f || !i || !ctx)
            fail(404, 'not-found', 'Work association not found');
        if (!['running', 'blocked'].includes(a.state) || f.state !== 'in-progress' || !['in-progress', 'in-review'].includes(i.state) || f.approvedRevisionId !== a.flowRevisionId || i.approvedRevisionId !== a.intentRevisionId || ctx.flowRevisionId !== a.flowRevisionId || ctx.intentRevisionId !== a.intentRevisionId)
            fail(409, 'work-association-stale', 'Execution requires current started Attempt and approved work pins');
        if (ctx.entries.some(e => e.required && e.resolution !== 'resolved'))
            fail(409, 'context-unavailable', 'Required immutable context is unavailable');
        if (pendingAmendments(state.records,f.id,i.id).length)
            fail(409, 'pending-amendment', 'Resolve requirements amendment before dispatch');
        return { state, f, i, ctx };
    };
    const release = (operationId: string) => {
        const reservation = store.work.executionReservation(operationId);
        if (reservation?.state === 'reserved') store.work.saveExecutionReservation({...reservation, state:'released'});
    };
    const sourceReservation = (operationId: string, sessionId?: string) => {
        const operation = store.remote.get<OperationRecord>('remote_operation',operationId);
        const parsed = operation && validateControl('QueueReauthorize',operation.request);
        if (!parsed?.ok) return;
        const source = store.remote.get<QueueRow>('remote_queue',parsed.value.queueItemId);
        if (!source || source.item.operationId !== parsed.value.originalOperationId || sessionId && source.sessionId !== sessionId) return;
        const queue = store.remote.all<QueueRow>('remote_queue',{sessionId:source.sessionId});
        let original: string | null = source.item.operationId;
        for (let depth=0; original && depth<=queue.length; depth++) {
            const reservation = store.work.executionReservation(original);
            if (reservation) return reservation.sessionId === source.sessionId && reservation.projectId === source.projectId && reservation.machineId === source.machineId ? reservation : undefined;
            original = queue.find(row => row.item.operationId === original)?.item.replacesOperationId ?? null;
        }
    };
    const reconcileSession = (sessionId: string) => {
        const session = store.remote.get<SessionRow>('remote_session',sessionId);
        const queue = store.remote.all<QueueRow>('remote_queue',{sessionId});
        const commands = store.remote.all<StoredCommand>('remote_command',{sessionId});
        const operations = store.remote.all<OperationRecord>('remote_operation',{sessionId});
        for (const reservation of store.work.pendingReservationsForSession(sessionId)) {
            if (reservation.state !== 'reserved') continue;
            const original = queue.find(row => row.item.operationId === reservation.operationId);
            const liveReplacement = queue.some(row => ['queued','suspended'].includes(row.item.state) && sourceReservation(row.item.operationId,sessionId)?.operationId === reservation.operationId);
            const pendingReplacement = operations.some(operation => {
                const request = validateControl('QueueReauthorize',operation.request);
                const edit = validateControl('QueueEdit',operation.request);
                const replacesOriginal = request.ok && sourceReservation(operation.id,sessionId)?.operationId === reservation.operationId || edit.ok && original?.item.queueItemId === edit.value.queueItemId;
                if (!replacesOriginal || queue.some(row => row.item.operationId === operation.id)) return false;
                const response = operation.response as {status?:string};
                return !['rejected','not-applied'].includes(response.status ?? '');
            });
            const refused = commands.some(command => command.operationId === reservation.operationId && (command.status === 'rejected' || command.status === 'not-applied' && command.receipt && typeof command.receipt === 'object' && 'errorCode' in command.receipt && command.receipt.errorCode !== 'recovery-required'));
            if (refused || session?.record.state === 'closed' && !!session.closedProof || original && ['removed','rejected'].includes(original.item.state) && !liveReplacement && !pendingReplacement) release(reservation.operationId);
        }
    };
    const reserve = (auth: HumanAuthority, legacy: HubState, projectId: string, row: SessionRow, hint: WorkExecutionHint, operationId: string, association: Control['FlowAssociation']) => {
        if (auth.actor.kind !== 'human' || auth.actor.role !== 'operator' || auth.actor.readOnly || auth.actor.projectIds && !auth.actor.projectIds.includes(projectId))
            fail(403, 'human-operator-required', 'Current original human operator is required');
        if (association.mode !== 'ad-hoc')
            fail(409, 'conflicting-association', 'Managed Attempt uses server association alongside explicit ad-hoc wire consent');
        const { a, state: attemptState } = attempt(projectId, hint.attemptId);
        if (a.version !== hint.expectedVersion)
            fail(409, 'version-conflict', 'Attempt version changed');
        const { state, ctx } = guard(legacy, projectId, a, attemptState);
        assertKnownExecutions(projectId, a.id, state);
        if (hasPendingExecution(projectId, a.id))
            fail(409, 'execution-allocation-uncertain', 'An existing execution reservation must reconcile before another dispatch');
        const fr = state.records.find(r => r.id === a.flowRevisionId && r.kind === 'flow-revision'), ir = state.records.find(r => r.id === a.intentRevisionId && r.kind === 'intent-revision');
        if (!fr || !ir || !('contentDigest' in fr) || !('contentDigest' in ir))
            fail(409, 'missing-pins', 'Approved work revision unavailable');
        const pins = { attemptId: a.id, flowId: a.flowId, intentId: a.intentId, flowRevisionId: a.flowRevisionId, intentRevisionId: a.intentRevisionId, contextSnapshotId: a.contextSnapshotId, flowRevisionDigest: fr.contentDigest, intentRevisionDigest: ir.contentDigest, contextDigest: ctx.contentDigest };
        const reservation: WorkExecutionReservation = { ...pins, operationId, projectId, actorId: auth.actor.id, sessionDigest: auth.sessionDigest, sessionId: row.record.sessionId, machineId: row.record.machineId, checkoutId: row.record.checkoutId, associationDigest: workDigest(pins), wireAssociationDigest: canonicalDigest(association), createdAt: new Date().toISOString(), state: 'reserved', runId: null, turnId: null };
        store.work.saveExecutionReservation(reservation);
        return reservation;
    };
    const queueObserved = (event: Control['SessionEvent'], previous?:QueueRow) => {
        if (event.kind !== 'queue-changed') return;
        const operation = store.remote.get<OperationRecord>('remote_operation',event.item.operationId);
        const edit = operation && validateControl('QueueEdit',operation.request);
        if (!operation || !edit?.ok || store.work.executionReservation(operation.id)) return;
        const source = previous?.item.queueItemId === edit.value.queueItemId ? previous : store.remote.get<QueueRow>('remote_queue',edit.value.queueItemId);
        if (!source || source.item.operationId === operation.id) return;
        const reservation = store.work.executionReservation(source.item.operationId) ?? sourceReservation(source.item.operationId,event.sessionId);
        if (!reservation) return;
        if (reservation.state !== 'reserved' || reservation.sessionId !== event.sessionId || reservation.projectId !== event.projectId || reservation.machineId !== source.machineId || event.item.replacesOperationId !== source.item.operationId || event.item.text !== edit.value.text) fail(409,'work-binding-authority','Edited managed queue requires exact original reservation');
        release(reservation.operationId);
        store.work.saveExecutionReservation({...reservation,operationId:operation.id,actorId:operation.actorId,sessionDigest:operation.sessionDigest,state:'reserved'});
    };
    const beforeAdmission = (auth: HumanAuthority, row: SessionRow, operationId: string, legacy:HubState) => {
        let reservation = store.work.executionReservation(operationId);
        if (!reservation) {
            const source = sourceReservation(operationId,row.record.sessionId);
            if (!source) return;
            if (source.state !== 'reserved') fail(409,'execution-reservation-released','Original managed queue reservation is no longer available');
            const replacement = store.remote.get<OperationRecord>('remote_operation',operationId);
            const queued = store.remote.all<QueueRow>('remote_queue',{sessionId:row.record.sessionId}).find(item => item.item.operationId === operationId);
            if (!replacement || !queued || queued.projectId !== source.projectId || queued.machineId !== source.machineId || !['queued','suspended'].includes(queued.item.state) || replacement.actorId !== auth.actor.id || replacement.sessionDigest !== auth.sessionDigest || auth.actor.kind !== 'human' || auth.actor.role !== 'operator' || auth.actor.readOnly || auth.actor.projectIds && !auth.actor.projectIds.includes(source.projectId)) fail(403,'work-binding-authority','Replacement requires its exact currently authorized operator');
            release(source.operationId);
            reservation = {...source,operationId,actorId:auth.actor.id,sessionDigest:auth.sessionDigest,state:'reserved'};
            store.work.saveExecutionReservation(reservation);
        }
        if (reservation.state !== 'reserved')
            fail(409, 'execution-already-allocated', 'Original reservation already has an immutable run');
        if (reservation.actorId !== auth.actor.id || reservation.sessionDigest !== auth.sessionDigest || reservation.sessionId !== row.record.sessionId || reservation.projectId !== row.record.projectId || reservation.machineId !== row.record.machineId || reservation.checkoutId !== row.record.checkoutId)
            fail(403, 'work-binding-authority', 'Reservation belongs to a different original authority');
        const { a, state: attemptState } = attempt(reservation.projectId, reservation.attemptId);
        const { state } = guard(legacy, reservation.projectId, a, attemptState);
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
        if (!command || !session || !machine)
            fail(409, 'execution-proof-mismatch', 'Immutable original execution proof is unavailable');
        const originalAuthority = command.operationId === reservation.operationId && command.authority.actor.id === reservation.actorId && command.authority.sessionDigest === reservation.sessionDigest;
        const originalCommand = executionBinding(command, run) && canonicalDigest(run.association) === reservation.wireAssociationDigest;
        const allocatedRun = reservation.sessionId === run.sessionId && reservation.machineId === run.machineId && reservation.checkoutId === run.checkoutId && reservation.runId === run.runId && reservation.turnId === run.turnId;
        const scopedSession = session.record.projectId === projectId && session.record.machineId === machine.machineId;
        if (!originalAuthority || !originalCommand || !allocatedRun || !scopedSession)
            fail(409, 'execution-proof-mismatch', 'Immutable original execution proof is unavailable');
        if (requireActor && (requireActor.kind !== 'human' || requireActor.role !== 'operator' || requireActor.id !== reservation.actorId || requireActor.readOnly))
            fail(403, 'original-operator-required', 'Only the original human operator can bind this run');
        if (input.sessionId !== run.sessionId || input.turnId !== run.turnId || input.machineId !== run.machineId || input.checkoutId !== run.checkoutId || input.associationDigest !== reservation.associationDigest)
            fail(409, 'execution-proof-mismatch', 'Execution references differ from original allocation');
        const terminal = ['succeeded', 'failed', 'cancelled', 'rejected', 'lost'].includes(run.state) && !!run.terminalAt;
        const unavailable = machine.revoked || machine.recoveryRequired || !machine.projectIds.includes(projectId) || run.state === 'unknown';
        return { originalOperatorId: reservation.actorId, projectId, sessionId: run.sessionId, runId: run.runId, turnId: run.turnId, machineId: run.machineId, checkoutId: run.checkoutId, associationDigest: reservation.associationDigest, flowRevisionId: reservation.flowRevisionId, intentRevisionId: reservation.intentRevisionId, contextSnapshotId: reservation.contextSnapshotId, contextObservation: 'unverified', observedContextDigest: null, executionOutcome: terminal ? 'known-terminal' : unavailable ? 'unknown' : 'active' };
    };
    const assertKnownExecutions = (projectId: string, attemptId: string, state: WorkState) => {
        for (const link of state.records.filter((r): r is ExecutionLink => r.kind === 'execution-link' && r.attemptId === attemptId))
            if (facts(projectId, link).executionOutcome === 'unknown')
                fail(409, 'execution-allocation-uncertain', 'Reconcile existing unknown execution before another managed admission');
    };
    const verifyExecution = (actor: Principal, projectId: string, input: ExecutionBindingInput) => facts(projectId, input, actor);
    const inspectExecution = (projectId: string, link: ExecutionLink) => facts(projectId, link);
    const admitted = (run: RunRow, operationId: string, legacy:HubState) => {
        const reservation = store.work.executionReservation(operationId);
        if (!reservation)
            return;
        if (reservation.state === 'released') fail(409,'execution-reservation-released','Reservation ended before admission');
        if (reservation.state === 'bound' && reservation.runId !== run.runId)
            fail(409, 'execution-already-allocated', 'Reservation already owns another run');
        if (reservation.projectId !== run.projectId || reservation.sessionId !== run.sessionId || canonicalDigest(run.association) !== reservation.wireAssociationDigest)
            fail(409, 'execution-proof-mismatch', 'Allocated run differs from reservation');
        reservation.state = 'bound';
        reservation.runId = run.runId;
        reservation.turnId = run.turnId;
        store.work.saveExecutionReservation(reservation);
        const state = store.work.commandState(run.projectId, { command: 'execution.bind', operationId: 'execution-bind:' + operationId, payload: { attemptId: reservation.attemptId } }, reservation.actorId);
        const a = state.records.find((record): record is Attempt => record.kind === 'attempt' && record.id === reservation.attemptId);
        if (!a) fail(404, 'not-found', 'Attempt not found');
        const command = store.remote.get<StoredCommand>('remote_command', run.commandId);
        if (!command)
            fail(409, 'execution-proof-missing', 'Original execution command missing');
        workCommand(state, command.authority.actor, run.projectId, { operationId: 'execution-bind:' + operationId, expectedVersions: { [a.id]: a.version }, command: 'execution.bind', payload: { attemptId: a.id, sessionId: run.sessionId, runId: run.runId, turnId: run.turnId, machineId: run.machineId, checkoutId: run.checkoutId, associationDigest: reservation.associationDigest } }, { legacy, now: () => new Date().toISOString(), verifyExecution, inspectExecution });
        store.work.save(run.projectId, state);
    };
    const hasPendingExecution = (projectId: string, attemptId: string) => {
        const reservations = store.work.reservationsForAttempt(projectId, attemptId);
        for (const sessionId of new Set(reservations.filter(reservation => reservation.state === 'reserved').map(reservation => reservation.sessionId))) reconcileSession(sessionId);
        return store.work.reservationsForAttempt(projectId, attemptId).some(reservation => reservation.state === 'reserved');
    };
    const context: Pick<WorkContext, 'verifyExecution' | 'inspectExecution' | 'hasPendingExecution'> = { verifyExecution, inspectExecution, hasPendingExecution };
    const admissionRefused = (operationId: string) => {
        const reservation = store.work.executionReservation(operationId) ?? sourceReservation(operationId);
        if (reservation) release(reservation.operationId);
    };
    return { hint:workExecutionHint, reserve, beforeAdmission, admitted, reconcileSession, admissionRefused, queueObserved, ...context };
}
