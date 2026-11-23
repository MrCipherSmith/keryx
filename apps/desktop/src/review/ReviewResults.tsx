import { memo, useState } from "react";
import { CardReviewProgress } from "./ReviewProgress";
import { openPullRequest } from "../platform/commands";
import { useToast } from "../components/Toasts";
import { errMessage } from "../lib/format";
import { reviewUrl } from "./ReviewBrowserLink";
import { Icon } from "../components/Icon";
import { absoluteTime, relativeTime } from "../lib/format";
import { CI_LABEL, DECISION_LABEL, LANES, STATE_LABEL, laneReason, prState, reviewLane, reviewNote, type Lane } from "./model";
import type { ReviewCard } from "./types";

interface ReviewActions {
  onOpen: (number: number) => void;
  onReview: (card: ReviewCard) => void;
  onOpenSession?: (card: ReviewCard) => void;
  onSubscribe?: (card: ReviewCard) => void;
  subscriptions?: ReadonlySet<number>;
}

function ReviewTags({ card }: { card: ReviewCard }) {
  return <span className="review-tags">
    <span className={`badge pr-${card.state}`}>{STATE_LABEL[card.state]}</span>
    {prState(card) === "draft" && <span className="badge">Draft</span>}
    {card.decision && <span className={`badge pr-${card.decision.toLowerCase()}`}>{DECISION_LABEL[card.decision]}</span>}
    {card.reviewers.length > 0 && <span className="badge pr-review_requested" title={card.reviewers.join(", ")}>Review requested</span>}
    {card.state === "open" && card.localReview?.publicationPending && <span className="badge review-publication-pending">Action required</span>}
  </span>;
}

function ReviewAction({ card, onReview, onOpenSession, onSubscribe, subscriptions }: Omit<ReviewActions, "onOpen"> & { card: ReviewCard }) {
  const toast = useToast();
  const href = reviewUrl(card.url);
  const showReview = card.state === "open" || card.localReview?.runState;
  const label = card.localReview?.awaitingAnswer ? "Answer question" : card.localReview?.active ? "View review" :
    card.state === "open" && card.localReview?.publicationPending ? "Review publication" :
    card.localReview?.runState ? "View review result" : card.localReview?.outdated ? "Review changes" : "Run review";
  const browserLabel = `Open PR #${card.number} in browser`;
  const sessionLabel = `Open PR #${card.number} in Sessions`;
  const following = subscriptions?.has(card.number) ?? false;
  const watchLabel = `${following ? "Edit subscription for" : "Subscribe to"} PR #${card.number}`;
  return <div className="card-actions">
    {showReview && <button type="button" className="icon-btn" title={label} aria-label={`${label} for #${card.number}`}
      onClick={() => onReview(card)}><Icon name={card.localReview?.runState ? "checklist" : "play"} size={15} /></button>}
    {onOpenSession && <button type="button" className="icon-btn" aria-label={sessionLabel} title={sessionLabel} onClick={() => onOpenSession(card)}>
      <Icon name="chat" size={15} />
    </button>}
    {href && <a className="icon-btn" href={href} rel="noreferrer" title={browserLabel} aria-label={browserLabel}
      onClick={event => {
        event.preventDefault();
        void openPullRequest(href).catch(error => toast({ level: "error", title: "Could not open pull request", body: errMessage(error) }));
      }}><Icon name="external" size={15} /></a>}
    {onSubscribe && <button type="button" className={`icon-btn${following ? " is-following" : ""}`} aria-haspopup="dialog"
      aria-label={watchLabel} title={watchLabel} onClick={() => onSubscribe(card)}><Icon name="bell" size={15} /></button>}
  </div>;
}

function secondaryNote(card: ReviewCard, reason: string) {
  const note = reviewNote(card);
  return note && note !== reason ? note : null;
}

