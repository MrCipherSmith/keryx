import { keryxConfigDir } from '../config-dir';
import { listEnrollments } from './config';
import { readMachinePolicy } from './policy';
import { MachineBridge } from './bridge';
import { machineFailure } from './errors';
import { startLocalOwnerControl, type LocalOwnerRequest, type LocalOwnerResult } from './local-control';
export interface LocalOwnerControlTarget {
    localOwnerControl(request: LocalOwnerRequest): Promise<LocalOwnerResult>;
}
/** One owner-only installation socket. A request reaches only the live bridge enrolled for its exact hubId; there is no default route. */
export function startMachineOwnerControl(configDir: string, bridges: ReadonlyMap<string, LocalOwnerControlTarget>): Promise<{
    stop(): Promise<void>;
}> {
    return startLocalOwnerControl({ configDir, handle: async (request) => {
            const bridge = bridges.get(request.hubId);
            return bridge ? bridge.localOwnerControl(request) : { ok: false, error: { code: 'scope-denied', message: 'scope-denied' } };
        } });
}
/** Called only after existing serve opt-in, credential, bind and policy gates succeed. Adds no network listener; the owner channel is a local Unix socket. */
export async function startConfiguredMachineBridges(options: {
    configDir?: string;
    onNotice?: (code: string) => void;
} = {}): Promise<{
    count: number;
    stop(): Promise<void>;
}> {
    const configDir = keryxConfigDir(options.configDir);
    const bridges: MachineBridge[] = [];
    let enrollments;
    try {
        enrollments = listEnrollments(configDir);
    }
    catch (cause) {
        options.onNotice?.(machineFailure(cause).code);
        return { count: 0, async stop() { } };
    }
    for (const enrollment of enrollments) {
        try {
            const policy = readMachinePolicy(configDir, enrollment.hubId);
            if (!policy?.enabled) {
                options.onNotice?.('machine-policy-required');
                continue;
            }
            const bridge = new MachineBridge({ configDir, enrollment, policy, ...(options.onNotice ? { onNotice: options.onNotice } : {}) });
            await bridge.start();
            bridges.push(bridge);
        }
        catch (cause) {
            options.onNotice?.(machineFailure(cause).code);
        }
    }
    // Recovery stays unavailable rather than replacing an existing endpoint; the bridges themselves are unaffected.
    let owner: { stop(): Promise<void> } | undefined;
    if (bridges.length > 0) {
        try {
            owner = await startMachineOwnerControl(configDir, new Map(bridges.map(bridge => [bridge.hubId, bridge])));
        }
        catch (cause) {
            options.onNotice?.(machineFailure(cause).code);
        }
    }
    return { count: bridges.length, async stop() {
            // The owner channel closes first, so no new local request races bridge disposal.
            try {
                await owner?.stop();
            }
            catch (cause) {
                options.onNotice?.(machineFailure(cause).code);
            }
            // Every bridge finishes stopping before a failure is reported, so a rejecting one never cuts the others short.
            const stopped = await Promise.allSettled(bridges.map(b => b.stop()));
            const failed = stopped.find(result => result.status === 'rejected');
            if (failed)
                throw failed.reason;
        } };
}
