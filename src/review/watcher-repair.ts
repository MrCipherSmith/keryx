import { watcherScope } from "./watcher-db";
import type { ReviewCard } from "./board-types";
import { readOwnedPullRequest, type OwnedPullRequest } from "./watcher-rebase";
import { readFailedActionsJob } from "./pr-repair-ci";
import { RepairCheckout } from "./pr-repair-git";
import { RepairStore, type RepairGrant, type RepairPlan } from "./watcher-repair-store";
import type { WatcherKey } from "./watcher-types";

type RepairSubject = { project: string; key: WatcherKey; card: ReviewCard; grant: RepairGrant; store: RepairStore };
const maxSeconds = 240;
interface RepairTask {
  cause: string;
  kind: "conflict" | "ci";
  prompt: string;
  evidence: unknown;
  commitMessage: string;
  starting: string;
  complete: string;
}

async function findTask(subject: OwnedPullRequest, { key, card, grant, store }: RepairSubject): Promise<RepairTask | null> {
  const conflict = subject.pull.mergeable === "CONFLICTING";
  if (conflict) {
    const cause = `conflict:${card.baseSha}:${card.headSha}`;
    return grant.settings.conflicts && !store.seen(grant, cause) ? {
      kind: "conflict", cause, prompt: "Resolve the conflicting edits in this PR.",
      evidence: { sourceBranch: grant.branch, baseBranch: subject.pull.baseRefName },
      commitMessage: "fix: resolve pull request merge conflicts",
      starting: "Resolving merge conflicts in a separate checkout.", complete: "Merge conflicts resolved and pushed.",
    } : null;
  }
  const cause = `ci:${card.headSha}`;
  if (grant.settings.ci && card.ci === "failed" && subject.pull.mergeable === "MERGEABLE" &&
      !store.seen(grant, cause) && !store.repairedCiHead(grant, card.headSha)) {
    const evidence = await readFailedActionsJob(subject, key);
    if (evidence) return {
      kind: "ci", cause, evidence, prompt: "Fix the source code causing this GitHub Actions failure.",
      commitMessage: "fix: repair failing pull request checks",
      starting: "Repairing a failing GitHub Actions check in a separate checkout.",
      complete: "CI repair pushed. GitHub Actions will verify the new commit.",
    };
  }
  return null;
}

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

async function executeRepair(context: RepairSubject, subject: OwnedPullRequest, id: string, task: RepairTask) {
  const { store, grant, key, card } = context;
  const signal = AbortSignal.timeout(maxSeconds * 1000);
  const checkout = await RepairCheckout.create(subject, key, card.number, signal);
  try {
    const conflicts = task.kind === "conflict" ? await checkout.mergeBase() : [];
    if (conflicts.length || task.kind !== "conflict") {
      const { runPrRepairAgent } = await import("../commands/pr-repair-agent");
      await runPrRepairAgent({
        cwd: checkout.cwd, model: grant.settings.model, task: task.prompt,
        evidence: task.evidence, conflicts, signal,
        authorize: () => store.authorized(grant, subject.auth, () => undefined),
      });
    }
    const commit = await checkout.commit(task.commitMessage, conflicts);
    if (!commit) throw new Error("There were no repair changes to push.");
    const current = await readCurrent(context, card.headSha);
    store.plan(id, { commit, ready: false });
    await store.authorized(grant, current.auth, () => checkout.push(commit));
    store.event(commit, task.complete, id, "done");
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
      if (!(grant.settings.conflicts && card.watcherMergeState === "DIRTY") &&
          !(grant.settings.ci && card.ci === "failed" && !store.seen(grant, `ci:${card.headSha}`) &&
            !store.repairedCiHead(grant, card.headSha))) continue;
      const context = { project, key, card, grant, store };
      const subject = await readCurrent(context, card.headSha);
      const task = await findTask(subject, context);
      if (!task) continue;
      store.authorized(grant, subject.auth, () => undefined);
      const id = store.claim(grant, task.cause, card.headSha);
      if (!id) continue;
      store.event(card.headSha, task.starting);
      try {
        await executeRepair(context, subject, id, task);
      } catch {
        // Subprocess/provider failures may contain untrusted code, logs or credentials.
        // The plan is retained if a push happened but its receipt was lost.
        const pending = store.active(grant);
        if (pending?.id === id && pending.state !== "prepared")
          store.event(card.headSha, "Automatic repair stopped before a verified push.", id, "failed");
      }
      // One model turn per watcher tick leaves the remaining PRs for later polls.
      return;
    } catch {
      // A closed, changed or inaccessible PR must not stop the shared watcher.
    }
  }
}
