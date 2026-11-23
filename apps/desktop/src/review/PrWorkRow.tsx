import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Menu, type MenuItem } from "../components/Menu";
import type { SessionInfo, SessionSubject } from "../acp/types";
import { flowStage, prSubject, reviewSlotState, type PrWorkIndex, type SubjectSessionTarget } from "./prWork";
import { reviewProgressText } from "./ReviewProgress";
import { reviewNote } from "./model";
import type { ReviewCard } from "./types";

/** What the work row needs from the board: the repository, the indexed Flows and sessions, and where its links go. */
export interface PrWork {
  repo: string;
  repositoryId?: string;
  /** Built once per sessions and Flows change (`prWorkIndex`), shared by every row. */
  index: PrWorkIndex;
  onOpenFlow: (dir: string) => void;
  onCreateFlow?: ((card: ReviewCard, subject: SessionSubject) => void) | undefined;
  onOpenSubjectSession?: ((card: ReviewCard, target: SubjectSessionTarget, subject: SessionSubject) => void) | undefined;
}

/**
 * The Keryx work row of a PR card or list row: three slots in a fixed order (review, Flow, session), the
 * same elements whether a slot holds a link or its labelled action, in a row of fixed height.
 */
export function PrWorkRow({ card, work, onReview }: { card: ReviewCard; work: PrWork; onReview: (card: ReviewCard) => void }) {
  const subject = prSubject(card, work.repo, work.repositoryId);
  const sessions = work.index.sessions(subject);
  const flow = work.index.flows(card, sessions)[0];
  const state = reviewSlotState(card.localReview);
  // A review waiting on the viewer (an answer, a publication decision) gets the warn tone; the text says which.
  const waitsOnViewer = !!(card.localReview?.awaitingAnswer || card.localReview?.publicationPending);
  const canReview = !!state || card.state === "open";
  const reviewText = state ? `Review · ${state}` : "Run review";
  const progress = reviewProgressText(card.localReview);
  const reviewTitle = [state === "outdated" ? reviewNote(card) ?? reviewText : canReview ? reviewText : "Only an open pull request can be reviewed", progress]
    .filter(Boolean).join(" — ");
  const flowText = flow ? `Flow #${flow.id} · ${flowStage(flow)}` : "Create Flow";
  const sessionText = sessions.length > 1 ? `${sessions.length} sessions` : sessions.length ? "Session" : "Open in session";
  const openSession = work.onOpenSubjectSession;
  const createFlow = work.onCreateFlow;
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const of = ` for #${card.number}`;
  return <div className="pr-work-row" role="group" aria-label={`Keryx work${of}`}>
    <span className="pr-work-slot" data-slot="review">
      <button type="button" className={"pr-work-link" + (state ? "" : " is-empty") + (waitsOnViewer ? " is-attention" : "")} title={reviewTitle}
        aria-label={reviewText + of} disabled={!canReview} onClick={() => onReview(card)}>{reviewText}</button>
    </span>
    <span className="pr-work-slot" data-slot="flow">
      <button type="button" className={"pr-work-link" + (flow ? "" : " is-empty")} title={flow ? `${flowText}: ${flow.title}` : flowText}
        aria-label={flowText + of} disabled={!flow && !createFlow}
        onClick={() => flow ? work.onOpenFlow(flow.dir) : createFlow?.(card, subject)}>{flowText}</button>
    </span>
    <span className="pr-work-slot" data-slot="session">
      <button type="button" className={"pr-work-link" + (sessions.length ? "" : " is-empty")} title={sessionText}
        aria-label={sessionText + of} disabled={!openSession} onClick={() => openSession?.(card, "latest", subject)}>{sessionText}</button>
      <button ref={more} type="button" className="pr-work-more" aria-haspopup="menu" aria-expanded={menu}
        aria-label={`More sessions${of}`} title="Sessions of this pull request" disabled={!openSession}
        onClick={() => setMenu(open => !open)}>More</button>
      {/* Portaled: the card's content-visibility contains paint, which would clip a fixed menu inside it. */}
      {menu && createPortal(<Menu anchor={more.current} items={sessionItems(sessions, open => openSession?.(card, open, subject))}
        label={`Sessions${of}`} placement="auto" closeOnScroll onClose={() => setMenu(false)} />, document.body)}
    </span>
  </div>;
}

/** The session menu: the bound sessions, then "New session". Built only while the menu is open. */
function sessionItems(sessions: readonly SessionInfo[], open: (target: SubjectSessionTarget) => void): MenuItem[] {
  return [
    ...sessions.map((s): MenuItem => ({ id: "s-" + s.sessionId, label: s.title?.trim() || "New session (not saved yet)",
      icon: "chat", onSelect: () => open(s.sessionId) })),
    ...(sessions.length ? [{ kind: "separator" as const, id: "sep" }] : []),
    { id: "new", label: "New session", icon: "plus", onSelect: () => open("new") },
  ];
}
