import { MANAGED_WORK_WRITER_VERSION } from '../remote-v2/storage';
import { randomBytes } from 'node:crypto';
import type { HubDocument } from '../contracts';
import type { Database } from 'bun:sqlite';
import type { GitObservation } from './git-observer';
import type { WorkExecutionReservation } from './execution';
import type { LegacyPreview } from './legacy';
import type { WorkEvent, WorkReceipt, WorkRecord, WorkState } from './model';
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
    CREATE TABLE IF NOT EXISTS hub_work_legacy_previews(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,receipt_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,receipt_id));
    CREATE TABLE IF NOT EXISTS hub_work_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_work_records(project_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,id));
    CREATE TABLE IF NOT EXISTS hub_work_events(project_id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,sequence));
    CREATE TABLE IF NOT EXISTS hub_work_operations(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,state_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,operation_id));
    CREATE TABLE IF NOT EXISTS hub_work_documents(project_id TEXT NOT NULL,document_id TEXT NOT NULL,version INTEGER NOT NULL,content_digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,document_id,version));
    CREATE TABLE IF NOT EXISTS hub_work_outbox(project_id TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL,delivered_at TEXT,PRIMARY KEY(project_id,sequence));`);
}
export function workRepository(db: Database) {
    const load = (projectId: string): WorkState => ({
        records: db.query<{
            body: string;
        }, [
            string
        ]>('SELECT body FROM hub_work_records WHERE project_id=? ORDER BY rowid').all(projectId).map(row => JSON.parse(row.body) as WorkRecord),
        events: db.query<{
            body: string;
        }, [
            string
        ]>('SELECT body FROM hub_work_events WHERE project_id=? ORDER BY sequence').all(projectId).map(row => JSON.parse(row.body) as WorkEvent),
        operations: Object.fromEntries(db.query<{
            state_key: string;
            body: string;
        }, [
            string
        ]>('SELECT state_key,body FROM hub_work_operations WHERE project_id=?').all(projectId).map(row => [row.state_key, JSON.parse(row.body) as WorkReceipt])),
    });
    const save = db.transaction((projectId: string, state: WorkState): void => {
        if ([...state.records, ...state.events, ...Object.values(state.operations)].some(record => record.projectId !== projectId))
            throw new TypeError('Cross-project work write refused');
        // Mark activation in the existing startup gate an older binary already checks.
        // This is a minimum writer version, not a machine protocol/schema rewrite.
        db.query('UPDATE remote_schema_version SET version=?').run(MANAGED_WORK_WRITER_VERSION);
        const putRecord = db.query('INSERT INTO hub_work_records(project_id,id,body) VALUES(?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET body=excluded.body');
        for (const record of state.records)
            putRecord.run(projectId, record.id, JSON.stringify(record));
        const putEvent = db.query('INSERT OR IGNORE INTO hub_work_events(project_id,sequence,body) VALUES(?,?,?)');
        const putOutbox = db.query('INSERT OR IGNORE INTO hub_work_outbox(project_id,sequence,body) VALUES(?,?,?)');
        for (const event of state.events) {
            const body = JSON.stringify(event);
            putEvent.run(projectId, event.sequence, body);
            putOutbox.run(projectId, event.sequence, body);
        }
        const putOperation = db.query('INSERT OR IGNORE INTO hub_work_operations(project_id,actor_id,operation_id,state_key,body) VALUES(?,?,?,?,?)');
        for (const [key, receipt] of Object.entries(state.operations))
            putOperation.run(projectId, receipt.actorId, receipt.operationId, key, JSON.stringify(receipt));
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
    const conversions = () => db.query<{
        project_id: string;
        legacy_flow_id: string;
        managed_flow_id: string;
    }, [
    ]>('SELECT project_id,legacy_flow_id,managed_flow_id FROM hub_work_conversions').all();
    const markConverted = (projectId: string, legacyFlowId: string, managedFlowId: string) => {
        db.query('UPDATE remote_schema_version SET version=?').run(MANAGED_WORK_WRITER_VERSION);
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
        db.query('UPDATE remote_schema_version SET version=?').run(MANAGED_WORK_WRITER_VERSION);
        db.query('INSERT INTO hub_work_execution_reservations(operation_id,project_id,attempt_id,run_id,body) VALUES(?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET run_id=excluded.run_id,body=excluded.body').run(reservation.operationId, reservation.projectId, reservation.attemptId, reservation.runId, JSON.stringify(reservation));
    };
    const gitObservations = (projectId: string, subjectId: string): GitObservation[] => db.query<{
        body: string;
    }, [
        string,
        string
    ]>('SELECT body FROM hub_work_git_observations WHERE project_id=? AND subject_id=? ORDER BY generation,id').all(projectId, subjectId).map(row => JSON.parse(row.body) as GitObservation);
    const saveGitObservation = (observation: GitObservation): void => {
        db.query('UPDATE remote_schema_version SET version=?').run(MANAGED_WORK_WRITER_VERSION);
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
        db.query('UPDATE remote_schema_version SET version=?').run(MANAGED_WORK_WRITER_VERSION);
        db.query('INSERT INTO hub_work_observation_jobs(project_id,actor_id,operation_id,body) VALUES(?,?,?,?)').run(job.projectId, job.actorId, job.operationId, JSON.stringify(job));
    };
    const deleteObservationJob = (projectId: string, actorId: string, operationId: string): void => {
        db.query('DELETE FROM hub_work_observation_jobs WHERE project_id=? AND actor_id=? AND operation_id=?').run(projectId, actorId, operationId);
    };
    return {
        gitObservations, saveGitObservation, nextObservationGeneration, observationJob, saveObservationJob, deleteObservationJob, executionReservation, reservationForRun, reservationsForAttempt, saveExecutionReservation, load, save, archiveDocument, documentVersion, cursorSecret, conversion, conversions, markConverted, saveLegacyPreview, legacyPreview
    };
}
