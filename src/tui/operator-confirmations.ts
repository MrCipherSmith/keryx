// Flow 464 (AC6): the operator-confirmation cards this shell mirrored to the Telegram topic — each question still
// waiting for a press (with its age and the time left of the 1-hour token), and the recent ones with who pressed.
// Held in memory only: the stores keep the durable record (`confirmedVia`, `pressedBy`, `pressedAt`); this is the
// live view the sidebar, the `/remote-control` status and the `/decisions` modal read.

import { REMOTE_CARD_TTL_MS } from "../commands/operator-confirm-tools";

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
  readonly answered?: {
    readonly place: CardAnswerPlace;
    readonly yes: boolean;
    readonly at: number;
    /** The Telegram user id that pressed, when `place` is `telegram`. */
    readonly pressedBy?: number;
  };
}

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

  /** The topic leg did not deliver a card that was logged as mirrored: it no longer waits for a press there. */
  markUndelivered(id: number): void {
    const at = this.items.findIndex((item) => item.id === id);
    const entry = this.items[at];
    if (entry === undefined || entry.answered !== undefined || !entry.mirrored) return;
    this.items[at] = { ...entry, mirrored: false };
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
  const where = entry.mirrored ? "" : " · Telegram mirror not delivered, answer in the shell";
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
