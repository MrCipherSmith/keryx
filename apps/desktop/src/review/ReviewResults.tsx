import { useState } from "react";
import { ReviewProgress } from "./ReviewProgress";
import { Icon } from "../components/Icon";
import { absoluteTime, relativeTime } from "../lib/format";
import { CI_LABEL, DECISION_LABEL, LANES, STATE_LABEL, laneReason, prState, reviewLane, type Lane } from "./model";
import type { ReviewCard } from "./types";

function ReviewTile({ card, onOpen }: { card: ReviewCard; onOpen: (n: number) => void }) {
  const reason = laneReason(card);
  return <button className="flow-card review-card" onClick={() => onOpen(card.number)}>
    <span className="flow-card-top">
      <span className="flow-id">#{card.number}</span>
      <span className="review-state">{STATE_LABEL[prState(card)]}</span>
      <span className="grow" />
      <time className="flow-time" dateTime={card.updatedAt} title={absoluteTime(card.updatedAt)}>{relativeTime(card.updatedAt)}</time>
    </span>
    <span className="flow-title">{card.title}</span>
    <span className="flow-meta"><span className="meta-item"><Icon name="user" size={12} />{card.author}</span>
      <span className={'review-ci ci-' + card.ci}>{CI_LABEL[card.ci]}</span>
    </span>
    <span className={card.localReview?.active ? "review-reason review-live-state" : "review-reason"}>{reason}</span>
    {card.localReview?.active && <ReviewProgress active progress={card.localReview.progress} />}
    {card.decision && DECISION_LABEL[card.decision] !== reason && <span className="review-request">{DECISION_LABEL[card.decision]}</span>}
    {card.assignees.length > 0 && <span className="review-request">Assigned to {card.assignees.join(", ")}</span>}
    {card.reviewers.length > 0 && <span className="review-request">Requested from {card.reviewers.join(", ")}</span>}
  </button>;
}

function ReviewLane({ lane, cards, onOpen }: { lane: Lane; cards: ReviewCard[]; onOpen: (n: number) => void }) {
  const [limit, setLimit] = useState(30);
  return <section className="lane" aria-label={LANES[lane]}>
    <header className="lane-head"><span className={'lane-dot review-lane-' + lane} /><h2>{LANES[lane]}</h2><span className="lane-count">{cards.length}</span></header>
    <div className="lane-body">
      {!cards.length && <div className="lane-empty">No pull requests</div>}
      {cards.slice(0, limit).map((card) => <ReviewTile key={card.number} card={card} onOpen={onOpen} />)}
      {cards.length > limit && <button className="lane-more" onClick={() => setLimit(limit + 30)}>Show more ({cards.length - limit})</button>}
    </div>
  </section>;
}

export function ReviewResults({ cards, view, onOpen }: { cards: ReviewCard[]; view: "board" | "list"; onOpen: (n: number) => void }) {
  const [limit, setLimit] = useState(150);
  if (view === "board") {
    const lanes: Record<Lane, ReviewCard[]> = { attention: [], review: [], open: [], done: [] };
    for (const card of cards) lanes[reviewLane(card)].push(card);
    return <div className="board review-lanes">{(Object.keys(LANES) as Lane[]).map((lane) =>
      <ReviewLane key={lane} lane={lane} cards={lanes[lane]} onOpen={onOpen} />)}</div>;
  }
  return <div className="flow-list-wrap">
    <table className="flow-list review-table"><thead><tr>
      <th>Pull request</th><th>Author</th><th>State</th><th>Reason</th><th>Checks</th>
    </tr></thead><tbody>{cards.slice(0, limit).map((c) => <tr key={c.number}>
      <td><button className="review-list-link" onClick={() => onOpen(c.number)}><span className="flow-id">#{c.number}</span> {c.title}</button></td>
      <td>{c.author}</td><td>{STATE_LABEL[prState(c)]}</td><td title={laneReason(c)}><span className={c.localReview?.active ? "review-live-state" : undefined}>{laneReason(c)}</span>
        {c.localReview?.active && <ReviewProgress active progress={c.localReview.progress} />}</td><td><span className={'review-ci ci-' + c.ci}>{CI_LABEL[c.ci]}</span></td>
    </tr>)}</tbody></table>
    {cards.length > limit && <button className="lane-more" onClick={() => setLimit(limit + 150)}>Show more ({cards.length - limit})</button>}
  </div>;
}
