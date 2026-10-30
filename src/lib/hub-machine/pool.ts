import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirectory, protectedWrite, validateProtectedFile } from './secure-state';
import { MachineError } from './errors';
import type { Control } from '../../remote-control/protocol';
/** Actual evidence about one message attempt, read after the host answered it. */
export interface NonadmissionEvidence {
    runId: string;
    turnId: string;
    receipt: { status: string; runId: string | null };
    session: Pick<Control['SessionRecord'], 'state' | 'activeRunId' | 'activeTurnId'>;
    /** The bridge ever observed this run running or terminal. */
    nativeObserved: boolean;
}
/** Proven only when the host refused this exact attempt and holds no live or unknown work for it. Anything else is unknown. */
export function provenNonadmission(evidence: NonadmissionEvidence): boolean {
    return evidence.receipt.status === 'rejected' && evidence.receipt.runId === null && !evidence.nativeObserved && evidence.session.state !== 'recovery-required'
        && evidence.session.activeRunId !== evidence.runId && evidence.session.activeTurnId !== evidence.turnId;
}
/** Physical-installation ceiling shared by every enrollment and daemon using this state root. */
export class MachineExecutionPool {
    private readonly db: Database;
    constructor(file: string) { ensurePrivateDirectory(path.dirname(file)); if (existsSync(file))
        validateProtectedFile(file, 1048576);
    else
        try {
            protectedWrite(file, '', true);
        }
        catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'EEXIST')
                throw cause;
        } this.db = new Database(file, { strict: true }); this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS execution_pool(hubId TEXT NOT NULL,runId TEXT NOT NULL,daemonId TEXT NOT NULL,nonce TEXT NOT NULL,PRIMARY KEY(hubId,runId));'); }
    claim(input: {
        hubId: string;
        runId: string;
        daemonId: string;
        limit: number;
    }): {
        nonce: string;
    } { return this.db.transaction(() => { if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 2)
        throw new MachineError('invalid-budget'); const old = this.db.query<{
        daemonId: string;
        nonce: string;
    }, [
        string,
        string
    ]>('SELECT daemonId,nonce FROM execution_pool WHERE hubId=? AND runId=?').get(input.hubId, input.runId); if (old) {
        if (old.daemonId !== input.daemonId)
            throw new MachineError('recovery-required');
        return { nonce: old.nonce };
    } const total = this.db.query<{
        n: number;
    }, [
    ]>('SELECT count(*) AS n FROM execution_pool').get()!.n; const scoped = this.db.query<{
        n: number;
    }, [
        string
    ]>('SELECT count(*) AS n FROM execution_pool WHERE hubId=?').get(input.hubId)!.n; if (total >= 2 || scoped >= input.limit)
        throw new MachineError('machine-busy'); const nonce = randomUUID(); this.db.query('INSERT INTO execution_pool VALUES(?,?,?,?)').run(input.hubId, input.runId, input.daemonId, nonce); return { nonce }; }).immediate(); }
    release(hubId: string, runId: string, nonce: string): void { if (this.db.query('DELETE FROM execution_pool WHERE hubId=? AND runId=? AND nonce=?').run(hubId, runId, nonce).changes !== 1)
        throw new MachineError('lease-owner-mismatch'); }
    /** Releases one exact reservation on proven nonadmission. Unknown evidence keeps the capacity and its nonce for later exact proof. */
    releaseNonadmitted(hubId: string, runId: string, nonce: string, evidence: NonadmissionEvidence): boolean { if (evidence.runId !== runId)
        return false; const owned = this.db.query<{
        nonce: string;
    }, [
        string,
        string
    ]>('SELECT nonce FROM execution_pool WHERE hubId=? AND runId=?').get(hubId, runId); if (!owned || owned.nonce !== nonce)
        throw new MachineError('lease-owner-mismatch'); if (!provenNonadmission(evidence))
        return false; this.release(hubId, runId, nonce); return true; }
    /** Reservations of one Hub, oldest daemon state included: what a crash left held is visible, never inferred from age. */
    reservations(hubId: string): Array<{ runId: string; daemonId: string }> { return this.db.query<{ runId: string; daemonId: string }, [string]>('SELECT runId,daemonId FROM execution_pool WHERE hubId=? ORDER BY runId LIMIT 1000').all(hubId); }
    /**
     * Releases a crashed daemon's reservation for one run, only for its exact recorded daemon and only after the caller
     * proved absence and Hub recorded a human resolution. Absent is idempotent; another owner is refused, never overwritten.
     */
    releaseRecovered(hubId: string, runId: string, daemonId: string): boolean { return this.db.transaction(() => { const owned = this.db.query<{ daemonId: string }, [string, string]>('SELECT daemonId FROM execution_pool WHERE hubId=? AND runId=?').get(hubId, runId); if (!owned)
        return false; if (owned.daemonId !== daemonId)
        throw new MachineError('lease-owner-mismatch'); this.db.query('DELETE FROM execution_pool WHERE hubId=? AND runId=? AND daemonId=?').run(hubId, runId, daemonId); return true; }).immediate(); }
    close(): void { this.db.close(); }
}
