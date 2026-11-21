import type { DeskRun, DeskRunKey } from "../../../../src/review/desk-run-types";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { Spinner } from "../components/ui";
import { absoluteTime, errMessage, relativeTime } from "../lib/format";
import { openExternal, openPullRequest, type FlowCard } from "../platform/commands";
import { reviewRun } from "../platform/reviewRuns";
import { PullRequestAutomation } from "./PullRequestAutomation";
import type { reviewRules } from "../platform/reviewRules";
import { pendingManualQuestions } from "./ReviewProgress";
import { launchAction, ReviewRuns } from "./ReviewRuns";
import type { reviewPublish } from "./ReviewPublishDialog";
import { ReviewRunDialog, ReviewRunHistory } from "./ReviewRunDialog";
import type { ReviewLifecycleCommand } from "./ReviewLifecycle";
import { sameRange, useReviewRuns, type RunObserver } from "./useReviewRuns";
import { fetchReviewDetail } from "../platform/review";
import type { ReviewDetailSnapshot, ReviewMessage } from "./ReviewDetailTypes";
import type { ReviewCard } from "./types";
import { markRepliesRead, readReplies, subscribeReviewReads } from "./reviewReadState";
import { DiscussionMarkdown } from "./DiscussionMarkdown";
import { githubPrUrl } from "../lib/githubPr";
import { ReviewBrowserLink, reviewUrl } from "./ReviewBrowserLink";
import { ReviewChecks } from "./ReviewChecks";
import { ReviewLaunchDialog, type ReviewLaunchModel } from "./ReviewLaunchDialog";
import "./ReviewDetail.css";

export interface ReviewIntent { kind: "start" | "view" | "answer"; baseSha: string; headSha: string }

interface Props {
  reviewIntent?: ReviewIntent | undefined;
  cwd: string;
  repo: string;
  repositoryId: string;
  viewer: string;
  card: ReviewCard;
  width?: number;
  onResize?: (width: number) => void;
  flow?: FlowCard | undefined;
  projectFlows?: readonly FlowCard[];
  reviewModels?: readonly ReviewLaunchModel[];
  onOpenFlow?: (dir: string) => void;
  onClose: () => void;
  onAccessLost?: (reason: string) => void;
  load?: typeof fetchReviewDetail;
  openBrowser?: typeof openExternal;
  onOpenReviewSession?: (key: DeskRunKey, run: DeskRun) => Promise<void>;
  onOpenSession?: (() => void) | undefined;
  runCommand?: typeof reviewRun;
  publishCommand?: typeof reviewPublish;
  onRunSnapshot?: RunObserver;
  rulesCommand?: typeof reviewRules;
  onRefreshBoard?: () => void;
  onDiscussionLoaded?: (detail: ReviewDetailSnapshot) => void;
}

function Message({ item, label, read }: { item: ReviewMessage; label: string; read: Set<string> }) {
  return <article className="review-detail-message">
    <div className="review-detail-meta discussion-byline">
      <strong>{item.author}</strong>
      {item.own && <span>You</span>}
      <span className="discussion-event">{label}</span>
      {!item.own && !read.has(item.id) && <span className="badge">Unread</span>}
      <time dateTime={item.createdAt} title={absoluteTime(item.createdAt)}><ReviewBrowserLink url={item.url}>{relativeTime(item.createdAt)}</ReviewBrowserLink></time>
    </div>
    {item.body && <DiscussionMarkdown body={item.body} />}
  </article>;
}

