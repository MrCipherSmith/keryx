import type { DeskRun, DeskRunKey, DeskRunState } from "../../../../src/review/desk-run-types";
import type { ReviewAttemptSummary, ReviewRound, ReviewSummary } from "../../../../src/review/review-entity";
import { useCallback, useId, useLayoutEffect, useMemo, useRef } from "react";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { absoluteTime, errMessage, relativeTime } from "../lib/format";
import type { FlowCard, openExternal } from "../platform/commands";
import type { reviewRun } from "../platform/reviewRuns";
import { openReviewLink, ReviewBrowserLink } from "../review/ReviewBrowserLink";
import { PanelResizer } from "../review/PanelResizer";
import type { ReviewLaunchModel } from "../review/ReviewLaunchDialog";
import type { reviewPublish } from "../review/ReviewPublishDialog";
import type { ReviewCard } from "../review/types";
import { ReviewWorkspace, type ReviewIntent } from "../review/ReviewWorkspace";
import type { RunObserver } from "../review/useReviewRuns";
import { findingsLabel, fixFindingsPrompt, type FixFindingsFlow, fixFindingsTarget, freshnessLabel, publicationLabel, reviewedCommit, reviewStateLabel, reviewTitle, SOURCE_LABEL } from "./model";

const ATTEMPT_STATE: Record<DeskRunState, string> = {
  queued: "Queued", running: "Running", cancelling: "Stopping", completed: "Completed", partial: "Partial",
  blocked: "Blocked", failed: "Failed", cancelled: "Cancelled", skipped: "Skipped", budget: "Budget reached",
};

const short = (sha: string) => sha.slice(0, 7) || "unknown";
const attemptAnchor = (scope: string, id: string) => `${scope}-attempt-${id}`;

function Attempt({ attempt, scope, known }: { attempt: ReviewAttemptSummary; scope: string; known: ReadonlySet<string> }) {
  const state = attempt.awaitingAnswer && attempt.state === "running" ? "Awaiting your answer" : ATTEMPT_STATE[attempt.state] ?? attempt.state;
  const previous = attempt.previousRunId;
  return <li id={attemptAnchor(scope, attempt.id)} tabIndex={-1} className="review-round-attempt">
    <strong>{state}</strong>
    <span>{attempt.coverage ? `Coverage ${attempt.coverage}` : "Coverage unconfirmed"}</span>
    <time dateTime={attempt.createdAt} title={absoluteTime(attempt.createdAt)}>{relativeTime(attempt.createdAt)}</time>
    <span className="mono" title={attempt.id}>Run {attempt.id.slice(0, 8)}</span>
    {previous && (known.has(previous)
      ? <button type="button" className="link-btn" aria-label={`after ${previous.slice(0, 8)} — go to the attempt this one follows`}
        onClick={() => document.getElementById(attemptAnchor(scope, previous))?.focus()}>after {previous.slice(0, 8)}</button>
      : <span className="mono" title={previous}>after {previous.slice(0, 8)}</span>)}
  </li>;
}

function Rounds({ rounds }: { rounds: ReviewRound[] }) {
  const scope = useId();
  const known = useMemo(() => new Set(rounds.flatMap(round => round.attempts.map(attempt => attempt.id))), [rounds]);
  return <section className="review-rounds" aria-label="Rounds">
    <h3>Rounds</h3>
    <ol>{rounds.map(round => <li key={round.number} className="review-round">
      <div className="review-round-head">
        <strong>Round {round.number}</strong>
        <span className="mono" title={`${round.baseSha} → ${round.headSha}`}>{short(round.baseSha)} → {short(round.headSha)}</span>
        <span>{round.attempts.length === 1 ? "1 attempt" : `${round.attempts.length} attempts`}</span>
      </div>
      <ul>{round.attempts.map(attempt => <Attempt key={attempt.id} attempt={attempt} scope={scope} known={known} />)}</ul>
    </li>)}</ol>
  </section>;
}

interface Props {
  cwd: string;
  target: Omit<DeskRunKey, "number">;
  review: ReviewSummary;
  reviewIntent?: ReviewIntent | undefined;
  flows?: readonly FlowCard[] | undefined;
  reviewModels?: readonly ReviewLaunchModel[] | undefined;
  runCommand?: typeof reviewRun | undefined;
  publishCommand?: typeof reviewPublish | undefined;
  onRunSnapshot?: RunObserver | undefined;
  onAccessLost?: ((reason: string) => void) | undefined;
  onOpenReviewSession?: ((key: DeskRunKey, run: DeskRun) => Promise<void>) | undefined;
  onOpenFlow?: ((dir: string) => void) | undefined;
  /**
   * "Fix findings" on the viewer's own PR: the PR card, the prompt to prefill in its bound session (never sent) and the
   * prompt for a fix round of the PR's Flow, for the caller that knows the PR has one.
   */
  onFixFindings?: ((card: ReviewCard, prompt: string, fixRoundPrompt: (flow: FixFindingsFlow) => string) => void) | undefined;
  onRefresh: () => void;
  /** The board action's intent was taken by the review interface. */
  onIntentConsumed?: (() => void) | undefined;
  onClose: () => void;
  /** The panel width, which the left-edge handle changes through `onResize`. */
  width?: number | undefined;
  onResize?: ((width: number) => void) | undefined;
  /** Opens the PR outside the app; defaults to the system browser. */
  openBrowser?: typeof openExternal | undefined;
}

