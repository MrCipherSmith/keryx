import type { DeskRevision, DeskRun, DeskRunKey } from "../../../../src/review/desk-run-types";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "../components/Toasts";
import { errMessage } from "../lib/format";
import type { FlowCard } from "../platform/commands";
import { reviewRun } from "../platform/reviewRuns";
import { pendingManualQuestions } from "./ReviewProgress";
import { latestAttempt, launchAction, ReviewRuns } from "./ReviewRuns";
import { reviewIsArchived } from "./ReviewLifecycle";
import type { reviewPublish } from "./ReviewPublishDialog";
import { ReviewRunDialog, ReviewRunHistory } from "./ReviewRunDialog";
import type { ReviewLifecycleCommand } from "./ReviewLifecycle";
import { runActive, sameRange, useReviewRuns, type RunObserver } from "./useReviewRuns";
import { ReviewPlanSummary, reviewPlanEvidence } from "./ReviewPlanSummary";
import { ReviewLaunchDialog, type ReviewLaunchModel } from "./ReviewLaunchDialog";
import type { ReviewCard } from "./types";
import "./ReviewDetail.css";

/** What a board action asked of the review interface, tied to the revision it was clicked on. */
export interface ReviewIntent { kind: "start" | "view" | "answer"; baseSha: string; headSha: string }

function pinnedPlanSummary(run: DeskRun) {
  const plan = run.reviewerProgress?.planSummary;
  return plan?.baseSha === run.baseSha && plan.headSha === run.headSha ? plan : undefined;
}

function latestTerminalPlanRun(runs: readonly DeskRun[]) {
  return runs.filter(run => (run.state === "completed" || run.state === "partial") && !reviewIsArchived(run) &&
      (pinnedPlanSummary(run) || (run.options?.orchestrator === false && run.pullRequestScope)))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
}

/** The launch form for one PR's current range: it refuses a range that moved since the form opened. */
export function RunLaunchDialog({ cwd, subject, card, stale, models, flows, defaultFlow, runCommand, onRunSnapshot, onStarted, onClose }: {
  cwd: string;
  subject: DeskRunKey;
  card: ReviewCard;
  /** The PR revision is known to have moved since the card was read. */
  stale: boolean;
  models: readonly ReviewLaunchModel[];
  flows: readonly FlowCard[];
  defaultFlow?: string | undefined;
  runCommand: typeof reviewRun;
  onRunSnapshot?: RunObserver | undefined;
  /** Re-reads the attempts once the start is confirmed; its outcome is not used. */
  onStarted: () => Promise<unknown>;
  onClose: () => void;
}) {
  return <ReviewLaunchDialog models={models} flows={flows} defaultFlow={defaultFlow}
    fixedTarget={{ repo: subject.repo, repositoryId: subject.repositoryId, viewer: subject.viewer, card }}
    onApply={async (key, revision, options) => {
      if (card.state !== "open" || stale || !sameRange(card, revision)) {
        throw new Error("The PR revision changed. Refresh the board and open the launch form again.");
      }
      const snapshot = await runCommand(cwd, key, { kind: "start", ...revision, options });
      if (!snapshot.startedRunId || !snapshot.runs.some(run => run.id === snapshot.startedRunId)) {
        throw new Error("The selected Keryx CLI did not confirm the new review attempt.");
      }
      onRunSnapshot?.(key, revision, snapshot);
      await onStarted();
    }}
    onClose={onClose} />;
}

interface Props {
  cwd: string;
  subject: DeskRunKey;
  card: ReviewCard;
  reviewIntent?: ReviewIntent | undefined;
  flow?: FlowCard | undefined;
  projectFlows?: readonly FlowCard[] | undefined;
  reviewModels?: readonly ReviewLaunchModel[] | undefined;
  runCommand?: typeof reviewRun | undefined;
  publishCommand?: typeof reviewPublish | undefined;
  onRunSnapshot?: RunObserver | undefined;
  onAccessLost?: ((reason: string) => void) | undefined;
  onOpenReviewSession?: ((key: DeskRunKey, run: DeskRun) => Promise<void>) | undefined;
  onOpenFlow?: ((dir: string) => void) | undefined;
  /** Re-reads the list the card came from; offered when the PR revision moved. */
  onRefreshBoard?: (() => void) | undefined;
  /** The review moved to Sessions: the surrounding panel closes. */
  onLeave?: (() => void) | undefined;
  /** The board action's intent was taken (acted on or dropped); the caller must not hand it over again. */
  onIntentConsumed?: (() => void) | undefined;
  /** Shown between the primary action and the latest attempt (the Review panel puts its rounds here). */
  children?: ReactNode;
}

/**
 * The Keryx review interface of one PR's current range: the primary action, run history, the latest
 * attempt with its report, answers, cancel, continue, publication and lifecycle actions, and the launch form.
 */