function Discussion({ data }: { data: ReviewDetailSnapshot }) {
  const messages = useMemo(() => [...data.comments, ...data.reviews, ...data.threads.flatMap(t => t.messages)], [data]);
  const ids = useMemo(() => messages.map(item => item.id), [messages]);
  const { viewer, repositoryId, number } = data;
  const [read, setRead] = useState(() => readReplies(viewer, repositoryId, number, ids));
  const [viewOnly, setViewOnly] = useState<Set<string>>(() => new Set());
  const toast = useToast();
  useEffect(() => {
    const refresh = () => setRead(readReplies(viewer, repositoryId, number, ids));
    refresh();
    return subscribeReviewReads(viewer, repositoryId, number, refresh);
  }, [viewer, repositoryId, number, ids]);
  const visibleRead = useMemo(() => new Set([...read, ...viewOnly]), [read, viewOnly]);
  const unread = messages.filter(item => !item.own && !visibleRead.has(item.id));
  function markRead() {
    const marked = unread.map(item => item.id);
    try {
      markRepliesRead(viewer, repositoryId, number, marked);
      setRead(previous => new Set([...previous, ...marked]));
    } catch {
      setViewOnly(previous => new Set([...previous, ...marked]));
      toast({ level: "info", title: "Read status saved for this view only" });
    }
  }

  const activity = [
    ...data.comments.map(item => ({ item, label: "Comment" })),
    ...data.reviews.map(item => ({ item, label: item.state.toLowerCase().replaceAll("_", " ") })),
  ].sort((a, b) => a.item.createdAt.localeCompare(b.item.createdAt));

  return <div className="pr-discussion">
    {data.description?.trim() && <section className="discussion-description" aria-label="Pull request description">
      <h3>Description</h3>
      <DiscussionMarkdown body={data.description} />
    </section>}
    <div className="discussion-heading"><h3>Conversation</h3>
      {unread.length > 0 && <button className="btn btn-sm" onClick={markRead}>Mark {unread.length} as read</button>}
    </div>
    {activity.length > 0 && <section className="discussion-conversation" aria-label="Conversation">{activity.map(({ item, label }) =>
      <Message key={item.id} item={item} label={label} read={visibleRead} />)}</section>}
    {data.threads.length > 0 && <h3>Code threads <span className="discussion-count">{data.threads.length}</span></h3>}
    {data.threads.map(thread => <section key={thread.id} className="review-detail-thread">
      <header className="review-detail-meta">
        <strong className="mono">{thread.path}{thread.line !== null ? `:${thread.line}` : ""}</strong>
        <span className="badge" data-resolved={thread.resolved}>{thread.resolved ? "Resolved" : "Unresolved"}</span>
        {thread.outdated && <span>Outdated</span>}
      </header>
      {thread.messages.map((item, i) => <Message key={item.id} item={item} label={i === 0 ? "Inline comment" : "Reply"} read={visibleRead} />)}
    </section>)}
    {!activity.length && !data.threads.length && <p className="review-detail-muted">{data.warnings.length ? "No discussion loaded." : "No discussion yet."}</p>}
  </div>;
}

export function ReviewDetail(props: Props) {
  return <ReviewDetailSheet key={JSON.stringify([props.cwd, props.repo, props.repositoryId, props.viewer, props.card.number])} {...props} />;
}

