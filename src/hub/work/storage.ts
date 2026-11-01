import { randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { fail } from '../domain';
import { MANAGED_WORK_WRITER_VERSION } from '../remote-v2/storage';
import type { HubDocument } from '../contracts';
import type { GitObservation } from './git-observer';
import type { WorkExecutionReservation } from './execution';
import type { LegacyPreview } from './legacy';
import type { WorkEvent, WorkReceipt, WorkRecord, WorkState } from './model';
export const workStorageLimits = { retainedEvents: 10000, maxRecords: 100000, maxOperations: 100000, maxRecordBytes: 1024 * 1024, maxOperationBytes: 2 * 1024 * 1024, maxHistoryBytes: 256 * 1024 * 1024 } as const;
export type WorkObservationJob = {
    projectId: string;
    actorId: string;
    operationId: string;
    requestDigest: string;
    receiptId: string;
    observationId: string;
    generation: number;
    subjectId: string;
    subjectDigest: string;
    attemptId: string;
    expectedVersion: number;
};
/** Additive tables share the Hub connection and its outer authority transaction. */
export function migrateWork(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_work_git_observations(project_id TEXT NOT NULL,subject_id TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,id));
    CREATE INDEX IF NOT EXISTS hub_work_git_subject ON hub_work_git_observations(project_id,subject_id,generation);
    CREATE TABLE IF NOT EXISTS hub_work_observation_generations(project_id TEXT NOT NULL,subject_id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(project_id,subject_id));
    CREATE TABLE IF NOT EXISTS hub_work_observation_jobs(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,operation_id));
    CREATE TABLE IF NOT EXISTS hub_work_execution_reservations(operation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,attempt_id TEXT NOT NULL,run_id TEXT UNIQUE,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS hub_work_reservations_attempt ON hub_work_execution_reservations(project_id,attempt_id);
    CREATE TABLE IF NOT EXISTS hub_work_conversions(project_id TEXT NOT NULL,legacy_flow_id TEXT NOT NULL,managed_flow_id TEXT NOT NULL,PRIMARY KEY(project_id,legacy_flow_id));
    CREATE INDEX IF NOT EXISTS hub_work_conversion_legacy ON hub_work_conversions(legacy_flow_id);
    CREATE TABLE IF NOT EXISTS hub_work_legacy_previews(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,receipt_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,receipt_id));
    CREATE TABLE IF NOT EXISTS hub_work_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_work_records(project_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,id));
    CREATE TABLE IF NOT EXISTS hub_work_events(project_id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,sequence));
    CREATE TABLE IF NOT EXISTS hub_work_operations(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,state_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,operation_id));
    CREATE TABLE IF NOT EXISTS hub_work_documents(project_id TEXT NOT NULL,document_id TEXT NOT NULL,version INTEGER NOT NULL,content_digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,document_id,version));
    CREATE TABLE IF NOT EXISTS hub_work_outbox(project_id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,delivered_at TEXT,PRIMARY KEY(project_id,sequence));`);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_work_cursors(project_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,pruned_through INTEGER NOT NULL);
    INSERT INTO hub_work_cursors(project_id,sequence,pruned_through) SELECT project_id,max(sequence),0 FROM hub_work_events WHERE 1 GROUP BY project_id ON CONFLICT(project_id) DO UPDATE SET sequence=max(sequence,excluded.sequence);
    UPDATE hub_work_cursors SET pruned_through=max(pruned_through,sequence-10000);
    DELETE FROM hub_work_events WHERE sequence<=(SELECT pruned_through FROM hub_work_cursors c WHERE c.project_id=hub_work_events.project_id);
    DELETE FROM hub_work_outbox;`);
    for (const field of ['kind', 'flowId', 'intentId', 'attemptId', 'subjectId', 'targetId', 'runId'])
        db.exec(`CREATE INDEX IF NOT EXISTS hub_work_record_${field} ON hub_work_records(project_id,json_extract(body,'$.${field}'))`);
    db.exec("CREATE INDEX IF NOT EXISTS hub_work_record_state ON hub_work_records(project_id,json_extract(body,'$.kind'),json_extract(body,'$.state')); CREATE INDEX IF NOT EXISTS hub_work_revision_flow ON hub_work_records(project_id,json_extract(body,'$.kind'),json_extract(body,'$.flowId'),json_extract(body,'$.revision')); CREATE INDEX IF NOT EXISTS hub_work_revision_intent ON hub_work_records(project_id,json_extract(body,'$.kind'),json_extract(body,'$.intentId'),json_extract(body,'$.revision'));");

    db.exec(`CREATE TABLE IF NOT EXISTS hub_work_usage(project_id TEXT PRIMARY KEY,records INTEGER NOT NULL DEFAULT 0,operations INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO hub_work_usage(project_id,records,operations,bytes) SELECT project_id,count(*),0,sum(length(CAST(body AS BLOB))) FROM hub_work_records GROUP BY project_id;
    INSERT OR IGNORE INTO hub_work_usage(project_id) SELECT DISTINCT project_id FROM hub_work_operations;
    UPDATE hub_work_usage SET operations=(SELECT count(*) FROM hub_work_operations o WHERE o.project_id=hub_work_usage.project_id),bytes=coalesce((SELECT sum(length(CAST(body AS BLOB))) FROM hub_work_records r WHERE r.project_id=hub_work_usage.project_id),0)+coalesce((SELECT sum(length(CAST(body AS BLOB))) FROM hub_work_operations o WHERE o.project_id=hub_work_usage.project_id),0);
    CREATE TRIGGER IF NOT EXISTS hub_work_record_insert AFTER INSERT ON hub_work_records BEGIN INSERT INTO hub_work_usage(project_id,records,bytes) VALUES(new.project_id,1,length(CAST(new.body AS BLOB))) ON CONFLICT(project_id) DO UPDATE SET records=records+1,bytes=bytes+length(CAST(new.body AS BLOB)); END;
    CREATE TRIGGER IF NOT EXISTS hub_work_record_update AFTER UPDATE ON hub_work_records BEGIN UPDATE hub_work_usage SET bytes=bytes+length(CAST(new.body AS BLOB))-length(CAST(old.body AS BLOB)) WHERE project_id=new.project_id; END;
    CREATE TRIGGER IF NOT EXISTS hub_work_operation_insert AFTER INSERT ON hub_work_operations BEGIN INSERT INTO hub_work_usage(project_id,operations,bytes) VALUES(new.project_id,1,length(CAST(new.body AS BLOB))) ON CONFLICT(project_id) DO UPDATE SET operations=operations+1,bytes=bytes+length(CAST(new.body AS BLOB)); END;`);

    db.exec(`CREATE TABLE IF NOT EXISTS hub_work_first_approval(project_id TEXT NOT NULL,flow_id TEXT NOT NULL,decision_id TEXT NOT NULL,PRIMARY KEY(project_id,flow_id));
    CREATE TABLE IF NOT EXISTS hub_work_pending_amendment(project_id TEXT NOT NULL,flow_id TEXT NOT NULL,amendment_id TEXT NOT NULL,PRIMARY KEY(project_id,amendment_id));
    CREATE INDEX IF NOT EXISTS hub_work_pending_flow ON hub_work_pending_amendment(project_id,flow_id);
    INSERT OR IGNORE INTO hub_work_first_approval SELECT d.project_id,json_extract(r.body,'$.flowId'),d.id FROM hub_work_records d JOIN hub_work_records r ON r.project_id=d.project_id AND r.id=json_extract(d.body,'$.targetId') WHERE json_extract(d.body,'$.kind')='decision' AND json_extract(d.body,'$.targetType')='flow-revision' AND json_extract(d.body,'$.decision')='approve' ORDER BY d.rowid;
    INSERT OR IGNORE INTO hub_work_pending_amendment SELECT r.project_id,json_extract(r.body,'$.flowId'),r.id FROM hub_work_records r WHERE json_extract(r.body,'$.kind')='amendment' AND NOT EXISTS(SELECT 1 FROM hub_work_records d WHERE d.project_id=r.project_id AND json_extract(d.body,'$.kind')='decision' AND json_extract(d.body,'$.targetId')=r.id AND json_extract(d.body,'$.decision') IN ('approve','withdraw'));
    CREATE TRIGGER IF NOT EXISTS hub_work_approval_projection AFTER INSERT ON hub_work_records WHEN json_extract(new.body,'$.kind')='decision' AND json_extract(new.body,'$.decision')='approve' AND json_extract(new.body,'$.targetType')='flow-revision' BEGIN INSERT OR IGNORE INTO hub_work_first_approval SELECT new.project_id,json_extract(body,'$.flowId'),new.id FROM hub_work_records WHERE project_id=new.project_id AND id=json_extract(new.body,'$.targetId'); END;
    CREATE TRIGGER IF NOT EXISTS hub_work_amendment_projection AFTER INSERT ON hub_work_records WHEN json_extract(new.body,'$.kind')='amendment' BEGIN INSERT INTO hub_work_pending_amendment VALUES(new.project_id,json_extract(new.body,'$.flowId'),new.id); END;
    CREATE TRIGGER IF NOT EXISTS hub_work_amendment_resolved AFTER INSERT ON hub_work_records WHEN json_extract(new.body,'$.kind')='decision' AND json_extract(new.body,'$.targetType')='amendment' AND json_extract(new.body,'$.decision') IN ('approve','withdraw') BEGIN DELETE FROM hub_work_pending_amendment WHERE project_id=new.project_id AND amendment_id=json_extract(new.body,'$.targetId'); END;`);

    db.exec(`CREATE TABLE IF NOT EXISTS hub_work_incidents(project_id TEXT NOT NULL,evidence_id TEXT NOT NULL,intent_id TEXT NOT NULL,attempt_id TEXT NOT NULL,flow_id TEXT NOT NULL,PRIMARY KEY(project_id,evidence_id));
    CREATE INDEX IF NOT EXISTS hub_work_incident_flow ON hub_work_incidents(project_id,flow_id);
    CREATE INDEX IF NOT EXISTS hub_work_incident_intent ON hub_work_incidents(project_id,intent_id);
    CREATE INDEX IF NOT EXISTS hub_work_incident_attempt ON hub_work_incidents(project_id,attempt_id);`);
    const incidentSelection = `SELECT e.project_id,e.id,i.id,a.id,json_extract(a.body,'$.flowId') FROM hub_work_records e JOIN hub_work_records a ON a.project_id=e.project_id AND a.id=json_extract(e.body,'$.attemptId') JOIN hub_work_records i ON i.project_id=a.project_id AND i.id=json_extract(a.body,'$.intentId') WHERE json_extract(e.body,'$.kind')='evidence' AND json_extract(e.body,'$.result')<>'pass' AND EXISTS(SELECT 1 FROM hub_work_records s WHERE s.project_id=e.project_id AND json_extract(s.body,'$.kind')='submission' AND json_extract(s.body,'$.attemptId')=a.id AND json_extract(s.body,'$.subjectId')=json_extract(e.body,'$.subjectId') AND json_extract(s.body,'$.subjectDigest')=json_extract(e.body,'$.subjectDigest') AND NOT EXISTS(SELECT 1 FROM json_each(s.body,'$.evidenceIds') WHERE value=e.id) AND EXISTS(SELECT 1 FROM hub_work_records d WHERE d.project_id=e.project_id AND json_extract(d.body,'$.kind')='decision' AND json_extract(d.body,'$.targetType')='intent-review' AND json_extract(d.body,'$.targetId')=i.id AND json_extract(d.body,'$.targetDigest')=json_extract(s.body,'$.contentDigest') AND json_extract(d.body,'$.decision')='accept') AND NOT EXISTS(SELECT 1 FROM hub_work_records replacement JOIN hub_work_records selected ON selected.project_id=replacement.project_id AND selected.id=json_extract(i.body,'$.selectedSubmissionId') WHERE replacement.project_id=e.project_id AND replacement.id=json_extract(i.body,'$.acceptanceDecisionId') AND json_extract(replacement.body,'$.decision')='accept' AND json_extract(replacement.body,'$.targetDigest')=json_extract(selected.body,'$.contentDigest') AND selected.id<>s.id))`;
    if (!db.query("SELECT 1 FROM hub_work_settings WHERE key='incidents-projection-v1'").get()) db.transaction(() => {
        db.exec('INSERT OR IGNORE INTO hub_work_incidents ' + incidentSelection);
        db.query("INSERT INTO hub_work_settings(key,value) VALUES('incidents-projection-v1','1')").run();
    })();
    db.exec(`CREATE TRIGGER IF NOT EXISTS hub_work_incident_evidence AFTER INSERT ON hub_work_records WHEN json_extract(new.body,'$.kind')='evidence' AND json_extract(new.body,'$.result')<>'pass' BEGIN INSERT OR IGNORE INTO hub_work_incidents ${incidentSelection} AND e.project_id=new.project_id AND e.id=new.id; END;
    CREATE TRIGGER IF NOT EXISTS hub_work_incident_replaced AFTER INSERT ON hub_work_records WHEN json_extract(new.body,'$.kind')='decision' AND json_extract(new.body,'$.targetType')='intent-review' AND json_extract(new.body,'$.decision')='accept' BEGIN DELETE FROM hub_work_incidents WHERE project_id=new.project_id AND intent_id=json_extract(new.body,'$.targetId') AND NOT EXISTS(${incidentSelection} AND e.project_id=hub_work_incidents.project_id AND e.id=hub_work_incidents.evidence_id); END;`);

}
export function workRepository(db: Database) {
    type StoredRow = { rowid: number; body: string };
    const baselines = new WeakMap<WorkState, Map<string, string>>();
    const parse = (row: { body: string }) => JSON.parse(row.body) as WorkRecord;
    const currentSequence = (projectId: string): number => db.query<{ sequence: number }, [string]>('SELECT sequence FROM hub_work_cursors WHERE project_id=?').get(projectId)?.sequence ?? 0;
    const record = (projectId: string, id: string): WorkRecord | undefined => {
        const row = db.query<StoredRow, [string, string]>('SELECT rowid,body FROM hub_work_records WHERE project_id=? AND id=?').get(projectId, id);
        return row ? parse(row) : undefined;
    };
    const operation = (projectId: string, actorId: string, operationId: string): WorkReceipt | undefined => {
        const row = db.query<{ body: string }, [string, string, string]>('SELECT body FROM hub_work_operations WHERE project_id=? AND actor_id=? AND operation_id=?').get(projectId, actorId, operationId);
        return row ? JSON.parse(row.body) as WorkReceipt : undefined;
    };
    const rowsWhere = (projectId: string, clause: string, values: (string | number)[] = []) => db.query<StoredRow, (string | number)[]>(`SELECT rowid,body FROM hub_work_records WHERE project_id=? AND (${clause}) ORDER BY rowid`).all(projectId, ...values);
    const nextRevisionNumber = (projectId: string, kind: 'flow-revision' | 'intent-revision', targetId: string): number => {
        const field = kind === 'flow-revision' ? 'flowId' : 'intentId';
        return (db.query<{ n: number | null }, [string, string, string]>(`SELECT max(json_extract(body,'$.revision')) AS n FROM hub_work_records WHERE project_id=? AND json_extract(body,'$.kind')=? AND json_extract(body,'$.${field}')=?`).get(projectId, kind, targetId)?.n ?? 0) + 1;
    };
    const eventsAfter = (projectId: string, after: number, limit: number): WorkEvent[] => {
        const position = db.query<{ sequence: number; pruned_through: number }, [string]>('SELECT sequence,pruned_through FROM hub_work_cursors WHERE project_id=?').get(projectId);
        if (after > (position?.sequence ?? 0) || after < (position?.pruned_through ?? 0))
            fail(410, 'resync-required', 'Event history gap; start a new snapshot');
        return db.query<{ body: string }, [string, number, number]>('SELECT body FROM hub_work_events WHERE project_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(projectId, after, limit).map(row => JSON.parse(row.body) as WorkEvent);
    };
    function stateFromRows(projectId: string, rows: StoredRow[], receipt?: WorkReceipt): WorkState {
        const state: WorkState = { records: rows.map(parse), events: [], operations: {}, sequence: currentSequence(projectId) };
        if (receipt) state.operations[projectId + ':' + receipt.actorId + ':' + receipt.operationId] = receipt;
        baselines.set(state, new Map(rows.map(row => [(JSON.parse(row.body) as WorkRecord).id, row.body])));
        return state;
    }
    /** Only outgoing immutable pins and command-specific relevant siblings enter a unit of work. */
    const commandState = (projectId: string, input: unknown, actorId: string): WorkState => {
        const command = input as { command?: string; payload?: unknown; expectedVersions?: Record<string, unknown>; operationId?: string };
        const kind = command.command ?? '';
        const membership = ['revision.propose', 'flow.start', 'flow.submit', 'review.decide', 'requirements.approve', 'requirements.amend', 'requirements.resolve-amendment', 'work.cancel'].includes(kind);
        const found = new Map<string, StoredRow>();
        const addRows = (rows: StoredRow[]) => { for (const row of rows) found.set(parse(row).id, row); };
        const visit = (value: unknown, key = ''): void => {
            if (['requiredIntentIds', 'affectedIntentIds'].includes(key) && !membership) return;
            if (typeof value === 'string' && (key.endsWith('Id') || key.endsWith('Ids') || key === 'seed')) {
                if (['supersedesAttemptId', 'legacyFlowId', 'createdBy', 'ownerId'].includes(key) || found.has(value)) return;
                const row = db.query<StoredRow, [string, string]>('SELECT rowid,body FROM hub_work_records WHERE project_id=? AND id=?').get(projectId, value);
                if (row) { found.set(value, row); visit(parse(row)); }
            } else if (Array.isArray(value)) { for (const item of value) visit(item, key); }
            else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
        };
        const payload = command.payload as Record<string, unknown> | undefined;
        if (kind === 'attempt.create') visit(payload?.supersedesAttemptId, 'seed');
        if (kind === 'execution.bind' && typeof payload?.runId === 'string') addRows(rowsWhere(projectId, "json_extract(body,'$.kind')='execution-link' AND json_extract(body,'$.runId')=?", [payload.runId]));
        visit(command.payload);
        const loadedAttempts = new Set<string>(), loadedFlows = new Set<string>(), loadedSubjects = new Set<string>();
        const acceptance = ['attempt.submit', 'attempt.select', 'review.decide', 'flow.submit'].includes(kind);
        for (let changed = true; changed;) {
            const before = found.size;
            for (const row of [...found.values()]) {
                const r = parse(row); visit(r);
                if (r.kind === 'attempt' && !loadedAttempts.has(r.id)) {
                    loadedAttempts.add(r.id);
                    addRows(rowsWhere(projectId, "json_extract(body,'$.attemptId')=? AND json_extract(body,'$.kind') IN ('execution-link'" + (acceptance ? ",'evidence','subject','submission'" : '') + ')', [r.id]));
                }
                if (r.kind === 'subject' && acceptance && !loadedSubjects.has(r.id)) {
                    loadedSubjects.add(r.id);
                    addRows(rowsWhere(projectId, "json_extract(body,'$.kind')='evidence' AND json_extract(body,'$.subjectId')=?", [r.id]));
                }
                if (r.kind === 'flow' && !loadedFlows.has(r.id)) {
                    loadedFlows.add(r.id);
                    // Only unresolved amendments block work. Resolved history is immutable audit data.
                    addRows(db.query<StoredRow,[string,string]>('SELECT r.rowid,r.body FROM hub_work_pending_amendment p JOIN hub_work_records r ON r.project_id=p.project_id AND r.id=p.amendment_id WHERE p.project_id=? AND p.flow_id=? ORDER BY r.rowid').all(projectId,r.id));
                    if (['requirements.approve', 'requirements.amend', 'requirements.resolve-amendment', 'work.cancel'].includes(kind))
                        addRows(rowsWhere(projectId, "json_extract(body,'$.kind')='intent' AND json_extract(body,'$.flowId')=?", [r.id]));
                    if (kind === 'requirements.approve') {
                    const first = db.query<StoredRow, [string, string]>('SELECT r.rowid,r.body FROM hub_work_first_approval p JOIN hub_work_records r ON r.project_id=p.project_id AND r.id=p.decision_id WHERE p.project_id=? AND p.flow_id=?').get(projectId,r.id);
                    if (first) addRows([first]);
                    }
                }
                if (r.kind === 'intent' && kind === 'work.cancel') addRows(rowsWhere(projectId, "json_extract(body,'$.kind')='attempt' AND json_extract(body,'$.intentId')=?", [r.id]));
            }
            changed = before !== found.size;
        }
        // Criterion waivers are immutable decisions addressed by exact criterion digest.
        if (acceptance) {
            for (const row of [...found.values()]) {
                const r = parse(row);
                if (r.kind === 'flow-revision' || r.kind === 'intent-revision')
                    for (const criterion of r.criteria) addRows(rowsWhere(projectId, "json_extract(body,'$.kind')='decision' AND json_extract(body,'$.targetType')='criterion-waiver' AND json_extract(body,'$.targetId')=?", [criterion.criterionId]));
            }
        }
        return stateFromRows(projectId, [...found.values()].sort((a, b) => a.rowid - b.rowid), typeof command.operationId === 'string' ? operation(projectId, actorId, command.operationId) : undefined);
    };
    const recordState = (projectId: string, id: string): WorkState => commandState(projectId, { command: 'attempt.report', payload: { recordId: id } }, '');
    /** Bounded read projections retain the public cursor and aggregate contracts. */
    const readState = (projectId: string, path: string[], url: URL, supportAttention = true): WorkState => {
        const kinds: Record<string, string> = { flows: 'flow', intents: 'intent', attempts: 'attempt', contexts: 'context', subjects: 'subject', submissions: 'submission', 'flow-submissions': 'flow-submission', decisions: 'decision', amendments: 'amendment' };
        if (path[2] === 'acceptance-preview') return commandState(projectId, { command: 'flow.submit', payload: { flowId: path[1] } }, '');
        let clause: string, args: (string | number)[] = [], parent: StoredRow | undefined;
        if (path.length === 1) {
            if (path[0] === 'attention') {
                clause = "id IN (SELECT id FROM hub_work_records WHERE project_id=? AND json_extract(body,'$.kind') IN ('flow','intent') AND json_extract(body,'$.state')='in-review' UNION SELECT id FROM hub_work_records WHERE project_id=? AND json_extract(body,'$.kind')='attempt' AND json_extract(body,'$.state')='blocked' UNION SELECT evidence_id FROM hub_work_incidents WHERE project_id=?)";
                args.push(projectId,projectId,projectId);
            }
            else { clause = "json_extract(body,'$.kind')=?"; args.push(kinds[path[0]!] ?? 'unknown'); }
            const target = url.searchParams.get('targetId');
            if (target) { clause = '(' + clause + ") AND json_extract(body,'$.targetId')=?"; args.push(target); }
        } else if (path.length === 3 && ['intents','attempts','evidence'].includes(path[2]!)) {
            parent = db.query<StoredRow, [string,string]>('SELECT rowid,body FROM hub_work_records WHERE project_id=? AND id=?').get(projectId,path[1]!) ?? undefined;
            const field = path[0] === 'flows' ? 'flowId' : path[0] === 'intents' ? 'intentId' : 'attemptId';
            clause = `json_extract(body,'$.kind')=? AND json_extract(body,'$.${field}')=?`;
            args = [path[2] === 'evidence' ? 'evidence' : kinds[path[2]!]!, path[1]!];
        } else {
            const state = commandState(projectId, { command: 'attempt.report', payload: { entityId: path[1], revisionId: path[3] } }, '');
            const r = state.records.find(r => r.id === path[1]);
            if (path.length === 2 && r && ['flow','intent','attempt'].includes(r.kind)) {
                const field = r.kind === 'flow' ? 'flowId' : r.kind === 'intent' ? 'intentId' : 'attemptId';
                const children = db.query<StoredRow, [string,string]>(`SELECT rowid,body FROM hub_work_records WHERE project_id=? AND json_extract(body,'$.${field}')=? ORDER BY rowid LIMIT 201`).all(projectId,r.id);
                if (children.length > 200) fail(413,'projection-too-large','Use scoped history pages for this aggregate');
                const ids = new Set(state.records.map(r => r.id));
                for (const child of children) if (!ids.has(parse(child).id)) state.records.push(parse(child));
            }
            return state;
        }
        const rawLimit = url.searchParams.get('limit'), limit = rawLimit === null ? 50 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail(400,'invalid-limit','Limit must be 1 through 200');
        const after = url.searchParams.get('afterId');
        if (after) {
            let parsed: unknown; try { parsed = JSON.parse(Buffer.from(after,'base64url').toString()); } catch { fail(400,'invalid-cursor','Invalid cursor'); }
            if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== projectId || typeof parsed[1] !== 'string') fail(400,'invalid-cursor','Invalid cursor');
            const previous = db.query<StoredRow, (string | number)[]>(`SELECT rowid,body FROM hub_work_records WHERE project_id=? AND (${clause}) AND id=?`).get(projectId,...args,parsed[1]);
            if (!previous) fail(400,'invalid-cursor','Cursor not found');
            clause = '(' + clause + ') AND rowid>=?'; args.push(previous.rowid);
        }
        const rows = db.query<StoredRow, (string | number)[]>(`SELECT rowid,body FROM hub_work_records WHERE project_id=? AND (${clause}) ORDER BY rowid LIMIT ?`).all(projectId,...args,limit+2);
        if (parent) rows.unshift(parent);
        const state = stateFromRows(projectId,rows);
        if (path[0] === 'attention' && supportAttention) {
            const ids = new Set(state.records.map(r => r.id));
            for (const item of [...state.records]) if (item.kind === 'evidence') {
                const related = commandState(projectId, { command: 'attempt.submit', payload: { attemptId: item.attemptId } }, '');
                for (const record of related.records) if (!ids.has(record.id)) { state.records.push(record); ids.add(record.id); }
                // Historical acceptance may differ from the Intent's current decision.
                for (const record of related.records) if (record.kind === 'submission')
                    for (const row of rowsWhere(projectId, "json_extract(body,'$.kind')='decision' AND json_extract(body,'$.targetId')=? AND json_extract(body,'$.targetDigest')=?", [related.records.find((item): item is import('./model').Attempt => item.kind === 'attempt' && item.id === record.attemptId)?.intentId ?? '',record.contentDigest])) if (!ids.has(parse(row).id)) { state.records.push(parse(row)); ids.add(parse(row).id); }
            }
        }
        return state;
    };
    const attentionPage = (projectId: string, url: URL) => {
        const state = readState(projectId, ['attention'], url, false);
        const matching = state.records;
        const limit = Number(url.searchParams.get('limit') ?? 50), after = url.searchParams.get('afterId');
        const afterId: unknown = after ? (JSON.parse(Buffer.from(after, 'base64url').toString()) as unknown[])[1] : undefined;
        const start = afterId ? matching.findIndex(r => r.id === afterId) + 1 : 0;
        const records = matching.slice(start,start+limit);
        return { records, nextCursor: start+limit<matching.length ? Buffer.from(JSON.stringify([projectId, records.at(-1)!.id])).toString('base64url') : null, eventCursor: state.sequence ?? 0 };
    };
    const snapshotState = (projectId: string, maxBytes: number): WorkState => {
        const row = db.query<{ bytes: number | null }, [string]>('SELECT sum(length(CAST(body AS BLOB))) AS bytes FROM hub_work_records WHERE project_id=?').get(projectId);
        if ((row?.bytes ?? 0) > maxBytes) fail(413,'quota-exceeded','Snapshot export exceeds quota; use scoped views');
        return stateFromRows(projectId, rowsWhere(projectId, '1'));
    };
    /** Explicit full export only. Polling and mutations use indexed bounded repository methods. */
    const load = (projectId: string): WorkState => {
        const state = stateFromRows(projectId, rowsWhere(projectId, '1'));
        state.events = db.query<{ body: string }, [string]>('SELECT body FROM hub_work_events WHERE project_id=? ORDER BY sequence').all(projectId).map(row => JSON.parse(row.body) as WorkEvent);
        state.operations = Object.fromEntries(db.query<{ state_key: string; body: string }, [string]>('SELECT state_key,body FROM hub_work_operations WHERE project_id=?').all(projectId).map(row => [row.state_key, JSON.parse(row.body) as WorkReceipt]));
        // Preserve the public export's original shape; scoped units carry sequence explicitly.
        delete state.sequence;
        return state;
    };
    const activateWriter = () => db.query('UPDATE remote_schema_version SET version=? WHERE version<?').run(MANAGED_WORK_WRITER_VERSION, MANAGED_WORK_WRITER_VERSION);
    const save = db.transaction((projectId: string, state: WorkState): void => {
        if ([...state.records, ...state.events, ...Object.values(state.operations)].some(record => record.projectId !== projectId)) throw new TypeError('Cross-project work write refused');
        activateWriter();
        const baseline = baselines.get(state);
        const putRecord = db.query('INSERT INTO hub_work_records(project_id,id,body) VALUES(?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body WHERE body<>excluded.body');
        for (const record of state.records) {
            const body = JSON.stringify(record);
            if (Buffer.byteLength(body) > workStorageLimits.maxRecordBytes) fail(413, 'quota-exceeded', 'Work record exceeds durable quota');
            if (baseline?.get(record.id) !== body) putRecord.run(projectId, record.id, body);
        }
        const putEvent = db.query('INSERT OR IGNORE INTO hub_work_events(project_id,sequence,body) VALUES(?,?,?)');
        for (const event of state.events) putEvent.run(projectId, event.sequence, JSON.stringify(event));
        const sequence = Math.max(currentSequence(projectId), state.sequence ?? 0, state.events.reduce((latest, event) => Math.max(latest, event.sequence), 0));
        db.query('INSERT INTO hub_work_cursors(project_id,sequence,pruned_through) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET sequence=max(sequence,excluded.sequence),pruned_through=max(pruned_through,excluded.pruned_through)').run(projectId, sequence, Math.max(0, sequence - workStorageLimits.retainedEvents));
        db.query('DELETE FROM hub_work_events WHERE project_id=? AND sequence<=?').run(projectId, Math.max(0, sequence - workStorageLimits.retainedEvents));
        const putOperation = db.query('INSERT OR IGNORE INTO hub_work_operations(project_id,actor_id,operation_id,state_key,body) VALUES(?,?,?,?,?)');
        for (const [key, receipt] of Object.entries(state.operations)) {
            const body = JSON.stringify(receipt);
            if (Buffer.byteLength(body) > workStorageLimits.maxOperationBytes) fail(413, 'quota-exceeded', 'Work receipt exceeds durable quota');
            putOperation.run(projectId, receipt.actorId, receipt.operationId, key, body);
        }
        const usage = db.query<{ records: number; operations: number; bytes: number }, [string]>('SELECT records,operations,bytes FROM hub_work_usage WHERE project_id=?').get(projectId);
        if (usage && (usage.records > workStorageLimits.maxRecords || usage.operations > workStorageLimits.maxOperations || usage.bytes > workStorageLimits.maxHistoryBytes)) fail(413, 'quota-exceeded', 'Managed work durable history quota exceeded; archive the project before adding more history');
    });
    const archiveDocument = (document: HubDocument): void => {
        db.query('INSERT OR IGNORE INTO hub_work_documents(project_id,document_id,version,content_digest,body) VALUES(?,?,?,?,?)').run(document.projectId, document.id, document.version, document.contentDigest, JSON.stringify(document));
    };
    const documentVersion = (projectId: string, reference: {
        documentId: string;
        version: number;
        contentDigest: string;
    }): HubDocument | undefined => {
        const row = db.query<{
            body: string;
        }, [
            string,
            string,
            number,
            string
        ]>('SELECT body FROM hub_work_documents WHERE project_id=? AND document_id=? AND version=? AND content_digest=?').get(projectId, reference.documentId, reference.version, reference.contentDigest);
        return row ? JSON.parse(row.body) as HubDocument : undefined;
    };
    const cursorSecret = (): string => {
        const existing = db.query<{value:string},[string]>('SELECT value FROM hub_work_settings WHERE key=?').get('cursor-secret');
        if (existing) return existing.value;
        db.query('INSERT OR IGNORE INTO hub_work_settings(key,value) VALUES(?,?)').run('cursor-secret', randomBytes(32).toString('base64url'));
        const row = db.query<{
            value: string;
        }, [
            string
        ]>('SELECT value FROM hub_work_settings WHERE key=?').get('cursor-secret');
        if (!row)
            throw new TypeError('Work cursor configuration unavailable');
        return row.value;
    };
    const conversion = (projectId: string, legacyFlowId: string): string | undefined => db.query<{
        managed_flow_id: string;
    }, [
        string,
        string
    ]>('SELECT managed_flow_id FROM hub_work_conversions WHERE project_id=? AND legacy_flow_id=?').get(projectId, legacyFlowId)?.managed_flow_id;
    const conversionForLegacy = (legacyFlowId: string): {projectId: string; managedFlowId: string} | undefined => {
        const row = db.query<{project_id:string;managed_flow_id:string},[string]>('SELECT project_id,managed_flow_id FROM hub_work_conversions WHERE legacy_flow_id=?').get(legacyFlowId);
        return row ? { projectId: row.project_id, managedFlowId: row.managed_flow_id } : undefined;
    };
    const conversions = () => db.query<{
        project_id: string;
        legacy_flow_id: string;
        managed_flow_id: string;
    }, [
    ]>('SELECT project_id,legacy_flow_id,managed_flow_id FROM hub_work_conversions').all();
    const markConverted = (projectId: string, legacyFlowId: string, managedFlowId: string) => {
        activateWriter();
        db.query('INSERT INTO hub_work_conversions(project_id,legacy_flow_id,managed_flow_id) VALUES(?,?,?)').run(projectId, legacyFlowId, managedFlowId);
    };
    const saveLegacyPreview = (projectId: string, actorId: string, preview: LegacyPreview) => db.query('INSERT INTO hub_work_legacy_previews(project_id,actor_id,receipt_id,body) VALUES(?,?,?,?)').run(projectId, actorId, preview.receiptId, JSON.stringify(preview));
    const legacyPreview = (projectId: string, actorId: string, receiptId: string): LegacyPreview | undefined => {
        const row = db.query<{
            body: string;
        }, [
            string,
            string,
            string
        ]>('SELECT body FROM hub_work_legacy_previews WHERE project_id=? AND actor_id=? AND receipt_id=?').get(projectId, actorId, receiptId);
        return row ? JSON.parse(row.body) as LegacyPreview : undefined;
    };
    const executionReservation = (operationId: string): WorkExecutionReservation | undefined => {
        const row = db.query<{
            body: string;
        }, [
            string
        ]>('SELECT body FROM hub_work_execution_reservations WHERE operation_id=?').get(operationId);
        return row ? JSON.parse(row.body) as WorkExecutionReservation : undefined;
    };
    const reservationForRun = (runId: string): WorkExecutionReservation | undefined => {
        const row = db.query<{
            body: string;
        }, [
            string
        ]>('SELECT body FROM hub_work_execution_reservations WHERE run_id=?').get(runId);
        return row ? JSON.parse(row.body) as WorkExecutionReservation : undefined;
    };
    const reservationsForAttempt = (projectId: string, attemptId: string): WorkExecutionReservation[] => db.query<{
        body: string;
    }, [
        string,
        string
    ]>('SELECT body FROM hub_work_execution_reservations WHERE project_id=? AND attempt_id=? ORDER BY rowid').all(projectId, attemptId).map(row => JSON.parse(row.body) as WorkExecutionReservation);
    const saveExecutionReservation = (reservation: WorkExecutionReservation): void => {
        const previous = executionReservation(reservation.operationId);
        if (previous) {
            const immutable = (value: WorkExecutionReservation) => {
                const { state: unusedState, runId: unusedRun, turnId: unusedTurn, ...pins } = value;
                void unusedState;
                void unusedRun;
                void unusedTurn;
                return JSON.stringify(pins);
            };
            if (immutable(previous) !== immutable(reservation) || previous.state === 'bound' && (previous.runId !== reservation.runId || previous.turnId !== reservation.turnId || reservation.state !== 'bound'))
                throw new TypeError('Immutable execution reservation conflict');
        }
        activateWriter();
        db.query('INSERT INTO hub_work_execution_reservations(operation_id,project_id,attempt_id,run_id,body) VALUES(?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET run_id=excluded.run_id,body=excluded.body').run(reservation.operationId, reservation.projectId, reservation.attemptId, reservation.runId, JSON.stringify(reservation));
    };
    const gitObservations = (projectId: string, subjectId: string): GitObservation[] => db.query<{
        body: string;
    }, [
        string,
        string
    ]>('SELECT body FROM hub_work_git_observations WHERE project_id=? AND subject_id=? ORDER BY generation,id').all(projectId, subjectId).map(row => JSON.parse(row.body) as GitObservation);
    const saveGitObservation = (observation: GitObservation): void => {
        activateWriter();
        db.query('INSERT INTO hub_work_git_observations(project_id,subject_id,id,generation,body) VALUES(?,?,?,?,?)').run(observation.projectId, observation.subjectId, observation.id, observation.generation, JSON.stringify(observation));
    };
    const nextObservationGeneration = db.transaction((projectId: string, subjectId: string): number => {
        db.query('INSERT INTO hub_work_observation_generations(project_id,subject_id,generation) VALUES(?,?,1) ON CONFLICT(project_id,subject_id) DO UPDATE SET generation=generation+1').run(projectId, subjectId);
        return db.query<{
            generation: number;
        }, [
            string,
            string
        ]>('SELECT generation FROM hub_work_observation_generations WHERE project_id=? AND subject_id=?').get(projectId, subjectId)!.generation;
    });
    const observationJob = (projectId: string, actorId: string, operationId: string): WorkObservationJob | undefined => {
        const row = db.query<{
            body: string;
        }, [
            string,
            string,
            string
        ]>('SELECT body FROM hub_work_observation_jobs WHERE project_id=? AND actor_id=? AND operation_id=?').get(projectId, actorId, operationId);
        return row ? JSON.parse(row.body) as WorkObservationJob : undefined;
    };
    const saveObservationJob = (job: WorkObservationJob): void => {
        activateWriter();
        db.query('INSERT INTO hub_work_observation_jobs(project_id,actor_id,operation_id,body) VALUES(?,?,?,?)').run(job.projectId, job.actorId, job.operationId, JSON.stringify(job));
    };
    const deleteObservationJob = (projectId: string, actorId: string, operationId: string): void => {
        db.query('DELETE FROM hub_work_observation_jobs WHERE project_id=? AND actor_id=? AND operation_id=?').run(projectId, actorId, operationId);
    };
    return {
        attentionPage, snapshotState, readState, record, recordState, commandState, operation, currentSequence, eventsAfter, nextRevisionNumber, gitObservations, saveGitObservation, nextObservationGeneration, observationJob, saveObservationJob, deleteObservationJob, executionReservation, reservationForRun, reservationsForAttempt, saveExecutionReservation, load, save, archiveDocument, documentVersion, cursorSecret, conversion, conversionForLegacy, conversions, markConverted, saveLegacyPreview, legacyPreview
    };
}
