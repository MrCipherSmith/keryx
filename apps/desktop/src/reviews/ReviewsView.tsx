import type { DeskRun, DeskRunKey } from "../../../../src/review/desk-run-types";
import { reviewNeedsViewer, type ReviewState, type ReviewSummary, type ReviewsSnapshot } from "../../../../src/review/review-entity";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { EmptyState, overlayOpen, Spinner } from "../components/ui";
import { absoluteTime, errMessage } from "../lib/format";
import type { FlowCard } from "../platform/commands";
import { fetchReviews } from "../platform/review";
import { reviewRules } from "../platform/reviewRules";
import type { reviewRun } from "../platform/reviewRuns";
import { ProjectReviewRules } from "../review/ProjectReviewRules";
import type { ReviewLaunchModel } from "../review/ReviewLaunchDialog";
import type { reviewPublish } from "../review/ReviewPublishDialog";
import type { ReviewIntent } from "../review/ReviewWorkspace";
import type { RunObserver } from "../review/useReviewRuns";
import type { ReviewsTabIndicator } from "../shell/AppShell";
import {
  COLUMNS, EMPTY_REVIEW_FILTERS, filterReviewList, filtersActive, findingsLabel, freshnessLabel, groupByColumn, isBehind,
  publicationLabel, reviewedCommit, reviewTitle, SOURCE_LABEL, STATE_LABEL, type ReviewColumn, type ReviewFilters,
} from "./model";
import { ReviewPanel } from "./ReviewPanel";

/** A request from another tab to show one PR's Review; a new nonce repeats it. */
export interface ReviewsFocus { number: number; nonce: number; intent?: ReviewIntent | undefined }

interface Props {
  cwd: string;
  expectedViewer?: string | undefined;
  /** This tab is shown. The view stays mounted while hidden so the tab indicator stays current. */
  active: boolean;
  focus?: ReviewsFocus | null | undefined;
  onIndicatorChange?: ((indicator: ReviewsTabIndicator) => void) | undefined;
  flows?: readonly FlowCard[] | undefined;
  reviewModels?: readonly ReviewLaunchModel[] | undefined;
  onOpenReviewSession?: ((key: DeskRunKey, run: DeskRun) => Promise<void>) | undefined;
  onOpenFlow?: ((dir: string) => void) | undefined;
  load?: typeof fetchReviews;
  runCommand?: typeof reviewRun | undefined;
  publishCommand?: typeof reviewPublish | undefined;
  rulesCommand?: typeof reviewRules;
}

/** While the tab is shown and a Review is queued or running, the list is read again this often. */
export const RUNNING_RELOAD_MS = 60_000;

const STATES: ReviewState[] = ["queued", "running", "needs_answer", "ready", "stopped", "published", "closed"];

interface ReadState {
  snapshot: ReviewsSnapshot | null;
  error: string;
  loading: boolean;
  /** The request that produced this state; a focus request waits for a load started after it. */
  request: number;
}

const accessProblem = (message: string) => /^(access|configuration):/i.test(message);
const plainError = (message: string) => message.replace(/^(access|configuration|unavailable):\s*/i, "");

export function ReviewsView(props: Props) {
  const [repo, setRepo] = useState<string>();
  return <RepositoryReviews key={JSON.stringify([props.cwd, props.expectedViewer?.toLowerCase(), repo])} {...props} repo={repo} selectRepo={setRepo} />;
}

