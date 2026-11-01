import type { HubState } from '../store';
import type { Control } from '../../remote-control/protocol';
import type { HumanAuthority, SessionRow, QueueRow } from './model';
import type { SessionDependencies } from './sessions';

/** Injected by Hub composition; remote transport does not construct work storage/domain. */
export type ManagedExecutionPort = Required<Pick<SessionDependencies, 'beforeAdmission' | 'admitted' | 'admissionRefused'>> & {
    hint(request: Request): {attemptId: string; expectedVersion: number} | undefined;
    reserve(auth: HumanAuthority, state: HubState, projectId: string, row: SessionRow, hint: {attemptId:string; expectedVersion:number}, operationId: string, association: Control['FlowAssociation']): unknown;
    reconcileSession(sessionId: string): void;
    queueObserved(event: Control["SessionEvent"], previous?: QueueRow): void;
};
