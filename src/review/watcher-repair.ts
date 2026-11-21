import { join } from "node:path";
import { ensureKeryxSubdir, keryxDataDir } from "../lib/config-dir";
import { withFileLock } from "../lib/fs";
import { watcherScope } from "./watcher-db";
import type { ReviewCard } from "./board-types";
import { readOwnedPullRequest, type OwnedPullRequest } from "./watcher-rebase";
import { setRepairDraft } from "./pr-repair-draft";
import { readFailedActionsJob } from "./pr-repair-ci";
import { isActionableReview, publishRepairReply, readReviewFeedback } from "./pr-repair-feedback";
import { RepairCheckout } from "./pr-repair-git";
import { RepairStore, type RepairGrant, type RepairPlan, type RepairReply } from "./watcher-repair-store";
import type { PrRepairModel, WatcherKey } from "./watcher-types";

type RepairSubject = { project: string; key: WatcherKey; card: ReviewCard; grant: RepairGrant; store: RepairStore };
const maxSeconds = 240;
export type RunPrRepair = (input: {
  cwd: string;
  model: PrRepairModel;
  task: string;
  evidence: unknown;
  conflicts: string[];
  signal: AbortSignal;
  authorize: () => void;
}) => Promise<void>;
interface RepairTask {
  cause: string;
  kind: "conflict" | "ci" | "review";
  reply?: RepairReply;
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
  if (grant.settings.reviews && hasReviewFeedback(card, key) && subject.pull.mergeable === "MERGEABLE") {
    const feedback = await readReviewFeedback(subject, key, card.number, candidate => store.seen(grant, candidate));
    if (feedback) return {
      ...feedback, kind: "review",
      prompt: "Apply the reviewer's requested code change when supported by the checked-out code.",
      commitMessage: "fix: address pull request review feedback",
      starting: "Applying pull request review feedback in a separate checkout.",
      complete: "Review fix pushed and an English reply posted on GitHub.",
    };
  }
  return null;
}

function hasReviewFeedback(card: ReviewCard, key: WatcherKey) {
  return card.watcherReviews?.some(review => review.login.toLowerCase() !== key.viewer.toLowerCase() &&
    isActionableReview(review.state));
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

async function finishRepair(context: RepairSubject, id: string, plan: RepairPlan, description: string) {
  const { store, grant, key, card } = context;
  const directory = ensureKeryxSubdir(["desktop-review"], keryxDataDir());
  await withFileLock(join(directory, `repair-${id}.lock`), async () => {
    if (store.active(grant)?.id !== id) return;
    const current = await readCurrent(context, plan.commit);
    const authorized = <T>(act: () => T) => store.authorized(grant, current.auth, act);
    if (plan.reply) await publishRepairReply(current, key, card.number, plan.reply, authorized);
    if (plan.ready) {
      const latest = await readCurrent(context, plan.commit);
      if (await setRepairDraft(latest, false, act => store.authorized(grant, latest.auth, act)))
        store.event(plan.commit, "Marked the pull request ready for review.");
    }
    authorized(() => undefined);
    store.event(plan.commit, description, id, "done");
  }, { timeoutMs: 0 });
}

async function executeRepair(context: RepairSubject, subject: OwnedPullRequest, id: string, task: RepairTask, runPrRepair: RunPrRepair) {
  const { store, grant, key, card } = context;
  const signal = AbortSignal.timeout(maxSeconds * 1000);
  let stage = "preparing the checkout";
  let checkout: RepairCheckout | undefined;
  let drafted = false;
  try {
    checkout = await RepairCheckout.create(subject, key, card.number, signal);
    stage = "verifying the current PR revision";
    const beforeRepair = await readCurrent(context, card.headSha);
    if (grant.settings.draftWhileRepairing) {
      stage = "moving the PR to Draft";
      drafted = await setRepairDraft(beforeRepair, true, act => store.authorized(grant, beforeRepair.auth, act));
      if (drafted) store.event(card.headSha, "Moved the pull request to Draft for the automatic repair.");
    }
    stage = "preparing the repair inputs";
    const conflicts = task.kind === "conflict" ? await checkout.mergeBase() : [];
    if (conflicts.length || task.kind !== "conflict") {
      stage = "waiting for the selected model to complete the repair";
      await runPrRepair({
        cwd: checkout.cwd, model: grant.settings.model, task: task.prompt,
        evidence: task.evidence, conflicts, signal,
        authorize: () => store.authorized(grant, subject.auth, () => undefined),
      });
    }
    stage = "validating the model changes";
    const commit = await checkout.commit(task.commitMessage, conflicts);
    if (!commit) throw new Error("There were no repair changes to push.");
    stage = "verifying the revision before push";
    const current = await readCurrent(context, card.headSha);
    const plan = { commit, ready: drafted && grant.settings.readyAfterPush, ...(task.reply && { reply: task.reply }) };
    store.plan(id, plan);
    stage = "pushing the validated commit";
    await checkout.push(commit, act => store.authorized(grant, current.auth, act));
    stage = "confirming the push and completing GitHub follow-up";
    await finishRepair(context, id, plan, task.complete);
  } catch {
    // Provider and subprocess diagnostics can expose untrusted code, logs or credentials.
    // A prepared receipt stays pending so a later tick can recover a successful push.
    const current = store.active(grant);
    if (current?.id === id) {
      const message = `Automatic repair stopped while ${stage}.`;
      if (current.state !== "prepared") store.event(card.headSha,
        message + (drafted ? " The pull request remains in Draft." : ""), id, "failed");
      else store.event(card.headSha, "Waiting for GitHub to confirm the repair and any follow-up actions.");
    }
  } finally {
    await checkout?.dispose();
  }
}

export async function repairWatchedPullRequests(project: string, key: WatcherKey, cards: ReviewCard[], runPrRepair: RunPrRepair) {
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
            if (Date.now() - active.claimedAt > 10 * 60_000) {
              store.event(plan.commit, "The repair was pushed, but GitHub follow-up could not be completed.", active.id, "failed");
            } else {
              const description = plan.reply ? "Review fix pushed and an English reply posted on GitHub." : "Automatic repair pushed.";
              await finishRepair({ project, key, card, grant, store }, active.id, plan, description);
            }
          } else if (card.headSha !== active.headSha || Date.now() - active.claimedAt > maxSeconds * 1000) {
            store.event(card.headSha, "The prepared repair could not be verified on GitHub.", active.id, "failed");
          }
        }
        continue;
      }
      if (!(grant.settings.conflicts && card.watcherMergeState === "DIRTY") &&
          !(grant.settings.ci && card.ci === "failed" && !store.seen(grant, `ci:${card.headSha}`) &&
            !store.repairedCiHead(grant, card.headSha)) &&
          !(grant.settings.reviews && hasReviewFeedback(card, key))) continue;
      const context = { project, key, card, grant, store };
      const subject = await readCurrent(context, card.headSha);
      const task = await findTask(subject, context);
      if (!task) continue;
      store.authorized(grant, subject.auth, () => undefined);
      const id = store.claim(grant, task.cause, card.headSha);
      if (!id) continue;
      store.event(card.headSha, task.starting);
      await executeRepair(context, subject, id, task, runPrRepair);
      // One model turn per watcher tick leaves the remaining PRs for later polls.
      return;
    } catch {
      // A closed, changed or inaccessible PR must not stop the shared watcher.
    }
  }
}
