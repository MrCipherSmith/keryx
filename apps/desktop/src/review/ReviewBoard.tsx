import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { EmptyState, overlayOpen, Spinner } from "../components/ui";
import { absoluteTime, errMessage } from "../lib/format";
import type { FlowCard } from "../platform/commands";
import { fetchReviewBoard, fetchReviewRepositories, type fetchReviewDetail } from "../platform/review";
import { runActive, sameRange, type RunObserver } from "./useReviewRuns";
import { reviewRun } from "../platform/reviewRuns";
import type { reviewWatcher } from "../platform/reviewWatcher";
import { ProjectReviewRules } from "./ProjectReviewRules";
import type { reviewRules } from "../platform/reviewRules";
import { ReviewWatcher } from "./ReviewWatcher";
import { ReviewDetail } from "./ReviewDetail";
import { ReviewFilters, filterSummary } from "./ReviewFilters";
import { ReviewResults } from "./ReviewResults";
import { EMPTY_FILTERS, filterReviews, stateQuery } from "./model";
import type { ReviewBoardSnapshot, ReviewBoardState, ReviewCard } from "./types";

interface Props {
  cwd: string;
  flows: FlowCard[];
  onOpenFlow: (dir: string) => void;
  load?: typeof fetchReviewBoard;
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

export function ReviewBoard(props: Props) {
  const [repo, setRepo] = useState<string>();
  return <RepositoryBoard key={JSON.stringify([props.cwd, repo])} {...props} repo={repo} selectRepo={setRepo} />;
}

function RepositoryBoard({ cwd, flows, onOpenFlow, loadDetail, watcherCommand, rulesCommand, runCommand = reviewRun, load = fetchReviewBoard, listRepositories = fetchReviewRepositories, repo, selectRepo }: Props & {
  repo?: string;
  selectRepo: (repo?: string) => void;
}) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [query, setQuery] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [view, setView] = useState<"board" | "list">("board");
  const [selected, setSelected] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const identity = useRef("");
  const sequence = useRef(0);
  // A delayed GitHub refresh can carry older local run badges than a just-finished launch.
  const pendingBadges = useRef<Map<number, Pick<ReviewCard, "baseSha" | "headSha" | "localReview">> | null>(null);
  const restoreFocus = useRef(false);
  const scope = stateQuery(filters.state);
  const [read, setRead] = useState<ReadState>({ scope, snapshot: null, error: "", loading: true });
  const q = useDeferredValue(query);

  const clearPrivateView = useCallback((resetState = false) => {
    restoreFocus.current = !!document.activeElement?.closest('.review-board [role="dialog"]');
    setQuery("");
    setFilters((old) => resetState ? EMPTY_FILTERS : { ...EMPTY_FILTERS, state: old.state });
    setSelected(null);
    setFiltering(false);
  }, []);

  const updateRunSummary = useCallback<RunObserver>((key, revision, runs) => {
    const current = runs.runs.find(run => runActive(run) && run.state !== "queued") ?? runs.runs.find(runActive);
    const active = !!current;
    const roster = current && sameRange(current, revision) ? current.reviewerProgress : undefined;
    const progress = roster && { wave: roster.wave, planned: roster.planned, finished: roster.finished };
    const ready = runs.runs.some(run => run.source !== "existing" && ["completed", "partial", "budget"].includes(run.state)
      && !!run.result && sameRange(run.result.reviewed, revision));
    const localReview = { active, ready, progress };
    if (identity.current === JSON.stringify([key.repositoryId, key.viewer])) {
      pendingBadges.current?.set(key.number, { ...revision, localReview });
    }
    setRead(old => {
      const board = old.snapshot;
      if (!board || key.repositoryId !== board.repositoryId || key.viewer !== board.viewer) return old;
      const card = board.cards.find(c => c.number === key.number);
      if (!card || !sameRange(card, revision)) return old;
      const prior = card.localReview?.progress;
      if (!!card.localReview?.active === active && !!card.localReview?.ready === ready &&
        prior?.wave === progress?.wave && prior?.planned === progress?.planned && prior?.finished === progress?.finished) return old;
      const updated = { ...card, localReview };
      return { ...old, snapshot: { ...board, cards: board.cards.map(c => c === card ? updated : c) } };
    });
  }, []);

  const accessLost = useCallback((message: string) => {
    // A list request started before a denied detail request cannot restore its private snapshot.
    sequence.current++;
    identity.current = "";
    pendingBadges.current = null;
    clearPrivateView();
    setRead((old) => ({ ...old, error: message, snapshot: null, loading: false }));
  }, [clearPrivateView]);

