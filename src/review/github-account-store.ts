import type { Database } from "bun:sqlite";
import { watcherTransaction } from "./watcher-db";

interface GithubProjectBinding {
  login: string | null;
  generation: number;
}

export function projectGithubBinding(project: string, db?: Database): GithubProjectBinding | null {
  if (!db) return watcherTransaction((connection) => projectGithubBinding(project, connection));
  return db.query<GithubProjectBinding, [string]>(
    "SELECT login,generation FROM review_github_accounts WHERE project=?",
  ).get(project);
}

export function saveProjectGithubBinding(db: Database, project: string, login: string | null, generation: number): void {
  db.run(
    "INSERT INTO review_github_accounts(project,login,generation) VALUES(?,?,?) ON CONFLICT(project) DO UPDATE SET login=excluded.login,generation=excluded.generation",
    [project, login, generation],
  );
}

const superseded = "stale: A newer GitHub account selection superseded this request.";

// Keep intent order apart from the effective credential generation. Re-selecting
// the same login supersedes pending preference writes without disrupting reads.
export function claimProjectGithubAccountIntent(project: string, order: number): void {
  watcherTransaction((db) => {
    const { changes } = db.run(
      `INSERT INTO review_github_account_intents(project,ordinal) VALUES(?,?)
       ON CONFLICT(project) DO UPDATE SET ordinal=excluded.ordinal WHERE excluded.ordinal > ordinal`,
      [project, order],
    );
    if (!changes) throw new Error(superseded);
  });
}

export function verifyProjectGithubAccountIntent(db: Database, project: string, order: number): void {
  const intent = db.query<{ ordinal: number }, [string]>(
    "SELECT ordinal FROM review_github_account_intents WHERE project=?",
  ).get(project);
  if (intent?.ordinal !== order) throw new Error(superseded);
}
