import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { Sheet, Spinner } from "../components/ui";
import { absoluteTime, errMessage, relativeTime } from "../lib/format";
import { openExternal, type FlowCard } from "../platform/commands";
import { reviewRun } from "../platform/reviewRuns";
import { PullRequestAutomation } from "./PullRequestAutomation";
import type { reviewRules } from "../platform/reviewRules";
import { launchAction, ReviewRuns } from "./ReviewRuns";
import { useReviewRuns, type RunObserver } from "./useReviewRuns";
import { fetchReviewDetail } from "../platform/review";
import type { ReviewDetailSnapshot, ReviewMessage } from "./ReviewDetailTypes";
import type { ReviewCard } from "./types";
import { markRepliesRead, readReplies, subscribeReviewReads } from "./reviewReadState";
import "./ReviewDetail.css";

interface Props {
  cwd: string;
  repo: string;
  repositoryId: string;
  viewer: string;
  card: ReviewCard;
  flow?: FlowCard | undefined;
  onOpenFlow?: (dir: string) => void;
  onClose: () => void;
  onAccessLost?: (reason: string) => void;
  load?: typeof fetchReviewDetail;
  runCommand?: typeof reviewRun;
  onRunSnapshot?: RunObserver;
  rulesCommand?: typeof reviewRules;
  onRefreshBoard?: () => void;
  onDiscussionLoaded?: (detail: ReviewDetailSnapshot) => void;
}

function External({ url, children }: { url: string | null; children: ReactNode }) {
  const toast = useToast();
  let target: URL;
  try {
    target = new URL(url ?? "");
  } catch {
    return <>{children}</>;
  }
  if (target.protocol !== "https:" || target.username || target.password) return <>{children}</>;
  return <a className="link-btn" href={target.href} target="_blank" rel="noopener noreferrer" onClick={(e) => {
    e.preventDefault();
    void openExternal(target.href).catch((cause) => toast({ level: "error", title: "Could not open link", detail: errMessage(cause) }));
  }}>{children}</a>;
}

function Message({ item, label, read }: { item: ReviewMessage; label: string; read: Set<string> }) {
  return <article className="review-detail-message">
    <div className="review-detail-meta">
      <strong>{item.author}</strong>
      {item.own && <span>You</span>}
      <span>{label}</span>
      {!item.own && !read.has(item.id) && <span className="badge">Unread</span>}
      <time dateTime={item.createdAt} title={absoluteTime(item.createdAt)}><External url={item.url}>{relativeTime(item.createdAt)}</External></time>
    </div>
    {item.body && <p>{item.body}</p>}
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

  return <>
    {unread.length > 0 && <button className="btn" onClick={markRead}>Mark {unread.length} as read</button>}
    {activity.length > 0 && <section aria-label="Conversation">{activity.map(({ item, label }) =>
      <Message key={item.id} item={item} label={label} read={visibleRead} />)}</section>}
    {data.threads.map(thread => <section key={thread.id} className="review-detail-thread">
      <header className="review-detail-meta">
        <strong className="mono">{thread.path}{thread.line !== null ? `:${thread.line}` : ""}</strong>
        <span className="badge">{thread.resolved ? "Resolved" : "Unresolved"}</span>
        {thread.outdated && <span>Outdated</span>}
      </header>
      {thread.messages.map((item, i) => <Message key={item.id} item={item} label={i === 0 ? "Inline comment" : "Reply"} read={visibleRead} />)}
    </section>)}
    {!activity.length && !data.threads.length && <p className="review-detail-muted">{data.warnings.length ? "No discussion loaded." : "No discussion yet."}</p>}
  </>;
}

export function ReviewDetail(props: Props) {
  return <ReviewDetailSheet key={JSON.stringify([props.cwd, props.repo, props.repositoryId, props.viewer, props.card.number])} {...props} />;
}

