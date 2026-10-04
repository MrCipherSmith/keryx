// Flow 403: the contract of work intake. Every other part (cards, button actions, the hub route, the
// TUI surfaces) imports its types from here and from nowhere else in `src/intake`.
//
// Three stores, three jobs:
//   - the CARD REGISTRY (`cards.json`) holds what a card says: titles, links, the assessment. It is the
//     only place that text lives, and the only thing an action reads to learn WHAT to do (never the press);
//   - the LEDGER (`ledger.jsonl`) holds what happened to a card: one appended line per state change,
//     no texts, so its export carries none;
//   - the STATE (`state.json`) holds what the poll has already seen.

import type { GhAccount } from "../scheduler/digest-gh";

/** The five kinds of event a poll raises. */
export const INTAKE_EVENT_KINDS = ["issue", "review", "ci", "comment", "board"] as const;
export type IntakeEventKind = (typeof INTAKE_EVENT_KINDS)[number];

/** `overflow` is the single "ещё N событий" card; it carries no buttons and no event of its own. */
export type IntakeCardKind = IntakeEventKind | "overflow";

/** Everything a button can ask for. The press carries one of these codes; the registry decides what it does. */
export const INTAKE_ACTIONS = ["take", "decline", "later", "review-flow", "skip", "ci-triage", "ignore", "understood"] as const;
export type IntakeAction = (typeof INTAKE_ACTIONS)[number];

/** The buttons of a card, and the closed set the assessor may suggest from, per kind. */
export const INTAKE_ACTIONS_BY_KIND: Readonly<Record<IntakeEventKind, readonly IntakeAction[]>> = {
  issue: ["take", "decline", "later"],
  review: ["review-flow", "skip"],
  ci: ["ci-triage", "ignore"],
  comment: ["understood"],
  board: ["understood"],
};

/**
 * `queued` made, not yet sent (quiet hours, hourly limit, delivery retry) · `sent` waiting for the human ·
 * `collapsed` folded into an overflow card · `taking` a press was accepted and the action is running ·
 * `taken` the action finished · `decided` a decision without an action (decline, skip, later, ...) ·
 * `failed` the action failed and may be pressed again · `expired` the buttons ran out · `undelivered` delivery gave up.
 */
export const INTAKE_CARD_STATES = ["queued", "sent", "collapsed", "taking", "taken", "decided", "failed", "expired", "undelivered"] as const;
export type IntakeCardState = (typeof INTAKE_CARD_STATES)[number];

/** One thing that happened on GitHub or on the board. `key` is stable across polls. */
export interface IntakeEvent {
  /** `issue:<repo>#<n>`, `review:<repo>#<n>`, `ci:<repo>:<runId>`, `comment:<repo>#<n>:<commentId>`, `board:<id>`. */
  readonly key: string;
  readonly kind: IntakeEventKind;
  readonly repo?: string;
  /** The number, run id, comment id or board id the key is built from. */
  readonly ref: string;
  readonly title: string;
  readonly url?: string;
  /** `updatedAt` (a run's `createdAt`, a comment's `createdAt`, a board entry's `status|closedAt|verdict`). */
  readonly stamp: string;
  readonly author?: string;
  /** Untrusted text for the assessor only: a ticket body or a comment. Never stored. */
  readonly body?: string;
}

/** What the registry keeps of a card. The only home of texts. */
export interface IntakeCardContent {
  readonly id: string;
  readonly eventKey: string;
  /** The stamp of the event this card reported (a board entry may report again when it moves). */
  readonly stamp: string;
  readonly kind: IntakeCardKind;
  readonly repo?: string;
  readonly ref: string;
  readonly title: string;
  readonly url?: string;
  /** Up to 400 characters, or absent when the assessment was unavailable. */
  readonly assessment?: string;
  /** From the closed set of the kind, or absent. */
  readonly suggestion?: IntakeAction;
  /** The buttons, in order. `take` is missing on a work-account card unless the config enables it. */
  readonly actions: readonly IntakeAction[];
  readonly takeAllowed: boolean;
  readonly account: GhAccount;
  readonly createdAt: string;
  /** The buttons stop working at this time. */
  readonly expiresAt: string;
  /** An overflow card: the ids of the cards it folded. */
  readonly collapsedIds?: readonly string[];
}

/** One line of `ledger.jsonl`. Never holds a title, a body or an assessment. */
export interface IntakeLedgerRecord {
  readonly v: 1;
  readonly at: string;
  readonly cardId: string;
  readonly eventKey: string;
  readonly kind: IntakeCardKind;
  readonly state: IntakeCardState;
  readonly suggestion?: IntakeAction;
  readonly choice?: IntakeAction;
  /** A Telegram user id, or `tui`. */
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly timeToAnswerMs?: number;
  readonly flowId?: string;
  readonly chatId?: string;
  readonly messageId?: string;
  /** A short machine-written reason (a failure, a gave-up delivery). Never copied from GitHub. */
  readonly reason?: string;
  readonly collapsedInto?: string;
  /** When `later` should bring the card back. */
  readonly remindAt?: string;
}

