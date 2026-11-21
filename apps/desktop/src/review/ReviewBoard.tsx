import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { EmptyState, overlayOpen, Spinner } from "../components/ui";
import { absoluteTime, errMessage } from "../lib/format";
import type { FlowCard } from "../platform/commands";
import { fetchReviewBadges, fetchReviewBoard, fetchReviewRepositories, type fetchReviewDetail } from "../platform/review";
import { withRunBackoff } from "./runPolling";
import { localBadge, type LocalBadge } from "../../../../src/review/board-badges";
import { sameRange, type RunObserver } from "./useReviewRuns";
import { reviewRun, subscribeSessionReview } from "../platform/reviewRuns";
import type { reviewWatcher, ReviewWatcherKey } from "../platform/reviewWatcher";
import { ProjectReviewRules } from "./ProjectReviewRules";
import { reviewRules } from "../platform/reviewRules";
import { PrSubscriptionDialog } from "./PrSubscriptionDialog";
import { ReviewWatcher } from "./ReviewWatcher";
import { ReviewDetail, type ReviewIntent } from "./ReviewDetail";
import { readReplies, subscribeReviewReads } from "./reviewReadState";
import type { ReviewDetailSnapshot } from "./ReviewDetailTypes";
import { mentionsViewer } from "../../../../src/review/board-addressed-replies";
import { ReviewFilters, filterSummary } from "./ReviewFilters";
import { ReviewResults } from "./ReviewResults";
import type { ReviewLaunchModel } from "./ReviewLaunchDialog";
import { readReviewFilters, reviewFilterKey, saveReviewFilters } from "./reviewFilterStorage";
import { EMPTY_FILTERS, filterReviews, stateQuery, type Filters } from "./model";
import type { DeskRun, DeskRunKey } from "../../../../src/review/desk-run-types";
import type { ReviewBoardSnapshot, ReviewCard } from "./types";

export type ReviewTabIndicator = "attention" | "watching" | null;

interface Props {
  cwd: string;
  expectedViewer?: string;
  active?: boolean;
  onIndicatorChange?: (indicator: ReviewTabIndicator, viewer?: string) => void;
  flows: FlowCard[];
  reviewModels?: readonly ReviewLaunchModel[];
  currentRepairModel?: ReviewLaunchModel | undefined;
  onOpenFlow: (dir: string) => void;
  onOpenReviewSession?: (key: DeskRunKey, run: DeskRun) => Promise<void>;
  onOpenSession?: ((card: ReviewCard) => void) | undefined;
  load?: typeof fetchReviewBoard;
  loadBadges?: typeof fetchReviewBadges;
  listRepositories?: typeof fetchReviewRepositories;
  loadDetail?: typeof fetchReviewDetail;
  runCommand?: typeof reviewRun;
  watcherCommand?: typeof reviewWatcher;
  rulesCommand?: typeof reviewRules;
}

interface ReadState {
  scope: string;
  snapshot: ReviewBoardSnapshot | null;
  error: string;
  loading: boolean;
}

function badgesEqual(a: LocalBadge | undefined, b: LocalBadge | undefined) {
  return !!a?.active === !!b?.active && !!a?.ready === !!b?.ready && a?.progress?.wave === b?.progress?.wave
    && a?.awaitingAnswer === b?.awaitingAnswer && a?.publicationPending === b?.publicationPending && a?.lastActivityAt === b?.lastActivityAt
    && a?.runState === b?.runState && a?.progress?.completed === b?.progress?.completed
    && a?.progress?.finished === b?.progress?.finished && a?.progress?.planned === b?.progress?.planned;
}

export function ReviewBoard(props: Props) {
  return <ProjectBoard key={JSON.stringify([props.cwd, props.expectedViewer?.toLowerCase()])} {...props} />;
}

function ProjectBoard(props: Props) {
  const [repo, setRepo] = useState<string>();
  return <RepositoryBoard key={JSON.stringify([props.cwd, repo])} {...props} repo={repo} selectRepo={setRepo} />;
}