function ReviewTile({ card, onOpen, ...actions }: ReviewActions & { card: ReviewCard }) {
  const reason = laneReason(card);
  const note = secondaryNote(card, reason);
  return <article className="flow-card">
    <button className="review-card" onClick={() => onOpen(card.number)}>
      <span className="flow-card-top">
        <span className="flow-id">#{card.number}</span>
        <span className="grow" />
        <time className="flow-time" dateTime={card.updatedAt} title={absoluteTime(card.updatedAt)}>{relativeTime(card.updatedAt)}</time>
      </span>
      <span className="flow-title">{card.title}</span>
      <ReviewTags card={card} />
      <span className="flow-meta"><span className="meta-item"><Icon name="user" size={12} />{card.author || "Unknown author"}</span>
        <span className={'review-ci ci-' + card.ci}>{CI_LABEL[card.ci]}</span>
      </span>
      <span className={card.localReview?.active && !card.localReview.awaitingAnswer ? "review-reason review-live-state" : "review-reason"}>{reason}</span>
      {note && <span className="review-note">{note}</span>}
      <CardReviewProgress badge={card.localReview} />
      {card.assignees.length > 0 && <span className="review-request">Assigned to {card.assignees.join(", ")}</span>}
      {card.reviewers.length > 0 && <span className="review-request">Requested from {card.reviewers.join(", ")}</span>}
    </button>
    <ReviewAction card={card} {...actions} />
  </article>;
}

function ReviewLane({ lane, cards, ...actions }: ReviewActions & { lane: Lane; cards: ReviewCard[] }) {
  const [limit, setLimit] = useState(30);
  return <section className="lane" aria-label={LANES[lane]}>
    <header className="lane-head"><span className={'lane-dot review-lane-' + lane} /><h2>{LANES[lane]}</h2><span className="lane-count">{cards.length}</span></header>
    <div className="lane-body">
      {!cards.length && <div className="lane-empty">No pull requests</div>}
      {cards.slice(0, limit).map((card) => <ReviewTile key={card.number} card={card} {...actions} />)}
      {cards.length > limit && <button className="lane-more" onClick={() => setLimit(limit + 30)}>Show more ({cards.length - limit})</button>}
    </div>
  </section>;
}

export const ReviewResults = memo(function ReviewResults({ cards, view, showDone, onOpen, ...actions }: ReviewActions & { cards: ReviewCard[]; view: "board" | "list"; showDone: boolean }) {
  const [limit, setLimit] = useState(150);
  if (view === "board") {
    const lanes: Record<Lane, ReviewCard[]> = { attention: [], review: [], open: [], done: [] };
    for (const card of cards) lanes[reviewLane(card)].push(card);
    const drawn = (Object.keys(LANES) as Lane[]).filter((lane) => lane !== "done" || showDone);
    return <div className="board review-lanes">{drawn.map((lane) =>
      <ReviewLane key={lane} lane={lane} cards={lanes[lane]} onOpen={onOpen} {...actions} />)}</div>;
  }
  return <div className="flow-list-wrap">
    <table className="flow-list review-table"><thead><tr>
      <th>Pull request</th><th>Author</th><th>State</th><th>Reason</th><th>Checks</th><th>Actions</th>
    </tr></thead><tbody>{cards.slice(0, limit).map((c) => <tr key={c.number}>
      <td><button className="review-list-link" onClick={() => onOpen(c.number)}><span className="flow-id">#{c.number}</span> {c.title}</button></td>
      <td>{c.author || "Unknown author"}</td><td><ReviewTags card={c} /></td><td title={laneReason(c)}><span className={c.localReview?.active && !c.localReview.awaitingAnswer ? "review-live-state" : undefined}>{laneReason(c)}</span>
        {secondaryNote(c, laneReason(c)) && <span className="review-note">{secondaryNote(c, laneReason(c))}</span>}
        <CardReviewProgress badge={c.localReview} /></td><td><span className={'review-ci ci-' + c.ci}>{CI_LABEL[c.ci]}</span></td>
      <td><ReviewAction card={c} {...actions} /></td>
    </tr>)}</tbody></table>
    {cards.length > limit && <button className="lane-more" onClick={() => setLimit(limit + 150)}>Show more ({cards.length - limit})</button>}
  </div>;
});