/** States in which a human decision can still arrive (a press, or the TUI). */
export const INTAKE_OPEN_STATES: readonly IntakeCardState[] = ["sent", "collapsed", "failed"];

/**
 * A card as the ledger folds it, without any text. A record that puts a card back in `queued` or `sent`
 * starts it over: the decision fields (`choice`, `decidedBy`, `decidedAt`, `timeToAnswerMs`, `remindAt`) are
 * cleared and `sentAt` is the latest send, so `timeToAnswerMs` is measured from the send the human saw.
 */
export interface IntakeLedgerCard {
  readonly cardId: string;
  readonly eventKey: string;
  readonly kind: IntakeCardKind;
  readonly state: IntakeCardState;
  readonly suggestion?: IntakeAction;
  readonly choice?: IntakeAction;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly timeToAnswerMs?: number;
  readonly flowId?: string;
  readonly chatId?: string;
  readonly messageId?: string;
  readonly reason?: string;
  readonly collapsedInto?: string;
  readonly remindAt?: string;
  /** True once a `later` reminder brought the card back: it is brought back at most once. */
  readonly reminded: boolean;
  readonly createdAt: string;
  readonly sentAt?: string;
  readonly updatedAt: string;
}

/** A card as the surfaces see it: the registry content plus the ledger's latest word. */
export interface IntakeCardView extends IntakeCardContent {
  readonly state: IntakeCardState;
  readonly choice?: IntakeAction;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly timeToAnswerMs?: number;
  readonly flowId?: string;
  readonly chatId?: string;
  readonly messageId?: string;
  readonly reason?: string;
  readonly collapsedInto?: string;
  readonly remindAt?: string;
  readonly reminded: boolean;
  readonly sentAt?: string;
  readonly updatedAt: string;
}

export interface IntakeQuietHours {
  /** Local hour 0-23 the quiet period starts at (inclusive). */
  readonly startHour: number;
  /** Local hour 0-23 it ends at (exclusive). A start later than the end wraps midnight. */
  readonly endHour: number;
}

export interface IntakeConfig {
  readonly enabled: boolean;
  /** `owner/name` of every repository to poll. */
  readonly repos: readonly string[];
  readonly intervalMinutes: number;
  /** The service topic the cards go to. */
  readonly topic: string;
  readonly quietHours: IntakeQuietHours;
  readonly cardsPerHour: number;
  readonly buttonTtlHours: number;
  /** «Позже» brings the card back once, after this many hours outside quiet hours. */
  readonly laterHours: number;
  /** Model spend per poll run, in USD. */
  readonly budgetUsd: number;
  readonly maxSeconds: number;
  readonly memoryLimitMb: number;
  /** Rows asked of each gh list call. */
  readonly rows: number;
  /** Allow the «Взять в работу» button on a project under the work root. */
  readonly allowTakeInWork: boolean;
}

/** What the poll remembers between runs. */
export interface IntakeState {
  readonly version: 1;
  readonly paused: boolean;
  /** item key -> stamp, for everything the poll has reported or baselined. */
  readonly seen: Readonly<Record<string, string>>;
  /** Sources (`issue:<repo>`, `board`, ...) that were read once without error: their first read was the baseline. */
  readonly baselined: readonly string[];
  readonly lastPollAt?: string;
  readonly lastRun?: IntakeRunSummary;
  /** card id -> delivery retry bookkeeping. */
  readonly delivery: Readonly<Record<string, { readonly attempts: number; readonly nextAt: string }>>;
  /** The last status line sent to the topic, so an unchanged one is not repeated within the hour. */
  readonly lastStatus?: { readonly text: string; readonly at: string };
  /** The most recent poll events, newest last, for the events tab. */
  readonly recent: readonly IntakeRecentEvent[];
}

export interface IntakeRecentEvent {
  readonly at: string;
  readonly key: string;
  readonly kind: IntakeEventKind;
  /** The card the event produced. */
  readonly cardId: string;
}

export type IntakeRunOutcome = "ok" | "failed" | "skipped";

export interface IntakeFailure {
  /** `issue:<repo>`, `review:<repo>`, `comment:<repo>`, `ci:<repo>`, `board`, `gh`, `model`, `delivery`. */
  readonly source: string;
  readonly detail: string;
}

export interface IntakeRunSummary {
  readonly runId: string;
  readonly at: string;
  readonly outcome: IntakeRunOutcome;
  readonly detail: string;
  readonly newEvents: number;
  readonly cards: number;
  readonly failures: number;
}

