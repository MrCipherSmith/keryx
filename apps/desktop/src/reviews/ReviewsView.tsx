import type { DeskRun, DeskRunKey } from "../../../../src/review/desk-run-types";
import { reviewNeedsViewer, type ReviewState, type ReviewSummary, type ReviewsSnapshot } from "../../../../src/review/review-entity";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { EmptyState, overlayOpen, Spinner } from "../components/ui";
import { absoluteTime, errMessage } from "../lib/format";
import type { FlowCard } from "../platform/commands";
import { fetchReviews } from "../platform/review";
import { reviewRules } from "../platform/reviewRules";
import { subscribeSessionReview, type reviewRun } from "../platform/reviewRuns";
import { ProjectReviewRules } from "../review/ProjectReviewRules";
import type { ReviewLaunchModel } from "../review/ReviewLaunchDialog";
import type { reviewPublish } from "../review/ReviewPublishDialog";
import type { ReviewCard } from "../review/types";
import type { ReviewIntent } from "../review/ReviewWorkspace";
import type { RunObserver } from "../review/useReviewRuns";
import {
  COLUMNS, EMPTY_REVIEW_FILTERS, filterReviewList, filtersActive, findingsLabel, freshnessLabel, groupByColumn, isBehind, isClosedOrArchived,
  publicationLabel, reviewedCommit, reviewStateLabel, reviewTitle, SOURCE_LABEL, STATE_LABEL, type FixFindingsFlow, type ReviewColumn, type ReviewFilters,
} from "./model";
import { ReviewPanel } from "./ReviewPanel";

/** The Reviews tab lights when a Review waits on the viewer: an answer, a publication decision or a stopped round. */
export type ReviewsTabIndicator = "attention" | null;

/** A request from another tab to show one PR's Review of the named repository; a new nonce repeats it. */
export interface ReviewsFocus { repo: string; repositoryId?: string | undefined; number: number; nonce: number; intent?: ReviewIntent | undefined }

type RulesTarget = Omit<DeskRunKey, "number">;

interface Props {
  cwd: string;
  expectedViewer?: string | undefined;
  /** This tab is shown. The view stays mounted while hidden so the tab indicator stays current. */
  active: boolean;
  focus?: ReviewsFocus | null | undefined;
  /** The view took the focus request: the caller drops it, so a remount (repository or account) cannot replay it. */
  onFocusHandled?: ((nonce: number) => void) | undefined;
  /** Changes when the PR watcher completed a background poll: the list is read again, also while the tab is hidden. */
  reloadSignal?: number | undefined;
  /** The Pull requests board's verified identity: Review rules stay reachable when this list cannot be read. */
  rulesTarget?: RulesTarget | null | undefined;
  onIndicatorChange?: ((indicator: ReviewsTabIndicator) => void) | undefined;
  flows?: readonly FlowCard[] | undefined;
  reviewModels?: readonly ReviewLaunchModel[] | undefined;
  onOpenReviewSession?: ((key: DeskRunKey, run: DeskRun) => Promise<void>) | undefined;
  onOpenFlow?: ((dir: string) => void) | undefined;
  /** "Fix findings" in a Review panel: the PR card, the list's repository (to bind the PR's session) and the prompt to prefill. */
  onFixFindings?: ((card: ReviewCard, repository: { repo: string; repositoryId: string }, prompt: string,
    fixRoundPrompt: (flow: FixFindingsFlow) => string) => void) | undefined;
  load?: typeof fetchReviews;
  runCommand?: typeof reviewRun | undefined;
  publishCommand?: typeof reviewPublish | undefined;
  rulesCommand?: typeof reviewRules;
}

/** While a Review is queued or running, the list is read again this often (shown or hidden tab, not a hidden window). */
export const RUNNING_RELOAD_MS = 60_000;

const STATES: ReviewState[] = ["queued", "running", "needs_answer", "ready", "stopped", "published", "closed"];
const FRESHNESS_LABEL: Record<ReviewFilters["freshness"], string> = { "": "Any freshness", current: "Current", behind: "Behind", unknown: "Unknown" };

interface ReadState {
  snapshot: ReviewsSnapshot | null;
  error: string;
  loading: boolean;
  /** The request that produced this state; a focus request waits for a load started after it. */
  request: number;
}

const accessProblem = (message: string) => /^(access|configuration):/i.test(message);
const plainError = (message: string) => message.replace(/^(access|configuration|unavailable):\s*/i, "");

/** Focus inside a dialog of this view, its Review panel, or a Review rules dialog portaled to the body. */
function inViewOverlay(el: Element | null) {
  if (!el) return false;
  if (el.closest('.reviews-workspace [role="dialog"], .review-panel')) return true;
  return !!el.closest('[role="dialog"]')?.querySelector("[data-review-board-dialog]");
}