function RepositoryReviews({ cwd, expectedViewer, active, focus, onIndicatorChange, flows, reviewModels, onOpenReviewSession, onOpenFlow,
  load = fetchReviews, runCommand, publishCommand, rulesCommand = reviewRules, repo, selectRepo }: Props & { repo?: string | undefined; selectRepo: (repo?: string) => void }) {
  const [read, setRead] = useState<ReadState>({ snapshot: null, error: "", loading: true, request: 0 });
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt(n => n + 1), []);
  const sequence = useRef(0);
  const identity = useRef("");
  const [filters, setFilters] = useState<ReviewFilters>(EMPTY_REVIEW_FILTERS);
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query);
  const [showClosed, setShowClosed] = useState(false);
  const [view, setView] = useState<"board" | "list">("board");
  const [selected, setSelected] = useState<{ id: string; intent?: ReviewIntent | undefined } | null>(null);
  const [notice, setNotice] = useState("");
  const search = useRef<HTMLInputElement>(null);

  const resetView = useCallback(() => {
    setFilters(EMPTY_REVIEW_FILTERS);
    setQuery("");
    setShowClosed(false);
    setSelected(null);
    setNotice("");
  }, []);

  const accessLost = useCallback((message: string) => {
    sequence.current++;
    identity.current = "";
    resetView();
    setRead(old => ({ snapshot: null, error: message, loading: false, request: old.request }));
  }, [resetView]);

  useEffect(() => {
    const request = ++sequence.current;
    setRead(old => ({ ...old, loading: true }));
    void load(cwd, repo, expectedViewer).then(snapshot => {
      if (request !== sequence.current) return;
      const next = JSON.stringify([snapshot.repositoryId, snapshot.viewer.toLowerCase()]);
      // Another account or repository: nothing chosen for the previous one carries over.
      if (identity.current && identity.current !== next) resetView();
      identity.current = next;
      setSelected(current => current && snapshot.reviews.some(review => review.id === current.id) ? current : null);
      setRead({ snapshot, error: "", loading: false, request });
    }).catch((cause: unknown) => {
      if (request !== sequence.current) return;
      const message = errMessage(cause);
      if (accessProblem(message)) {
        accessLost(message);
        return;
      }
      // A failed refresh keeps the last list; a failed first load has none to keep.
      setRead(old => ({ snapshot: old.snapshot, error: message, loading: false, request }));
    });
    return () => { sequence.current++; };
  }, [cwd, repo, expectedViewer, attempt, load, resetView, accessLost]);

  // Read again whenever the tab is shown again.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refresh();
    wasActive.current = active;
  }, [active, refresh]);

  const { snapshot } = read;
  const running = !!snapshot?.reviews.some(review => review.state === "queued" || review.state === "running");
  useEffect(() => {
    if (!active || !running) return;
    const timer = window.setInterval(refresh, RUNNING_RELOAD_MS);
    return () => window.clearInterval(timer);
  }, [active, running, refresh]);

  const indicator: ReviewsTabIndicator = snapshot?.reviews.some(reviewNeedsViewer) ? "attention" : null;
  useEffect(() => { onIndicatorChange?.(indicator); }, [indicator, onIndicatorChange]);
  useEffect(() => () => onIndicatorChange?.(null), [onIndicatorChange]);

  useEffect(() => {
    if (!active) return;
    const focusSearch = (e: KeyboardEvent) => {
      if (!overlayOpen() && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [active]);

  // "Open in Reviews" from another tab: select the PR's Review, reading the list again once when it is not there yet.
  const [pending, setPending] = useState<(ReviewsFocus & { after?: number }) | null>(null);
  const focusNonce = focus?.nonce;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    if (focusNonce !== undefined && focusRef.current) setPending({ ...focusRef.current });
  }, [focusNonce]);
  useEffect(() => {
    if (!pending || read.loading || (!snapshot && !read.error)) return;
    const found = snapshot?.reviews.find(review => review.number === pending.number);
    if (found) {
      setPending(null);
      setNotice("");
      if (found.state === "closed") setShowClosed(true);
      if (!filterReviewList([found], filters, q, true).length) {
        setFilters(EMPTY_REVIEW_FILTERS);
        setQuery("");
      }
      setSelected({ id: found.id, intent: pending.intent });
    } else if (pending.after === undefined) {
      setPending({ ...pending, after: sequence.current });
      refresh();
    } else if (read.request > pending.after) {
      setPending(null);
      if (!read.error) setNotice(`Pull request #${pending.number} has no Keryx review in this list.`);
    }
  }, [pending, snapshot, read, filters, q, refresh]);

  // A mutation in the panel (start, cancel, answer, decision, publication) changes the Review's summary.
  const seenRuns = useRef(new Map<number, string>());
  const observeRuns = useCallback<RunObserver>((key, _revision, runs) => {
    const signature = JSON.stringify(runs.runs.map(run => [run.id, run.state, run.publication ?? null, run.decision?.action ?? null, !!run.result]));
    const previous = seenRuns.current.get(key.number);
    seenRuns.current.set(key.number, signature);
    if (previous !== undefined && previous !== signature) refresh();
  }, [refresh]);

  const visible = useMemo(() => snapshot ? filterReviewList(snapshot.reviews, filters, q, showClosed) : [], [snapshot, filters, q, showClosed]);
  const target = useMemo(() => snapshot ? { repo: snapshot.repo, repositoryId: snapshot.repositoryId, viewer: snapshot.viewer } : null,
    [snapshot?.repo, snapshot?.repositoryId, snapshot?.viewer]);
  const review = selected && snapshot?.reviews.find(item => item.id === selected.id);
  const narrowed = filtersActive(filters) || !!q.trim();
  const closedCount = snapshot?.reviews.filter(item => item.state === "closed").length ?? 0;
  const openReview = useCallback((id: string) => { setNotice(""); setSelected({ id }); }, []);
  const resetFilters = () => { setFilters(EMPTY_REVIEW_FILTERS); setQuery(""); search.current?.focus(); };
  const setFilter = <K extends keyof ReviewFilters>(key: K, value: ReviewFilters[K]) => setFilters(old => ({ ...old, [key]: value }));

  return <div className="review-workspace reviews-workspace" hidden={!active}>
    <section className="flows review-board reviews-board" aria-label="Reviews">
      <div className="flows-toolbar">
        <div className="flows-heading"><h1>Reviews</h1>{snapshot && <span className="count-label">
          {visible.length}<span className="count-word"> {visible.length === 1 ? "review" : "reviews"}</span>
        </span>}</div>
        <label className="search-field"><Icon name="search" size={14} />
          <input ref={search} type="search" aria-label="Search reviews" placeholder="Search by title or #number"
            value={query} onChange={e => setQuery(e.target.value)} />
        </label>
        <select className="select-compact" aria-label="Review state" value={filters.state} disabled={!snapshot}
          onChange={e => setFilter("state", e.target.value as ReviewFilters["state"])}>
          <option value="">All states</option>
          {STATES.map(state => <option key={state} value={state}>{STATE_LABEL[state]}</option>)}
        </select>
        <select className="select-compact" aria-label="Freshness" value={filters.freshness} disabled={!snapshot}
          onChange={e => setFilter("freshness", e.target.value as ReviewFilters["freshness"])}>
          <option value="">Any freshness</option><option value="current">Current</option><option value="behind">Behind</option><option value="unknown">Unknown</option>
        </select>
        <select className="select-compact" aria-label="Source" value={filters.source} disabled={!snapshot}
          onChange={e => setFilter("source", e.target.value as ReviewFilters["source"])}>
          <option value="">Any source</option>
          {(Object.keys(SOURCE_LABEL) as Array<keyof typeof SOURCE_LABEL>).map(source => <option key={source} value={source}>{SOURCE_LABEL[source]}</option>)}
        </select>
        <button className="btn btn-sm" aria-pressed={showClosed} disabled={!snapshot} onClick={() => setShowClosed(value => !value)}
          aria-label="Show closed" title={`Show closed${closedCount ? ` (${closedCount})` : ""}`}>
          <Icon name="archive" size={14} /> <span className="toolbar-label">Show closed</span>
        </button>
        <div className="grow" />
        {active && target && <ProjectReviewRules key={"rules-" + JSON.stringify(target)} cwd={cwd} target={target} command={rulesCommand} onAccessLost={accessLost} />}
        <div className="segmented" role="group" aria-label="Reviews view">
          {(["board", "list"] as const).map(mode => <button key={mode} aria-pressed={view === mode}
            aria-label={mode === "board" ? "Board" : "List"} title={mode === "board" ? "Board" : "List"}
            onClick={() => setView(mode)}><Icon name={mode} size={14} /> <span className="toolbar-label">{mode === "board" ? "Board" : "List"}</span></button>)}
        </div>
        <button className="btn btn-sm" disabled={read.loading} onClick={refresh} aria-label="Refresh reviews" title="Refresh reviews">
          {read.loading ? <Spinner /> : <Icon name="refresh" size={15} />} <span className="toolbar-label">Refresh</span>
        </button>
      </div>
      {snapshot && <div className="review-context">
        <Icon name="branch" size={14} />
        {snapshot.repositories.length > 1 ? <select className="select-compact" aria-label="Base repository" value={snapshot.repo}
          onChange={e => selectRepo(e.target.value)}>{snapshot.repositories.map(name => <option key={name}>{name}</option>)}</select>
          : <strong>{snapshot.repo}</strong>}
        <span>Signed in as {snapshot.viewer}</span>
        <span className="grow" />
        <span>{read.error ? "Last available list" : snapshot.warnings.length ? "Partial list" : "Synced"} <time dateTime={snapshot.fetchedAt}>{absoluteTime(snapshot.fetchedAt)}</time></span>
      </div>}
      {read.error && <div className="inline-banner tone-warn" role="alert">
        <Icon name="alert" size={15} /><span>{snapshot ? "Last available list. " : ""}{plainError(read.error)}</span>
        <button className="btn btn-sm" onClick={refresh}>Try again</button>
      </div>}
      {snapshot && snapshot.warnings.length > 0 && <div className="inline-banner tone-warn" role="status">
        <Icon name="alert" size={15} /><div>{snapshot.warnings.map(warning => <div key={warning}>{warning}</div>)}</div>
      </div>}
      {notice && <p className="inline-banner" role="status">{notice}</p>}
      {!snapshot && read.loading && <div className="review-loading" role="status"><Spinner /> Loading reviews…</div>}
      {active && snapshot && (visible.length ? <ReviewList view={view} reviews={visible} showClosed={showClosed} selectedId={review?.id} onOpen={openReview} />
        : <EmptyState icon={narrowed ? "search" : "checklist"}
          title={narrowed ? "No matching reviews" : snapshot.reviews.length ? "No open reviews" : "No Keryx reviews yet"}
          actions={narrowed ? <button className="btn" onClick={resetFilters}>Reset search and filters</button>
            : !snapshot.reviews.length ? undefined : closedCount && !showClosed ? <button className="btn" onClick={() => setShowClosed(true)}>Show closed</button> : undefined}>
          {narrowed ? "Try another title, number, or filter." : snapshot.reviews.length ? undefined : "Start a review from a pull request; its rounds appear here."}
        </EmptyState>)}
    </section>
    {active && review && target && <ReviewPanel key={review.id} cwd={cwd} target={target} review={review} reviewIntent={selected?.intent}
      flows={flows} reviewModels={reviewModels} runCommand={runCommand} publishCommand={publishCommand} onRunSnapshot={observeRuns}
      onAccessLost={accessLost} onOpenReviewSession={onOpenReviewSession} onOpenFlow={onOpenFlow} onRefresh={refresh}
      onClose={() => setSelected(null)} />}
  </div>;
}