function RepositoryBoard({ active: tabActive = true, onIndicatorChange, cwd, expectedViewer, flows, reviewModels, currentRepairModel, onOpenFlow, onOpenSession, onOpenReviewSession, loadDetail, watcherCommand, rulesCommand = reviewRules, runCommand = reviewRun, loadBadges = fetchReviewBadges, load = fetchReviewBoard, listRepositories = fetchReviewRepositories, repo, selectRepo }: Props & {
  repo?: string;
  selectRepo: (repo?: string) => void;
}) {
  const [attentionPrs, setAttentionPrs] = useState<ReadonlySet<number>>(() => new Set());
  const [subscriptionNumber, setSubscriptionNumber] = useState<number | null>(null);
  const [subscriptions, setSubscriptions] = useState<ReadonlySet<number>>(new Set());
  const [watchingTarget, setWatchingTarget] = useState<ReviewWatcherKey | null>(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const snapshots = useRef(new Map<string, ReviewBoardSnapshot>());
  const [query, setQuery] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [dismissedWarning, setDismissedWarning] = useState("");
  const warningId = useId();
  const warningToggle = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<"board" | "list">("board");
  const [selected, setSelected] = useState<{ number: number; reviewIntent?: ReviewIntent } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt(n => n + 1), []);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const identity = useRef("");
  const filterKey = useRef<string>();
  const sequence = useRef(0);
  // A delayed GitHub refresh can carry older local run badges than a just-finished launch.
  const pendingBadges = useRef<Map<number, Pick<ReviewCard, "baseSha" | "headSha" | "localReview">> | null>(null);
  const restoreFocus = useRef(false);
  const state = stateQuery(filters.state);
  const period = filters.updatedWithin;
  const scope = `${state}/${period ?? ""}`;
  const [read, setRead] = useState<ReadState>({ scope, snapshot: null, error: "", loading: true });
  const q = useDeferredValue(query);

  useEffect(() => {
    if (read.snapshot) snapshots.current.set(read.scope, read.snapshot);
  }, [read]);

  const clearPrivateView = useCallback((resetState = false) => {
    setSubscriptions(new Set());
    setSubscriptionNumber(null);
    restoreFocus.current = !!document.activeElement?.closest('.review-workspace [role="dialog"], .review-detail-panel');
    setQuery("");
    setFilters((old) => resetState ? EMPTY_FILTERS : { ...EMPTY_FILTERS, state: old.state });
    setSelected(null);
    setFiltering(false);
  }, []);

  const updateRunSummary = useCallback<RunObserver>((key, revision, runs) => {
    const localReview = localBadge(runs.runs, revision);
    if (identity.current === JSON.stringify([key.repositoryId, key.viewer])) {
      pendingBadges.current?.set(key.number, { ...revision, localReview });
    }
    setRead(old => {
      const board = old.snapshot;
      if (!board || key.repositoryId !== board.repositoryId || key.viewer !== board.viewer) return old;
      const card = board.cards.find(c => c.number === key.number);
      if (!card || !sameRange(card, revision)) return old;
      if (badgesEqual(card.localReview, localReview)) return old;
      const updated = { ...card, localReview };
      return { ...old, snapshot: { ...board, cards: board.cards.map(c => c === card ? updated : c) } };
    });
  }, []);

  useEffect(() => subscribeSessionReview((project, key, snapshot) => {
    if (project !== cwd) return;
    const started = snapshot.runs.find(run => run.id === snapshot.startedRunId);
    if (started) updateRunSummary(key, started, snapshot);
  }), [cwd, updateRunSummary]);

  const noteDiscussion = useCallback((detail: ReviewDetailSnapshot) => {
    const ids = new Set<string>();
    for (const message of [...detail.comments, ...detail.reviews]) {
      if (!message.own && mentionsViewer(message.body, detail.viewer)) ids.add(message.id);
    }
    for (const thread of detail.threads) {
      const ownThread = thread.messages[0]?.own;
      for (const message of thread.messages) {
        if (!message.own && (ownThread || mentionsViewer(message.body, detail.viewer))) ids.add(message.id);
      }
    }
    setRead(old => {
      const board = old.snapshot;
      if (!board || board.viewer !== detail.viewer || board.repositoryId !== detail.repositoryId) return old;
      const card = board.cards.find(c => c.number === detail.number);
      if (!card || card.headSha !== detail.headSha) return old;
      const addressedReplyIds = [...new Set([...(detail.warnings.length ? card.addressedReplyIds ?? [] : []), ...ids])];
      if (JSON.stringify(card.addressedReplyIds ?? []) === JSON.stringify(addressedReplyIds)) return old;
      return { ...old, snapshot: { ...board, cards: board.cards.map(c => c === card ? { ...c, addressedReplyIds } : c) } };
    });
  }, []);

  const accessLost = useCallback((message: string) => {
    // A list request started before a denied detail request cannot restore its private snapshot.
    sequence.current++;
    identity.current = "";
    filterKey.current = undefined;
    snapshots.current.clear();
    setAttentionPrs(new Set());
    setWatchingTarget(null);
    pendingBadges.current = null;
    clearPrivateView();
    setRead((old) => ({ ...old, error: message, snapshot: null, loading: false }));
  }, [clearPrivateView]);

  useEffect(() => {
    const request = ++sequence.current;
    const badges = new Map<number, Pick<ReviewCard, "baseSha" | "headSha" | "localReview">>();
    pendingBadges.current = badges;
    setRead(old => scope === old.scope && old.snapshot
      ? { ...old, loading: true }
      : { scope, snapshot: null, error: "", loading: true });
    const controller = new AbortController();
    const updatedSince = period && new Date(Date.now() - period * 86_400_000).toISOString();
    void load(cwd, state, repo, controller.signal, expectedViewer, updatedSince).then((snapshot) => {
      if (request !== sequence.current) return;
      const nextIdentity = JSON.stringify([snapshot.repositoryId, snapshot.viewer]);
      if (identity.current && identity.current !== nextIdentity) {
        snapshots.current.clear();
        clearPrivateView(true);
      } else if (badges.size) {
        snapshot = { ...snapshot, cards: snapshot.cards.map(card => {
          const update = badges.get(card.number);
          return update && sameRange(card, update) ? { ...card, localReview: update.localReview } : card;
        }) };
      }
      // Closed/merged-only views can retire known requests, but cannot replace the open snapshot.
      const replaceAttention = identity.current !== nextIdentity || (!period && (state === "open" || state === "all"));
      setAttentionPrs(previous => {
        const next = new Set(replaceAttention ? [] : previous);
        for (const card of snapshot.cards) {
          if (card.state === "open" && (card.reviewers.length > 0 || card.decision === "CHANGES_REQUESTED")) next.add(card.number);
          else next.delete(card.number);
        }
        return next;
      });
      const nextFilterKey = reviewFilterKey(cwd, snapshot.repositoryId, snapshot.viewer);
      if (filterKey.current !== nextFilterKey) {
        filterKey.current = nextFilterKey;
        setFilters(readReviewFilters(nextFilterKey));
      }
      pendingBadges.current = null;
      setSelected(current => current && snapshot.cards.some(c => c.number === current.number) ? current : null);
      if (!snapshot.warnings.length) setDismissedWarning("");
      identity.current = nextIdentity;
      setRead(old => {
        const previous = old.snapshot;
        if (previous?.repositoryId === snapshot.repositoryId && previous.viewer === snapshot.viewer) {
          // A card-only refresh has no discussion bodies. Carry known replies for unchanged PRs.
          const replies = new Map(previous.cards.filter(c => c.addressedReplyIds?.length).map(c => [c.number, c]));
          if (replies.size) {
            const cards = snapshot.cards.map(c => {
              const prior = replies.get(c.number);
              return !c.addressedReplyIds && prior?.addressedReplyIds && sameRange(prior, c) && prior.updatedAt === c.updatedAt
                ? { ...c, addressedReplyIds: prior.addressedReplyIds } : c;
            });
            return { scope, snapshot: { ...snapshot, cards }, error: "", loading: false };
          }
        }
        return { scope, snapshot, error: "", loading: false };
      });
    }).catch((cause: unknown) => {
      if (request !== sequence.current) return;
      pendingBadges.current = null;
      const message = errMessage(cause);
      if (/^unavailable:/i.test(message)) {
        setRead((old) => ({ scope, snapshot: (old.scope === scope ? old.snapshot : null) ?? snapshots.current.get(scope) ?? null, error: message, loading: false }));
      } else {
        accessLost(message);
      }
    });
    return () => { sequence.current++; controller.abort(); };
  }, [cwd, expectedViewer, state, period, scope, repo, attempt, load, clearPrivateView, accessLost]);

  useEffect(() => {
    if (restoreFocus.current && !overlayOpen()) search.current?.focus();
    restoreFocus.current = false;
  }, [read]);

  useEffect(() => {
    if (!tabActive) {
      setSelected(null);
      setFiltering(false);
      return;
    }
    const focusSearch = (e: KeyboardEvent) => {
      if (!overlayOpen() && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [tabActive]);

  const snapshot = read.scope === scope ? read.snapshot : null;
  useEffect(() => {
    if (!tabActive || !snapshot || selected !== null) return;
    const { repo, repositoryId, viewer } = snapshot;
    const active = snapshot.cards.filter(c => c.localReview?.active);
    if (!active.length) return;
    let cancelled = false;
    async function poll() {
      if (!document.hidden && !cancelled) {
        try {
          const key = { repo, repositoryId, viewer };
          const result = await withRunBackoff(runCommand, key, true, () => loadBadges(cwd, key, active));
          if (!cancelled && result) {
            const latest = new Map(result.cards.map(card => [card.number, card]));
            if (identity.current === JSON.stringify([repositoryId, viewer])) {
              for (const badge of result.cards) pendingBadges.current?.set(badge.number, badge);
            }
            setRead(old => {
              if (old.snapshot !== snapshot || !old.snapshot) return old;
              let changed = false;
              const cards = old.snapshot.cards.map(card => {
                const badge = latest.get(card.number);
                if (!badge || !sameRange(card, badge) || badgesEqual(card.localReview, badge.localReview)) return card;
                changed = true;
                return { ...card, localReview: badge.localReview };
              });
              return changed ? { ...old, snapshot: { ...old.snapshot, cards } } : old;
            });
          }
        } catch (cause) {
          const message = errMessage(cause);
          if (!cancelled && /^(access|configuration):/i.test(message)) accessLost(message);
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, 6000);
    }
    let timer = window.setTimeout(poll, 6000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [accessLost, cwd, loadBadges, runCommand, selected, snapshot, tabActive]);
  const needRepositories = read.scope === scope && !!read.error && !snapshot;
  useEffect(() => {
    if (!needRepositories) return;
    let active = true;
    void listRepositories(cwd).then((names) => {
      if (active) setAlternatives(names);
    }).catch(() => { if (active) setAlternatives([]); });
    return () => { active = false; };
  }, [cwd, needRepositories, listRepositories]);
  const [receiptVersion, setReceiptVersion] = useState(0);
  const viewer = snapshot?.viewer;
  const repositoryId = snapshot?.repositoryId;
  useEffect(() => {
    if (viewer && repositoryId) return subscribeReviewReads(viewer, repositoryId, undefined, () => setReceiptVersion(n => n + 1));
  }, [viewer, repositoryId]);
  const visible = useMemo(() => {
    if (!snapshot) return [];
    return filterReviews(snapshot.cards, filters, q).sort((a, b) => Number(!!b.localReview?.active) - Number(!!a.localReview?.active)).map(card => {
      if (!card.addressedReplyIds?.length) return card;
      const readIds = readReplies(snapshot.viewer, snapshot.repositoryId, card.number, card.addressedReplyIds);
      const ids = card.addressedReplyIds.filter(id => !readIds.has(id));
      return ids.length === card.addressedReplyIds.length ? card : { ...card, addressedReplyIds: ids };
    });
  }, [snapshot, filters, q, receiptVersion]);
  const active = filterSummary(filters);
  const card = selected === null ? null : snapshot?.cards.find((c) => c.number === selected.number);
  const error = read.scope === scope ? read.error : "";
  const loading = read.scope !== scope || read.loading;
  const warningKey = snapshot?.warnings.length
    ? JSON.stringify([snapshot.repositoryId, snapshot.viewer, [...snapshot.warnings].sort()]) : "";
  const showWarning = !!warningKey && warningKey !== dismissedWarning;
  const watcherRepo = snapshot?.repo;
  const watcherRepoId = snapshot?.repositoryId;
  const watcherViewer = snapshot?.viewer;
  const watcherTarget = useMemo(() => watcherRepo && watcherRepoId && watcherViewer
    ? { repo: watcherRepo, repositoryId: watcherRepoId, viewer: watcherViewer } : null, [watcherRepo, watcherRepoId, watcherViewer]);
  useEffect(() => {
    if (!tabActive || !watcherTarget) {
      setSubscriptionNumber(null);
      return;
    }
    let current = true;
    void rulesCommand(cwd, watcherTarget, { kind: "status" }).then(result => {
      if (current) setSubscriptions(new Set(result.subscriptions?.map(item => item.number)));
    }).catch(() => {});
    return () => { current = false; };
  }, [cwd, rulesCommand, tabActive, watcherTarget]);

  const indicator: ReviewTabIndicator = attentionPrs.size ? "attention" :
    watchingTarget && watcherTarget && watchingTarget.repositoryId === watcherTarget.repositoryId &&
    watchingTarget.viewer === watcherTarget.viewer ? "watching" : null;
  useEffect(() => { onIndicatorChange?.(indicator, viewer); }, [indicator, viewer, onIndicatorChange]);
  useEffect(() => () => onIndicatorChange?.(null), [onIndicatorChange]);

  function applyFilters(next: Filters) {
    setFilters(next);
    if (filterKey.current) saveReviewFilters(filterKey.current, next);
  }
  const reset = () => { applyFilters(EMPTY_FILTERS); setQuery(""); };

  const openDetails = useCallback((number: number) => setSelected({ number }), []);
  const [detailWidth, setDetailWidth] = useState(560);
  const openReview = useCallback((card: ReviewCard) => {
    const kind = card.localReview?.awaitingAnswer ? "answer" : card.localReview?.active || card.localReview?.runState ? "view" : "start";
    setSelected({ number: card.number, reviewIntent: { kind, baseSha: card.baseSha, headSha: card.headSha } });
  }, []);

  return <div className="review-workspace" hidden={!tabActive}>
    <section className="flows review-board" aria-label="Pull requests">
    <div className="flows-toolbar">
      <div className="flows-heading"><h1>Pull requests</h1>{snapshot && <span className="count-label">
        {visible.length} {visible.length === 1 ? "pull request" : "pull requests"}
      </span>}</div>
      <label className="search-field"><Icon name="search" size={14} />
        <input ref={search} type="search" aria-label="Search pull requests" placeholder="Search by title or #number"
          value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <button className="btn btn-sm" disabled={!filterKey.current} onClick={() => setFiltering(true)} aria-haspopup="dialog">
        <Icon name="checklist" size={14} /> Filters{active.length ? ' (' + active.length + ')' : ''}
      </button>
      <div className="grow" />
      {tabActive && watcherTarget && <ProjectReviewRules key={"rules-" + JSON.stringify(watcherTarget)} cwd={cwd} target={watcherTarget} command={rulesCommand} onAccessLost={accessLost} />}
      <ReviewWatcher key={JSON.stringify(watcherTarget)} cwd={cwd} target={watcherTarget} command={watcherCommand} active={tabActive} onPollCompleted={refresh} onWatchingChange={setWatchingTarget} onAccessLost={accessLost} />
      <div className="segmented" role="group" aria-label="Review view">
        {(["board", "list"] as const).map((mode) => <button key={mode} aria-pressed={view === mode}
          onClick={() => setView(mode)}><Icon name={mode} size={14} /> {mode === "board" ? "Board" : "List"}</button>)}
      </div>
      <button className="btn btn-sm" disabled={loading} onClick={refresh} aria-label="Refresh pull requests" title="Refresh pull requests">
        {loading ? <Spinner /> : <Icon name="refresh" size={15} />} Refresh
      </button>
    </div>
    {(snapshot || repo || (needRepositories && alternatives.length > 0) || active.length > 0) && <div className="review-context">
      {snapshot && <>
        <Icon name="branch" size={14} />
        {snapshot.repositories.length > 1 ? <select className="select-compact" aria-label="Base repository" value={snapshot.repo}
          onChange={(e) => selectRepo(e.target.value)}>{snapshot.repositories.map((name) => <option key={name}>{name}</option>)}</select>
          : <strong>{snapshot.repo}</strong>}
        <span>Signed in as {snapshot.viewer}</span>
        <span className="grow" />
        <span>{error ? "Last available snapshot" : warningKey ? "Partial snapshot" : "Synced"} <time dateTime={snapshot.fetchedAt}>{absoluteTime(snapshot.fetchedAt)}</time></span>
        {warningKey && <button ref={warningToggle} className="icon-btn" aria-label="Sync details" title="Sync details"
          aria-expanded={showWarning} aria-controls={warningId} onClick={() => setDismissedWarning(showWarning ? warningKey : "")}>
          <Icon name="info" size={15} />
        </button>}
      </>}
      {needRepositories && alternatives.length > 0 && <select className="select-compact" aria-label="Base repository"
        value={repo ?? ""} onChange={(e) => selectRepo(e.target.value)}>
        <option disabled value="">Choose a repository</option>
        {alternatives.map((name) => <option key={name}>{name}</option>)}
      </select>}
      {!snapshot && repo && <><strong>{repo}</strong><button className="link-btn" onClick={() => selectRepo()}>Use default repository</button></>}
      {active.length > 0 && <div className="review-active-filters">
        <button className="icon-btn" aria-label="Clear filters" title="Clear filters" onClick={() => applyFilters(EMPTY_FILTERS)}>
          <Icon name="clearFilters" size={16} />
        </button>
        {active.map((label) => <span key={label}>{label}</span>)}
      </div>}
    </div>}
    {error && <div className="inline-banner tone-warn" role="alert">
      <Icon name="alert" size={15} /><span>{error.replace(/^(access|configuration|unavailable):\s*/i, "")}</span>
      <button className="btn btn-sm" onClick={refresh}>Try again</button>
    </div>}
    {showWarning && snapshot && <div id={warningId} className="inline-banner tone-warn" role="status">
      <Icon name="alert" size={15} /><div><strong>Partial sync</strong>{snapshot.warnings.map((w) => <div key={w}>{w}</div>)}</div>
      <button className="icon-btn review-dismiss-warning" aria-label="Hide sync details" title="Hide sync details"
        onClick={() => { setDismissedWarning(warningKey); warningToggle.current?.focus(); }}>
        <Icon name="x" size={15} />
      </button>
    </div>}
    {!snapshot && loading && <div className="review-loading" role="status"><Spinner /> Loading pull requests…</div>}
    {tabActive && snapshot && (visible.length ? <ReviewResults view={view} cards={visible} onOpen={openDetails} onReview={openReview} onOpenSession={onOpenSession}
        {...(watcherTarget && { onSubscribe: (item: ReviewCard) => setSubscriptionNumber(item.number), subscriptions })} /> :
      <EmptyState icon={q || active.length ? "search" : "pr"}
        title={q || active.length ? "No matching pull requests" : snapshot.warnings.length ? "No pull requests in the available data" : "No open pull requests"}
        actions={q || active.length ? <button className="btn" onClick={reset}>Reset search and filters</button> : undefined}>
        {q || active.length ? "Try another title, number, or filter." : undefined}
      </EmptyState>)}
    </section>
    {tabActive && watcherTarget && subscriptionNumber !== null && <PrSubscriptionDialog key={subscriptionNumber}
      cwd={cwd} target={watcherTarget} command={rulesCommand} number={subscriptionNumber}
      owned={snapshot?.cards.some(item => item.number === subscriptionNumber && item.state === "open" &&
        item.author.toLowerCase() === watcherTarget.viewer.toLowerCase()) ?? false}
      models={reviewModels} currentModel={currentRepairModel}
      watching={watchingTarget !== null} onAccessLost={accessLost}
      onSaved={numbers => setSubscriptions(new Set(numbers))} onClose={() => setSubscriptionNumber(null)} />}
    {tabActive && filtering && <ReviewFilters cards={snapshot?.cards ?? []} filters={filters} onClose={() => setFiltering(false)}
      onApply={(next) => { applyFilters(next); setFiltering(false); setSelected(null); }} />}
    {tabActive && card && snapshot && <ReviewDetail key={JSON.stringify([snapshot.repositoryId, snapshot.viewer, card.number])}
      cwd={cwd} repo={snapshot.repo} repositoryId={snapshot.repositoryId} viewer={snapshot.viewer} card={card} reviewIntent={selected?.reviewIntent}
      width={detailWidth} onResize={setDetailWidth}
      reviewModels={reviewModels} {...(onOpenReviewSession && { onOpenReviewSession })} onOpenSession={onOpenSession && (() => onOpenSession(card))}
      projectFlows={flows} flow={flows.find((flow) => flow.prUrl?.replace(/\/$/, "").toLowerCase() === card.url.toLowerCase())}
      load={loadDetail} rulesCommand={rulesCommand} runCommand={runCommand} onRunSnapshot={updateRunSummary} onDiscussionLoaded={noteDiscussion} onRefreshBoard={refresh} onAccessLost={accessLost} onOpenFlow={onOpenFlow} onClose={() => setSelected(null)} />}
  </div>;
}
