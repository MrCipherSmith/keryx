import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { Sheet, Spinner } from "../components/ui";
import { absoluteTime, errMessage, relativeTime } from "../lib/format";
import type { FlowCard } from "../platform/commands";
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
import { browserOpen } from "../platform/panels";
import { setPrefs } from "../lib/prefs";
import { ReviewBrowserLink, reviewUrl } from "./ReviewBrowserLink";
import { ReviewChecks } from "./ReviewChecks";
import "./ReviewDetail.css";

export interface ReviewIntent { kind: "start" | "view" | "answer"; baseSha: string; headSha: string }

interface Props {
  reviewIntent?: ReviewIntent | undefined;
  cwd: string;
  repo: string;
  repositoryId: string;
  viewer: string;
  card: ReviewCard;
  flow?: FlowCard | undefined;
  projectFlows?: readonly FlowCard[];
  onOpenFlow?: (dir: string) => void;
  onClose: () => void;
  onAccessLost?: (reason: string) => void;
  load?: typeof fetchReviewDetail;
  openBrowser?: typeof browserOpen;
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

function ReviewDetailSheet({ cwd, repo, repositoryId, viewer, card, reviewIntent, openBrowser = browserOpen, flow, projectFlows, onOpenFlow, onClose, onAccessLost, load = fetchReviewDetail, runCommand = reviewRun, publishCommand, onRunSnapshot, onRefreshBoard, rulesCommand, onDiscussionLoaded }: Props) {
  const toast = useToast();
  const openingLink = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function followLink(event: MouseEvent<HTMLElement>) {
    if (event.button > 1) return;
    const link = (event.target as Element).closest("a[href]");
    if (!link) return;
    event.preventDefault();
    const url = reviewUrl(link.getAttribute("href"));
    if (!url || openingLink.current) return;
    openingLink.current = true;
    void openBrowser(cwd, url).then(() => {
      // WebKit hides child views under modal sheets. Reveal the tab once it exists.
      if (!mounted.current) return;
      setPrefs({ sidePanel: "browser" });
      onClose();
    }).catch(cause => {
      if (mounted.current) toast({ level: "error", title: "Could not open the project browser", detail: errMessage(cause) });
    }).finally(() => { openingLink.current = false; });
  }
  const [data, setData] = useState<ReviewDetailSnapshot | null>(null);
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
      void local.request({ kind: "start", baseSha: next.baseSha, headSha: next.headSha });
    }
  }, [action.open, action.sessionId, local.runs, card.state, card.baseSha, card.headSha, tab, local.error, local.loaded, local.request, revisionChanged]);

  function answerQuestion(id: string, questionId: string, answer: string) {
    void local.request({ kind: "answer", id, questionId, answer });
  }

  function launch() {
    setTab("review");
    if (action.sessionId) setSessionId(action.sessionId);
    else if (!action.open) void local.request({ kind: "start", baseSha: card.baseSha, headSha: card.headSha });
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

  return <Sheet label={`Pull request #${card.number}`} onClose={onClose} width={720}>
    <header className="sheet-head">
      <div className="sheet-head-row">
        <span className="flow-id">{repo} #{card.number}</span>
        <span className="grow" />
        <ReviewRunHistory runs={local.runs} onSelect={setSessionId} />
        <button className="icon-btn" onClick={onClose} aria-label="Close details"><Icon name="x" size={16} /></button>
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
      {tab === "automation" ? <PullRequestAutomation cwd={cwd} target={rulesTarget} number={card.number} open={card.state === "open"} command={rulesCommand} onAccessLost={onAccessLost} /> : tab === "review" ? <ReviewRuns publication={publication} onAnswer={answerQuestion} onOpenSession={setSessionId} card={card} {...local} loadAttempt={loadAttempt} onAccessLost={onAccessLost}
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
    {session && <ReviewRunDialog key={session.id} publication={publication} run={session} card={card} working={local.working} activity={local.activity}
      error={local.error} loadAttempt={loadAttempt} onAccessLost={onAccessLost} onClose={() => setSessionId(null)}
      onCancel={id => void local.request({ kind: "cancel", id })}
      onLifecycle={lifecycle}
      onRefresh={() => void local.request({ kind: "status" })}
      onAnswer={answerQuestion} />}
  </Sheet>;
}