/** Why a poll did not run, or was stopped. */
export type IntakeStopReason = "timeout" | "memory" | "spend";

export interface IntakePollResult {
  readonly runId: string;
  readonly outcome: IntakeRunOutcome;
  readonly detail: string;
  /** True when every source this run read was read for the first time: nothing was reported. */
  readonly baseline: boolean;
  /** Events found this run that had not been seen. Baselined ones are not counted. */
  readonly newEvents: number;
  readonly cardIds: readonly string[];
  readonly sent: number;
  readonly collapsed: number;
  /** Cards still waiting to be sent (quiet hours, the hourly limit, a failed delivery). */
  readonly held: number;
  readonly failures: readonly IntakeFailure[];
  readonly costUsd: number;
  readonly stoppedBy?: IntakeStopReason;
  readonly statusLine?: string;
  readonly reportPath?: string;
  /** The `GH_ACCOUNT` the run asked gh for. */
  readonly ghAccount?: string;
}

// ---- seams -----------------------------------------------------------------------------------

export type IntakeSendResult =
  | { readonly ok: true; readonly chatId?: string; readonly messageId?: string }
  | { readonly ok: false; readonly reason: string };

/** What the poll needs from serve's Telegram path. The hub wiring renders the card and its buttons. */
export interface IntakeCardSink {
  sendCard(card: IntakeCardView): Promise<IntakeSendResult>;
  /** A one-line status in the same topic (a stopped run, a gh failure). Failure to send it is never an error of the run. */
  sendStatus(text: string): Promise<{ readonly ok: boolean }>;
}

export interface IntakeAssessInput {
  readonly event: IntakeEvent;
  /** The actions the card will offer; a suggestion outside this list is dropped. */
  readonly allowed: readonly IntakeAction[];
  readonly signal: AbortSignal;
  /** What is left of the run's budget, in USD. */
  readonly remainingUsd: number;
}

export type IntakeAssessResult =
  | { readonly ok: true; readonly assessment: string; readonly suggestion?: string; readonly costUsd: number }
  | { readonly ok: false; readonly reason: string; readonly costUsd: number };

/** One model call without tools. The default answers "unavailable" and calls nothing. */
export type IntakeAssessor = (input: IntakeAssessInput) => Promise<IntakeAssessResult>;

// ---- the status object every surface is built from -----------------------------------------------

export interface IntakeCardSummary {
  readonly id: string;
  readonly kind: IntakeCardKind;
  readonly repo?: string;
  readonly title: string;
  readonly url?: string;
  readonly state: IntakeCardState;
  readonly suggestion?: IntakeAction;
  readonly actions: readonly IntakeAction[];
  readonly createdAt: string;
  readonly choice?: IntakeAction;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly flowId?: string;
  readonly remindAt?: string;
}

/** The one object the sidebar line, the `/intake` modal, the readline text and `keryx intake status` read. */
export interface IntakeStatus {
  readonly enabled: boolean;
  readonly paused: boolean;
  /** Cards sent and waiting for a decision. */
  readonly waiting: number;
  /** Cards made but not yet sent. */
  readonly queued: number;
  /** Cards put off with «Позже». */
  readonly deferred: number;
  readonly decided: number;
  readonly lastPollAt: string | null;
  /** When the next automatic poll is due, or null while paused, disabled or never polled. */
  readonly nextPollAt: string | null;
  readonly quiet: boolean;
  readonly repos: readonly string[];
  readonly ghAccount: GhAccount;
  /** `Intake: <N ждут> | следующий опрос <время> | пауза | выкл`. */
  readonly line: string;
  readonly tabs: {
    readonly waiting: readonly IntakeCardSummary[];
    readonly decided: readonly IntakeCardSummary[];
    readonly deferred: readonly IntakeCardSummary[];
    readonly events: readonly IntakeRecentEvent[];
  };
  readonly lastRun?: IntakeRunSummary;
}

// ---- the report -------------------------------------------------------------------------------

export interface IntakeKindReport {
  readonly kind: IntakeCardKind;
  readonly cards: number;
  /** Decisions by action; only cards with a decision count. */
  readonly decisions: Readonly<Record<string, number>>;
  readonly medianAnswerMs: number | null;
  /** Share of decided cards whose choice equals the suggestion, among those that had a suggestion; null when none had. */
  readonly matchedSuggestion: number | null;
  readonly decidedWithSuggestion: number;
}

export interface IntakeChainLink {
  readonly cardId: string;
  readonly kind: IntakeCardKind;
  readonly flowId: string;
  /** The flow's pull request URL when the flow has recorded one. */
  readonly pr: string | null;
}

export interface IntakeReport {
  readonly schema: 1;
  readonly generatedAt: string;
  readonly totalCards: number;
  readonly kinds: readonly IntakeKindReport[];
  readonly chains: readonly IntakeChainLink[];
}
