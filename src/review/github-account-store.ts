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
