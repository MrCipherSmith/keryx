import { boardGraphql, projectGithubConnection, type GithubConnection } from "./board-github";
import type { ReviewCard } from "./board-types";
import { projectGithubBinding } from "./github-account-store";
import { watcherScope, watcherTransaction } from "./watcher-db";
import { resolveWatcherCheckout } from "./watcher-project";
import { appendPrSubscriptionEvent } from "./watcher-subscriptions";
import type { WatcherKey } from "./watcher-types";

export interface PullRequest {
  id: string;
  author: { login: string } | null;
  state: string;
  headRefOid: string;
  baseRefOid: string;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  mergeStateStatus: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  headRepository: { id?: string; nameWithOwner?: string; viewerPermission?: string; defaultBranchRef: { name: string } | null } | null;
}
export interface OwnedPullRequest { pull: PullRequest; checkout: string; auth: GithubConnection }

const readQuery = `query($owner:String!, $name:String!, $number:Int!) {
  viewer { login }
  repository(owner:$owner,name:$name) {
    id
    pullRequest(number:$number) {
      id author { login } state headRefOid baseRefOid headRefName baseRefName mergeable mergeStateStatus
      isDraft reviewDecision headRepository { id nameWithOwner viewerPermission defaultBranchRef { name } }
    }
  }
}`;
const rebaseQuery = `mutation($id:ID!, $head:GitObjectID!) {
  updatePullRequestBranch(input:{pullRequestId:$id, expectedHeadOid:$head, updateMethod:REBASE}) {
    pullRequest { id }
  }
}`;

export async function readOwnedPullRequest(project: string, key: WatcherKey, number: number): Promise<OwnedPullRequest> {
  const checkout = await resolveWatcherCheckout(project, key.repo);
  const auth = await projectGithubConnection(checkout, process.env, key.viewer);
  const [owner, name] = key.repo.split("/") as [string, string];
  const data = await boardGraphql<{
    viewer?: { login: string };
    repository?: { id: string; pullRequest?: PullRequest };
  }>(checkout, readQuery, { owner, name, number }, auth);
  const pull = data.repository?.pullRequest;
  const viewer = key.viewer.toLowerCase();
  if (data.viewer?.login.toLowerCase() !== viewer || data.repository?.id !== key.repositoryId || !pull?.id) {
    throw new Error("access: The current GitHub account or repository changed. Refresh Pull requests.");
  }
  if (pull.author?.login.toLowerCase() !== viewer) {
    throw new Error("configuration: Automatic rebase is available only for your own pull requests.");
  }
  if (pull.state !== "OPEN" || !pull.headRepository?.defaultBranchRef || !pull.headRefName ||
      pull.headRefName === pull.headRepository.defaultBranchRef.name || pull.headRefName === pull.baseRefName) {
    throw new Error("configuration: Automatic rebase requires an open PR with its own source branch.");
  }
  return { pull, checkout, auth };
}

export async function rebaseWatchedPullRequests(project: string, key: WatcherKey, cards: ReviewCard[],
  { read = readOwnedPullRequest, mutate = boardGraphql }: { read?: typeof readOwnedPullRequest; mutate?: typeof boardGraphql } = {},
) {
  const scope = watcherScope(project, key);
  const eligible = watcherTransaction(db => {
    const isPending = db.query(`SELECT 1 FROM watchers w JOIN review_pr_subscriptions s ON s.watcher=w.id
      WHERE w.id=? AND w.state='enabled' AND s.number=? AND s.rebase=1 AND NOT EXISTS (
        SELECT 1 FROM review_pr_rebase_attempts a WHERE a.watcher=w.id AND a.number=s.number AND a.baseSha=? AND a.headSha=?)`);
    return cards.filter(card => card.author.toLowerCase() === key.viewer.toLowerCase() &&
      isPending.get(scope, card.number, card.baseSha, card.headSha)).slice(0, 3);
  });
  for (const card of eligible) {
    let subject;
    try {
      subject = await read(project, key, card.number);
    } catch {
      continue;
    }
    const { pull, checkout, auth } = subject;
    if (!/^[a-f0-9]{40}$/i.test(card.headSha) || pull.headRefOid !== card.headSha || pull.baseRefOid !== card.baseSha) continue;
    const conflict = pull.mergeable === "CONFLICTING";
    if (!conflict && (pull.mergeable !== "MERGEABLE" || pull.mergeStateStatus !== "BEHIND")) continue;
    const request = watcherTransaction(db => {
      const binding = auth.binding;
      if (binding && (projectGithubBinding(binding.project, db)?.generation ?? null) !== binding.generation) return;
      const eligible = db.query(`SELECT 1 FROM watchers w JOIN review_pr_subscriptions s ON s.watcher=w.id
        WHERE w.id=? AND w.state='enabled' AND s.number=? AND s.rebase=1`).get(scope, card.number);
      if (!eligible) return;
      const claim = db.run(`INSERT OR IGNORE INTO review_pr_rebase_attempts(watcher,number,baseSha,headSha)
        VALUES(?,?,?,?)`, [scope, card.number, card.baseSha, card.headSha]);
      if (claim.changes !== 1) return;
      if (conflict) return { conflict: true } as const;
      const result = mutate<{ updatePullRequestBranch?: { pullRequest?: { id: string } } }>(
        checkout, rebaseQuery, { id: pull.id, head: card.headSha }, auth,
      );
      return { result };
    });
    if (!request) continue;
    let description: string;
    if ("conflict" in request) {
      description = "Automatic rebase stopped because the branch has conflicts.";
    } else {
      try {
        const result = await request.result;
        description = result.updatePullRequestBranch?.pullRequest?.id === pull.id
          ? "GitHub accepted the automatic rebase."
          : "GitHub did not confirm the automatic rebase.";
      } catch {
        description = "GitHub could not rebase this revision.";
      }
    }
    watcherTransaction(db => {
      if (!db.query("SELECT 1 FROM review_pr_subscriptions WHERE watcher=? AND number=?").get(scope, card.number)) return;
      appendPrSubscriptionEvent(db, scope, {
        kind: "rebase", number: card.number, headSha: card.headSha, at: new Date().toISOString(), description,
      });
    });
  }
}