interface RepositoryProps {
  repo?: string | undefined;
  /** The viewer picked a base repository: a waiting focus request is dropped. */
  selectRepo: (repo?: string) => void;
  /** A focus request names another repository: show it. */
  focusRepo: (repo: string) => void;
  pending: ReviewsFocus | null;
  settlePending: () => void;
}

export function ReviewsView(props: Props) {
  const [repo, setRepo] = useState<string>();
  // The focus request lives here, above the keyed list: it survives the switch to its repository and is
  // taken once, so neither a remount nor a later repository switch replays it.
  const [pending, setPending] = useState<ReviewsFocus | null>(null);
  const taken = useRef<number>();
  const focusRef = useRef(props.focus);
  focusRef.current = props.focus;
  const handled = useRef(props.onFocusHandled);
  handled.current = props.onFocusHandled;
  const focusNonce = props.focus?.nonce;
  useEffect(() => {
    const request = focusRef.current;
    if (!request || request.nonce === taken.current) return;
    taken.current = request.nonce;
    setPending(request);
    handled.current?.(request.nonce);
  }, [focusNonce]);
  const selectRepo = useCallback((next?: string) => {
    setPending(null);
    setRepo(next);
  }, []);
  const settlePending = useCallback(() => setPending(null), []);
  return <RepositoryReviews key={JSON.stringify([props.cwd, props.expectedViewer?.toLowerCase(), repo])} {...props} repo={repo}
    selectRepo={selectRepo} focusRepo={setRepo} pending={pending} settlePending={settlePending} />;
}

