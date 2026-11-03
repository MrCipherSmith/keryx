import type { Database } from 'bun:sqlite';
import type { HubFlow, LegacyReviewDecision, LegacyReviewReceipt } from './contracts';
import { fail } from './domain';
import { LEGACY_REVIEW_WRITER_VERSION } from './remote-v2/storage';

/** Additive immutable facts share the legacy transaction and its existing operation ledger. */
export function legacyReviewRepository(db: Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_legacy_review_decisions(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, flow_id TEXT NOT NULL,
      subject_revision_id TEXT NOT NULL, flow_version INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
      UNIQUE(project_id,flow_id,flow_version));
      CREATE TABLE IF NOT EXISTS hub_legacy_review_guards(project_id TEXT NOT NULL,flow_id TEXT NOT NULL,decision_id TEXT NOT NULL,flow_version INTEGER NOT NULL,PRIMARY KEY(project_id,flow_id));
      CREATE INDEX IF NOT EXISTS hub_legacy_review_subject ON hub_legacy_review_decisions(project_id,flow_id,subject_revision_id);
      CREATE TRIGGER IF NOT EXISTS hub_legacy_review_no_update BEFORE UPDATE ON hub_legacy_review_decisions BEGIN SELECT RAISE(ABORT,'Immutable legacy review decision'); END;
      CREATE TRIGGER IF NOT EXISTS hub_legacy_review_no_delete BEFORE DELETE ON hub_legacy_review_decisions BEGIN SELECT RAISE(ABORT,'Immutable legacy review decision'); END;`);
    db.query('UPDATE remote_schema_version SET version=? WHERE version<?').run(LEGACY_REVIEW_WRITER_VERSION, LEGACY_REVIEW_WRITER_VERSION);
  })();
  const decision = (projectId: string, flowId: string, id: string): LegacyReviewDecision | undefined => {
    const row = db.query<{body:string},[string,string,string]>('SELECT body FROM hub_legacy_review_decisions WHERE project_id=? AND flow_id=? AND id=?').get(projectId,flowId,id);
    return row ? JSON.parse(row.body) as LegacyReviewDecision : undefined;
  };
  return {
    append(projectId: string, receipt: LegacyReviewReceipt) {
      const value = receipt.decision;
      db.query('INSERT INTO hub_legacy_review_decisions(id,project_id,flow_id,subject_revision_id,flow_version,body) VALUES(?,?,?,?,?,?)').run(value.id,projectId,value.flowId,value.subjectRevisionId,receipt.flowVersion,JSON.stringify(value));
      db.query('INSERT INTO hub_legacy_review_guards(project_id,flow_id,decision_id,flow_version) VALUES(?,?,?,?) ON CONFLICT(project_id,flow_id) DO UPDATE SET decision_id=excluded.decision_id,flow_version=excluded.flow_version').run(projectId,value.flowId,value.id,receipt.flowVersion);
    },
    decision,
    history(projectId: string, flowId: string, after: string | undefined, limit: number): {decisions: LegacyReviewDecision[];nextAfter: string | null} {
      // Authorization has already established a current project reader. Resolve the exact
      // legacy target through its indexed projection, never the lifetime JSON aggregate.
      const target = db.query<{id:string},[string,string]>(`SELECT f.id FROM hub_legacy_records f JOIN hub_legacy_records p ON p.kind='projects' AND p.id=f.project_id
        WHERE f.kind='flows' AND f.project_id=? AND f.id=?`).get(projectId,flowId);
      if (!target) fail(404,'not-found','Flow not found');
      let version: number | undefined;
      if (after !== undefined) {
        const anchor = db.query<{flow_version:number},[string,string,string]>('SELECT flow_version FROM hub_legacy_review_decisions WHERE project_id=? AND flow_id=? AND id=?').get(projectId,flowId,after);
        if (!anchor) fail(400,'invalid-cursor','Review decision cursor does not belong to this Flow');
        version=anchor.flow_version;
      }
      // The existing UNIQUE(project_id,flow_id,flow_version) index supplies a reverse
      // keyset walk; immutable versions are unique within a Flow, including timestamp ties.
      const rows = version === undefined
        ? db.query<{body:string},[string,string,number]>('SELECT body FROM hub_legacy_review_decisions WHERE project_id=? AND flow_id=? ORDER BY flow_version DESC LIMIT ?').all(projectId,flowId,limit+1)
        : db.query<{body:string},[string,string,number,number]>('SELECT body FROM hub_legacy_review_decisions WHERE project_id=? AND flow_id=? AND flow_version<? ORDER BY flow_version DESC LIMIT ?').all(projectId,flowId,version,limit+1);
      const decisions=rows.slice(0,limit).map(row=>JSON.parse(row.body) as LegacyReviewDecision);
      return {decisions,nextAfter:rows.length>limit ? decisions.at(-1)!.id : null};
    },
    projectFlows(flows: readonly HubFlow[]): HubFlow[] {
      // Only current unresolved decision IDs are loaded, never lifetime history or per-row queries.
      const ids = flows.filter(flow => flow.lastReturnDecisionId && !flow.returnResolved).map(flow => flow.lastReturnDecisionId!);
      const decisions = new Map(db.query<{id:string;project_id:string;flow_id:string;body:string},[string]>(
        'SELECT id,project_id,flow_id,body FROM hub_legacy_review_decisions WHERE id IN (SELECT value FROM json_each(?))',
      ).all(JSON.stringify(ids)).map(row => [row.id,{projectId:row.project_id,flowId:row.flow_id,value:JSON.parse(row.body) as LegacyReviewDecision}]));
      return flows.map(flow => {
        const current = flow.lastReturnDecisionId && !flow.returnResolved ? decisions.get(flow.lastReturnDecisionId) : undefined;
        if (flow.lastReturnDecisionId && !flow.returnResolved && (!current || current.projectId !== flow.projectId || current.flowId !== flow.id)) fail(409,'review-history-unavailable','Return history is unavailable; restore the complete backup');
        const {reviewFeedback:unused,returnResolved:resolved,...record}=flow; void unused; void resolved;
        return {...record, reviewFeedback: current?.value ?? null};
      });
    },
    assertGuards(flows: readonly HubFlow[]) {
      // Batch latest guards, including deleted/missing Flows: an old aggregate cannot erase returned work.
      const rows = db.query<{project_id:string;flow_id:string;id:string;flow_version:number},[]>('SELECT project_id,flow_id,decision_id AS id,flow_version FROM hub_legacy_review_guards').all();
      const byId = new Map(flows.map(flow => [JSON.stringify([flow.projectId,flow.id]),flow]));
      for (const row of rows) {
        const flow = byId.get(JSON.stringify([row.project_id,row.flow_id]));
        if (!flow || flow.lastReturnDecisionId !== row.id || flow.version < row.flow_version) fail(409,'return-guard-conflict','Return history changed; reload before saving');
      }
    },
  };
}
