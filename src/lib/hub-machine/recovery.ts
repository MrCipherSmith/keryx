import { canonicalDigest, validateControl, type Control } from '../../remote-control/protocol';
import { MachineError } from './errors';
export interface RecoverySnapshot {
    runs: Control['RecoveryPage']['runs'];
    sessions: Control['RecoveryPage']['sessions'];
    hubSequence: number;
}
export async function readAllRecovery(read: (cursor: number) => Promise<unknown>): Promise<RecoverySnapshot> {
    const runs = new Map<string, Control['RecoveryPage']['runs'][number]>(), sessions = new Map<string, Control['SessionRecord']>();
    let cursor = 0, hubSequence: number | undefined;
    for (let page = 0; page < 1000; page++) {
        const checked = validateControl('RecoveryPage', await read(cursor));
        if (!checked.ok)
            throw new MachineError('recovery-required');
        const value = checked.value;
        if (hubSequence !== undefined && hubSequence !== value.hubSequence)
            throw new MachineError('recovery-snapshot-changed');
        hubSequence = value.hubSequence;
        for (const run of value.runs) {
            const prior = runs.get(run.runId);
            if (prior && canonicalDigest(prior) !== canonicalDigest(run))
                throw new MachineError('recovery-snapshot-changed');
            runs.set(run.runId, run);
        }
        for (const session of value.sessions) {
            const prior = sessions.get(session.sessionId);
            if (prior && canonicalDigest(prior) !== canonicalDigest(session))
                throw new MachineError('recovery-snapshot-changed');
            sessions.set(session.sessionId, session);
        }
        if (runs.size > 100000 || sessions.size > 100000)
            throw new MachineError('quota-exceeded');
        if (!value.hasMore)
            return { runs: [...runs.values()], sessions: [...sessions.values()], hubSequence };
        if (value.cursor <= cursor)
            throw new MachineError('replay-gap');
        cursor = value.cursor;
    }
    throw new MachineError('quota-exceeded');
}
export function verifyReconciliationReceipt(value: unknown, report: Control['ReconciliationReport'], machineId: string, now: number): value is Control['ReconciliationReceipt'] {
    const checked = validateControl('ReconciliationReceipt', value);
    if (!checked.ok)
        return false;
    const receipt = checked.value, received = Date.parse(receipt.receivedAt);
    return receipt.machineId === machineId && receipt.reportDigest === canonicalDigest(report) && received <= now + 5000 && received >= now - 30000
        && receipt.runId === report.runId && receipt.projectId === report.projectId && receipt.checkoutId === report.checkoutId && receipt.ledgerId === report.ledgerId && receipt.daemonId === report.daemonId
        && receipt.expectedRunVersion === report.expectedRunVersion && receipt.observation === report.observation && receipt.sessionId === report.sessionId && receipt.turnId === report.turnId;
}