function RepositoryReviews({ cwd, expectedViewer, active, onIndicatorChange, reloadSignal, rulesTarget: boardRules, flows, reviewModels, onOpenReviewSession, onOpenFlow, onFixFindings,
  load = fetchReviews, runCommand, publishCommand, rulesCommand = reviewRules, repo, selectRepo, focusRepo, pending, settlePending }: Props & RepositoryProps) {
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
  const restoreFocus = useRef(false);

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
    // A waiting "Open in Reviews" request goes with the list: a later Try again must not act on it.
    settlePending();
    setRead(old => ({ snapshot: null, error: message, loading: false, request: old.request }));
  }, [resetView, settlePending]);

  useEffect(() => {
    const request = ++sequence.current;
    setRead(old => ({ ...old, loading: true }));
    // Locally closed Reviews' PR cards are read only while they are shown.
    void load(cwd, repo, expectedViewer, showClosed).then(snapshot => {
      if (request !== sequence.current) return;
      const next = JSON.stringify([snapshot.repositoryId, snapshot.viewer.toLowerCase()]);
      // Another account or repository: nothing chosen for the previous one carries over. Focus held by a
      // dialog or the panel that closes with it goes back to search.
      if (identity.current && identity.current !== next) {
        restoreFocus.current = inViewOverlay(document.activeElement);
        resetView();
      }
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
  }, [cwd, repo, expectedViewer, showClosed, attempt, load, resetView, accessLost]);

  useEffect(() => {
    if (restoreFocus.current && !overlayOpen()) search.current?.focus();
    restoreFocus.current = false;
  }, [read]);

  // Read again whenever the tab is shown again.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refresh();
    wasActive.current = active;
  }, [active, refresh]);

  const { snapshot } = read;
  const running = !!snapshot?.reviews.some(review => review.state === "queued" || review.state === "running");
  // The indicator follows a running Review while the tab is hidden too; a hidden window reads for nobody.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") refresh(); }, RUNNING_RELOAD_MS);
    return () => window.clearInterval(timer);
  }, [running, refresh]);
  // A review started or changed from a Session, and a completed PR watcher poll, can change what waits on the viewer.
  useEffect(() => subscribeSessionReview(project => { if (project === cwd) refresh(); }), [cwd, refresh]);
  const lastSignal = useRef(reloadSignal);
  useEffect(() => {
    if (lastSignal.current === reloadSignal) return;
    lastSignal.current = reloadSignal;
    refresh();
  }, [reloadSignal, refresh]);

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

  // "Open in Reviews" from another tab: show its repository, select the PR's Review there, and read the list
  // again once when it is not there yet.
  const [refreshedFor, setRefreshedFor] = useState<{ nonce: number; after: number } | null>(null);
  useEffect(() => {
    if (!pending || read.loading || (!snapshot && !read.error)) return;
    const wanted = pending.repo.toLowerCase();
    const shown = snapshot?.repo.toLowerCase();
    if (shown !== wanted && repo?.toLowerCase() !== wanted) {
      focusRepo(pending.repo);
      return;
    }
    const found = snapshot && shown === wanted && (!pending.repositoryId || snapshot.repositoryId === pending.repositoryId)
      ? snapshot.reviews.find(review => review.number === pending.number) : undefined;
    if (found) {
      settlePending();
      setNotice("");
      if (isClosedOrArchived(found)) setShowClosed(true);
      if (!filterReviewList([found], filters, q, true).length) {
        setFilters(EMPTY_REVIEW_FILTERS);
        setQuery("");
      }
      setSelected({ id: found.id, intent: pending.intent });
    } else if (refreshedFor?.nonce !== pending.nonce) {
      setRefreshedFor({ nonce: pending.nonce, after: sequence.current });
      refresh();
    } else if (read.request > refreshedFor.after) {
      settlePending();
      if (!read.error) setNotice(`Pull request #${pending.number} has no Keryx review in this list.`);
    }
  }, [pending, snapshot, read, filters, q, refresh, repo, focusRepo, settlePending, refreshedFor]);

  // An intent (answer, view, start) is acted on once: after the review interface took it, and when the tab is
  // left, the selection keeps only the Review, so coming back never replays it.
  const consumeIntent = useCallback(() => setSelected(current => current?.intent ? { id: current.id } : current), []);
  useEffect(() => { if (!active) consumeIntent(); }, [active, consumeIntent]);

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
  const fixFindings = useMemo(() => onFixFindings && target
    ? (card: ReviewCard, prompt: string, fixRoundPrompt: (flow: FixFindingsFlow) => string) =>
      onFixFindings(card, { repo: target.repo, repositoryId: target.repositoryId }, prompt, fixRoundPrompt) : undefined,
  [onFixFindings, target]);
  const narrowed = filtersActive(filters) || !!q.trim();
  const closedCount = snapshot?.reviews.filter(isClosedOrArchived).length ?? 0;
  // Review rules from the Pull requests board when this list could not be read (an older CLI, GitHub unavailable).
  const rulesTarget = target ?? (!snapshot && read.error && !accessProblem(read.error) && boardRules &&
    (!expectedViewer || boardRules.viewer.toLowerCase() === expectedViewer.toLowerCase()) &&
    (!repo || boardRules.repo.toLowerCase() === repo.toLowerCase()) ? boardRules : null);
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
          title={filters.state ? STATE_LABEL[filters.state] : "All states"}
          onChange={e => setFilter("state", e.target.value as ReviewFilters["state"])}>
          <option value="">All states</option>
          {STATES.map(state => <option key={state} value={state}>{STATE_LABEL[state]}</option>)}
        </select>
        <select className="select-compact" aria-label="Freshness" value={filters.freshness} disabled={!snapshot}
          title={FRESHNESS_LABEL[filters.freshness]}
          onChange={e => setFilter("freshness", e.target.value as ReviewFilters["freshness"])}>
          {(Object.keys(FRESHNESS_LABEL) as Array<ReviewFilters["freshness"]>).map(kind => <option key={kind} value={kind}>{FRESHNESS_LABEL[kind]}</option>)}
        </select>
        <select className="select-compact" aria-label="Source" value={filters.source} disabled={!snapshot}
          title={filters.source ? SOURCE_LABEL[filters.source] : "Any source"}
          onChange={e => setFilter("source", e.target.value as ReviewFilters["source"])}>
          <option value="">Any source</option>
          {(Object.keys(SOURCE_LABEL) as Array<keyof typeof SOURCE_LABEL>).map(source => <option key={source} value={source}>{SOURCE_LABEL[source]}</option>)}
        </select>
        <button className="btn btn-sm" aria-pressed={showClosed} disabled={!snapshot} onClick={() => setShowClosed(value => !value)}
          aria-label="Show closed" title={`Show closed${closedCount ? ` (${closedCount})` : ""}`}>
          <Icon name="archive" size={14} /> <span className="toolbar-label">Show closed</span>
        </button>
        <div className="grow" />
        {active && rulesTarget && <ProjectReviewRules key={"rules-" + JSON.stringify(rulesTarget)} cwd={cwd} target={rulesTarget} command={rulesCommand} onAccessLost={accessLost} />}
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
    {active && review && target && <ReviewPanel key={review.id} cwd={cwd} target={target} review={review} reviewIntent={selected?.intent} onIntentConsumed={consumeIntent}
      flows={flows} reviewModels={reviewModels} runCommand={runCommand} publishCommand={publishCommand} onRunSnapshot={observeRuns}
      onAccessLost={accessLost} onOpenReviewSession={onOpenReviewSession} onOpenFlow={onOpenFlow} onFixFindings={fixFindings} onRefresh={refresh}
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
    <button className="review-card" onClick={() => onOpen(review.id)}>
      <span className="flow-card-top"><span className="flow-id">#{review.number}</span><span className="grow" />
        <span className="badge">{reviewStateLabel(review)}</span></span>
      <span className="flow-title">{reviewTitle(review)}</span>
      {/* Without its PR card (a closed Review read while Show closed was off) the PR number stands alone. */}
      {review.card && <span className="flow-meta"><span className="meta-item"><Icon name="user" size={12} />{review.card.author || "Unknown author"}</span></span>}
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
      <td>{review.card ? review.card.author || "Unknown author" : ""}</td>
      <td>{reviewStateLabel(review)}</td>
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
