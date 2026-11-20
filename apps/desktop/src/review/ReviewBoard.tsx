import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { EmptyState, overlayOpen, Spinner } from "../components/ui";
import { absoluteTime, errMessage } from "../lib/format";
import type { FlowCard } from "../platform/commands";
import { fetchReviewBadges, fetchReviewBoard, fetchReviewRepositories, type fetchReviewDetail } from "../platform/review";
import { withRunBackoff } from "./runPolling";
import { localBadge, type LocalBadge } from "../../../../src/review/board-badges";
import { sameRange, type RunObserver } from "./useReviewRuns";
import { reviewRun } from "../platform/reviewRuns";
import type { reviewWatcher } from "../platform/reviewWatcher";
import { ProjectReviewRules } from "./ProjectReviewRules";
import type { reviewRules } from "../platform/reviewRules";
import { ReviewWatcher } from "./ReviewWatcher";
import { ReviewDetail } from "./ReviewDetail";
import { readReplies, subscribeReviewReads } from "./reviewReadState";
import type { ReviewDetailSnapshot } from "./ReviewDetailTypes";
import { mentionsViewer } from "../../../../src/review/board-addressed-replies";
import { ReviewFilters, filterSummary } from "./ReviewFilters";
import { ReviewResults } from "./ReviewResults";
import { EMPTY_FILTERS, filterReviews, stateQuery } from "./model";
import type { ReviewBoardSnapshot, ReviewBoardState, ReviewCard } from "./types";

interface Props {
  cwd: string;
  active?: boolean;
  flows: FlowCard[];
  onOpenFlow: (dir: string) => void;
  load?: typeof fetchReviewBoard;
  loadBadges?: typeof fetchReviewBadges;
  listRepositories?: typeof fetchReviewRepositories;
  loadDetail?: typeof fetchReviewDetail;
  runCommand?: typeof reviewRun;
  watcherCommand?: typeof reviewWatcher;
  rulesCommand?: typeof reviewRules;
}

interface ReadState {
  scope: ReviewBoardState;
  snapshot: ReviewBoardSnapshot | null;
  error: string;
  loading: boolean;
}

function badgesEqual(a: LocalBadge | undefined, b: LocalBadge | undefined) {
  return !!a?.active === !!b?.active && !!a?.ready === !!b?.ready && a?.progress?.wave === b?.progress?.wave
    && a?.progress?.finished === b?.progress?.finished && a?.progress?.planned === b?.progress?.planned;
}

export function ReviewBoard(props: Props) {
  return <ProjectBoard key={props.cwd} {...props} />;
}

interface BoardCache {
  snapshots: Map<ReviewBoardState, ReviewBoardSnapshot>;
  identity: string;
  filters: typeof EMPTY_FILTERS;
}

function ProjectBoard(props: Props) {
  const [repo, setRepo] = useState<string>();
  const cache = useMemo<BoardCache>(() => ({ snapshots: new Map(), identity: "", filters: EMPTY_FILTERS }), [repo]);
  if (props.active === false) return null;
  return <RepositoryBoard cache={cache} key={JSON.stringify([props.cwd, repo])} {...props} repo={repo} selectRepo={setRepo} />;
}

