// Flow 464 (AC6): the operator-confirmation cards this shell mirrored to the Telegram topic — each question still
// waiting for a press (with its age and the time left of the 1-hour token), and the recent ones with who pressed.
// Held in memory only: the stores keep the durable record (`confirmedVia`, `pressedBy`, `pressedAt`); this is the
// live view the sidebar, the `/remote-control` status and the `/decisions` modal read.

import type { ApprovalResponse } from "../commands/agent";
import { REMOTE_CARD_TTL_MS } from "../commands/operator-confirm-tools";
import type { RemoteApprovalAnswer } from "../remote/shell-bridge";
import { type ApprovalRaceOutcome, type DockRace, raceApproval } from "./approval-mirror";

/** How many answered cards the view keeps. */
export const ANSWERED_CARDS_KEPT = 5;

export type CardAnswerPlace = "telegram" | "shell" | "withdrawn";

export interface ConfirmationEntry {
  readonly id: number;
  /** The card's title: the question the operator was asked. */
  readonly question: string;
  readonly askedAt: number;
  /** Whether the question reached the topic at all (false: the card says the mirror was not delivered). */
  readonly mirrored: boolean;
  /** Set when the topic leg ended without a press after the card was posted (a dropped stream, the wait running out). */
  readonly topicEnded?: true;
  readonly answered?: {
    readonly place: CardAnswerPlace;
    readonly yes: boolean;
    readonly at: number;
    /** The Telegram user id that pressed, when `place` is `telegram`. */
    readonly pressedBy?: number;
  };
}

export type MirroredCardOutcome =
  | { readonly from: "dock"; readonly result: unknown }
  | { readonly from: "topic"; readonly answer: { readonly decision: string; readonly fromId?: number | undefined } };

export class OperatorConfirmationLog {
  private readonly items: ConfirmationEntry[] = [];
  private nextId = 1;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** A card was put to the operator. Returns the handle for {@link answer}. */
  ask(question: string, mirrored: boolean): number {
    const id = this.nextId++;
    this.items.push({ id, question, askedAt: this.now(), mirrored });
    this.changed();
    return id;
  }

  /** The card was answered (or withdrawn, when the turn stopped). */
  answer(id: number, result: { place: CardAnswerPlace; yes: boolean; pressedBy?: number }): void {
    const at = this.items.findIndex((item) => item.id === id);
    const entry = this.items[at];
    if (entry === undefined || entry.answered !== undefined) return;
    this.items[at] = {
      ...entry,
      answered: { place: result.place, yes: result.yes, at: this.now(), ...(result.pressedBy === undefined ? {} : { pressedBy: result.pressedBy }) },
    };
    const answered = this.items.filter((item) => item.answered !== undefined);
    for (const old of answered.slice(0, Math.max(0, answered.length - ANSWERED_CARDS_KEPT))) {
      this.items.splice(this.items.indexOf(old), 1);
    }
    this.changed();
  }

  /** Settle a mirrored card from how its race ended; no outcome means the race threw, so the card is withdrawn. */
  settle(id: number, outcome: MirroredCardOutcome | undefined, turnAborted: boolean): void {
    if (outcome === undefined) this.answer(id, { place: "withdrawn", yes: false });
    else if (outcome.from === "dock") this.answer(id, { place: turnAborted ? "withdrawn" : "shell", yes: outcome.result !== false });
    else this.answer(id, { place: "telegram", yes: outcome.answer.decision === "allow", ...(outcome.answer.fromId === undefined ? {} : { pressedBy: outcome.answer.fromId }) });
  }

  /** The topic leg did not deliver a card that was logged as mirrored: it no longer waits for a press there. */
  markUndelivered(id: number, reason: "undelivered" | "ended" = "undelivered"): void {
    const at = this.items.findIndex((item) => item.id === id);
    const entry = this.items[at];
    if (entry === undefined || entry.answered !== undefined || !entry.mirrored) return;
    this.items[at] = { ...entry, mirrored: false, ...(reason === "ended" ? { topicEnded: true as const } : {}) };
    this.changed();
  }

  /** Cards waiting for a press in the topic: mirrored, not yet answered and inside the 1-hour token. */
  waiting(): readonly ConfirmationEntry[] {
    const now = this.now();
    return this.items.filter((item) => item.answered === undefined && item.mirrored && now - item.askedAt <= REMOTE_CARD_TTL_MS);
  }

