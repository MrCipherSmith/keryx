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
import type { PrWork } from "./PrWorkRow";
import { prSubject, prWorkIndex, type PrFlowOffer } from "./prWork";
import type { SessionInfo } from "../acp/types";
import { readReviewFilters, readReviewGrouping, reviewFilterKey, saveReviewFilters, saveReviewGrouping } from "./reviewFilterStorage";
import {
  EMPTY_FILTERS, GROUPING_LABEL, QUICK_FILTERS, filterReviews, needsViewerAttention, stateQuery, type Filters, type Grouping, type QuickFilter,
} from "./model";
import type { DeskRun, DeskRunKey } from "../../../../src/review/desk-run-types";
import type { ReviewBoardSnapshot, ReviewCard } from "./types";
import { displayReason } from "../../../../src/integrations/issues-contract";

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
  /** The project's sessions (pending Subject bindings included): the session slot lists those bound to each PR. */
  sessions?: readonly SessionInfo[];
  onOpenSubjectSession?: PrWork["onOpenSubjectSession"];
  onCreateFlow?: PrWork["onCreateFlow"];
  /** New packages offered for linking to PR-bound sessions after Create Flow: the work row asks Link / Dismiss. */
  flowOffers?: readonly PrFlowOffer[];
  onLinkFlowOffer?: PrWork["onLinkFlowOffer"];
  onDismissFlowOffer?: PrWork["onDismissFlowOffer"];
  /**
   * Open this PR's panel on the board of `repo` (compared without case); a new `nonce` opens it again. A
   * `repo` among the board's other repositories is selected first; one the board cannot show gets a notice.
   * Once opened or refused, `onFocusHandled(nonce)` lets the owner clear the request, so a remounted board
   * cannot replay it.
   */
  focus?: { repo: string; number: number; nonce: number } | null;
  onFocusHandled?: (nonce: number) => void;
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
  /** The snapshot is a cached fallback from an earlier visit to this scope, not the result of the latest request. */
  stale?: boolean;
}

export function badgesEqual(a: LocalBadge | undefined, b: LocalBadge | undefined) {
  return !!a?.active === !!b?.active && !!a?.ready === !!b?.ready && a?.progress?.wave === b?.progress?.wave
    && a?.awaitingAnswer === b?.awaitingAnswer && a?.publicationPending === b?.publicationPending
    && a?.runState === b?.runState && a?.outdated?.headSha === b?.outdated?.headSha && a?.outdated?.state === b?.outdated?.state && a?.progress?.completed === b?.progress?.completed
    && a?.progress?.finished === b?.progress?.finished && a?.progress?.planned === b?.progress?.planned;
}

const PORTALED_DIALOG_CONTENT = "[data-review-board-dialog]";
/** Focus inside the workspace dialogs, the detail panel, or the Review rules and PR watcher dialogs portaled to the body. */
function inBoardOverlay(el: Element | null) {
  if (!el) return false;
  if (el.closest('.review-workspace [role="dialog"], .review-detail-panel')) return true;
  return !!el.closest('[role="dialog"]')?.querySelector(PORTALED_DIALOG_CONTENT);
}

function unreadIds(board: ReviewBoardSnapshot, card: ReviewCard) {
  if (!card.addressedReplyIds?.length) return card.addressedReplyIds ?? [];
  const readIds = readReplies(board.viewer, board.repositoryId, card.number, card.addressedReplyIds);
  return card.addressedReplyIds.filter(id => !readIds.has(id));
}
const unreadCount = (board: ReviewBoardSnapshot, card: ReviewCard) => unreadIds(board, card).length;
const attentionNumbers = (board: ReviewBoardSnapshot) =>
  new Set(board.cards.filter(card => needsViewerAttention(card, board.viewer, unreadCount(board, card))).map(card => card.number));
