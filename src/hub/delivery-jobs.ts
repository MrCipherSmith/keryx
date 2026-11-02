import type { Database } from 'bun:sqlite';
import type { GitDeliveryResult } from './contracts';
import { fail } from './domain';
export type DeliveryJob = {
    id: string; replayKey: string; actorId: string; projectId: string; requestDigest: string;
    expectedLineVersion: number; revisionId: string; remoteUrl: string; baseBranch: string;
    status: 'pending' | 'result' | 'uncertain' | 'completed'; result?: GitDeliveryResult;
    response?: unknown; httpStatus?: number; version?: number;
    archival?: {actorId:string;reason:string;recordedAt:string};
    reconciliation?: { actorId: string; decision: 'confirm-no-effect' | 'finalize-recorded-result' | 'inspect-publication'; reason: string; recordedAt: string };
};
/** Durable external-effect reservation. Revision bytes stay in the existing immutable revision store. */
export function deliveryJobs(db: Database) {
    db.exec('CREATE TABLE IF NOT EXISTS hub_delivery_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS hub_delivery_active ON hub_delivery_jobs(status,project_id); CREATE TABLE IF NOT EXISTS hub_delivery_jobs_archive(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS hub_delivery_archive_project ON hub_delivery_jobs_archive(project_id,id)');
    // An interrupted external effect must be reconciled explicitly, never re-issued after restart.
    const markInterrupted = () => db.exec("UPDATE hub_delivery_jobs SET status='uncertain',body=json_set(body,'$.status','uncertain','$.version',COALESCE(json_extract(body,'$.version'),1)+1) WHERE status='pending'");
    const get = (id: string): DeliveryJob | undefined => {
        const row=db.query<{body:string},[string,string]>('SELECT body FROM hub_delivery_jobs WHERE id=? UNION ALL SELECT body FROM hub_delivery_jobs_archive WHERE id=? LIMIT 1').get(id,id);
        if (!row) return; const job = JSON.parse(row.body) as DeliveryJob; job.version ??= 1; return job;
    };
    const save = (job: DeliveryJob, expectedVersion?: number): void => {
        const previous = get(job.id);
        if (expectedVersion !== undefined && previous?.version !== expectedVersion) fail(409, 'version-conflict', 'Delivery job changed; reload before reconciling');
        job.version = (previous?.version ?? 0) + 1;
        db.query('INSERT INTO hub_delivery_jobs(id,project_id,status,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body').run(job.id,job.projectId,job.status,JSON.stringify(job));
    };
    const reserve = (job: DeliveryJob): void => {
        if(db.query("SELECT 1 FROM hub_delivery_jobs WHERE project_id=? AND status IN ('pending','result','uncertain') LIMIT 1").get(job.projectId)) fail(409,'delivery-in-progress','Resolve the existing delivery operation for this project before starting another');
        if((db.query<{n:number},[]>('SELECT count(*) AS n FROM hub_delivery_jobs').get()?.n??0)>=10000) fail(413,'quota-exceeded','Delivery audit quota exceeded; explicit archival is required');
        if((db.query<{n:number},[]>("SELECT count(*) AS n FROM hub_delivery_jobs WHERE status='pending'").get()?.n??0)>=2) fail(503,'hub-busy','Concurrent Git delivery quota exceeded');
        save(job);
    };
    const list = (projectId: string): DeliveryJob[] => db.query<{body:string},[string]>("SELECT body FROM hub_delivery_jobs WHERE project_id=? ORDER BY CASE WHEN status IN ('pending','result','uncertain') THEN 0 ELSE 1 END,rowid DESC LIMIT 50").all(projectId).map(row => {const job = JSON.parse(row.body) as DeliveryJob;job.version ??= 1;return job;});
    const archive = (id: string, expectedVersion: number, actorId: string, reason: string): DeliveryJob => db.transaction(() => {
        const job = get(id);
        if (!job) fail(404,'not-found','Delivery job not found');
        if (job.version !== expectedVersion) fail(409,'version-conflict','Delivery job changed; reload before archiving');
        if (job.status !== 'completed' || job.archival) fail(409,'invalid-state','Only unarchived completed jobs can move to cold storage');
        job.archival={actorId,reason,recordedAt:new Date().toISOString()};job.version=expectedVersion+1;
        db.query('INSERT INTO hub_delivery_jobs_archive(id,project_id,body) VALUES(?,?,?)').run(id,job.projectId,JSON.stringify(job));
        db.query('DELETE FROM hub_delivery_jobs WHERE id=? AND status=\'completed\'').run(id);
        return job;
    })();
    return {get,save,reserve,markInterrupted,list,archive};
}
