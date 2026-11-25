import { useCallback, useEffect, useRef, useState } from "react";
import { canContinueDeskRun, type CoordinatorEvent, type DeskRun } from "../../../../src/review/desk-run-types";
import { errMessage } from "../lib/format";
import { Icon } from "../components/Icon";
import { publishSessionReview, reviewRun, type ReviewRunAction } from "../platform/reviewRuns";
import { REVIEW_SESSION_BUSY } from "./reviewTurn";
import { pendingManualQuestions, ReviewProgress, runStatusLabel } from "./ReviewProgress";
import { ReviewRunDialog } from "./ReviewRunDialog";
import { ReviewQuestion } from "./ReviewQuestion";
import { ReviewTranscript } from "./ReviewTranscript";
import { ReviewPlanSummary, reviewPlanEvidence } from "./ReviewPlanSummary";
import { ReviewOutcome } from "./ReviewOutcome";
import { readRunStatus } from "./runPolling";
import { runActive } from "./useReviewRuns";
import type { SessionReviewLink } from "./sessionReview";
import type { ReviewLifecycleCommand } from "./ReviewLifecycle";
import "./ReviewDetail.css";
import "./SessionReviewActivity.css";

const PASSIVE_FOLLOW = () => () => {};

/**
 * Publication from Sessions offers no "Update review": this view follows one attempt on its recorded range and
 * cannot see the PR's other attempts, so the next round starts from the Review panel.
 */
export function sessionReviewPublication(cwd: string, key: SessionReviewLink["key"]) {
  return { cwd, target: key, url: `https://github.com/${key.repo}/pull/${key.number}` };
}

/**
 * Sends a continue turn into the link's session (Desktop Review v3); false when the session refused it (busy). Continue
 * is a turn in the live session, never a new detached attempt (`review_run continue`).
 */
export type ContinueReviewTurn = (link: SessionReviewLink, note: string) => boolean | Promise<boolean>;

/** The compact line of a round's card: round, verdict and finding counts, the parts a collapsed card keeps. */
export function compactSummary(run: DeskRun): string {
  const parts = [`Round ${run.round ?? 1}`];
  if (run.result?.verdict) parts.push(`verdict ${run.result.verdict}`);
  const findings = run.result?.findingsKnown === false ? undefined : run.result?.findings;
  if (findings) {
    const counts = (["blocker", "major", "minor", "info"] as const).filter(level => findings[level] > 0)
      .map(level => `${findings[level]} ${level}`);
    parts.push(counts.length ? counts.join(", ") : "no findings");
  }
  return parts.join(" · ");
}

/**
 * What a round's card keeps when it moves between the pinned slot and the timeline (a move mounts it anew): whether it
 * is expanded, its open dialog, the unsent Continue note and the last run it read. Keyed `sessionId:id`; the caller
 * holds one map for the window.
 */
export type ReviewCardMemory = Map<string, { expanded?: boolean; open?: boolean; guidance?: string; run?: DeskRun | null }>;

/** `useState` whose value outlives the component in `memory[key][field]`. */
function useRemembered<K extends "expanded" | "open" | "guidance" | "run">(memory: ReviewCardMemory | undefined, key: string, field: K,
  initial: NonNullable<ReturnType<ReviewCardMemory["get"]>>[K]) {
  const [value, setValue] = useState(() => memory?.get(key)?.[field] ?? initial);
  const set = useCallback((next: typeof value | ((previous: typeof value) => typeof value)) => {
    setValue(previous => {
      const resolved = typeof next === "function" ? (next as (previous: typeof value) => typeof value)(previous) : next;
      if (memory) memory.set(key, { ...memory.get(key), [field]: resolved });
      return resolved;
    });
  }, [memory, key, field]);
  return [value, set] as const;
}

/** Reports whether a round's card belongs pinned above the composer (running or waiting) or in the timeline. */
export type ReviewActiveChange = (id: string, active: boolean) => void;

/** Whether `link` may offer Continue: no newer link (earlier in `all`) follows the same PR, account and range. */
export function continuableLink(all: readonly SessionReviewLink[], link: SessionReviewLink): boolean {
  const index = all.findIndex(item => item.id === link.id && item.sessionId === link.sessionId);
  const newer = index < 0 ? [] : all.slice(0, index);
  return !newer.some(next => next.key.repositoryId === link.key.repositoryId && next.key.number === link.key.number &&
    next.key.viewer.toLowerCase() === link.key.viewer.toLowerCase() && next.revision.headSha === link.revision.headSha &&
    next.revision.baseSha === link.revision.baseSha);
}