/** One Review: its state, rounds timeline and the review interface of the PR's current range. */
export function ReviewPanel({ cwd, target, review, reviewIntent, flows, reviewModels, runCommand, publishCommand, onRunSnapshot, onAccessLost, onOpenReviewSession, onOpenFlow, onFixFindings, onRefresh, onIntentConsumed, onClose, width = 560, onResize, openBrowser = openReviewLink }: Props) {
  const panelId = useId();
  const toast = useToast();
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const pane = panel.current;
    closeButton.current?.focus();
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pane?.contains(document.activeElement) && before?.isConnected) before.focus();
    };
  }, []);
  // The app blocks navigation away from itself, so the link is handed to the system browser.
  const openPullRequestLink = useCallback((url: string) => {
    void openBrowser(url).catch(cause => {
      if (mounted.current) toast({ level: "error", title: "Could not open link", detail: errMessage(cause) });
    });
  }, [openBrowser, toast]);
  const { card } = review;
  const subject = useMemo(() => ({ ...target, number: review.number }), [target, review.number]);
  const flow = card ? flows?.find(item => item.prUrl?.replace(/\/$/, "").toLowerCase() === card.url.toLowerCase()) : undefined;
  const findings = findingsLabel(review.findings);
  const publication = publicationLabel(review);
  const freshness = freshnessLabel(review.freshness);
  const fix = onFixFindings ? fixFindingsTarget(review, target.viewer) : null;
  return <aside ref={panel} id={panelId} className="side-panel review-detail-panel review-panel" style={{ width }} aria-label={`Review of pull request #${review.number}`}
    onKeyDown={event => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && !(event.target as Element).closest('[role="dialog"]')) {
        event.preventDefault();
        onClose();
      }
    }}>
    {onResize && <PanelResizer panel={panel} panelId={panelId} width={width} label="Resize review details" onResize={onResize} />}
    <header className="sheet-head">
      <div className="sheet-head-row">
        <span className="flow-id">{target.repo} #{review.number}</span>
        <span className="grow" />
        {fix && onFixFindings && <button type="button" className="btn btn-sm" aria-label={`Fix findings of pull request #${review.number}`}
          onClick={() => onFixFindings(fix.card, fixFindingsPrompt(review, target, fix), flow => fixFindingsPrompt(review, target, fix, flow))}>Fix findings</button>}
        {card && <ReviewBrowserLink className="btn review-icon-action review-pr-link" url={card.url} label="Open pull request" onOpen={openPullRequestLink}><Icon name="external" /></ReviewBrowserLink>}
        <button ref={closeButton} className="icon-btn" onClick={onClose} aria-label="Close review"><Icon name="x" size={16} /></button>
      </div>
      <h2 className="sheet-title">{reviewTitle(review)}</h2>
      <div className="review-detail-meta review-panel-facts">
        <strong>{reviewStateLabel(review)}</strong>
        <span>Round {review.latestRound}</span>
        <span className="mono">{reviewedCommit(review)}</span>
        {freshness && <span>{freshness}</span>}
        {findings && <span>{findings}</span>}
        {publication && <span>{publication}</span>}
        <span>{SOURCE_LABEL[review.source] ?? review.source}</span>
        {review.flowId && <span>Flow #{review.flowId}</span>}
        {review.tokens !== null && <span>{review.tokens.toLocaleString()} tokens</span>}
      </div>
    </header>
    <div className="sheet-body review-detail-body">
      {card ? <ReviewWorkspace key={JSON.stringify([target.repositoryId, target.viewer, review.number, card.baseSha, card.headSha])} cwd={cwd} subject={subject} card={card}
        reviewIntent={reviewIntent} flow={flow} projectFlows={flows} reviewModels={reviewModels} runCommand={runCommand}
        publishCommand={publishCommand} onRunSnapshot={onRunSnapshot} onAccessLost={onAccessLost}
        onOpenReviewSession={onOpenReviewSession} onOpenFlow={onOpenFlow} onRefreshBoard={onRefresh} onLeave={onClose} onIntentConsumed={onIntentConsumed}>
        <Rounds rounds={review.rounds} />
      </ReviewWorkspace> : <>
        <div className="inline-banner tone-warn" role="status">
          <span>GitHub did not return this pull request, so its current range is unknown. Refresh the Reviews list to try again.</span>
          <button className="btn btn-sm" onClick={onRefresh}>Refresh</button>
        </div>
        <Rounds rounds={review.rounds} />
      </>}
    </div>
  </aside>;
}