/** A load of this scope holds every open PR, so it replaces the carried attention set. */
const holdsAllOpen = (state: string, period?: number) => !period && (state === "open" || state === "all");
const DEFAULT_SCOPE = `${stateQuery(EMPTY_FILTERS.state)}/`;
const NO_SESSIONS: readonly SessionInfo[] = [];
const NO_OFFERS: readonly PrFlowOffer[] = [];

export function ReviewBoard(props: Props) {
  return <ProjectBoard key={JSON.stringify([props.cwd, props.expectedViewer?.toLowerCase()])} {...props} />;
}

function ProjectBoard(props: Props) {
  const [repo, setRepo] = useState<string>();
  return <RepositoryBoard key={JSON.stringify([props.cwd, repo])} {...props} repo={repo} selectRepo={setRepo} />;
}

function RepositoryBoard({ active: tabActive = true, onIndicatorChange, cwd, expectedViewer, flows, reviewModels, currentRepairModel, onOpenFlow, sessions = NO_SESSIONS, onOpenSubjectSession, onCreateFlow, flowOffers = NO_OFFERS, onLinkFlowOffer, onDismissFlowOffer, focus, onFocusHandled, onOpenReviewSession, loadDetail, watcherCommand, rulesCommand = reviewRules, runCommand = reviewRun, loadBadges = fetchReviewBadges, load = fetchReviewBoard, listRepositories = fetchReviewRepositories, repo, selectRepo }: Props & {
  repo?: string;
  selectRepo: (repo?: string) => void;
}) {
  // Attention entries that outlive one snapshot; the set the tab shows is derived below from this and the shown snapshot.
  const [carriedAttention, setCarriedAttention] = useState<ReadonlySet<number>>(() => new Set());
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
  const [grouping, setGrouping] = useState<Grouping>("status");
  const [selected, setSelected] = useState<{ number: number; reviewIntent?: ReviewIntent } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt(n => n + 1), []);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const search = useRef<HTMLInputElement>(null);
  const identity = useRef("");
  const filterKey = useRef<string>();
  const sequence = useRef(0);
  // The identity whose carried set was last replaced from a load that holds every open PR (open or all, no period).
  const seeded = useRef("");
  const [seedFor, setSeedFor] = useState<{ identity: string } | null>(null);
  // A delayed GitHub refresh can carry older local run badges than a just-finished launch.
  const pendingBadges = useRef<Map<number, Pick<ReviewCard, "baseSha" | "headSha" | "localReview">> | null>(null);
  const restoreFocus = useRef(false);
  const state = stateQuery(filters.state);
  const period = filters.updatedWithin;
  const scope = `${state}/${period ?? ""}`;
  const [read, setRead] = useState<ReadState>({ scope, snapshot: null, error: "", loading: true });
  const latest = useRef(read);
  latest.current = read;
  const q = useDeferredValue(query);

  useEffect(() => {
    if (read.snapshot) snapshots.current.set(read.scope, read.snapshot);
  }, [read]);

  const clearPrivateView = useCallback((resetState = false) => {
    setSubscriptions(new Set());
    setSubscriptionNumber(null);
    restoreFocus.current = inBoardOverlay(document.activeElement);
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
    seeded.current = "";
    filterKey.current = undefined;
    snapshots.current.clear();
    setCarriedAttention(new Set());
    setSeedFor(null);
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
      // The filters this load leaves in place: they decide whether a load of every open PR follows.
      let nextFilters: Filters | undefined;
      if (identity.current && identity.current !== nextIdentity) {
        snapshots.current.clear();
        clearPrivateView(true);
        nextFilters = EMPTY_FILTERS;
      } else if (badges.size) {
        snapshot = { ...snapshot, cards: snapshot.cards.map(card => {
          const update = badges.get(card.number);
          return update && sameRange(card, update) ? { ...card, localReview: update.localReview } : card;
        }) };
      }
      // A card-only refresh has no discussion bodies. Carry known replies for unchanged PRs.
      const previous = latest.current.snapshot;
      if (previous?.repositoryId === snapshot.repositoryId && previous.viewer === snapshot.viewer) {
        const replies = new Map(previous.cards.filter(c => c.addressedReplyIds?.length).map(c => [c.number, c]));
        if (replies.size) {
          snapshot = { ...snapshot, cards: snapshot.cards.map(c => {
            const prior = replies.get(c.number);
            return !c.addressedReplyIds && prior?.addressedReplyIds && sameRange(prior, c) && prior.updatedAt === c.updatedAt
              ? { ...c, addressedReplyIds: prior.addressedReplyIds } : c;
          }) };
        }
      }
      const loaded = snapshot;
      const nextFilterKey = reviewFilterKey(cwd, loaded.repositoryId, loaded.viewer);
      if (filterKey.current !== nextFilterKey) {
        filterKey.current = nextFilterKey;
        nextFilters = readReviewFilters(nextFilterKey);
        setFilters(nextFilters);
        setGrouping(readReviewGrouping(nextFilterKey));
      }
      // Closed/merged-only and period views can retire known requests, but cannot replace the open snapshot:
      // a new identity seen there starts from nothing and gets one open load that only seeds the set.
      if (holdsAllOpen(state, period)) {
        seeded.current = nextIdentity;
        setCarriedAttention(attentionNumbers(loaded));
        setSeedFor(null);
      } else {
        if (identity.current !== nextIdentity) {
          setCarriedAttention(new Set());
          seeded.current = "";
        }
        // Filters reset to an open scope start that load now; a seed would repeat it.
        if (nextFilters && holdsAllOpen(stateQuery(nextFilters.state), nextFilters.updatedWithin)) setSeedFor(null);
        else if (seeded.current !== nextIdentity) setSeedFor(old => old?.identity === nextIdentity ? old : { identity: nextIdentity });
      }
      pendingBadges.current = null;
      setSelected(current => current && loaded.cards.some(c => c.number === current.number) ? current : null);
      if (!loaded.warnings.length) setDismissedWarning("");
      identity.current = nextIdentity;
      setRead({ scope, snapshot: loaded, error: "", loading: false });
    }).catch((cause: unknown) => {
      if (request !== sequence.current) return;
      pendingBadges.current = null;
      const message = errMessage(cause);
      if (/^unavailable:/i.test(message)) {
        setRead((old) => {
          const kept = old.scope === scope ? old.snapshot : null;
          return { scope, snapshot: kept ?? snapshots.current.get(scope) ?? null, stale: kept ? old.stale : true, error: message, loading: false };
        });
      } else {
        accessLost(message);
      }
    });
    return () => { sequence.current++; controller.abort(); };
  }, [cwd, expectedViewer, state, period, scope, repo, attempt, load, clearPrivateView, accessLost]);

  useEffect(() => {
    if (!seedFor) return;
    let current = true;
    const controller = new AbortController();
    void load(cwd, "open", repo, controller.signal, expectedViewer).then((seed) => {
      if (!current) return;
      // An answer for the current, unseeded identity holds all its open PRs, whichever identity asked for it.
      const key = JSON.stringify([seed.repositoryId, seed.viewer]);
      if (identity.current === key && seeded.current !== key) {
        seeded.current = key;
        setCarriedAttention(attentionNumbers(seed));
      }
      // Set only while a seed is in flight: an unseeded identity's next load must be able to ask again.
      setSeedFor(old => old === seedFor ? null : old);
    }).catch(() => {
      // The next successful load of an unseeded identity asks again; no retry from here.
      if (current) setSeedFor(old => old === seedFor ? null : old);
    });
    return () => { current = false; controller.abort(); };
  }, [seedFor, cwd, repo, expectedViewer, load]);

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
    return filterReviews(snapshot.cards, filters, q, snapshot.viewer).map(card => {
      if (!card.addressedReplyIds?.length) return card;
      const ids = unreadIds(snapshot, card);
      return ids.length === card.addressedReplyIds.length ? card : { ...card, addressedReplyIds: ids };
    });
  }, [snapshot, filters, q, receiptVersion]);
  // Receipts and discussion notes change after the load that seeded the carried set, so the shown snapshot is judged here.
  const attentionPrs = useMemo(() => {
    const next = new Set(carriedAttention);
    if (snapshot) {
      for (const c of snapshot.cards) {
        if (needsViewerAttention(c, snapshot.viewer, unreadCount(snapshot, c))) next.add(c.number);
        else next.delete(c.number);
      }
    }
    return next;
  }, [carriedAttention, snapshot, receiptVersion]);
  // Removals seen in the shown snapshot must survive a scope switch to a view that does not replace the set.
  // A cached fallback may predate what later loads observed, so it never writes back.
  const stale = !!read.stale;
  useEffect(() => {
    if (snapshot && !stale && (attentionPrs.size !== carriedAttention.size || [...attentionPrs].some(n => !carriedAttention.has(n)))) setCarriedAttention(attentionPrs);
  }, [snapshot, stale, attentionPrs, carriedAttention]);
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
  const reset = () => { applyFilters(EMPTY_FILTERS); setQuery(""); search.current?.focus(); };
  function toggleQuick(quick: QuickFilter) {
    const next = { ...filters };
    if (next[quick]) delete next[quick];
    else next[quick] = true;
    applyFilters(next);
  }
  function chooseGrouping(next: Grouping) {
    setGrouping(next);
    if (filterKey.current) saveReviewGrouping(filterKey.current, next);
  }
  // The hint counts what its reset shows: hidden cards of this snapshot, plus carried requests only when
  // the reset loads the open scope instead of this fresh one.
  const shownNumbers = new Set(visible.map(c => c.number));
  const cardNumbers = new Set(snapshot?.cards.map(c => c.number));
  const resetLoads = scope !== DEFAULT_SCOPE && !error && !stale;
  const hiddenAttention = snapshot ? [...attentionPrs].filter(n => !shownNumbers.has(n) && (resetLoads || cardNumbers.has(n))).length : 0;
  const hiddenText = `Show ${hiddenAttention} waiting on you`;

  const openDetails = useCallback((number: number) => setSelected({ number }), []);
  const [detailWidth, setDetailWidth] = useState(560);
  const openReview = useCallback((card: ReviewCard) => {
    const kind = card.localReview?.awaitingAnswer ? "answer" : card.localReview?.active || card.localReview?.runState ? "view" : "start";
    setSelected({ number: card.number, reviewIntent: { kind, baseSha: card.baseSha, headSha: card.headSha } });
  }, []);
  // A focus request waits for a snapshot of its repository, then opens the PR's panel once per nonce.
  // Another repository of this board is selected first (the board remounts on it). A repository it cannot
  // show, or a PR missing from the settled list of its repository (its state filtered out, say), is refused
  // with a notice, so the request is not left armed to open the panel later, unasked.
  const focused = useRef<number | null>(null);
  const [focusNotice, setFocusNotice] = useState("");
  useEffect(() => {
    if (!focus || focused.current === focus.nonce || !snapshot) return;
    // Every outcome marks the nonce, sets the notice (empty when the panel opens) and tells the App it is handled.
    const settle = (notice: string) => {
      focused.current = focus.nonce;
      setFocusNotice(notice);
      onFocusHandled?.(focus.nonce);
    };
    if (snapshot.repo.toLowerCase() !== focus.repo.toLowerCase()) {
      const listed = snapshot.repositories.find(name => name.toLowerCase() === focus.repo.toLowerCase());
      if (listed) selectRepo(listed);
      else settle(`${focus.repo}#${focus.number} is not in a repository this board shows (${snapshot.repositories.join(", ") || snapshot.repo}).`);
      return;
    }
    if (!snapshot.cards.some(c => c.number === focus.number)) {
      // A load in flight, or a cached fallback, may still bring the PR in: wait for the settled list.
      if (!loading && !stale) settle(`#${focus.number} is not in the current list of ${snapshot.repo}: its state may be filtered out.`);
      return;
    }
    settle("");
    setSelected({ number: focus.number });
  }, [focus, snapshot, loading, stale, onFocusHandled, selectRepo]);
  const workRepo = snapshot?.repo ?? "";
  // Indexed once per sessions and Flows change; every work row and the PR panel look up the same rule.
  const index = useMemo(() => prWorkIndex(flows, sessions), [flows, sessions]);
  const flowOffer = useMemo(() => {
    if (!flowOffers.length) return undefined;
    const bySession = new Map(flowOffers.map(offer => [offer.sessionId, offer]));
    return (bound: readonly SessionInfo[]) => bound.map(session => bySession.get(session.sessionId)).find(offer => offer !== undefined);
  }, [flowOffers]);
  const work = useMemo<PrWork>(() => ({ repo: workRepo, ...(repositoryId && { repositoryId }), index, onOpenFlow, onCreateFlow, onOpenSubjectSession,
    flowOffer, onLinkFlowOffer, onDismissFlowOffer }),
    [workRepo, repositoryId, index, onOpenFlow, onCreateFlow, onOpenSubjectSession, flowOffer, onLinkFlowOffer, onDismissFlowOffer]);
  const subscribe = useCallback((item: ReviewCard) => setSubscriptionNumber(item.number), []);
  const openPanelSession = (item: ReviewCard) => onOpenSubjectSession
    && (() => onOpenSubjectSession(item, "latest", prSubject(item, workRepo, repositoryId)));
  const panelFlow = (item: ReviewCard) => index.flows(item, index.sessions(prSubject(item, workRepo, repositoryId)))[0];

  return <div className="review-workspace" hidden={!tabActive}>
    <section className="flows review-board" aria-label="Pull requests">
    <div className="flows-toolbar">
      <div className="flows-heading"><h1>Pull requests</h1>{snapshot && <span className="count-label">
        {visible.length}<span className="count-word"> {visible.length === 1 ? "pull request" : "pull requests"}</span>
      </span>}
      {snapshot && hiddenAttention > 0 && <button className="review-hidden-attention" onClick={reset}
        aria-label={hiddenText + " — clears filters and search"} title={hiddenText + " — clears filters and search"}>
        <Icon name="alert" size={13} /> <span className="toolbar-label">{hiddenText}</span><span className="hint-short">{hiddenAttention} hidden</span>
      </button>}</div>
      <label className="search-field"><Icon name="search" size={14} />
        <input ref={search} type="search" aria-label="Search pull requests" placeholder="Search by title or #number"
          value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <button className="btn btn-sm" disabled={!filterKey.current} onClick={() => setFiltering(true)} aria-haspopup="dialog"
        aria-label={"Filters" + (active.length ? " (" + active.length + ")" : "")} title={"Filters" + (active.length ? " (" + active.length + ")" : "")}>
        <Icon name="checklist" size={14} /> <span className="toolbar-label">Filters</span>{active.length > 0 && <span className="filter-count">({active.length})</span>}
      </button>
      <div className="grow" />
      {tabActive && watcherTarget && <ProjectReviewRules key={"rules-" + JSON.stringify(watcherTarget)} cwd={cwd} target={watcherTarget} command={rulesCommand} onAccessLost={accessLost} />}
      <ReviewWatcher key={JSON.stringify(watcherTarget)} cwd={cwd} target={watcherTarget} command={watcherCommand} active={tabActive} onPollCompleted={refresh} onWatchingChange={setWatchingTarget} onAccessLost={accessLost} />
      <div className="segmented" role="group" aria-label="Review view">
        {(["board", "list"] as const).map((mode) => <button key={mode} aria-pressed={view === mode}
          aria-label={mode === "board" ? "Board" : "List"} title={mode === "board" ? "Board" : "List"}
          onClick={() => setView(mode)}><Icon name={mode} size={14} /> <span className="toolbar-label">{mode === "board" ? "Board" : "List"}</span></button>)}
      </div>
      <button className="btn btn-sm" disabled={loading} onClick={refresh} aria-label="Refresh pull requests" title="Refresh pull requests">
        {loading ? <Spinner /> : <Icon name="refresh" size={15} />} <span className="toolbar-label">Refresh</span>
      </button>
    </div>
    {(snapshot || repo || (needRepositories && alternatives.length > 0) || active.length > 0) && <div className="review-context">
      {snapshot && <>
        <Icon name="branch" size={14} />
        {snapshot.repositories.length > 1 ? <select className="select-compact" aria-label="Base repository" value={snapshot.repo}
          onChange={(e) => selectRepo(e.target.value)}>{snapshot.repositories.map((name) => <option key={name}>{name}</option>)}</select>
          : <strong>{snapshot.repo}</strong>}
        <span>Signed in as {snapshot.viewer}</span>
        <div className="review-quick-filters" role="group" aria-label="Quick filters">
          {(Object.keys(QUICK_FILTERS) as QuickFilter[]).map(quick => <button key={quick} type="button" className="btn btn-sm"
            aria-pressed={!!filters[quick]} disabled={!filterKey.current} onClick={() => toggleQuick(quick)}>{QUICK_FILTERS[quick]}</button>)}
        </div>
        {view === "board" && <label className="review-grouping">Group by
          <select className="select-compact" value={grouping} onChange={(e) => chooseGrouping(e.target.value === "role" ? "role" : "status")}>
            {(Object.keys(GROUPING_LABEL) as Grouping[]).map(value => <option key={value} value={value}>{GROUPING_LABEL[value]}</option>)}
          </select>
        </label>}
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
      <Icon name="alert" size={15} /><span>{displayReason(error)}</span>
      <button className="btn btn-sm" onClick={refresh}>Try again</button>
    </div>}
    {focusNotice && <div className="inline-banner tone-warn review-focus-notice" role="status">
      <Icon name="alert" size={15} /><span>{focusNotice}</span>
      <button className="icon-btn" aria-label="Dismiss notice" title="Dismiss notice" onClick={() => { setFocusNotice(""); search.current?.focus(); }}>
        <Icon name="x" size={15} />
      </button>
    </div>}
    {showWarning && snapshot && <div id={warningId} className="inline-banner tone-warn" role="status">
      <Icon name="alert" size={15} /><div><strong>Partial sync</strong>{snapshot.warnings.map((w) => <div key={w}>{w}</div>)}</div>
      <button className="icon-btn review-dismiss-warning" aria-label="Hide sync details" title="Hide sync details"
        onClick={() => { setDismissedWarning(warningKey); warningToggle.current?.focus(); }}>
        <Icon name="x" size={15} />
      </button>
    </div>}
    {!snapshot && loading && <div className="review-loading" role="status"><Spinner /> Loading pull requests…</div>}
    {tabActive && snapshot && (visible.length ? <ReviewResults view={view} cards={visible} grouping={grouping} filters={filters} viewer={snapshot.viewer} onOpen={openDetails} onReview={openReview} work={work}
        {...(watcherTarget && { onSubscribe: subscribe, subscriptions })} /> :
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
      reviewModels={reviewModels} {...(onOpenReviewSession && { onOpenReviewSession })} onOpenSession={openPanelSession(card)}
      projectFlows={flows} flow={panelFlow(card)}
      load={loadDetail} rulesCommand={rulesCommand} runCommand={runCommand} onRunSnapshot={updateRunSummary} onDiscussionLoaded={noteDiscussion} onRefreshBoard={refresh} onAccessLost={accessLost} onOpenFlow={onOpenFlow} onClose={() => setSelected(null)} />}
  </div>;
}