/**
 * The review cards of a session: one card per round (link), compact until expanded. `onActiveChange` tells the caller
 * where each card belongs: pinned above the composer while its round runs or waits, in the timeline once it finished.
 */
export function SessionReviewActivity({ cwd, links, allLinks = links, visible, pinned = false, onContinueTurn, onActiveChange, memory, runCommand = reviewRun }: {
  cwd: string; links: readonly SessionReviewLink[]; visible: boolean;
  /** Every link of the session, newest first: decides which card may Continue. Defaults to `links`. */
  allLinks?: readonly SessionReviewLink[] | undefined;
  /** Rendered in the pinned slot above the composer rather than in the transcript. */
  pinned?: boolean | undefined;
  onContinueTurn: ContinueReviewTurn;
  onActiveChange?: ReviewActiveChange | undefined;
  /** Keeps each card's state across a move between the pinned slot and the timeline. */
  memory?: ReviewCardMemory | undefined;
  /** The review_run command; injected by tests. */
  runCommand?: typeof reviewRun | undefined;
}) {
  return <section className={`session-review-activity${pinned ? " session-review-pinned" : ""}`}
    aria-label={pinned ? "Review in progress" : "Review activity"}>
    {links.map(link => <FollowedReview cwd={cwd} link={link} visible={visible} key={`${link.sessionId}:${link.id}`}
      canContinue={continuableLink(allLinks, link)} onContinueTurn={onContinueTurn} onActiveChange={onActiveChange}
      memory={memory} reviewRun={runCommand} />).reverse()}
  </section>;
}

