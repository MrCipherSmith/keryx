import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import type { SessionInfo, SessionSubject } from "../acp/types";
import { flowStage, prSubject, reviewSlotState, type PrFlowOffer, type PrWorkIndex, type SubjectSessionTarget } from "./prWork";
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
  /** The new package offered for one of the PR's bound sessions ("Link Flow #<id>?"), if any. */
  flowOffer?: ((bound: readonly SessionInfo[]) => PrFlowOffer | undefined) | undefined;
  onLinkFlowOffer?: ((offer: PrFlowOffer) => void) | undefined;
  onDismissFlowOffer?: ((offer: PrFlowOffer) => void) | undefined;
}

/**
 * The Keryx work row of a PR card or list row: three slots in a fixed order (review, Flow, session), the
 * same elements whether a slot holds a link or its labelled action, in a row of fixed height.
 */
export function PrWorkRow({ card, work, onReview }: { card: ReviewCard; work: PrWork; onReview: (card: ReviewCard) => void }) {
  const subject = prSubject(card, work.repo, work.repositoryId);
  const sessions = work.index.sessions(subject);
  const flow = work.index.flows(card, sessions)[0];
  const offer = flow ? undefined : work.flowOffer?.(sessions);
  const state = reviewSlotState(card.localReview);
  // A review waiting on the viewer (an answer, a publication decision) gets the warn tone; the text says which.
  // Open PRs only, as `needsViewerAttention` counts them for the tab indicator.
  const waitsOnViewer = card.state === "open" && !!(card.localReview?.awaitingAnswer || card.localReview?.publicationPending);
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
  const flowSlot = useRef<HTMLSpanElement>(null);
  // Link and Dismiss remove themselves with the offer: focus then moves to the control that replaces it.
  // A failed Link keeps the offer, so that press no longer waits for it to go.
  const refocusFlow = useRef(false);
  useEffect(() => {
    if (offer?.error) refocusFlow.current = false;
    if (offer || !refocusFlow.current) return;
    refocusFlow.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) flowSlot.current?.querySelector("button")?.focus();
  }, [offer]);
  const of = ` for #${card.number}`;
  return <div className="pr-work-row" role="group" aria-label={`Keryx work${of}`}>
    <span className="pr-work-slot" data-slot="review">
      <button type="button" className={"pr-work-link" + (state ? "" : " is-empty") + (waitsOnViewer ? " is-attention" : "")} title={reviewTitle}
        aria-label={reviewText + of} disabled={!canReview} onClick={() => onReview(card)}>{reviewText}</button>
    </span>
    <span ref={flowSlot} className="pr-work-slot" data-slot="flow">
      {offer ? <FlowOffer offer={offer} of={of} work={work} onAct={() => { refocusFlow.current = true; }} /> :
        <button type="button" className={"pr-work-link" + (flow ? "" : " is-empty")} title={flow ? `${flowText}: ${flow.title}` : flowText}
          aria-label={flowText + of} disabled={!flow && !createFlow}
          onClick={() => flow ? work.onOpenFlow(flow.dir) : createFlow?.(card, subject)}>{flowText}</button>}
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

/**
 * A package that appeared after Create Flow, offered for the PR's session: the link is written only on Link,
 * and Dismiss drops the question. Link carries the state, so it shows even in a narrow slot where its text
 * truncates: "Link Flow #<id> · <title>", "Linking…" while the write runs (both buttons then wait), and
 * "Retry link" in the warn tone after a failure, whose reason is Link's description. Dismiss is an icon.
 * State changes are announced through a polite live region that is there from the offer's first render.
 */
function FlowOffer({ offer, of, work, onAct }: { offer: PrFlowOffer; of: string; work: PrWork; onAct: () => void }) {
  const name = `Flow #${offer.flow.id} · ${offer.flow.title}`;
  const statusId = useId();
  // aria-disabled, not disabled: a disabled button would drop the keyboard focus while the write runs.
  const busy = offer.linking || undefined;
  const reason = !busy && offer.error ? sentence(offer.error) : undefined;
  // The visible label truncates; the rest of the name follows for assistive technology.
  const [label, rest] = busy ? ["Linking…", ` ${name}${of}`] : reason ? ["Retry link", ` ${name}${of}`] : [`Link ${name}`, of];
  const status = busy ? `Linking ${name}…` : reason ? `${name} was not linked: ${reason}` : "";
  const title = busy ? status : reason ? `${status} Press Retry link to try again.`
    : `${name} appeared after Create Flow. Link it to this pull request's session?`;
  return <>
    <button type="button" className={"pr-work-link pr-work-offer" + (reason ? " is-attention" : "")} title={title}
      aria-describedby={statusId} aria-disabled={busy} disabled={!work.onLinkFlowOffer}
      onClick={() => { if (busy) return; onAct(); work.onLinkFlowOffer?.(offer); }}>{label}<span className="sr-only">{rest}</span></button>
    <button type="button" className="pr-work-more pr-work-icon" aria-label={`Dismiss ${name}${of}`} title={`Dismiss ${name}`}
      aria-disabled={busy} disabled={!work.onDismissFlowOffer}
      onClick={() => { if (busy) return; onAct(); work.onDismissFlowOffer?.(offer); }}><Icon name="x" size={12} /></button>
    <span id={statusId} className="sr-only" aria-live="polite">{status}</span>
  </>;
}

/** A reason as a sentence: keryx's reasons may end without a period ("…; retry"), and the next sentence follows. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : trimmed + ".";
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
