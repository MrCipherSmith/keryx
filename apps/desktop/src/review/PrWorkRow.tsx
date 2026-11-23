import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Menu, type MenuItem } from "../components/Menu";
import type { SessionInfo, SessionSubject } from "../acp/types";
import type { FlowCard } from "../platform/commands";
import { boundSessions, flowStage, prFlows, prSubject, reviewSlotState, type SubjectSessionTarget } from "./prWork";
import { reviewNote } from "./model";
import type { ReviewCard } from "./types";

/** What the work row needs from the board: the repository, the project's Flows and sessions, and where its links go. */
export interface PrWork {
  repo: string;
  repositoryId?: string;
  flows: readonly FlowCard[];
  sessions: readonly SessionInfo[];
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
  const sessions = boundSessions(work.sessions, subject);
  const flow = prFlows(card, work.flows, sessions)[0];
  const state = reviewSlotState(card.localReview);
  const canReview = !!state || card.state === "open";
  const reviewText = state ? `Review · ${state}` : "Run review";
  const reviewTitle = state === "outdated" ? reviewNote(card) ?? reviewText : canReview ? reviewText : "Only an open pull request can be reviewed";
  const flowText = flow ? `Flow #${flow.id} · ${flowStage(flow)}` : "Create Flow";
  const sessionText = sessions.length > 1 ? `${sessions.length} sessions` : sessions.length ? "Session" : "Open in session";
  const openSession = work.onOpenSubjectSession;
  const createFlow = work.onCreateFlow;
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const items: MenuItem[] = [
    ...sessions.map((s): MenuItem => ({ id: "s-" + s.sessionId, label: s.title?.trim() || "New session (not saved yet)",
      icon: "chat", onSelect: () => openSession?.(card, s.sessionId, subject) })),
    ...(sessions.length ? [{ kind: "separator" as const, id: "sep" }] : []),
    { id: "new", label: "New session", icon: "plus", onSelect: () => openSession?.(card, "new", subject) },
  ];
  const of = ` for #${card.number}`;
  return <div className="pr-work-row" role="group" aria-label={`Keryx work${of}`}>
    <span className="pr-work-slot" data-slot="review">
      <button type="button" className={"pr-work-link" + (state ? "" : " is-empty")} title={reviewTitle} aria-label={reviewText + of}
        disabled={!canReview} onClick={() => onReview(card)}>{reviewText}</button>
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
      {menu && createPortal(<Menu anchor={more.current} items={items} label={`Sessions${of}`} placement="auto" closeOnScroll
        onClose={() => setMenu(false)} />, document.body)}
    </span>
  </div>;
}