function ReviewDetailSheet({ cwd, repo, repositoryId, viewer, card, flow, onOpenFlow, onClose, onAccessLost, load = fetchReviewDetail, runCommand = reviewRun, onRunSnapshot, onRefreshBoard, rulesCommand, onDiscussionLoaded }: Props) {
  const [data, setData] = useState<ReviewDetailSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [tab, setTab] = useState<"discussion" | "checks" | "review" | "automation">("discussion");
  const subject = useMemo(() => ({ repo, repositoryId, viewer, number: card.number }), [repo, repositoryId, viewer, card.number]);
  const rulesTarget = useMemo(() => ({ repo, repositoryId, viewer }), [repo, repositoryId, viewer]);
  const loadAttempt = useCallback(async (id: string) => {
    const history = await runCommand(cwd, subject, { kind: "status", id });
    return history.runs.find(run => run.id === id);
  }, [cwd, subject, runCommand]);
  const local = useReviewRuns(cwd, subject, card.baseSha, card.headSha, tab === "review", runCommand, onRunSnapshot, onAccessLost);
  const action = launchAction(local.runs, card);
  const revisionChanged = (data && data.headSha !== card.headSha) || /^stale:/i.test(local.error);
  function launch() {
    setTab("review");
    if (!action.open) void local.request({ kind: "start", baseSha: card.baseSha, headSha: card.headSha });
  }
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    void load(cwd, repo, card.number).then(detail => {
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
        <button className="icon-btn" onClick={onClose} aria-label="Close details"><Icon name="x" size={16} /></button>
      </div>
      <h2 className="sheet-title">{card.title}</h2>
      <div className="sheet-actions">
        {card.state === "open" && <button className="btn btn-primary" onClick={launch}
          disabled={local.working || !local.loaded || (!action.open && !!revisionChanged)}>
          {local.working ? "Updating review…" : !local.loaded && !local.error ? "Checking review…" : action.label}
        </button>}
        <External url={card.url}>Open pull request</External>
        {flow && (onOpenFlow ? <button className="link-btn" onClick={() => onOpenFlow(flow.dir)}>Flow #{flow.id} · {flow.title}</button>
          : <span>Flow #{flow.id} · {flow.title}</span>)}
        <button className="btn" disabled={busy} onClick={() => setRefresh(n => n + 1)}>Refresh details</button>
      </div>
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
    <div className="sheet-body review-detail-body" aria-busy={tab === "review" ? local.working : busy}>
      {revisionChanged && <div className="inline-banner tone-warn" role="status">
        <span>The PR revision changed. Refresh the board to load the latest range.</span>
        {onRefreshBoard && <button className="btn btn-sm" onClick={onRefreshBoard}>Refresh board</button>}
      </div>}
      {tab === "automation" ? <PullRequestAutomation cwd={cwd} target={rulesTarget} number={card.number} open={card.state === "open"} command={rulesCommand} onAccessLost={onAccessLost} /> : tab === "review" ? <ReviewRuns card={card} {...local} loadAttempt={loadAttempt} onAccessLost={onAccessLost}
        onCancel={id => void local.request({ kind: "cancel", id })}
        onRefresh={() => void local.request({ kind: "status" })} /> : <>
      {busy && <Spinner label="Loading PR details" />}
      {error && <div className="inline-banner" role="alert">{error}</div>}
      {data && <>
        {data.warnings.map(w => <p className="inline-banner" key={w} role="status">{w}</p>)}
        <div className="review-detail-meta"><span>Read {absoluteTime(data.fetchedAt)}</span><span className="mono">{data.headSha.slice(0, 9)}</span></div>
        {tab === "discussion" ? <Discussion key={JSON.stringify([data.viewer, data.repositoryId, data.number])} data={data} /> : <>
          {data.checks.map(check => <div key={check.id} className="review-detail-check">
            <External url={check.url}>{check.name}</External><span>{check.status.toLowerCase().replaceAll("_", " ")}</span>
          </div>)}
          {!data.checks.length && <p className="review-detail-muted">{data.warnings.length ? "No checks loaded." : "No checks reported for this commit."}</p>}
        </>}
      </>}
      </>}
    </div>
  </Sheet>;
}