export function ReviewWorkspace({ cwd, subject: target, card, reviewIntent, flow, projectFlows, reviewModels, runCommand = reviewRun, publishCommand, onRunSnapshot, onAccessLost, onOpenReviewSession, onOpenFlow, onRefreshBoard, onLeave, onIntentConsumed, children }: Props) {
  const toast = useToast();
  // The run hook re-reads whenever its key changes identity, so the key follows the target's fields.
  const { repo, repositoryId, viewer, number } = target;
  const subject = useMemo(() => ({ repo, repositoryId, viewer, number }), [repo, repositoryId, viewer, number]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [launchCard, setLaunchCard] = useState<ReviewCard | null>(null);
  const initialLaunch = useRef(reviewIntent);
  const intentConsumed = useRef(onIntentConsumed);
  intentConsumed.current = onIntentConsumed;
  const loadAttempt = useCallback(async (id: string) => {
    const history = await runCommand(cwd, subject, { kind: "status", id });
    return history.runs.find(run => run.id === id);
  }, [cwd, subject, runCommand]);
  const local = useReviewRuns(cwd, subject, card.baseSha, card.headSha, true, runCommand, onRunSnapshot, onAccessLost);
  const syncRuns = local.request;
  function openManagedRun(id: string) {
    const run = local.runs.find(item => item.id === id);
    if (!onOpenReviewSession || !run?.sessionId) {
      setSessionId(id);
      return;
    }
    void onOpenReviewSession(subject, run).then(() => onLeave?.(), reason => {
      if (mounted.current) toast({ level: "error", title: "Could not open the review in Sessions", detail: errMessage(reason) });
    });
  }
  const lifecycle = useCallback<ReviewLifecycleCommand>(async action => {
    const snapshot = await runCommand(cwd, subject, action);
    if (action.kind === "decide") {
      onRunSnapshot?.(subject, { baseSha: card.baseSha, headSha: card.headSha }, snapshot);
      if (action.decision === "delete") setSessionId(current => current === action.id ? null : current);
      await syncRuns({ kind: "status" });
    }
    return snapshot;
  }, [cwd, subject, runCommand, onRunSnapshot, card.baseSha, card.headSha, syncRuns]);
  const session = sessionId && local.runs.find(run => run.id === sessionId);
  const action = launchAction(local.runs, card);
  const active = local.runs.find(run => runActive(run) && sameRange(run, card));
  const planRun = active ?? (!local.runs.some(runActive) ? latestTerminalPlanRun(local.runs) : undefined);
  const planRunIsCurrent = planRun !== undefined && planRun === active;
  const questions = active ? pendingManualQuestions(active) : [];
  const associatedFlowId = local.runs.find(run => sameRange(run, card))?.options?.flowId;
  const associatedFlow = associatedFlowId ? projectFlows?.find(candidate => candidate.id === associatedFlowId) : flow;
  const revisionChanged = local.staleRange;
  // The control that opened the publish dialog belongs to an attempt the update may replace; focus then goes here.
  const latestHeading = useRef<HTMLHeadingElement>(null);
  const [focusLatest, setFocusLatest] = useState(0);
  useEffect(() => {
    const focused = document.activeElement;
    // Only focus that was lost moves: a user who moved on while the start ran keeps their place.
    if (focusLatest && (!focused || focused === document.body)) latestHeading.current?.focus();
  }, [focusLatest]);
  /**
   * "Update review" in a head-moved publish dialog: the next round of the same Review on the PR's current range, with
   * the reviewed attempt's settings except automatic publication. The panel stays open and shows the new attempt; a
   * board that has not seen the push is re-read once the start succeeded, or when the head already has an attempt,
   * so the panel follows the new range.
   */
  const updateReview = useCallback((reviewed: DeskRun, revision: DeskRevision) => {
    const boardBehind = !sameRange(card, revision);
    // Any attempt on the target range, in whatever state and whatever the board shows, is shown instead of a second one.
    const covering = local.runs.filter(run => run.source !== "existing" && !reviewIsArchived(run) && sameRange(run, revision));
    const existing = covering.find(runActive) ?? covering[0];
    if (existing) {
      const latest = existing.id === latestAttempt(local.runs, card)?.id;
      setSessionId(latest ? null : existing.id);
      if (latest) setFocusLatest(n => n + 1);
      toast({ level: "info", title: `Commit ${revision.headSha.slice(0, 7)} already has a review attempt`, body: "Showing it instead of starting another." });
      if (boardBehind) onRefreshBoard?.();
      return;
    }
    setSessionId(null);
    // `keryx review advance` (flow 521): the same command an agent session runs; it keeps the reviewed attempt's settings
    // without automatic publication (src/review/review-advance.ts) and refuses when a later round already exists.
    void local.request({ kind: "advance", id: reviewed.id, ...revision })
      .then(outcome => {
        if (outcome === "done" && mounted.current) setFocusLatest(n => n + 1);
        if (outcome === "done" && boardBehind) onRefreshBoard?.();
        // The button is disabled while another action runs; this covers a click that raced it.
        if (outcome === "skipped") toast({ level: "info", title: "Update review did not start", body: "Another action of this review is still running. Try again when it finishes." });
      });
  }, [card, local.runs, local.request, onRefreshBoard, toast]);
  const publication = { cwd, target: subject, url: card.url, publishCommand, onUpdateReview: updateReview };
  const start = useCallback(() => {
    if (reviewModels) setLaunchCard(card);
    else void local.request({ kind: "start", baseSha: card.baseSha, headSha: card.headSha });
  }, [reviewModels, card, local.request]);
  // A board action is tied to the clicked revision, and consumed once after status resolves.
  // The backend validates this same range again before admitting the run.
  useEffect(() => {
    const next = initialLaunch.current;
    if (!next) return;
    if (local.error || (next.kind === "start" && (card.state !== "open" || revisionChanged)) ||
      next.baseSha !== card.baseSha || next.headSha !== card.headSha) {
      initialLaunch.current = undefined;
      intentConsumed.current?.();
      return;
    }
    if (!local.loaded) return;
    initialLaunch.current = undefined;
    intentConsumed.current?.();
    if (next.kind === "answer" && action.sessionId && local.runs.some(run => run.id === action.sessionId && pendingManualQuestions(run).length > 0)) {
      setSessionId(action.sessionId);
    } else if (next.kind === "start" && !action.open) {
      start();
    }
  }, [action.open, action.sessionId, local.runs, card.state, card.baseSha, card.headSha, local.error, local.loaded, start, revisionChanged]);

  function answerQuestion(id: string, questionId: string, answer: string) {
    void local.request({ kind: "answer", id, questionId, answer });
  }
  function launch() {
    if (action.sessionId) setSessionId(action.sessionId);
    else if (!action.open) start();
  }

  return <div className="review-workspace-block" aria-busy={local.working}>
    <div className="sheet-actions review-detail-actions">
      {card.state === "open" && <button className="btn btn-sm btn-primary" onClick={launch}
        disabled={local.working || !local.loaded || (!action.open && revisionChanged)}>
        {local.working ? "Updating review…" : !local.loaded && !local.error ? "Checking review…" : action.label}
      </button>}
      <ReviewRunHistory runs={local.runs} onSelect={setSessionId} />
    </div>
    {associatedFlow ? (onOpenFlow ? <button className="link-btn review-associated-flow" onClick={() => onOpenFlow(associatedFlow.dir)}>Flow #{associatedFlow.id} · {associatedFlow.title}</button>
      : <span className="review-associated-flow">Flow #{associatedFlow.id} · {associatedFlow.title}</span>)
      : associatedFlowId && <span className="review-associated-flow">Flow #{associatedFlowId}</span>}
    {revisionChanged && <div className="inline-banner tone-warn" role="status">
      <span>The PR revision changed. Refresh to load the latest range.</span>
      {onRefreshBoard && <button className="btn btn-sm" onClick={onRefreshBoard}>Refresh</button>}
    </div>}
    {planRun && <ReviewPlanSummary data={{
      title: planRunIsCurrent ? (card.title || planRun.pullRequestTitle || `${target.repo} #${target.number}`)
        : (planRun.pullRequestTitle || `${target.repo} #${target.number}`),
      headSha: planRun.headSha,
      ...(planRunIsCurrent && card.changeStats && { changeStats: card.changeStats }),
      ...reviewPlanEvidence(pinnedPlanSummary(planRun), planRun.pullRequestScope),
      ...(planRun.options?.orchestrator === false && { singleReviewer: true }),
      stage: planRun.phase,
      runState: planRun.state,
      ...(planRun.reviewerProgress && { assignmentProgress: planRun.reviewerProgress }),
      ...(planRunIsCurrent && questions.length > 0 && { operatorStep: planRun.reason || "Reply to the requested review context." }),
    }} />}
    {children}
    <ReviewRuns headingRef={latestHeading} publication={publication} onAnswer={answerQuestion} onOpenSession={openManagedRun} card={card} {...local} loadAttempt={loadAttempt} onAccessLost={onAccessLost}
      onCancel={id => void local.request({ kind: "cancel", id })}
      onLifecycle={lifecycle}
      onRefresh={() => void local.request({ kind: "status" })} />
    {session && <ReviewRunDialog
      {...(onOpenReviewSession && session.sessionId && {
        onOpenWorkspace: async () => {
          await onOpenReviewSession(subject, session);
          setSessionId(null);
          onLeave?.();
        },
      })} key={session.id} publication={publication} run={session} card={card} working={local.working} activity={local.activity}
      error={local.error} loadAttempt={loadAttempt} onAccessLost={onAccessLost} onClose={() => setSessionId(null)}
      onCancel={id => void local.request({ kind: "cancel", id })}
      onLifecycle={lifecycle}
      onRefresh={() => void local.request({ kind: "status" })}
      onAnswer={answerQuestion} />}
    {launchCard && reviewModels && <RunLaunchDialog cwd={cwd} subject={subject} card={launchCard} stale={revisionChanged}
      models={reviewModels} flows={projectFlows ?? []} defaultFlow={associatedFlow?.id} runCommand={runCommand}
      onRunSnapshot={onRunSnapshot} onStarted={() => local.request({ kind: "status" })} onClose={() => setLaunchCard(null)} />}
  </div>;
}