function ReviewDetailSheet({ cwd, repo, repositoryId, viewer, card, width = 560, onResize, reviewIntent, openBrowser, onOpenSession, onOpenReviewSession, flow, projectFlows, reviewModels, onOpenFlow, onClose, onAccessLost, load = fetchReviewDetail, runCommand = reviewRun, publishCommand, onRunSnapshot, onRefreshBoard, rulesCommand, onDiscussionLoaded }: Props) {
  const toast = useToast();
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const openingLink = useRef(false);
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

  const currentWidth = () => panel.current?.offsetWidth || width;
  const maxWidth = () => Math.max(360, (panel.current?.parentElement?.clientWidth || window.innerWidth) - 280);
  const resize = (next: number) => onResize?.(Math.min(maxWidth(), Math.max(360, next)));
  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: currentWidth() };
  }

  function followLink(event: MouseEvent<HTMLElement>) {
    if (event.button > 1) return;
    const link = (event.target as Element).closest("a[href]");
    if (!link) return;
    event.preventDefault();
    const url = reviewUrl(link.getAttribute("href"));
    if (!url || openingLink.current) return;
    openingLink.current = true;
    const open = openBrowser ?? (githubPrUrl(url) ? openPullRequest : openExternal);
    void open(url).catch(cause => {
      if (mounted.current) toast({ level: "error", title: "Could not open link", detail: errMessage(cause) });
    }).finally(() => { openingLink.current = false; });
  }
  const [data, setData] = useState<ReviewDetailSnapshot | null>(null);
  const [launchCard, setLaunchCard] = useState<ReviewCard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState<"discussion" | "checks" | "review" | "automation">(reviewIntent ? "review" : "discussion");
  const initialLaunch = useRef(reviewIntent);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const subject = useMemo(() => ({ repo, repositoryId, viewer, number: card.number }), [repo, repositoryId, viewer, card.number]);
  const publication = { cwd, target: subject, url: card.url, publishCommand };
  const rulesTarget = useMemo(() => ({ repo, repositoryId, viewer }), [repo, repositoryId, viewer]);
  const loadAttempt = useCallback(async (id: string) => {
    const history = await runCommand(cwd, subject, { kind: "status", id });
    return history.runs.find(run => run.id === id);
  }, [cwd, subject, runCommand]);
  const local = useReviewRuns(cwd, subject, card.baseSha, card.headSha, tab === "review" || !!sessionId, runCommand, onRunSnapshot, onAccessLost);
  const syncRuns = local.request;
  function openManagedRun(id: string) {
    const run = local.runs.find(item => item.id === id);
    if (!onOpenReviewSession || !run || run.source === "existing") {
      setSessionId(id);
      return;
    }
    void onOpenReviewSession(subject, run).then(onClose, reason => {
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
  const associatedFlow = associatedFlowId
    ? projectFlows?.find(candidate => candidate.id === associatedFlowId)
    : flow;
  const revisionChanged = (data && data.headSha !== card.headSha) || local.staleRange;
  const start = useCallback(() => {
    if (reviewModels) setLaunchCard(card);
    else void local.request({ kind: "start", baseSha: card.baseSha, headSha: card.headSha });
  }, [reviewModels, card, local.request]);
  // A board action is tied to the clicked revision, and consumed once after status resolves.
  // The backend validates this same range again before admitting the run.
  useEffect(() => {
    const next = initialLaunch.current;
    if (!next) return;
    if (tab !== "review" || local.error || card.state !== "open" || revisionChanged ||
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
  }, [action.open, action.sessionId, local.runs, card.state, card.baseSha, card.headSha, tab, local.error, local.loaded, start, revisionChanged]);

  function answerQuestion(id: string, questionId: string, answer: string) {
    void local.request({ kind: "answer", id, questionId, answer });
  }

  function launch() {
    setTab("review");
    if (action.sessionId) setSessionId(action.sessionId);
    else if (!action.open) start();
  }
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    void load(cwd, repo, card.number, viewer).then(detail => {
      if (!live) return;
      if (detail.viewer !== viewer || detail.number !== card.number || detail.repositoryId !== repositoryId) {
        throw new Error("access: The GitHub account or pull request changed. Refresh the board.");
      }
      setData(detail);
      onDiscussionLoaded?.(detail);
    }).catch(cause => {
      if (!live) return;
      const problem = errMessage(cause);
      if (/^(access|configuration):/i.test(problem)) {
        setData(null);
        onAccessLost?.(problem);
      }
      setError(problem);
    }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [cwd, repo, repositoryId, viewer, card.number, card.headSha, card.updatedAt, refresh, load, onAccessLost, onDiscussionLoaded]);

  return <aside id={panelId} ref={panel} className="side-panel review-detail-panel" style={{ width }} aria-label={`Pull request #${card.number}`}
    onKeyDown={event => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && !(event.target as Element).closest('[role="dialog"]')) {
        event.preventDefault();
        onClose();
      }
    }}>
    {onResize && <div className="side-resize review-detail-resize" role="separator" tabIndex={0}
      aria-orientation="vertical" aria-label="Resize pull request details" aria-controls={panelId}
      aria-valuemin={360} aria-valuenow={Math.min(maxWidth(), width)} aria-valuemax={maxWidth()}
      onPointerDown={startResize} onPointerMove={event => {
        const start = drag.current;
        if (start?.pointerId === event.pointerId) resize(start.width + start.x - event.clientX);
      }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => {
        const keys: Record<string, number> = { ArrowLeft: currentWidth() + 32, ArrowRight: currentWidth() - 32, Home: 360, End: maxWidth() };
        if (!Object.hasOwn(keys, event.key)) return;
        event.preventDefault();
        resize(keys[event.key]!);
      }} />}
    <header className="sheet-head">
      <div className="sheet-head-row">
        <span className="flow-id">{repo} #{card.number}</span>
        <span className="grow" />
        <ReviewRunHistory runs={local.runs} onSelect={setSessionId} />
        <button ref={closeButton} className="icon-btn" onClick={onClose} aria-label="Close details"><Icon name="x" size={16} /></button>
      </div>
      <h2 className="sheet-title">{card.title}</h2>
      <div className="sheet-actions review-detail-actions" onClick={followLink} onAuxClick={followLink}>
        {card.state === "open" && <button className="btn btn-sm btn-primary" onClick={launch}
          disabled={local.working || !local.loaded || (!action.open && !!revisionChanged)}>
          {local.working ? "Updating review…" : !local.loaded && !local.error ? "Checking review…" : action.label}
        </button>}
        <div className="review-action-row">
          <button className="btn review-icon-action" type="button" disabled={busy} aria-label="Refresh details"
            title="Refresh details" onClick={() => setRefresh(n => n + 1)}><Icon name="refresh" /></button>
          {onOpenSession && <button className="btn review-icon-action" type="button" aria-label="Open in Sessions"
            title="Open in Sessions" onClick={onOpenSession}><Icon name="chat" /></button>}
          <ReviewBrowserLink className="btn review-icon-action review-pr-link" url={card.url} label="Open pull request"><Icon name="external" /></ReviewBrowserLink>
        </div>
      </div>
      {associatedFlow ? (onOpenFlow ? <button className="link-btn review-associated-flow" onClick={() => onOpenFlow(associatedFlow.dir)}>Flow #{associatedFlow.id} · {associatedFlow.title}</button>
        : <span className="review-associated-flow">Flow #{associatedFlow.id} · {associatedFlow.title}</span>)
        : associatedFlowId && <span className="review-associated-flow">Flow #{associatedFlowId}</span>}
    </header>
    {data?.projectContext && <details className="review-flow-context">
      <summary>{data.projectContext.totalFlows ? `Review context · ${data.projectContext.totalFlows} linked ${data.projectContext.totalFlows === 1 ? "Flow" : "Flows"}` : "Standalone review context"}</summary>
      <code>keryx review pr-context --pr {card.url}</code>
      {data.projectContext.flows.map(link => <article key={link.directory}>
        <strong>Flow #{link.id} · {link.title}</strong>
        {Object.entries(link.documents).map(([name, text]) => <details key={name}>
          <summary>{name}</summary><pre>{text}</pre>
        </details>)}
      </article>)}
    </details>}
    <div className="tabs" role="group" aria-label="Pull request details">
      <button className="tab" aria-pressed={tab === "discussion"} onClick={() => setTab("discussion")}>Discussion</button>
      <button className="tab" aria-pressed={tab === "checks"} onClick={() => setTab("checks")}>Checks</button>
      <button className="tab" aria-pressed={tab === "review"} onClick={() => setTab("review")}>Keryx review</button>
      <button className="tab" aria-pressed={tab === "automation"} onClick={() => setTab("automation")}>Automation</button>
    </div>
    <div className="sheet-body review-detail-body" onClick={tab === "checks" || tab === "discussion" ? followLink : undefined}
      onAuxClick={tab === "checks" || tab === "discussion" ? followLink : undefined} aria-busy={tab === "review" ? local.working : busy}>
      {revisionChanged && <div className="inline-banner tone-warn" role="status">
        <span>The PR revision changed. Refresh the board to load the latest range.</span>
        {onRefreshBoard && <button className="btn btn-sm" onClick={onRefreshBoard}>Refresh board</button>}
      </div>}
      {tab === "automation" ? <PullRequestAutomation cwd={cwd} target={rulesTarget} number={card.number} open={card.state === "open"} command={rulesCommand} onAccessLost={onAccessLost} /> : tab === "review" ? <ReviewRuns publication={publication} onAnswer={answerQuestion} onOpenSession={openManagedRun} card={card} {...local} loadAttempt={loadAttempt} onAccessLost={onAccessLost}
        onCancel={id => void local.request({ kind: "cancel", id })}
        onLifecycle={lifecycle}
        onRefresh={() => void local.request({ kind: "status" })} /> : <>
      {busy && <Spinner label="Loading PR details" />}
      {error && <div className="inline-banner" role="alert">{error}</div>}
      {data && <>
        {data.warnings.map(w => <p className="inline-banner" key={w} role="status">{w}</p>)}
        <div className="review-detail-meta"><span>Read {absoluteTime(data.fetchedAt)}</span><span className="mono">{data.headSha.slice(0, 9)}</span></div>
        {tab === "discussion" ? <Discussion key={JSON.stringify([data.viewer, data.repositoryId, data.number])} data={data} /> : <ReviewChecks checks={data.checks} partial={!!data.warnings.length} />}
      </>}
      </>}
    </div>
    {session && <ReviewRunDialog
      {...(onOpenReviewSession && session.source !== "existing" && {
        onOpenWorkspace: async () => {
          await onOpenReviewSession({ repo, repositoryId, viewer, number: card.number }, session);
          setSessionId(null);
          onClose();
        },
      })} key={session.id} publication={publication} run={session} card={card} working={local.working} activity={local.activity}
      error={local.error} loadAttempt={loadAttempt} onAccessLost={onAccessLost} onClose={() => setSessionId(null)}
      onCancel={id => void local.request({ kind: "cancel", id })}
      onLifecycle={lifecycle}
      onRefresh={() => void local.request({ kind: "status" })}
      onAnswer={answerQuestion} />}
    {launchCard && reviewModels && <ReviewLaunchDialog models={reviewModels} flows={projectFlows ?? []}
      defaultFlow={associatedFlow?.id} fixedTarget={{ repo, repositoryId, viewer, card: launchCard }}
      onApply={async (key, revision, options) => {
        if (card.state !== "open" || revisionChanged || !sameRange(card, revision)) {
          throw new Error("The PR revision changed. Refresh the board and open the launch form again.");
        }
        const snapshot = await runCommand(cwd, key, { kind: "start", ...revision, options });
        if (!snapshot.startedRunId || !snapshot.runs.some(run => run.id === snapshot.startedRunId)) {
          throw new Error("The selected Keryx CLI did not confirm the new review attempt.");
        }
        onRunSnapshot?.(key, revision, snapshot);
        await local.request({ kind: "status" });
      }}
      onClose={() => setLaunchCard(null)} />}
  </aside>;
}