  /** Every card the view holds, waiting first (oldest first), then the answered ones (newest first). */
  entries(): readonly ConfirmationEntry[] {
    const open = this.items.filter((item) => item.answered === undefined);
    const done = this.items.filter((item) => item.answered !== undefined).reverse();
    return [...open, ...done];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** `Complete review X? · asked 3m ago · 57m left of the 1-hour token`. */
export function pendingConfirmationLine(entry: ConfirmationEntry, now: number): string {
  const elapsed = now - entry.askedAt;
  const left = REMOTE_CARD_TTL_MS - elapsed;
  const token = left > 0 ? `${age(left)} left of the 1-hour token` : "Telegram token expired, answer in the shell";
  const where = entry.mirrored ? "" : entry.topicEnded === true ? " · Telegram is no longer waiting for this card, answer in the shell" : " · Telegram mirror not delivered, answer in the shell";
  return `${clip(entry.question, 80)} · asked ${age(elapsed)} ago · ${token}${where}`;
}

/** `Complete review X? · yes · pressed by Telegram user 9 at 12:03:11`. */
export function answeredConfirmationLine(entry: ConfirmationEntry): string {
  const done = entry.answered;
  if (done === undefined) return clip(entry.question, 80);
  const verdict = done.yes ? "yes" : "no";
  if (done.place === "telegram") {
    const who = done.pressedBy === undefined ? "a Telegram user" : `Telegram user ${done.pressedBy}`;
    return `${clip(entry.question, 80)} · ${verdict} · pressed by ${who} at ${clock(done.at)}`;
  }
  if (done.place === "withdrawn") return `${clip(entry.question, 80)} · withdrawn (the turn stopped) at ${clock(done.at)}`;
  return `${clip(entry.question, 80)} · ${verdict} · answered in the shell at ${clock(done.at)}`;
}

/**
 * The lines the surfaces print. No cards, no lines: a surface with nothing to say stays quiet. `heading` is the
 * section title; each card is one line.
 */
export function confirmationLines(entries: readonly ConfirmationEntry[], now: number, heading = "Operator confirmations (Telegram cards)"): string[] {
  if (entries.length === 0) return [];
  const waiting = entries.filter((entry) => entry.answered === undefined);
  const answered = entries.filter((entry) => entry.answered !== undefined);
  const lines = [heading];
  for (const entry of waiting) lines.push(`  waiting  ${pendingConfirmationLine(entry, now)}`);
  for (const entry of answered) lines.push(`  answered ${answeredConfirmationLine(entry)}`);
  return lines;
}

/** The sidebar fragment: `1 card waiting`, or undefined when none waits in the topic. */
export function waitingCardsText(waiting: number): string | undefined {
  if (waiting <= 0) return undefined;
  return `${waiting} card${waiting === 1 ? "" : "s"} waiting`;
}

/** An approval answered in the topic, carrying the pressing Telegram user and the shell's clock when the press arrived. */
export function remoteApproval(fingerprint: string, fromId: number | undefined, now: () => Date = () => new Date()): Extract<ApprovalResponse, { approved: boolean }> {
  return { approved: true, fingerprint, via: "remote", ...(fromId !== undefined ? { pressedBy: fromId } : {}), pressedAt: now().toISOString() };
}

/** A card the topic could not take: logged as not mirrored, answered in the shell, and withdrawn if the turn stopped or the dock threw. */
export async function askUnmirroredCard<V>(log: OperatorConfirmationLog, question: string, turnSignal: AbortSignal, ask: () => Promise<V>): Promise<V> {
  const id = log.ask(question, false);
  let verdict: V | undefined;
  let answered = false;
  try {
    verdict = await ask();
    answered = true;
    return verdict;
  } finally {
    log.answer(id, { place: turnSignal.aborted || !answered ? "withdrawn" : "shell", yes: answered && verdict !== false });
  }
}

/** A card raced between the dock and the topic: logged while it waits, and settled whichever way it ends, a throw included. */
export async function raceMirroredCard<V>(options: {
  log: OperatorConfirmationLog;
  /** The card's title; undefined for a question that is not an operator card (nothing is logged). */
  question: string | undefined;
  turnSignal: AbortSignal;
  dock: (race: DockRace) => Promise<V>;
  topic: (signal: AbortSignal) => Promise<RemoteApprovalAnswer>;
  /** The topic never took the card; the shell tells the operator to answer here. */
  onUndelivered?: () => void;
}): Promise<ApprovalRaceOutcome<V>> {
  const id = options.question === undefined ? undefined : options.log.ask(options.question, true);
  let outcome: ApprovalRaceOutcome<V> | undefined;
  try {
    outcome = await raceApproval({
      turnSignal: options.turnSignal,
      ...(id === undefined
        ? {}
        : {
            onUndelivered: () => {
              options.log.markUndelivered(id);
              options.onUndelivered?.();
            },
            onTopicEnded: () => options.log.markUndelivered(id, "ended"),
          }),
      dock: options.dock,
      topic: options.topic,
    });
    return outcome;
  } finally {
    if (id !== undefined) options.log.settle(id, outcome, options.turnSignal.aborted);
  }
}
