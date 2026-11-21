import { randomUUID } from "node:crypto";
import { projectGithubBinding } from "./github-account-store";
import type { GithubConnection } from "./board-github";
import { watcherTransaction } from "./watcher-db";
import { appendPrSubscriptionEvent } from "./watcher-subscriptions";
import type { PrRepairSettings, PrRepairSource } from "./watcher-types";

export interface RepairGrant extends PrRepairSource {
  generation: string;
  settings: PrRepairSettings;
  pause: number;
}

export interface RepairReply {
  kind: "thread" | "review";
  id: string;
  url: string;
}

export interface RepairPlan {
  commit: string;
  ready: boolean;
  reply?: RepairReply;
}

interface RepairRow {
  id: string;
  generation: string;
  headSha: string;
  pause: number;
  state: "working" | "prepared" | "done" | "failed";
  claimedAt: number;
  plan: string | null;
}

const maxJobAge = 10 * 60_000;

export class RepairStore {
  constructor(private readonly scope: string, private readonly number: number) {}

  grant(): RepairGrant | undefined {
    return watcherTransaction(db => {
      const row = db.query<Omit<RepairGrant, "settings"> & { settings: string }, [string, number]>(
        `SELECT r.generation,r.settings,r.repositoryId,r.branch,COALESCE(p.generation,0) AS pause
         FROM review_pr_repairs r JOIN watchers w ON r.watcher=w.id
         LEFT JOIN watcher_pauses p ON p.watcher=w.id
         WHERE r.watcher=? AND r.number=? AND w.state='enabled'`,
      ).get(this.scope, this.number);
      return row ? { ...row, settings: JSON.parse(row.settings) as PrRepairSettings } : undefined;
    });
  }

  authorized<T>(grant: RepairGrant, auth: GithubConnection, act: () => T): T {
    return watcherTransaction(db => {
      const row = db.query<{ generation: string; pause: number }, [string, number]>(
        `SELECT r.generation,COALESCE(p.generation,0) AS pause FROM review_pr_repairs r
         JOIN watchers w ON r.watcher=w.id LEFT JOIN watcher_pauses p ON p.watcher=w.id
         WHERE r.watcher=? AND r.number=? AND w.state='enabled'`,
      ).get(this.scope, this.number);
      if (row?.generation !== grant.generation || row.pause !== grant.pause ||
          (auth.binding && (projectGithubBinding(auth.binding.project, db)?.generation ?? null) !== auth.binding.generation)) {
        throw new Error("Automatic repair authorization changed.");
      }
      return act();
    });
  }

  active(grant: RepairGrant): RepairRow | undefined {
    return watcherTransaction(db => {
      const row = db.query<RepairRow, [string, number]>(
        `SELECT id,generation,pause,headSha,state,claimedAt,plan FROM review_pr_repair_runs
         WHERE watcher=? AND number=? AND state IN ('working','prepared') ORDER BY claimedAt DESC LIMIT 1`,
      ).get(this.scope, this.number);
      if (!row) return undefined;
      if (row.generation === grant.generation && row.pause === grant.pause && (row.state === "prepared" || Date.now() - row.claimedAt < maxJobAge)) return row;
      db.run("UPDATE review_pr_repair_runs SET state='failed' WHERE id=?", [row.id]);
      appendPrSubscriptionEvent(db, this.scope, {
        kind: "repair", number: this.number, headSha: row.headSha, at: new Date().toISOString(),
        description: "The previous automatic repair was interrupted.",
      });
      return undefined;
    });
  }

  seen(grant: RepairGrant, cause: string): boolean {
    return watcherTransaction(db => Boolean(db.query(
      "SELECT 1 FROM review_pr_repair_runs WHERE watcher=? AND number=? AND generation=? AND cause=?",
    ).get(this.scope, this.number, grant.generation, cause)));
  }

  repairedCiHead(grant: RepairGrant, head: string): boolean {
    return watcherTransaction(db => Boolean(db.query(
      `SELECT 1 FROM review_pr_repair_runs WHERE watcher=? AND number=? AND generation=?
       AND cause LIKE 'ci:%' AND plan IS NOT NULL AND json_extract(plan,'$.commit')=?`,
    ).get(this.scope, this.number, grant.generation, head)));
  }

  claim(grant: RepairGrant, cause: string, head: string): string | undefined {
    const id = randomUUID();
    return watcherTransaction(db => {
      const claim = db.run(`INSERT OR IGNORE INTO review_pr_repair_runs(id,watcher,number,generation,pause,cause,headSha,state,claimedAt)
         SELECT ?,?,?,?,?,?,?,'working',? WHERE EXISTS (
           SELECT 1 FROM review_pr_repairs r JOIN watchers w ON r.watcher=w.id LEFT JOIN watcher_pauses p ON p.watcher=w.id
           WHERE r.watcher=? AND r.number=? AND r.generation=? AND w.state='enabled' AND COALESCE(p.generation,0)=?
         ) AND NOT EXISTS (
           SELECT 1 FROM review_pr_repair_runs WHERE watcher=? AND number=? AND state IN ('working','prepared')
         )`, [id, this.scope, this.number, grant.generation, grant.pause, cause, head, Date.now(), this.scope, this.number, grant.generation, grant.pause,
        this.scope, this.number]);
      return claim.changes === 1 ? id : undefined;
    });
  }

  plan(id: string, plan: RepairPlan) {
    watcherTransaction(db => {
      if (db.run("UPDATE review_pr_repair_runs SET state='prepared',plan=? WHERE id=? AND state='working'", [JSON.stringify(plan), id]).changes !== 1)
        throw new Error("The repair no longer owns this pull request.");
    });
  }

  event(headSha: string, description: string, id?: string, state?: "done" | "failed") {
    watcherTransaction(db => {
      if (id && state) db.run("UPDATE review_pr_repair_runs SET state=? WHERE id=?", [state, id]);
      if (!db.query("SELECT 1 FROM review_pr_subscriptions WHERE watcher=? AND number=?").get(this.scope, this.number)) return;
      appendPrSubscriptionEvent(db, this.scope, { kind: "repair", number: this.number, headSha, at: new Date().toISOString(), description });
    });
  }
}
