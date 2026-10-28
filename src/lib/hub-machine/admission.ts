import type { Control } from '../../remote-control/protocol';
import type { GrantApplication } from './client';
import type { MachineResult } from './errors';
/** The durable uncertain-start marker precedes the final one-use freshness check. */
export function applyStartingCommand<T>(application: GrantApplication, markStarting: () => void, start: (grant: Control['AuthorizationGrant']) => T | Promise<T>): Promise<MachineResult<T>> {
    markStarting();
    return application.apply(start);
}