function ReviewFacts({ review }: { review: ReviewSummary }) {
  const findings = findingsLabel(review.findings);
  const publication = publicationLabel(review);
  const freshness = freshnessLabel(review.freshness);
  return <>
    <span className="meta-item">Round {review.latestRound}</span>
    <span className="meta-item"><span className="mono">{reviewedCommit(review)}</span>{freshness && <span className={isBehind(review.freshness) ? "review-behind" : undefined}> · {freshness}</span>}</span>
    {findings && <span className="meta-item">{findings}</span>}
    {publication && <span className="meta-item">{publication}</span>}
    <span className="meta-item">{SOURCE_LABEL[review.source] ?? review.source}</span>
    {review.flowId && <span className="meta-item">Flow #{review.flowId}</span>}
    {review.tokens !== null && <span className="meta-item">{review.tokens.toLocaleString()} tokens</span>}
  </>;
}

function ReviewTile({ review, selected, onOpen }: { review: ReviewSummary; selected: boolean; onOpen: (id: string) => void }) {
  return <article className="flow-card review-summary-card" aria-current={selected || undefined}>
    <button className="review-card" onClick={() => onOpen(review.id)} aria-label={`Open review of #${review.number} ${reviewTitle(review)}`}>
      <span className="flow-card-top"><span className="flow-id">#{review.number}</span><span className="grow" />
        <span className="badge">{STATE_LABEL[review.state] ?? review.state}</span></span>
      <span className="flow-title">{reviewTitle(review)}</span>
      <span className="flow-meta"><span className="meta-item"><Icon name="user" size={12} />{review.card?.author || "Unknown author"}</span></span>
      <span className="flow-meta review-summary-facts"><ReviewFacts review={review} /></span>
    </button>
  </article>;
}

function ReviewLane({ column, reviews, selectedId, onOpen }: { column: ReviewColumn; reviews: ReviewSummary[]; selectedId?: string | undefined; onOpen: (id: string) => void }) {
  return <section className="lane" aria-label={COLUMNS[column]}>
    <header className="lane-head"><span className={"lane-dot reviews-lane-" + column} /><h2>{COLUMNS[column]}</h2><span className="lane-count">{reviews.length}</span></header>
    <div className="lane-body">
      {!reviews.length && <div className="lane-empty">No reviews</div>}
      {reviews.map(review => <ReviewTile key={review.id} review={review} selected={review.id === selectedId} onOpen={onOpen} />)}
    </div>
  </section>;
}

const ReviewList = memo(function ReviewList({ view, reviews, showClosed, selectedId, onOpen }: {
  view: "board" | "list"; reviews: ReviewSummary[]; showClosed: boolean; selectedId?: string | undefined; onOpen: (id: string) => void;
}) {
  if (view === "board") {
    return <div className="board review-lanes reviews-lanes">{groupByColumn(reviews, showClosed).map(([column, items]) =>
      <ReviewLane key={column} column={column} reviews={items} selectedId={selectedId} onOpen={onOpen} />)}</div>;
  }
  return <div className="flow-list-wrap">
    <table className="flow-list review-table reviews-table"><thead><tr>
      <th>Pull request</th><th>Author</th><th>State</th><th>Round</th><th>Reviewed</th><th>Findings</th><th>Publication</th><th>Source</th><th>Flow</th><th>Tokens</th>
    </tr></thead><tbody>{reviews.map(review => <tr key={review.id} aria-current={review.id === selectedId || undefined}>
      <td><button className="review-list-link" onClick={() => onOpen(review.id)}><span className="flow-id">#{review.number}</span> {reviewTitle(review)}</button></td>
      <td>{review.card?.author || "Unknown author"}</td>
      <td>{STATE_LABEL[review.state] ?? review.state}</td>
      <td>{review.latestRound}</td>
      <td><span className="mono">{reviewedCommit(review)}</span> {freshnessLabel(review.freshness)}</td>
      <td>{findingsLabel(review.findings)}</td>
      <td>{publicationLabel(review)}</td>
      <td>{SOURCE_LABEL[review.source] ?? review.source}</td>
      <td>{review.flowId ? `#${review.flowId}` : ""}</td>
      <td>{review.tokens !== null ? review.tokens.toLocaleString() : ""}</td>
    </tr>)}</tbody></table>
  </div>;
});