  useEffect(() => {
    const request = ++sequence.current;
    const badges = new Map<number, Pick<ReviewCard, "baseSha" | "headSha" | "localReview">>();
    pendingBadges.current = badges;
    setRead((old) => ({ scope, snapshot: scope === old.scope ? old.snapshot : null, error: "", loading: true }));
    void load(cwd, scope, repo).then((snapshot) => {
      if (request !== sequence.current) return;
      const nextIdentity = JSON.stringify([snapshot.repositoryId, snapshot.viewer]);
      if (identity.current && identity.current !== nextIdentity) {
        clearPrivateView(true);
      } else if (badges.size) {
        snapshot = { ...snapshot, cards: snapshot.cards.map(card => {
          const update = badges.get(card.number);
          return update && sameRange(card, update) ? { ...card, localReview: update.localReview } : card;
        }) };
      }
      pendingBadges.current = null;
      identity.current = nextIdentity;
      setRead({ scope, snapshot, error: "", loading: false });
    }).catch((cause: unknown) => {
      if (request !== sequence.current) return;
      pendingBadges.current = null;
      const message = errMessage(cause);
      if (/^unavailable:/i.test(message)) {
        setRead((old) => ({ scope, snapshot: old.scope === scope ? old.snapshot : null, error: message, loading: false }));
      } else {
        accessLost(message);
      }
    });
    return () => { sequence.current++; };
  }, [cwd, scope, repo, attempt, load, clearPrivateView, accessLost]);

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
  const pollCursor = useRef(0);
  // After the drawer closes, follow known active jobs without reloading the repository's PR pages.
  useEffect(() => {
    if (!snapshot || selected !== null) return;
    const { repo, repositoryId, viewer } = snapshot;
    const active = snapshot.cards.filter(card => card.state === "open" && card.localReview?.active);
    if (!active.length) return;
    let cancelled = false;
    async function poll() {
      if (!document.hidden && !cancelled) {
        const card = active[pollCursor.current++ % active.length]!;
        const key = { number: card.number, repo, repositoryId, viewer };
        try {
          const runs = await runCommand(cwd, key, { kind: "status" });
          if (!cancelled) updateRunSummary(key, card, runs);
        } catch (cause) {
          const message = errMessage(cause);
          if (!cancelled && /^access:/i.test(message)) accessLost(message);
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, 6000);
    }
    let timer = window.setTimeout(poll, 6000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [accessLost, cwd, runCommand, selected, snapshot, updateRunSummary]);
  const needRepositories = read.scope === scope && !!read.error && !snapshot;
  useEffect(() => {
    if (!needRepositories) return;
    let active = true;
    void listRepositories(cwd).then((names) => {
      if (active) setAlternatives(names);
    }).catch(() => { if (active) setAlternatives([]); });
    return () => { active = false; };
  }, [cwd, needRepositories, listRepositories]);
  const visible = useMemo(() => snapshot ? filterReviews(snapshot.cards, filters, q) : [], [snapshot, filters, q]);
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
      <ReviewWatcher key={JSON.stringify(watcherTarget)} cwd={cwd} target={watcherTarget} command={watcherCommand} />
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
        <span>{error ? "Last available snapshot" : "Synced"} <time dateTime={snapshot.fetchedAt}>{absoluteTime(snapshot.fetchedAt)}</time></span>
      </>}
      {needRepositories && alternatives.length > 0 && <select className="select-compact" aria-label="Base repository"
        value={repo ?? ""} onChange={(e) => selectRepo(e.target.value)}>
        <option disabled value="">Choose a repository</option>
        {alternatives.map((name) => <option key={name}>{name}</option>)}
      </select>}
      {!snapshot && repo && <><strong>{repo}</strong><button className="link-btn" onClick={() => selectRepo()}>Use default repository</button></>}
      {active.length > 0 && <div className="review-active-filters">
        {active.map((label) => <span key={label}>{label}</span>)}
        <button className="link-btn" onClick={reset}>Clear filters</button>
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
      load={loadDetail} rulesCommand={rulesCommand} runCommand={runCommand} onRunSnapshot={updateRunSummary} onRefreshBoard={refresh} onAccessLost={accessLost} onOpenFlow={onOpenFlow} onClose={() => setSelected(null)} />}
  </section>;
}
