import type { Database } from 'bun:sqlite';
import type { GitDeliveryResult } from './contracts';
import { fail } from './domain';
export type DeliveryJob = {
    id: string; replayKey: string; actorId: string; projectId: string; requestDigest: string;
    expectedLineVersion: number; revisionId: string; remoteUrl: string; baseBranch: string;
    status: 'pending' | 'result' | 'uncertain' | 'completed'; result?: GitDeliveryResult;
    response?: unknown; httpStatus?: number;
};
/** Durable external-effect reservation. Revision bytes stay in the existing immutable revision store. */
export function deliveryJobs(db: Database) {
    db.exec('CREATE TABLE IF NOT EXISTS hub_delivery_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,status TEXT NOT NULL,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS hub_delivery_active ON hub_delivery_jobs(status,project_id)');
    // An interrupted external effect must be reconciled explicitly, never re-issued after restart.
    const markInterrupted = () => db.exec("UPDATE hub_delivery_jobs SET status='uncertain',body=json_set(body,'$.status','uncertain') WHERE status='pending'");
    const get = (id: string): DeliveryJob | undefined => {
        const row=db.query<{body:string},[string]>('SELECT body FROM hub_delivery_jobs WHERE id=?').get(id);
        return row ? JSON.parse(row.body) as DeliveryJob : undefined;
    };
    const save = (job: DeliveryJob): void => {
        db.query('INSERT INTO hub_delivery_jobs(id,project_id,status,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body').run(job.id,job.projectId,job.status,JSON.stringify(job));
    };
    const reserve = (job: DeliveryJob): void => {
        if(db.query("SELECT 1 FROM hub_delivery_jobs WHERE project_id=? AND status IN ('pending','result','uncertain') LIMIT 1").get(job.projectId)) fail(409,'delivery-in-progress','Resolve the existing delivery operation for this project before starting another');
        if((db.query<{n:number},[]>('SELECT count(*) AS n FROM hub_delivery_jobs').get()?.n??0)>=10000) fail(413,'quota-exceeded','Delivery audit quota exceeded; explicit archival is required');
        if((db.query<{n:number},[]>("SELECT count(*) AS n FROM hub_delivery_jobs WHERE status='pending'").get()?.n??0)>=2) fail(503,'hub-busy','Concurrent Git delivery quota exceeded');
        save(job);
    };
    return {get,save,reserve,markInterrupted};
}