function FollowedReview({ cwd, link, visible, canContinue, onContinueTurn, onActiveChange, memory, reviewRun }: {
  cwd: string; link: SessionReviewLink; visible: boolean; canContinue: boolean;
  onContinueTurn: ContinueReviewTurn; onActiveChange?: ReviewActiveChange | undefined;
  memory?: ReviewCardMemory | undefined;
  reviewRun: typeof import("../platform/reviewRuns").reviewRun;
}) {
  const remembered = `${link.sessionId}:${link.id}`;
  const [run, setRun] = useRemembered(memory, remembered, "run", null);
  const [expanded, setExpanded] = useRemembered(memory, remembered, "expanded", false);
  const [open, setOpen] = useRemembered(memory, remembered, "open", false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [guidance, setGuidance] = useRemembered(memory, remembered, "guidance", "");
  const [history, setHistory] = useState<{ events: CoordinatorEvent[]; before?: number }>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const readingEarlier = useRef(false);
  const inFlight = useRef(false);
  const writing = useRef(false);
  const generation = useRef(0);
  const publishedState = useRef<string>();
  useEffect(() => () => { generation.current++; }, [cwd, link]);
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  const refresh = useCallback(async (automatic = false) => {
    if (inFlight.current || writing.current) return;
    const current = generation.current;
    inFlight.current = true;
    try {
      const snapshot = await readRunStatus(reviewRun, cwd, link.key, { kind: "status", activityId: link.id }, automatic);
      if (!snapshot || current !== generation.current) return;
      const found = snapshot.runs.find(item => item.id === link.id);
      setRun(found ?? null);
      if (!found) setHistory(undefined);
      if (found?.source === "session" && publishedState.current !== found.state) {
        publishedState.current = found.state;
        publishSessionReview(cwd, link.key, snapshot);
      }
      setError(found ? "" : "This review attempt is no longer available.");
      if (!found) setOpen(false);
    } catch (failure) {
      if (current !== generation.current) return;
      const message = errMessage(failure);
      if (/^(access|configuration):/i.test(message)) {
        setRun(null);
        setHistory(undefined);
        setOpen(false);
      }
      setError(message);
    } finally { inFlight.current = false; }
  }, [cwd, link, reviewRun]);
  const pending = !run || runActive(run);
  // Placement follows the round's state once it is known: running, or waiting on the user's answer, pins the card;
  // anything else (finished, paused, stopped) is history. A run that vanished or can no longer be read unpins it.
  const active = run ? runActive(run) || pendingManualQuestions(run).length > 0 : error ? false : undefined;
  useEffect(() => {
    if (active !== undefined) onActiveChange?.(link.id, active);
  }, [active, link.id, onActiveChange]);
  const automaticPublication = run?.options?.autoPublish && run.publication === "pending" ? run.finishedAt : null;
  useEffect(() => {
    if (!visible) return;
    if (pending) void refresh();
    const poll = () => {
      if (document.visibilityState !== "hidden") void refresh(true);
    };
    const timer = pending || automaticPublication ? window.setInterval(() => {
      if (pending || (automaticPublication && Date.now() - Date.parse(automaticPublication) < 120_000)) poll();
    }, 6000) : undefined;
    window.addEventListener("focus", poll);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [visible, pending, automaticPublication, refresh]);

  const mutate = useCallback(async (action: Extract<ReviewRunAction, { kind: "cancel" | "answer" }>) => {
    if (writing.current) return false;
    writing.current = true;
    const current = ++generation.current;
    setWorking(true);
    setError("");
    try {
      const result = await reviewRun(cwd, link.key, action);
      const latest = result.runs.find(item => item.id === link.id);
      if (action.kind === "answer" && (!latest || pendingManualQuestions(latest).some(item => item.id === action.questionId))) {
        throw new Error("Could not confirm the reply. Refresh review status before retrying.");
      }
      if (current === generation.current && latest) {
        setRun(previous => ({ ...latest, coordinatorActivity: latest.coordinatorActivity ?? previous?.coordinatorActivity }));
      }
    }
    catch (failure) {
      if (current !== generation.current) return false;
      const message = errMessage(failure);
      if (/^access:/i.test(message)) {
        setRun(null);
        setHistory(undefined);
        setOpen(false);
      }
      setError(message);
      if (/^stale:/i.test(message)) window.setTimeout(() => void refresh(), 0);
      return false;
    } finally { writing.current = false; setWorking(false); }
    void refresh();
    return true;
  }, [cwd, link, reviewRun, refresh]);
  const continueReview = useCallback(async (guidance: string) => {
    if (writing.current) return false;
    writing.current = true;
    const current = generation.current;
    setWorking(true);
    setError("");
    try {
      // The note stays in the form until the turn is accepted: a busy session keeps what the user typed.
      if (!(await onContinueTurn(link, guidance.trim()))) throw new Error(REVIEW_SESSION_BUSY);
      if (current === generation.current) setGuidance("");
      return true;
    } catch (failure) {
      if (current === generation.current) setError(errMessage(failure));
      return false;
    } finally {
      writing.current = false;
      setWorking(false);
    }
  }, [link, onContinueTurn]);

  const lifecycle = useCallback<ReviewLifecycleCommand>(async action => {
    const snapshot = await reviewRun(cwd, link.key, action);
    if (action.kind === "decide") {
      generation.current++;
      const attempt = snapshot.runs.find(item => item.id === link.id);
      setRun(attempt ?? null);
      if (!attempt) setOpen(false);
      publishSessionReview(cwd, link.key, snapshot);
    }
    return snapshot;
  }, [cwd, link, reviewRun]);

  const prefix = `[Review #${link.key.number}]`;
  const status = run ? runStatusLabel(run) : "Checking review status…";
  const questions = run ? pendingManualQuestions(run) : [];
  const awaitAnswer = questions.length > 0;
  const terminal = !!run && !runActive(run);
  const needsPublication = run?.publication === "pending";
  const canResume = !!run && canContinue && canContinueDeskRun(run);
  const sessionLabel = needsPublication ? "Review publication" : terminal ? "View review result" : "Review details";
  const events = history?.events ?? run?.coordinatorActivity ?? [];
  const before = history ? history.before : run?.coordinatorActivityBefore;
  async function loadEarlier() {
    if (before === undefined || readingEarlier.current) return;
    readingEarlier.current = true;
    const current = generation.current;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const snapshot = await reviewRun(cwd, link.key, { kind: "status", activityId: link.id, activityBefore: before });
      if (current !== generation.current) return;
      const page = snapshot.runs.find(item => item.id === link.id);
      if (!page?.coordinatorActivity || (page.coordinatorActivityBefore !== undefined && page.coordinatorActivityBefore >= before)) {
        throw new Error("The review activity could not be loaded.");
      }
      const previous = page.coordinatorActivity;
      const boundary = previous.at(-1);
      const newer = events[0];
      const duplicate = boundary?.kind === "message" && newer?.kind === "message" && boundary.text === newer.text;
      setHistory({ events: [...(duplicate ? previous.slice(0, -1) : previous), ...events],
        ...(page.coordinatorActivityBefore !== undefined && { before: page.coordinatorActivityBefore }) });
    } catch (error) {
      if (current !== generation.current) return;
      const message = errMessage(error);
      if (/^(access|configuration):/i.test(message)) {
        setRun(null);
        setHistory(undefined);
        setOpen(false);
        setError(message);
      } else {
        setHistoryError(message);
      }
    } finally {
      readingEarlier.current = false;
      setHistoryLoading(false);
    }
  }

  return <>
    <article className="session-review-item">
      <header>
        <strong role="status">{prefix} {status}</strong>
        {(needsPublication || canResume || awaitAnswer) && <span className="badge review-publication-pending">Action required</span>}
        {run && <div className="review-action-row">
          <button className="btn review-icon-action" type="button" aria-label={sessionLabel} title={sessionLabel}
            aria-haspopup="dialog" onClick={() => setOpen(true)}><Icon name={terminal ? "file" : "chat"} /></button>
        </div>}
      </header>
      {run && <div className="session-review-summary">
        <span>{compactSummary(run)}</span>
        <button className="btn btn-sm session-review-toggle" type="button" aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} details of review #${link.key.number}${run.round ? ` round ${run.round}` : ""}`}
          onClick={() => setExpanded(value => !value)}>{expanded ? "Hide details" : "Show details"}</button>
      </div>}
      {error && <div className="session-review-message" role="alert">{prefix} {error} <button className="btn btn-sm" onClick={() => void refresh()}>Retry status</button></div>}
      {awaitAnswer && <p className="session-review-message">{questions.length} {questions.length === 1 ? "question is" : "questions are"} waiting for a reply.</p>}
      {expanded && link.prompt && <blockquote className="session-review-request">{link.prompt}</blockquote>}
      {run && expanded && <>
        <ReviewPlanSummary data={{
          title: run.pullRequestTitle ?? `${link.key.repo} #${link.key.number}`,
          headSha: run.headSha,
          ...reviewPlanEvidence(run.reviewerProgress?.planSummary, run.pullRequestScope),
          ...(run.options?.orchestrator === false && { singleReviewer: true }),
          stage: run.phase,
          runState: run.state,
          ...(run.reviewerProgress && { assignmentProgress: run.reviewerProgress }),
          ...(needsPublication ? { operatorStep: "Choose whether to publish on GitHub." }
            : awaitAnswer ? { operatorStep: run.reason || "Reply to the requested review context." } : {}),
        }} />
        {run.options?.orchestrator !== false && <ReviewProgress state={run.state} progress={run.reviewerProgress} />}
        {terminal && <ReviewOutcome run={run} />}
        {canResume && <form className="review-question" onSubmit={event => {
          event.preventDefault();
          void continueReview(guidance);
        }}>
          <label>Context for the coordinator<textarea maxLength={2000} value={guidance}
            onChange={event => setGuidance(event.target.value)} rows={2} /></label>
          <button type="submit" className="btn btn-sm" disabled={working}>Continue review</button>
        </form>}
        {(events.length > 0 || before !== undefined) && <details>
          <summary>Review activity</summary>
          {before !== undefined && <button className="btn btn-sm" type="button" disabled={historyLoading} onClick={() => void loadEarlier()}>
            {historyLoading ? "Loading activity…" : "Load earlier activity"}
          </button>}
          {history && <button className="btn btn-sm" type="button" disabled={historyLoading} onClick={() => {
            setHistory(undefined);
            setHistoryError("");
          }}>Back to latest activity</button>}
          {historyError && <p role="alert">{historyError}</p>}
          <ReviewTranscript actor="Coordinator" events={events} loading={false} error={error} followLatest={!history} />
        </details>}
      </>}
    </article>
    {questions.map(question => <ReviewQuestion key={question.id} question={question} working={working}
      legend={question.reviewer ?? "Review coordinator"}
      onAnswer={answer => void mutate({ kind: "answer", id: link.id, questionId: question.id, answer })} />)}
    {visible && open && run && <ReviewRunDialog run={run} card={{ number: link.key.number, ...link.revision }}
      publication={sessionReviewPublication(cwd, link.key)}
      working={working} activity={{ follow: PASSIVE_FOLLOW, loaded: run.id, error }}
      error={error} onClose={() => setOpen(false)} onRefresh={() => void refresh()}
      loadAttempt={async id => {
        const result = await reviewRun(cwd, link.key, { kind: "status", id });
        return result.runs.find(item => item.id === id);
      }}
      onAccessLost={message => { setRun(null); setHistory(undefined); setOpen(false); setError(message); }}
      onLifecycle={lifecycle}
      onAnswer={(id, questionId, answer) => void mutate({ kind: "answer", id, questionId, answer })}
      onCancel={id => void mutate({ kind: "cancel", id })} />}
  </>;
}
