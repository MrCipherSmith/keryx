import { memo, useState } from "react";
import { CardReviewProgress } from "./ReviewProgress";
import { Icon } from "../components/Icon";
import { absoluteTime, relativeTime } from "../lib/format";
import { CI_LABEL, DECISION_LABEL, LANES, STATE_LABEL, laneReason, prState, reviewLane, type Lane } from "./model";
import type { ReviewCard } from "./types";

interface ReviewActions {
  onOpen: (number: number) => void;
  onReview: (card: ReviewCard) => void;
}

function ReviewTags({ card }: { card: ReviewCard }) {
  return <span className="review-tags">
    <span className={`badge pr-${card.state}`}>{STATE_LABEL[card.state]}</span>
    {prState(card) === "draft" && <span className="badge">Draft</span>}
    {card.decision && <span className={`badge pr-${card.decision.toLowerCase()}`}>{DECISION_LABEL[card.decision]}</span>}
    {card.reviewers.length > 0 && <span className="badge pr-review_requested" title={card.reviewers.join(", ")}>Review requested</span>}
  </span>;
}

function ReviewAction({ card, onReview }: Pick<ReviewActions, "onReview"> & { card: ReviewCard }) {
  if (card.state !== "open" && !card.localReview?.runState) return null;
  const label = card.localReview?.awaitingAnswer ? "Answer question" : card.localReview?.active ? "View review" : card.localReview?.runState ? "View review result" : "Run review";
  return <button type="button" className="btn btn-sm review-row-action" aria-label={`${label} for #${card.number}`}
    onClick={() => onReview(card)}>{label}</button>;
}

function ReviewTile({ card, onOpen, onReview }: ReviewActions & { card: ReviewCard }) {
  const reason = laneReason(card);
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
      <CardReviewProgress badge={card.localReview} />
      {card.assignees.length > 0 && <span className="review-request">Assigned to {card.assignees.join(", ")}</span>}
      {card.reviewers.length > 0 && <span className="review-request">Requested from {card.reviewers.join(", ")}</span>}
    </button>
    <ReviewAction card={card} onReview={onReview} />
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

export const ReviewResults = memo(function ReviewResults({ cards, view, onOpen, onReview }: ReviewActions & { cards: ReviewCard[]; view: "board" | "list" }) {
  const [limit, setLimit] = useState(150);
  if (view === "board") {
    const lanes: Record<Lane, ReviewCard[]> = { attention: [], review: [], open: [], done: [] };
    for (const card of cards) lanes[reviewLane(card)].push(card);
    return <div className="board review-lanes">{(Object.keys(LANES) as Lane[]).map((lane) =>
      <ReviewLane key={lane} lane={lane} cards={lanes[lane]} onOpen={onOpen} onReview={onReview} />)}</div>;
  }
  return <div className="flow-list-wrap">
    <table className="flow-list review-table"><thead><tr>
      <th>Pull request</th><th>Author</th><th>State</th><th>Reason</th><th>Checks</th><th>Review</th>
    </tr></thead><tbody>{cards.slice(0, limit).map((c) => <tr key={c.number}>
      <td><button className="review-list-link" onClick={() => onOpen(c.number)}><span className="flow-id">#{c.number}</span> {c.title}</button></td>
      <td>{c.author || "Unknown author"}</td><td><ReviewTags card={c} /></td><td title={laneReason(c)}><span className={c.localReview?.active && !c.localReview.awaitingAnswer ? "review-live-state" : undefined}>{laneReason(c)}</span>
        <CardReviewProgress badge={c.localReview} /></td><td><span className={'review-ci ci-' + c.ci}>{CI_LABEL[c.ci]}</span></td>
      <td><ReviewAction card={c} onReview={onReview} /></td>
    </tr>)}</tbody></table>
    {cards.length > limit && <button className="lane-more" onClick={() => setLimit(limit + 150)}>Show more ({cards.length - limit})</button>}
  </div>;
});