function RepositoryBoard({ cwd, flows, onOpenFlow, loadDetail, watcherCommand, rulesCommand, runCommand = reviewRun, loadBadges = fetchReviewBadges, load = fetchReviewBoard, listRepositories = fetchReviewRepositories, repo, selectRepo, cache }: Props & {
  cache: BoardCache;
  repo?: string;
  selectRepo: (repo?: string) => void;
}) {
  const [filters, setFilters] = useState(cache.filters);
  const [query, setQuery] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [view, setView] = useState<"board" | "list">("board");
  const [selected, setSelected] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const identity = useRef(cache.identity);
  const sequence = useRef(0);
  // A delayed GitHub refresh can carry older local run badges than a just-finished launch.
  const pendingBadges = useRef<Map<number, Pick<ReviewCard, "baseSha" | "headSha" | "localReview">> | null>(null);
  const restoreFocus = useRef(false);
  const scope = stateQuery(filters.state);
  const [read, setRead] = useState<ReadState>({ scope, snapshot: null, error: "", loading: true });
  const q = useDeferredValue(query);

  useEffect(() => {
    cache.filters = filters;
    if (read.snapshot) cache.snapshots.set(read.scope, read.snapshot);
  }, [cache, filters, read]);

  const clearPrivateView = useCallback((resetState = false) => {
    restoreFocus.current = !!document.activeElement?.closest('.review-board [role="dialog"]');
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
    cache.snapshots.clear();
    cache.identity = "";
    pendingBadges.current = null;
    clearPrivateView();
    setRead((old) => ({ ...old, error: message, snapshot: null, loading: false }));
  }, [cache, clearPrivateView]);

  useEffect(() => {
    const request = ++sequence.current;
    const badges = new Map<number, Pick<ReviewCard, "baseSha" | "headSha" | "localReview">>();
    pendingBadges.current = badges;
    setRead(old => scope === old.scope && old.snapshot
      ? { ...old, loading: true }
      : { scope, snapshot: null, error: "", loading: true });
    const controller = new AbortController();
    void load(cwd, scope, repo, controller.signal).then((snapshot) => {
      if (request !== sequence.current) return;
      const nextIdentity = JSON.stringify([snapshot.repositoryId, snapshot.viewer]);
      if (identity.current && identity.current !== nextIdentity) {
        cache.snapshots.clear();
        clearPrivateView(true);
      } else if (badges.size) {
        snapshot = { ...snapshot, cards: snapshot.cards.map(card => {
          const update = badges.get(card.number);
          return update && sameRange(card, update) ? { ...card, localReview: update.localReview } : card;
        }) };
      }
      pendingBadges.current = null;
      setSelected(number => snapshot.cards.some(c => c.number === number) ? number : null);
      cache.identity = nextIdentity;
      identity.current = nextIdentity;
      setRead({ scope, snapshot, error: "", loading: false });
    }).catch((cause: unknown) => {
      if (request !== sequence.current) return;
      pendingBadges.current = null;
      const message = errMessage(cause);
      if (/^unavailable:/i.test(message)) {
        setRead((old) => ({ scope, snapshot: (old.scope === scope ? old.snapshot : null) ?? cache.snapshots.get(scope) ?? null, error: message, loading: false }));
      } else {
        accessLost(message);
      }
    });
    return () => { sequence.current++; controller.abort(); };
  }, [cwd, scope, repo, attempt, load, clearPrivateView, accessLost, cache]);

  useEffect(() => {
    if (restoreFocus.current && !overlayOpen()) search.current?.focus();
    restoreFocus.current = false;
  }, [read]);

  useEffect(() => {
    const focusSearch = (e: KeyboardEvent) => {
      if (!overlayOpen() && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const snapshot = read.scope === scope ? read.snapshot : null;
  useEffect(() => {
    if (!snapshot || selected !== null) return;
    const { repo, repositoryId, viewer } = snapshot;
    const active = snapshot.cards.filter(c => c.state === "open" && c.localReview?.active);
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
  }, [accessLost, cwd, loadBadges, runCommand, selected, snapshot]);
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
    return filterReviews(snapshot.cards, filters, q).map(card => {
      if (!card.addressedReplyIds?.length) return card;
      const readIds = readReplies(snapshot.viewer, snapshot.repositoryId, card.number, card.addressedReplyIds);
      const ids = card.addressedReplyIds.filter(id => !readIds.has(id));
      return ids.length === card.addressedReplyIds.length ? card : { ...card, addressedReplyIds: ids };
    });
  }, [snapshot, filters, q, receiptVersion]);
  const active = filterSummary(filters);
  const card = selected === null ? null : snapshot?.cards.find((c) => c.number === selected);
  const error = read.scope === scope ? read.error : "";
  const loading = read.scope !== scope || read.loading;
  const watcherRepo = snapshot?.repo;
  const watcherRepoId = snapshot?.repositoryId;
  const watcherViewer = snapshot?.viewer;
  const watcherTarget = useMemo(() => watcherRepo && watcherRepoId && watcherViewer
    ? { repo: watcherRepo, repositoryId: watcherRepoId, viewer: watcherViewer } : null, [watcherRepo, watcherRepoId, watcherViewer]);
  const refresh = () => setAttempt((n) => n + 1);
  const reset = () => { setFilters(EMPTY_FILTERS); setQuery(""); };

  return <section className="flows review-board" aria-label="Review">
    <div className="flows-toolbar">
      <div className="flows-heading"><h1>Review</h1>{snapshot && <span className="count-label">
        {visible.length} {visible.length === 1 ? "pull request" : "pull requests"}
      </span>}</div>
      <label className="search-field"><Icon name="search" size={14} />
        <input ref={search} type="search" aria-label="Search pull requests" placeholder="Search by title or #number"
          value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <button className="btn btn-sm" onClick={() => setFiltering(true)} aria-haspopup="dialog">
        <Icon name="checklist" size={14} /> Filters{active.length ? ' (' + active.length + ')' : ''}
      </button>
      <div className="grow" />
      {watcherTarget && <ProjectReviewRules key={"rules-" + JSON.stringify(watcherTarget)} cwd={cwd} target={watcherTarget} command={rulesCommand} onAccessLost={accessLost} />}
      <ReviewWatcher key={JSON.stringify(watcherTarget)} cwd={cwd} target={watcherTarget} command={watcherCommand} onAccessLost={accessLost} />
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
        <span>{error ? "Last available snapshot" : snapshot.warnings.length ? "Partial snapshot" : "Synced"} <time dateTime={snapshot.fetchedAt}>{absoluteTime(snapshot.fetchedAt)}</time></span>
      </>}
      {needRepositories && alternatives.length > 0 && <select className="select-compact" aria-label="Base repository"
        value={repo ?? ""} onChange={(e) => selectRepo(e.target.value)}>
        <option disabled value="">Choose a repository</option>
        {alternatives.map((name) => <option key={name}>{name}</option>)}
      </select>}
      {!snapshot && repo && <><strong>{repo}</strong><button className="link-btn" onClick={() => selectRepo()}>Use default repository</button></>}
      {active.length > 0 && <div className="review-active-filters">
        {active.map((label) => <span key={label}>{label}</span>)}
        <button className="link-btn" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>
      </div>}
    </div>}
    {error && <div className="inline-banner tone-warn" role="alert">
      <Icon name="alert" size={15} /><span>{error.replace(/^(access|configuration|unavailable):\s*/i, "")}</span>
      <button className="btn btn-sm" onClick={refresh}>Try again</button>
    </div>}
    {!!snapshot?.warnings.length && <div className="inline-banner tone-warn" role="status">
      <Icon name="alert" size={15} /><div><strong>Partial sync</strong>{snapshot.warnings.map((w) => <div key={w}>{w}</div>)}</div>
    </div>}
    {!snapshot && loading && <div className="review-loading" role="status"><Spinner /> Loading pull requests…</div>}
    {snapshot && (visible.length ? <ReviewResults view={view} cards={visible} onOpen={setSelected} /> :
      <EmptyState icon={q || active.length ? "search" : "pr"}
        title={q || active.length ? "No matching pull requests" : snapshot.warnings.length ? "No pull requests in the available data" : "No open pull requests"}
        actions={q || active.length ? <button className="btn" onClick={reset}>Reset search and filters</button> : undefined}>
        {q || active.length ? "Try another title, number, or filter." : undefined}
      </EmptyState>)}
    {filtering && <ReviewFilters cards={snapshot?.cards ?? []} filters={filters} onClose={() => setFiltering(false)}
      onApply={(next) => { setFilters(next); setFiltering(false); setSelected(null); }} />}
    {card && snapshot && <ReviewDetail key={JSON.stringify([snapshot.repositoryId, snapshot.viewer, card.number])}
      cwd={cwd} repo={snapshot.repo} repositoryId={snapshot.repositoryId} viewer={snapshot.viewer} card={card}
      flow={flows.find((flow) => flow.prUrl?.replace(/\/$/, "").toLowerCase() === card.url.toLowerCase())}
      load={loadDetail} rulesCommand={rulesCommand} runCommand={runCommand} onRunSnapshot={updateRunSummary} onDiscussionLoaded={noteDiscussion} onRefreshBoard={refresh} onAccessLost={accessLost} onOpenFlow={onOpenFlow} onClose={() => setSelected(null)} />}
  </section>;
}
