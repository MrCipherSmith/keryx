import type { DeskRun, DeskRunKey } from "../../../../src/review/desk-run-types";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useToast } from "../components/Toasts";
import { errMessage } from "../lib/format";
import type { FlowCard } from "../platform/commands";
import { reviewRun } from "../platform/reviewRuns";
import { pendingManualQuestions } from "./ReviewProgress";
import { launchAction, ReviewRuns } from "./ReviewRuns";
import type { reviewPublish } from "./ReviewPublishDialog";
import { ReviewRunDialog, ReviewRunHistory } from "./ReviewRunDialog";
import type { ReviewLifecycleCommand } from "./ReviewLifecycle";
import { sameRange, useReviewRuns, type RunObserver } from "./useReviewRuns";
import { ReviewLaunchDialog, type ReviewLaunchModel } from "./ReviewLaunchDialog";
import type { ReviewCard } from "./types";
import "./ReviewDetail.css";

/** What a board action asked of the review interface, tied to the revision it was clicked on. */
export interface ReviewIntent { kind: "start" | "view" | "answer"; baseSha: string; headSha: string }

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
  onStarted: () => Promise<void>;
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
  /** Shown between the primary action and the latest attempt (the Review panel puts its rounds here). */
  children?: ReactNode;
}

/**
 * The Keryx review interface of one PR's current range: the primary action, run history, the latest
 * attempt with its report, answers, cancel, continue, publication and lifecycle actions, and the launch form.
 */
export function ReviewWorkspace({ cwd, subject: target, card, reviewIntent, flow, projectFlows, reviewModels, runCommand = reviewRun, publishCommand, onRunSnapshot, onAccessLost, onOpenReviewSession, onOpenFlow, onRefreshBoard, onLeave, children }: Props) {
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
  const publication = { cwd, target: subject, url: card.url, publishCommand };
  const loadAttempt = useCallback(async (id: string) => {
    const history = await runCommand(cwd, subject, { kind: "status", id });
    return history.runs.find(run => run.id === id);
  }, [cwd, subject, runCommand]);
  const local = useReviewRuns(cwd, subject, card.baseSha, card.headSha, true, runCommand, onRunSnapshot, onAccessLost);
  const syncRuns = local.request;
  function openManagedRun(id: string) {
    const run = local.runs.find(item => item.id === id);
    if (!onOpenReviewSession || !run || run.source === "existing") {
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
  const associatedFlowId = local.runs.find(run => sameRange(run, card))?.options?.flowId;
  const associatedFlow = associatedFlowId ? projectFlows?.find(candidate => candidate.id === associatedFlowId) : flow;
  const revisionChanged = local.staleRange;
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
      return;
    }
    if (!local.loaded) return;
    initialLaunch.current = undefined;
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
      <span>The PR revision changed. Refresh the board to load the latest range.</span>
      {onRefreshBoard && <button className="btn btn-sm" onClick={onRefreshBoard}>Refresh board</button>}
    </div>}
    {children}
    <ReviewRuns publication={publication} onAnswer={answerQuestion} onOpenSession={openManagedRun} card={card} {...local} loadAttempt={loadAttempt} onAccessLost={onAccessLost}
      onCancel={id => void local.request({ kind: "cancel", id })}
      onLifecycle={lifecycle}
      onRefresh={() => void local.request({ kind: "status" })} />
    {session && <ReviewRunDialog
      {...(onOpenReviewSession && session.source !== "existing" && {
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
