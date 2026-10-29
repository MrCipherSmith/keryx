import { canonicalDigest, validateControl, LIMITS, type Control } from '../../remote-control/protocol';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { MachineError } from './errors';
import { ensurePrivateDirectory, validateProtectedFile, protectedWrite } from './secure-state';
export interface CommandClaim {
    hubId: string;
    commandId: string;
    digest: string;
    runId: string | null;
    checkoutId: string;
    hubSequence?: number;
    envelope?: unknown;
    /** The daemon that claims the command, recorded before any effect so a crash leaves an owner identity. */
    daemonId?: string;
    /** New work (a turn, a run-scoped command or a new/forked session). Refused near the event cap so admitted runs keep headroom. */
    launch?: boolean;
}
type Phase = 'received' | 'starting' | 'unknown' | 'applied' | 'rejected' | 'lost';
/** Retained run/session events. Critical events are never refused by this count; new launches stop short of it. */
export const LEDGER_EVENT_CAPACITY = 100000;
/** Critical-event headroom kept for already admitted runs once new launches are refused. */
export const LEDGER_LAUNCH_HEADROOM = 2000;
/** Discarded-log metadata bound; beyond it a log chunk cannot even be recorded as a gap. */
const DISCARD_CAPACITY = 2 * LEDGER_EVENT_CAPACITY;
const MiB = 1024 * 1024;
/** Reopen bound. A larger control.sqlite is refused at open with `ledger-size-exceeded`; it is never truncated to make it open. */
export const LEDGER_FILE_LIMIT = 64 * MiB;
/** Stored bytes at which new launches stop, leaving 24 MiB below the reopen bound for the critical events of runs already admitted. */
export const LEDGER_LAUNCH_BYTE_LIMIT = 40 * MiB;
/** Stored bytes from which log content of admitted runs becomes gap metadata; critical events are still always stored. */
export const LEDGER_LOG_BYTE_LIMIT = 48 * MiB;
/** Spec section 12: log content is retained seven days after its run is terminal. */
export const LOG_RETENTION_MS = 7 * 86400000;
const TERMINAL_RUN_STATES = new Set(['succeeded', 'failed', 'cancelled', 'rejected', 'lost']);
const OWNED_PROCESS_CAPACITY = 10000;
/** Identity of a daemon process, recorded at start so a later crash can be judged without trusting a PID or a lock's age. */
export interface DaemonRecord { daemonId: string; lockNonce: string; pid: number; pgid: number; startedAt: string }
/** One owned process spawn: an `intent` row exists before the spawn, `recorded` once its identity is known. */
export interface OwnedProcessRecord { id: string; daemonId: string; checkoutId: string; sessionId: string; phase: 'intent' | 'recorded'; pid: number | null; pgid: number | null; startedAt: string | null }
type CommandRow = {
    hub: string;
    id: string;
    digest: string;
    run: string | null;
    checkout: string;
    phase: Phase;
    daemon: string | null;
    receipt: string | null;
    sequence: number;
    envelope: string | null;
};
/** One per-Hub ledger. Commands, receipts, launch identities and event tombstones have no automatic pruning; only acknowledged log content of runs terminal for seven days is retired, behind exact durable ranges. */
export class MachineLedger {
    private readonly db: Database;
    readonly ledgerId: string;
    constructor(file: string) {
        ensurePrivateDirectory(path.dirname(file));
        if (existsSync(file)) {
            validateProtectedFile(file, Number.MAX_SAFE_INTEGER);
            // A distinct, visible refusal: an oversized ledger is evidence to keep, never something to truncate or delete.
            if (lstatSync(file).size > LEDGER_FILE_LIMIT)
                throw new MachineError('ledger-size-exceeded');
        }
        else {
            try {
                protectedWrite(file, '', true);
            }
            catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== 'EEXIST')
                    throw cause;
            }
        }
        this.db = new Database(file, { create: false, strict: true });
        this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
        const hasMeta = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='machine_meta'").get();
        const existingVersion = hasMeta ? this.db.query<{
            value: string;
        }, [
        ]>("SELECT value FROM machine_meta WHERE key='version'").get() : null;
        if (existingVersion && !['1', '2', '3', '4', '5', '6', '7'].includes(existingVersion.value)) {
            this.db.close();
            throw new MachineError('unsupported-ledger-version');
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS machine_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS machine_commands(hub TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,run TEXT,checkout TEXT NOT NULL,phase TEXT NOT NULL,daemon TEXT,receipt TEXT,sequence INTEGER NOT NULL DEFAULT 0,envelope TEXT,PRIMARY KEY(hub,id));
   CREATE TABLE IF NOT EXISTS machine_events(stream TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,acked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(stream,seq));
   CREATE TABLE IF NOT EXISTS machine_discarded_logs(stream TEXT NOT NULL,seq INTEGER NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL,gapSeq INTEGER,sent INTEGER NOT NULL DEFAULT 0,acked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(stream,seq));
   CREATE TABLE IF NOT EXISTS machine_reconciliations(digest TEXT PRIMARY KEY,report TEXT NOT NULL,receipt TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS machine_results(runId TEXT PRIMARY KEY,draft TEXT NOT NULL,digest TEXT NOT NULL,upload TEXT,receipt TEXT);
   CREATE TABLE IF NOT EXISTS machine_local_recovery(id TEXT PRIMARY KEY,digest TEXT NOT NULL,sessionId TEXT NOT NULL,phase TEXT NOT NULL,result TEXT);
   CREATE TABLE IF NOT EXISTS machine_operations(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS machine_daemons(daemonId TEXT PRIMARY KEY,lockNonce TEXT NOT NULL,pid INTEGER NOT NULL,pgid INTEGER NOT NULL,startedAt TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS machine_owned_processes(id TEXT PRIMARY KEY,daemonId TEXT NOT NULL,checkoutId TEXT NOT NULL,sessionId TEXT NOT NULL,phase TEXT NOT NULL,pid INTEGER,pgid INTEGER,startedAt TEXT);
   CREATE TABLE IF NOT EXISTS machine_native_leases(token TEXT PRIMARY KEY,daemonId TEXT NOT NULL,sessionId TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS machine_run_recovery(id TEXT PRIMARY KEY,digest TEXT NOT NULL,runId TEXT NOT NULL,step TEXT NOT NULL,phase TEXT NOT NULL,result TEXT);
   CREATE TABLE IF NOT EXISTS machine_run_terminal(stream TEXT PRIMARY KEY,terminalAt INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS machine_retired_logs(stream TEXT NOT NULL,fromSeq INTEGER NOT NULL,toSeq INTEGER NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL,retiredAt INTEGER NOT NULL,PRIMARY KEY(stream,fromSeq));`);
        const version = this.db.query<{
            value: string;
        }, [
        ]>("SELECT value FROM machine_meta WHERE key='version'").get();
        if (version && version.value !== '1' && version.value !== '2' && version.value !== '3' && version.value !== '4' && version.value !== '5' && version.value !== '6' && version.value !== '7') {
            this.db.close();
            throw new MachineError('unsupported-ledger-version');
        }
        if (version?.value === '1') {
            this.db.transaction(() => { this.db.exec('ALTER TABLE machine_commands ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0; ALTER TABLE machine_commands ADD COLUMN envelope TEXT;'); this.db.query("UPDATE machine_meta SET value='2' WHERE key='version'").run(); }).immediate();
        }
        if (version && version.value !== '7') {
            // Runs already terminal before retention existed start their seven days now, never earlier.
            this.db.query("INSERT OR IGNORE INTO machine_run_terminal(stream,terminalAt) SELECT DISTINCT stream,? FROM machine_events WHERE stream LIKE 'run:%' AND json_extract(payload,'$.kind')='state' AND json_extract(payload,'$.state') IN ('succeeded','failed','cancelled','rejected','lost')").run(Date.now());
        }
        this.db.query("INSERT OR IGNORE INTO machine_meta VALUES('version','7')").run();
        this.db.query("INSERT OR IGNORE INTO machine_meta VALUES('ledgerId',?)").run(randomUUID());
        this.db.query("UPDATE machine_meta SET value='7' WHERE key='version'").run();
        this.ledgerId = this.db.query<{
            value: string;
        }, [
        ]>("SELECT value FROM machine_meta WHERE key='ledgerId'").get()!.value;
    }
    /** Claim before the actual local stop. A crash leaves uncertainty; no PID/age-based retry. */
    claimLocalRecovery(id:string,digest:string,sessionId:string):{status:'claimed'}|{status:'unknown'}|{status:'replay';result:unknown}{
        return this.db.transaction(()=>{
            const old=this.db.query<{digest:string;sessionId:string;phase:string;result:string|null},[string]>('SELECT * FROM machine_local_recovery WHERE id=?').get(id);
            if(old){if(old.digest!==digest||old.sessionId!==sessionId)throw new MachineError('payload-conflict');return old.phase==='complete'&&old.result?{status:'replay' as const,result:JSON.parse(old.result)}:{status:'unknown' as const};}
            if(this.db.query("SELECT id FROM machine_local_recovery WHERE sessionId=? AND phase!='complete'").get(sessionId))throw new MachineError('recovery-required');
            if(this.db.query<{n:number},[]>('SELECT count(*) n FROM machine_local_recovery').get()!.n>=1000)throw new MachineError('quota-exceeded');
            this.db.query('INSERT INTO machine_local_recovery(id,digest,sessionId,phase) VALUES(?,?,?,?)').run(id,digest,sessionId,'starting');return{status:'claimed' as const};
        }).immediate();
    }
    finishLocalRecovery(id:string,digest:string,result:unknown,confirmed=true):void{
        const body=JSON.stringify(result);if(Buffer.byteLength(body)>65536)throw new MachineError('quota-exceeded');
        this.db.transaction(()=>{const old=this.db.query<{digest:string;phase:string;result:string|null},[string]>('SELECT * FROM machine_local_recovery WHERE id=?').get(id);if(!old||old.digest!==digest)throw new MachineError('payload-conflict');if(old.result&&old.result!==body)throw new MachineError('payload-conflict');this.db.query('UPDATE machine_local_recovery SET phase=?,result=? WHERE id=?').run(confirmed?'complete':'unknown',body,id);}).immediate();
    }
    localRecoveryClaims():Array<{requestId:string;sessionId:string;state:'unknown'|'complete'}>{return this.db.query<{id:string;sessionId:string;phase:string},[]>('SELECT id,sessionId,phase FROM machine_local_recovery ORDER BY id LIMIT 1000').all().map(row=>({requestId:row.id,sessionId:row.sessionId,state:row.phase==='complete'?'complete':'unknown'}));}
    /** Written once per daemon before it may launch anything; the lock nonce binds the daemon lock file to this identity. */
    recordDaemon(daemon:DaemonRecord):void{this.db.transaction(()=>{const old=this.daemonRecord(daemon.daemonId);if(old){if(canonicalDigest(old)!==canonicalDigest(daemon))throw new MachineError('payload-conflict');return;}this.db.query('INSERT INTO machine_daemons(daemonId,lockNonce,pid,pgid,startedAt) VALUES(?,?,?,?,?)').run(daemon.daemonId,daemon.lockNonce,daemon.pid,daemon.pgid,daemon.startedAt);}).immediate();}
    daemonRecord(daemonId:string):DaemonRecord|null{return this.db.query<DaemonRecord,[string]>('SELECT daemonId,lockNonce,pid,pgid,startedAt FROM machine_daemons WHERE daemonId=?').get(daemonId);}
    daemonByLockNonce(lockNonce:string):DaemonRecord|null{return this.db.query<DaemonRecord,[string]>('SELECT daemonId,lockNonce,pid,pgid,startedAt FROM machine_daemons WHERE lockNonce=?').get(lockNonce);}
    /** Spawn intent, durable before the process exists: a crash before its identity is recorded leaves an uncertain row, never no row. */
    beginOwnedProcess(input:{id:string;daemonId:string;checkoutId:string;sessionId:string}):void{this.db.transaction(()=>{if(this.db.query<{n:number},[string]>('SELECT count(*) n FROM machine_owned_processes WHERE daemonId=?').get(input.daemonId)!.n>=OWNED_PROCESS_CAPACITY)throw new MachineError('quota-exceeded');this.db.query("INSERT INTO machine_owned_processes(id,daemonId,checkoutId,sessionId,phase) VALUES(?,?,?,?,'intent')").run(input.id,input.daemonId,input.checkoutId,input.sessionId);}).immediate();}
    /** `startedAt` is empty when the process could not be read at spawn: the record then stays uncertain while its PID is in use. */
    recordOwnedProcess(id:string,identity:{pid:number;pgid:number;startedAt:string}):void{if(this.db.query("UPDATE machine_owned_processes SET phase='recorded',pid=?,pgid=?,startedAt=? WHERE id=? AND phase='intent'").run(identity.pid,identity.pgid,identity.startedAt,id).changes!==1)throw new MachineError('recovery-required');}
    /** Only a spawn that provably created no process may drop its intent. */
    abandonOwnedProcess(id:string):void{this.db.query("DELETE FROM machine_owned_processes WHERE id=? AND phase='intent'").run(id);}
    ownedProcesses(daemonId:string,checkoutId:string):OwnedProcessRecord[]{return this.db.query<OwnedProcessRecord,[string,string]>('SELECT id,daemonId,checkoutId,sessionId,phase,pid,pgid,startedAt FROM machine_owned_processes WHERE daemonId=? AND checkoutId=? ORDER BY id').all(daemonId,checkoutId);}
    /**
     * The native session lease a daemon took, by the token of its owner record, durable before any run on that session: a crash
     * leaves exactly the binding a recovery judges, like the daemon lock's nonce. An unrecorded lease can never be taken over.
     */
    recordNativeLease(lease:{token:string;daemonId:string;sessionId:string}):void{this.db.transaction(()=>{const old=this.nativeLease(lease.token);if(old){if(old.daemonId!==lease.daemonId||old.sessionId!==lease.sessionId)throw new MachineError('payload-conflict');return;}if(this.db.query<{n:number},[string]>('SELECT count(*) n FROM machine_native_leases WHERE daemonId=?').get(lease.daemonId)!.n>=OWNED_PROCESS_CAPACITY)throw new MachineError('quota-exceeded');this.db.query('INSERT INTO machine_native_leases(token,daemonId,sessionId) VALUES(?,?,?)').run(lease.token,lease.daemonId,lease.sessionId);}).immediate();}
    nativeLease(token:string):{daemonId:string;sessionId:string}|null{return this.db.query<{daemonId:string;sessionId:string},[string]>('SELECT daemonId,sessionId FROM machine_native_leases WHERE token=?').get(token);}
    /** A daemon that stopped with every owned stop proven leaves no identity to recover. */
    forgetDaemon(daemonId:string):void{this.db.transaction(()=>{this.db.query('DELETE FROM machine_owned_processes WHERE daemonId=?').run(daemonId);this.db.query('DELETE FROM machine_native_leases WHERE daemonId=?').run(daemonId);this.db.query('DELETE FROM machine_daemons WHERE daemonId=?').run(daemonId);}).immediate();}
    /** The launch command of a run, matched by the Hub run's immutable command digest. */
    launchCommand(hub:string,runId:string,digest:string):{id:string;phase:Phase;daemon:string|null;checkout:string}|null{const row=this.db.query<CommandRow,[string,string,string]>('SELECT * FROM machine_commands WHERE hub=? AND run=? AND digest=?').get(hub,runId,digest);return row?{id:row.id,phase:row.phase==='starting'?'unknown':row.phase,daemon:row.daemon,checkout:row.checkout}:null;}
    /** Crash-run recovery claims. Each step only observes or applies exact idempotent releases, so an interrupted claim resumes rather than staying unknown. */
    claimRunRecovery(id:string,digest:string,runId:string,step:'confirm-run-absence'|'release-resolved-run'):{status:'claimed'}|{status:'replay';result:unknown}{
        return this.db.transaction(()=>{
            const old=this.db.query<{digest:string;runId:string;step:string;phase:string;result:string|null},[string]>('SELECT * FROM machine_run_recovery WHERE id=?').get(id);
            if(old){if(old.digest!==digest||old.runId!==runId||old.step!==step)throw new MachineError('payload-conflict');return old.phase==='complete'&&old.result?{status:'replay' as const,result:JSON.parse(old.result)}:{status:'claimed' as const};}
            if(this.db.query<{n:number},[]>('SELECT count(*) n FROM machine_run_recovery').get()!.n>=1000)throw new MachineError('quota-exceeded');
            this.db.query("INSERT INTO machine_run_recovery(id,digest,runId,step,phase) VALUES(?,?,?,?,'starting')").run(id,digest,runId,step);return{status:'claimed' as const};
        }).immediate();
    }
    finishRunRecovery(id:string,digest:string,result:unknown):void{const body=JSON.stringify(result);if(Buffer.byteLength(body)>65536)throw new MachineError('quota-exceeded');if(this.db.query("UPDATE machine_run_recovery SET phase='complete',result=? WHERE id=? AND digest=? AND (result IS NULL OR result=?)").run(body,id,digest,body).changes!==1)throw new MachineError('payload-conflict');}
    runRecoveryClaims():Array<{requestId:string;runId:string;step:string;state:'starting'|'complete'}>{return this.db.query<{id:string;runId:string;step:string;phase:string},[]>('SELECT id,runId,step,phase FROM machine_run_recovery ORDER BY id LIMIT 1000').all().map(row=>({requestId:row.id,runId:row.runId,step:row.step,state:row.phase==='complete'?'complete':'starting'}));}
    reconciliation(reconciliationId:string):{report:Control['ReconciliationReport'];receipt:Control['ReconciliationReceipt']}|null{const row=this.db.query<{report:string;receipt:string},[string]>("SELECT report,receipt FROM machine_reconciliations WHERE json_extract(receipt,'$.reconciliationId')=?").get(reconciliationId);return row?{report:JSON.parse(row.report),receipt:JSON.parse(row.receipt)}:null;}
    /** After an exact human `lost` resolution only: the launch tombstone is kept, marked lost, and the run's logs enter retention. */
    resolveLostRun(hub:string,commandId:string,runId:string,reconciliationId:string,now=Date.now()):void{this.db.transaction(()=>{const row=this.stored(hub,commandId);if(!row||row.run!==runId)throw new MachineError('stale-reference');const key=`lost:${commandId}`,prior=this.db.query<{value:string},[string]>('SELECT value FROM machine_meta WHERE key=?').get(key);if(prior&&prior.value!==reconciliationId)throw new MachineError('payload-conflict');
        if(['received','starting','unknown'].includes(row.phase))this.db.query("UPDATE machine_commands SET phase='lost' WHERE hub=? AND id=?").run(hub,commandId);
        this.db.query('INSERT OR IGNORE INTO machine_meta(key,value) VALUES(?,?)').run(key,reconciliationId);this.db.query('INSERT OR IGNORE INTO machine_run_terminal(stream,terminalAt) VALUES(?,?)').run(`run:${runId}`,now);}).immediate();}
    /**
     * A launch released after the exact human `lost` resolution of this ledger's own confirmed-stopped receipt (resolveLostRun):
     * its command, the crashed daemon that ran it and that receipt. Anything less (an unknown launch, a receipt of another run or
     * ledger) is null.
     */
    lostResolution(hub:string,runId:string,digest:string):{commandId:string;daemon:string;reconciliationId:string;expectedRunVersion:number}|null{
        const row=this.db.query<CommandRow,[string,string,string]>('SELECT * FROM machine_commands WHERE hub=? AND run=? AND digest=?').get(hub,runId,digest);
        // An admitted launch keeps its applied receipt; an unadmitted one became lost. Either way only resolveLostRun's marker releases it.
        if(!row||(row.phase!=='lost'&&row.phase!=='applied')||row.daemon===null)return null;
        const marker=this.db.query<{value:string},[string]>('SELECT value FROM machine_meta WHERE key=?').get(`lost:${row.id}`),local=marker?this.reconciliation(marker.value):null;
        if(!marker||!local||local.receipt.runId!==runId||local.receipt.observation!=='confirmed-stopped'||local.receipt.ledgerId!==this.ledgerId||local.report.commandDigest!==digest)return null;
        return{commandId:row.id,daemon:row.daemon,reconciliationId:marker.value,expectedRunVersion:local.receipt.expectedRunVersion};
    }
    /**
     * Version of this machine's complete inventory publication (the inventory and its capability projection), keyed by the digest of
     * that content. Identical content replays its version, so Hub sees an agreeing replay; any change takes the next version. It is
     * durable, so it only grows across reconnects and daemon restarts and Hub can tell a changed checkout from a conflicting replay.
     */
    publicationVersion(digest:string):number{
        return this.db.transaction(()=>{
            const row=this.db.query<{value:string},[]>("SELECT value FROM machine_meta WHERE key='inventory-publication'").get();
            const prior:unknown=row?JSON.parse(row.value):undefined;
            if(prior!==undefined&&(prior===null||typeof prior!=='object'||!Number.isSafeInteger((prior as {version?:unknown}).version)||typeof (prior as {digest?:unknown}).digest!=='string'))throw new MachineError('invalid-ledger-state');
            const last=prior as {version:number;digest:string}|undefined;
            if(last?.digest===digest)return last.version;
            const version=(last?.version??0)+1;
            this.db.query("INSERT INTO machine_meta(key,value) VALUES('inventory-publication',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({version,digest}));
            return version;
        }).immediate();
    }
    /** The latest native identity this ledger published for a run; a recovering daemon re-states it, it never invents one. */
    publishedNativeIdentity(stream:string):unknown{const row=this.db.query<{identity:string|null},[string]>("SELECT json_extract(payload,'$.nativeIdentity') AS identity FROM machine_events WHERE stream=? AND json_extract(payload,'$.kind')='state' AND json_extract(payload,'$.nativeIdentity') IS NOT NULL ORDER BY seq DESC LIMIT 1").get(stream);return row?.identity?JSON.parse(row.identity):undefined;}
    private eventCount():number{return this.db.query<{n:number},[]>('SELECT count(*) AS n FROM machine_events').get()!.n;}
    private discardCount():number{return this.db.query<{n:number},[]>('SELECT count(*) AS n FROM machine_discarded_logs').get()!.n;}
    /** Bounded storage blocks new launches first, so an admitted run can still persist its approval, terminal and result events. */
    launchQuotaExceeded():boolean{return this.eventCount()+this.discardCount()>=LEDGER_EVENT_CAPACITY-LEDGER_LAUNCH_HEADROOM||this.storedBytes()>=LEDGER_LAUNCH_BYTE_LIMIT;}
    /** Bytes in use: pages minus free pages. Retention frees pages that later writes reuse, so the file grows only with this. */
    storedBytes():number{const pages=this.db.query<{page_count:number},[]>('PRAGMA page_count').get()!.page_count,free=this.db.query<{freelist_count:number},[]>('PRAGMA freelist_count').get()!.freelist_count,size=this.db.query<{page_size:number},[]>('PRAGMA page_size').get()!.page_size;return (pages-free)*size;}
    /** Seven-day retention: only Hub-acknowledged log content of runs terminal for at least seven days, as exact durable retired ranges. */
    retireExpiredLogs(now=Date.now()):number{
        return this.db.transaction(()=>{
            let retired=0;
            for(const {stream} of this.db.query<{stream:string},[number]>('SELECT stream FROM machine_run_terminal WHERE terminalAt<=? ORDER BY terminalAt,stream').all(now-LOG_RETENTION_MS)){
                const rows=this.db.query<{seq:number;payload:string},[string,number]>("SELECT seq,payload FROM machine_events WHERE stream=? AND acked=1 AND json_extract(payload,'$.kind')='log' ORDER BY seq LIMIT ?").all(stream,1000-retired);
                let range:{from:number;to:number;digests:string[];bytes:number}|undefined;
                const flush=()=>{if(range)this.db.query('INSERT INTO machine_retired_logs(stream,fromSeq,toSeq,digest,bytes,retiredAt) VALUES(?,?,?,?,?,?)').run(stream,range.from,range.to,canonicalDigest(range.digests),range.bytes,now);range=undefined;};
                for(const row of rows){
                    const payload=JSON.parse(row.payload) as {text?:unknown};const bytes=typeof payload.text==='string'?Buffer.byteLength(payload.text):0;
                    if(range&&row.seq===range.to+1){range.to=row.seq;range.digests.push(canonicalDigest(payload));range.bytes+=bytes;}else{flush();range={from:row.seq,to:row.seq,digests:[canonicalDigest(payload)],bytes};}
                    this.db.query('DELETE FROM machine_events WHERE stream=? AND seq=?').run(stream,row.seq);
                }
                flush();retired+=rows.length;if(retired>=1000)break;
            }
            return retired;
        }).immediate();
    }
    retiredLogs(stream:string):Array<{fromSeq:number;toSeq:number;digest:string;bytes:number;retiredAt:number}>{return this.db.query<{fromSeq:number;toSeq:number;digest:string;bytes:number;retiredAt:number},[string]>('SELECT fromSeq,toSeq,digest,bytes,retiredAt FROM machine_retired_logs WHERE stream=? ORDER BY fromSeq').all(stream);}
    private stored(hub: string, id: string): CommandRow | null { return this.db.query<CommandRow, [
        string,
        string
    ]>('SELECT * FROM machine_commands WHERE hub=? AND id=?').get(hub, id); }
    get lastHubSequence(): number {
        const seq = this.db.query<{
            sequence: number;
        }, [
        ]>('SELECT DISTINCT sequence FROM machine_commands WHERE sequence>0 ORDER BY sequence').all();
        let cursor = 0;
        for (const r of seq) {
            if (r.sequence !== cursor + 1)
                break;
            cursor = r.sequence;
        }
        return cursor;
    }
    claim(c: CommandClaim): {
        status: 'claimed';
    } | {
        status: 'replay';
        phase: Phase;
    } {
        const claimed = this.db.transaction(() => {
            const old = this.stored(c.hubId, c.commandId);
            if (old) {
                if (old.digest !== c.digest || (c.hubSequence !== undefined && old.sequence !== c.hubSequence))
                    throw new MachineError('payload-conflict');
                return { status: 'replay' as const, phase: old.phase === 'starting' ? 'unknown' as const : old.phase };
            }
            if (this.db.query<{
                n: number;
            }, [
            ]>('SELECT count(*) AS n FROM machine_commands').get()!.n >= 100000 || this.db.query<{
                n: number;
            }, [
            ]>("SELECT count(*) AS n FROM machine_commands WHERE phase IN ('received','starting','unknown')").get()!.n >= 1000)
                throw new MachineError('quota-exceeded');
            const sequence = c.hubSequence ?? 0;
            if (!Number.isSafeInteger(sequence) || sequence < 0)
                throw new MachineError('invalid-frame');
            if (sequence && this.db.query('SELECT id FROM machine_commands WHERE sequence=?').get(sequence))
                throw new MachineError('payload-conflict');
            this.db.query('INSERT INTO machine_commands(hub,id,digest,run,checkout,phase,daemon,sequence,envelope) VALUES(?,?,?,?,?,?,?,?,?)').run(c.hubId, c.commandId, c.digest, c.runId, c.checkoutId, 'received', c.daemonId ?? null, sequence, c.envelope === undefined ? null : JSON.stringify(c.envelope));
            return { status: 'claimed' as const };
        }).immediate();
        // The refusal comes after the durable claim, so the caller rejects it visibly and a replay is refused the same way.
        if (c.launch === true && (claimed.status === 'claimed' || claimed.phase === 'received') && this.launchQuotaExceeded())
            throw new MachineError('quota-exceeded');
        return claimed;
    }
    markStarting(hub: string, id: string, daemon: string): void { if (this.db.query("UPDATE machine_commands SET phase='starting',daemon=? WHERE hub=? AND id=? AND phase='received'").run(daemon, hub, id).changes !== 1)
        throw new MachineError('recovery-required'); }
    recordReceipt(hub: string, id: string, receipt: unknown): void { if (this.db.query('UPDATE machine_commands SET receipt=? WHERE hub=? AND id=?').run(JSON.stringify(receipt), hub, id).changes !== 1)
        throw new MachineError('unknown-command'); }
    commandReceipt(hub: string, id: string): unknown { const record = this.stored(hub, id); return record?.receipt ? JSON.parse(record.receipt) : null; }
    finish(hub: string, id: string, phase: 'applied' | 'rejected', receipt: unknown): void { const record = this.stored(hub, id); if (!record)
        throw new MachineError('unknown-command'); if ((record.phase === 'applied' || record.phase === 'rejected') && (record.phase !== phase || record.receipt !== JSON.stringify(receipt)))
        throw new MachineError('payload-conflict'); this.db.query('UPDATE machine_commands SET phase=?,receipt=? WHERE hub=? AND id=?').run(phase, JSON.stringify(receipt), hub, id); }
    appendEvent(stream: string, payload: unknown | ((seq: number) => unknown)): number { return this.db.transaction(() => { const seq = this.highest(stream) + 1; this.persistEvent(stream, seq, typeof payload === 'function' ? payload(seq) : payload); return seq; }).immediate(); }
    private highest(stream: string): number { return this.db.query<{
        n: number;
    }, [
        string,
        string,
        string
    ]>('SELECT coalesce(max(seq),0) AS n FROM (SELECT seq FROM machine_events WHERE stream=? UNION ALL SELECT seq FROM machine_discarded_logs WHERE stream=? UNION ALL SELECT toSeq AS seq FROM machine_retired_logs WHERE stream=?)').get(stream, stream, stream)!.n; }
    persistEvent(stream: string, seq: number, payload: unknown): void {
        this.db.transaction(() => {
            const bytes = JSON.stringify(payload);
            if (Buffer.byteLength(bytes) > 65536)
                throw new MachineError('quota-exceeded');
            const prior = this.db.query<{
                payload: string;
            }, [
                string,
                number
            ]>('SELECT payload FROM machine_events WHERE stream=? AND seq=?').get(stream, seq);
            if (prior) {
                if (prior.payload !== bytes)
                    throw new MachineError('payload-conflict');
                return;
            }
            if (seq !== this.highest(stream) + 1)
                throw new MachineError('replay-gap');
            const kind = payload !== null && typeof payload === 'object' && 'kind' in payload ? payload.kind : undefined;
            // Only log content is bounded by the event count (appendRunLog discards it first). Critical
            // approval, state, result and session events of admitted work are never refused here.
            if (kind === 'log' && (this.eventCount() >= LEDGER_EVENT_CAPACITY || this.storedBytes() >= LEDGER_LOG_BYTE_LIMIT))
                throw new MachineError('quota-exceeded');
            this.db.query('INSERT INTO machine_events(stream,seq,payload) VALUES(?,?,?)').run(stream, seq, bytes);
            if (stream.startsWith('run:') && kind === 'state' && payload !== null && typeof payload === 'object' && 'state' in payload && typeof payload.state === 'string' && TERMINAL_RUN_STATES.has(payload.state))
                this.db.query('INSERT OR IGNORE INTO machine_run_terminal(stream,terminalAt) VALUES(?,?)').run(stream, Date.now());
        }).immediate();
    }
    resetUnackedForReplay(stream: string): void { this.db.transaction(() => { this.db.query('UPDATE machine_events SET sent=0 WHERE stream=? AND acked=0').run(stream); this.db.query('UPDATE machine_discarded_logs SET sent=0 WHERE stream=? AND acked=0').run(stream); }).immediate(); }
    unsentEvents(stream: string): Array<{
        seq: number;
        payload: unknown;
    }> { return this.db.query<{
        seq: number;
        payload: string;
    }, [
        string
    ]>('SELECT seq,payload FROM machine_events WHERE stream=? AND acked=0 AND sent=0 ORDER BY seq LIMIT 500').all(stream).map(r => ({ seq: r.seq, payload: JSON.parse(r.payload) })); }
    pendingEvents(stream: string): Array<{
        seq: number;
        payload: unknown;
    }> { return this.db.query<{
        seq: number;
        payload: string;
    }, [
        string
    ]>('SELECT seq,payload FROM machine_events WHERE stream=? AND acked=0 ORDER BY seq LIMIT 500').all(stream).map(r => ({ seq: r.seq, payload: JSON.parse(r.payload) })); }
    retainedLogBytes(stream: string): number { const key = `log-bytes:${stream}`, stored = this.db.query<{
        value: string;
    }, [
        string
    ]>('SELECT value FROM machine_meta WHERE key=?').get(key); if (stored)
        return Number(stored.value); const bytes = this.db.query<{
        n: number;
    }, [
        string
    ]>("SELECT coalesce(sum(length(CAST(json_extract(payload,'$.text') AS BLOB))),0) AS n FROM machine_events WHERE stream=? AND json_extract(payload,'$.kind')='log'").get(stream)!.n; this.db.query('INSERT INTO machine_meta(key,value) VALUES(?,?)').run(key, String(bytes)); return bytes; }
    appendRunLog(stream: string, payload: unknown | ((seq: number) => unknown), limit: number = LIMITS.runLogBytes): {
        seq: number;
        retained: boolean;
    } {
        return this.db.transaction(() => {
            if (!Number.isSafeInteger(limit) || limit < LIMITS.logChunkBytes || limit > LIMITS.runLogBytes)
                throw new MachineError('invalid-log-quota');
            const seq = this.highest(stream) + 1, value = typeof payload === 'function' ? payload(seq) : payload;
            if (!stream.startsWith('run:') || !value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'log' || !('text' in value) || typeof value.text !== 'string' || Buffer.byteLength(value.text) > LIMITS.logChunkBytes)
                throw new MachineError('invalid-log-discard');
            const bytes = Buffer.byteLength(value.text), retained = this.retainedLogBytes(stream);
            // Over the per-run quota or the ledger event cap, log content becomes durable gap metadata, never a lost critical slot.
            if (retained + bytes > limit || this.eventCount() >= LEDGER_EVENT_CAPACITY || this.storedBytes() >= LEDGER_LOG_BYTE_LIMIT)
                return { seq: this.appendDiscardedLog(stream, value), retained: false };
            this.persistEvent(stream, seq, value);
            this.db.query('UPDATE machine_meta SET value=? WHERE key=?').run(String(retained + bytes), `log-bytes:${stream}`);
            return { seq, retained: true };
        }).immediate();
    }
    appendDiscardedLog(stream: string, payload: unknown | ((seq: number) => unknown)): number {
        return this.db.transaction(() => {
            const seq = this.highest(stream) + 1, value = typeof payload === 'function' ? payload(seq) : payload;
            if (!stream.startsWith('run:') || !value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'log' || !('text' in value) || typeof value.text !== 'string')
                throw new MachineError('invalid-log-discard');
            if (this.discardCount() >= DISCARD_CAPACITY)
                throw new MachineError('quota-exceeded');
            this.db.query('INSERT INTO machine_discarded_logs(stream,seq,digest,bytes) VALUES(?,?,?,?)').run(stream, seq, canonicalDigest(value), Buffer.byteLength(value.text));
            return seq;
        }).immediate();
    }
    discardedLogs(stream: string): Array<{
        seq: number;
        digest: string;
        bytes: number;
        gapSeq: number | null;
    }> { return this.db.query<{
        seq: number;
        digest: string;
        bytes: number;
        gapSeq: number | null;
    }, [
        string
    ]>('SELECT seq,digest,bytes,gapSeq FROM machine_discarded_logs WHERE stream=? ORDER BY seq').all(stream); }
    flushDiscardedLogs(stream: string, makeGap: (seq: number, from: number, to: number) => unknown): number | null {
        return this.db.transaction(() => {
            const pending = this.db.query<{
                seq: number;
            }, [
                string
            ]>('SELECT seq FROM machine_discarded_logs WHERE stream=? AND gapSeq IS NULL ORDER BY seq').all(stream);
            if (!pending.length)
                return null;
            const from = pending[0]!.seq, to = pending.at(-1)!.seq;
            if (to !== this.highest(stream) || pending.length !== to - from + 1)
                throw new MachineError('replay-gap');
            const seq = to + 1, value = makeGap(seq, from, to);
            if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'log-gap' || !('fromSeq' in value) || value.fromSeq !== from || !('toSeq' in value) || value.toSeq !== to || !('localSeq' in value) || value.localSeq !== seq)
                throw new MachineError('invalid-log-discard');
            this.persistEvent(stream, seq, value);
            this.db.query('UPDATE machine_discarded_logs SET gapSeq=? WHERE stream=? AND gapSeq IS NULL').run(seq, stream);
            return seq;
        }).immediate();
    }
    markSent(stream: string, seq: number): void { this.db.transaction(() => { if (this.db.query('UPDATE machine_events SET sent=1 WHERE stream=? AND seq=?').run(stream, seq).changes !== 1)
        throw new MachineError('unsent-event-ack'); this.db.query('UPDATE machine_discarded_logs SET sent=1 WHERE stream=? AND gapSeq=?').run(stream, seq); }).immediate(); }
    ackEvents(stream: string, seq: number): void { this.db.transaction(() => { if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.highest(stream) || this.db.query<{
        n: number;
    }, [
        string,
        number
    ]>('SELECT count(*) AS n FROM machine_events WHERE stream=? AND seq<=? AND sent=0').get(stream, seq)!.n || this.db.query<{
        n: number;
    }, [
        string,
        number
    ]>('SELECT count(*) AS n FROM machine_discarded_logs WHERE stream=? AND seq<=? AND sent=0').get(stream, seq)!.n)
        throw new MachineError('unsent-event-ack'); this.db.query('UPDATE machine_events SET acked=1 WHERE stream=? AND seq<=?').run(stream, seq); this.db.query('UPDATE machine_discarded_logs SET acked=1 WHERE stream=? AND seq<=?').run(stream, seq); }).immediate(); }
    reconcileCursor(stream: string, remote: number): void { this.db.transaction(() => { if (!Number.isSafeInteger(remote) || remote < 0 || remote > this.highest(stream) || (remote > 0 && !this.db.query('SELECT seq FROM machine_events WHERE stream=? AND seq=?').get(stream, remote) && !this.db.query('SELECT toSeq FROM machine_retired_logs WHERE stream=? AND toSeq=?').get(stream, remote)))
        throw new MachineError('replay-gap'); const local = this.cursors().find(c => c.stream === stream)?.ack ?? 0; if (remote > local) {
        this.ackEvents(stream, remote);
        return;
    } if (remote < local) {
        // Retired log content was acknowledged before retention removed it; it can never be replayed or regenerated.
        if (this.db.query('SELECT toSeq FROM machine_retired_logs WHERE stream=? AND toSeq>?').get(stream, remote))
            throw new MachineError('replay-gap');
        this.db.query('UPDATE machine_events SET acked=0,sent=0 WHERE stream=? AND seq>?').run(stream, remote);
        this.db.query('UPDATE machine_discarded_logs SET acked=0,sent=0 WHERE stream=? AND seq>?').run(stream, remote);
    } }).immediate(); }
    cursors(): Array<{
        stream: string;
        ack: number;
    }> { return this.db.query<{
        stream: string;
        ack: number;
    }, [
    ]>('SELECT stream,coalesce(max(CASE WHEN acked=1 THEN seq ELSE 0 END),0) AS ack FROM (SELECT stream,seq,acked FROM machine_events UNION ALL SELECT stream,seq,acked FROM machine_discarded_logs UNION ALL SELECT stream,toSeq AS seq,1 AS acked FROM machine_retired_logs) GROUP BY stream ORDER BY stream').all(); }
    unresolved() { return this.db.query<CommandRow, [
    ]>("SELECT * FROM machine_commands WHERE phase IN ('received','starting','unknown') ORDER BY hub,id LIMIT 1000").all().map(row => ({ ...row, phase: row.phase === 'starting' ? 'unknown' as const : row.phase })); }
    /** `detail`: the fixed reason token of the guard that refused (MachineError.detail), when the code alone does not name it. */
    recordDiagnostic(commandId: string, code: string, detail?: string): void { this.db.query('INSERT INTO machine_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`fault:${commandId}`, JSON.stringify({ commandId, code, ...(detail === undefined ? {} : { detail }), observedAt: new Date().toISOString() })); }
    diagnostics(): Array<{
        commandId: string;
        code: string;
        detail?: string;
        observedAt: string;
    }> { return this.db.query<{
        value: string;
    }, [
    ]>("SELECT value FROM machine_meta WHERE key LIKE 'fault:%' LIMIT 100").all().map(v => JSON.parse(v.value)); }
    rememberOperation(id: string, operation: {
        sessionId: string;
        digest: string;
        kind: string;
        body: unknown;
    }): void { this.db.transaction(() => { const previous = this.operation(id, operation.sessionId); const digest = canonicalDigest(operation); if (previous) {
        if (canonicalDigest(previous) !== digest)
            throw new MachineError('payload-conflict');
        return;
    } if (this.db.query('SELECT id FROM machine_operations WHERE id=?').get(id))
        throw new MachineError('payload-conflict'); this.db.query('INSERT INTO machine_operations(id,sessionId,digest,body) VALUES(?,?,?,?)').run(id, operation.sessionId, digest, JSON.stringify(operation)); }).immediate(); }
    operation(id: string, sessionId: string): {
        sessionId: string;
        digest: string;
        kind: string;
        body: unknown;
    } | null { const row = this.db.query<{
        body: string;
    }, [
        string,
        string
    ]>('SELECT body FROM machine_operations WHERE id=? AND sessionId=?').get(id, sessionId); return row ? JSON.parse(row.body) : null; }
    stageResultDraft(runId: string, draft: unknown): void {
        if (!draft || typeof draft !== 'object' || Array.isArray(draft))
            throw new MachineError('invalid-result');
        const valid = validateControl('ResultUpload', { ...draft, expectedRunVersion: 1 });
        if (!valid.ok)
            throw new MachineError('invalid-result');
        this.db.transaction(() => { const digest = canonicalDigest(draft); const previous = this.db.query<{
            digest: string;
        }, [
            string
        ]>('SELECT digest FROM machine_results WHERE runId=?').get(runId); if (previous) {
            if (previous.digest !== digest)
                throw new MachineError('payload-conflict');
            return;
        } this.db.query('INSERT INTO machine_results(runId,draft,digest) VALUES(?,?,?)').run(runId, JSON.stringify(draft), digest); }).immediate();
    }
    sealResultVersion(runId: string, version: number): Control['ResultUpload'] {
        return this.db.transaction(() => {
            const row = this.db.query<{
                draft: string;
                upload: string | null;
            }, [
                string
            ]>('SELECT draft,upload FROM machine_results WHERE runId=?').get(runId);
            if (!row)
                throw new MachineError('recovery-required');
            if (row.upload)
                return JSON.parse(row.upload);
            const valid = validateControl('ResultUpload', { ...JSON.parse(row.draft), expectedRunVersion: version });
            if (!valid.ok)
                throw new MachineError('invalid-result');
            this.db.query('UPDATE machine_results SET upload=? WHERE runId=?').run(JSON.stringify(valid.value), runId);
            return valid.value;
        }).immediate();
    }
    pendingResults(): Array<{
        runId: string;
        draft: Omit<Control['ResultUpload'], 'expectedRunVersion'>;
        upload: Control['ResultUpload'] | null;
    }> { return this.db.query<{
        runId: string;
        draft: string;
        upload: string | null;
    }, [
    ]>('SELECT runId,draft,upload FROM machine_results WHERE receipt IS NULL ORDER BY runId LIMIT 100').all().map(r => ({ runId: r.runId, draft: JSON.parse(r.draft), upload: r.upload ? JSON.parse(r.upload) : null })); }
    completeResult(runId: string, receipt: Control['ResultReceipt']): void { const valid = validateControl('ResultReceipt', receipt); if (!valid.ok || receipt.runId !== runId)
        throw new MachineError('invalid-result'); this.db.query('UPDATE machine_results SET receipt=? WHERE runId=?').run(JSON.stringify(receipt), runId); }
    recordReconciliation(report: Control['ReconciliationReport'], receipt: Control['ReconciliationReceipt']): void { const digest = canonicalDigest(report); if (receipt.reportDigest !== digest || receipt.ledgerId !== this.ledgerId)
        throw new MachineError('invalid-reconciliation'); const prior = this.db.query<{
        receipt: string;
    }, [
        string
    ]>('SELECT receipt FROM machine_reconciliations WHERE digest=?').get(digest); if (prior) {
        if (prior.receipt !== JSON.stringify(receipt))
            throw new MachineError('payload-conflict');
        return;
    } this.db.query('INSERT INTO machine_reconciliations VALUES(?,?,?)').run(digest, JSON.stringify(report), JSON.stringify(receipt)); }
    close(): void { this.db.close(); }
}
