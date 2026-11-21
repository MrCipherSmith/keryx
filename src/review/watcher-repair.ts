import { watcherScope } from "./watcher-db";
import type { ReviewCard } from "./board-types";
import { readOwnedPullRequest, type OwnedPullRequest } from "./watcher-rebase";
import { RepairCheckout } from "./pr-repair-git";
import { RepairStore, type RepairGrant, type RepairPlan } from "./watcher-repair-store";
import type { WatcherKey } from "./watcher-types";

type RepairSubject = { project: string; key: WatcherKey; card: ReviewCard; grant: RepairGrant; store: RepairStore };
const maxSeconds = 240;

function matchesSource(subject: OwnedPullRequest, grant: RepairGrant) {
  return subject.pull.headRefName === grant.branch && subject.pull.headRepository?.id === grant.repositoryId &&
    ["ADMIN", "MAINTAIN", "WRITE"].includes(subject.pull.headRepository.viewerPermission ?? "");
}

async function readCurrent({ project, key, card, grant }: RepairSubject, head: string) {
  const subject = await readOwnedPullRequest(project, key, card.number);
  if (!matchesSource(subject, grant) || subject.pull.headRefOid !== head || subject.pull.baseRefOid !== card.baseSha)
    throw new Error("The pull request source or revision changed.");
  return subject;
}

async function repairConflict(context: RepairSubject, subject: OwnedPullRequest, id: string) {
  const { store, grant, key, card } = context;
  const signal = AbortSignal.timeout(maxSeconds * 1000);
  const checkout = await RepairCheckout.create(subject, key, card.number, signal);
  try {
    const conflicts = await checkout.mergeBase();
    if (conflicts.length) {
      const { runPrRepairAgent } = await import("../commands/pr-repair-agent");
      await runPrRepairAgent({
        cwd: checkout.cwd, model: grant.settings.model, task: "Resolve the conflicting edits in this PR.",
        evidence: { sourceBranch: grant.branch, baseBranch: subject.pull.baseRefName }, conflicts, signal,
        authorize: () => store.authorized(grant, subject.auth, () => undefined),
      });
    }
    const commit = await checkout.commit("fix: resolve pull request merge conflicts", conflicts);
    if (!commit) throw new Error("There was no merge to push.");
    const current = await readCurrent(context, card.headSha);
    store.plan(id, { commit, ready: false });
    await store.authorized(grant, current.auth, () => checkout.push(commit));
    store.event(commit, "Merge conflicts resolved and pushed.", id, "done");
  } finally {
    await checkout.dispose();
  }
}

export async function repairWatchedPullRequests(project: string, key: WatcherKey, cards: ReviewCard[]) {
  const scope = watcherScope(project, key);
  for (const card of cards) {
    if (card.author.toLowerCase() !== key.viewer.toLowerCase()) continue;
    const store = new RepairStore(scope, card.number);
    const grant = store.grant();
    if (!grant) continue;
    try {
      const active = store.active(grant);
      if (active) {
        if (active.state === "prepared" && active.plan) {
          const plan = JSON.parse(active.plan) as RepairPlan;
          if (card.headSha === plan.commit) {
            await readCurrent({ project, key, card, grant, store }, plan.commit);
            store.event(plan.commit, "Recovered the pushed automatic repair.", active.id, "done");
          } else if (card.headSha !== active.headSha || Date.now() - active.claimedAt > maxSeconds * 1000) {
            store.event(card.headSha, "The prepared repair could not be verified on GitHub.", active.id, "failed");
          }
        }
        continue;
      }
      const cause = `conflict:${card.baseSha}:${card.headSha}`;
      if (!grant.settings.conflicts || card.watcherMergeState !== "DIRTY" || store.seen(grant, cause)) continue;
      const context = { project, key, card, grant, store };
      const subject = await readCurrent(context, card.headSha);
      if (subject.pull.mergeable !== "CONFLICTING") continue;
      store.authorized(grant, subject.auth, () => undefined);
      const id = store.claim(grant, cause, card.headSha);
      if (!id) continue;
      store.event(card.headSha, "Resolving merge conflicts in a separate checkout.");
      try {
        await repairConflict(context, subject, id);
      } catch {
        // Subprocess/provider failures may contain untrusted code, logs or credentials.
        // The plan is retained if a push happened but its receipt was lost.
        const pending = store.active(grant);
        if (pending?.id === id && pending.state !== "prepared")
          store.event(card.headSha, "Automatic conflict repair stopped before a verified push.", id, "failed");
      }
      // One model turn per watcher tick leaves the remaining PRs for later polls.
      return;
    } catch {
      // A closed, changed or inaccessible PR must not stop the shared watcher.
    }
  }
}
