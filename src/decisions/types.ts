// Flow 392: the recommendation journal's records. One decision is an `open`
// record (written BEFORE the question is shown, so the recommendation can never
// be edited in hindsight), then one or more `answer` records, then at most one
// `reason` record. The file only ever grows; a report folds the records by id.

export type DecisionMode = "ordinary" | "blind";

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
}

export interface DecisionRecommendation {
  optionId: string;
  reason: string;
}

export interface OpenRecord {
  kind: "open";
  id: string;
  at: string;
  /** Flow id, or null for a question asked outside a flow. */
  flow: string | null;
  /** How the flow was found, when it was derived rather than given: env, branch, or inferred (the one flow in progress). */
  flowSource?: "env" | "branch" | "inferred";
  stage: string;
  question: string;
  /** The options in the order the agent gave them. */
  options: DecisionOption[];
  recommendation: DecisionRecommendation | null;
  mode: DecisionMode;
  /** Option ids in the order they are shown to the human (shuffled when blind). */
  order: string[];
  /** Whether the "recommended" mark is shown (never in blind mode). */
  showMark: boolean;
  /** True when the question matched the irreversible list, so blind was refused. */
  irreversible: boolean;
  /** The free tag the caller gave for the action (e.g. "release"), when any. */
  action?: string;
  /** True when the question would have been blind but looked irreversible, so it was asked the ordinary way. */
  blindRefused?: boolean;
  /** The session the question was asked in (what `/decisions change` without an id is checked against). */
  session?: string;
  /**
   * True for a decision imported after the fact (`keryx decisions import`): its
   * recommendation was written down once the answer was known, so it is never blind,
   * its time to answer is unknown, and every report and lookup keeps it apart from
   * the live records.
   */
  backfilled?: true;
  /** Where a backfilled decision came from (e.g. "poll 17"). */
  source?: string;
}

export interface AnswerRecord {
  kind: "answer";
  id: string;
  at: string;
  /** 1 for the first answer, 2 for a changed answer, and so on. */
  seq: number;
  choice: string;
  timeToAnswerMs: number;
  /** True when this answer replaces an earlier one for the same decision. */
  changed: boolean;
  /** True when the answer is the human's own words, not one of the options (a free-form answer). */
  other?: boolean;
  /**
   * Flow 401: the own answer in full (redacted, one line, up to 2000 characters, a visible marker when cut).
   * `choice` keeps the short display form of the same text. Present only when `other` is true.
   */
  text?: string;
}

export interface ReasonRecord {
  kind: "reason";
  id: string;
  at: string;
  /** Absent when the human answered the one question with nothing. Flow 401: kept in full (redacted, up to 2000 characters). */
  reason?: string;
}

export type DecisionRecord = OpenRecord | AnswerRecord | ReasonRecord;

export interface OpenInput {
  cwd: string;
  question: string;
  options: DecisionOption[];
  recommendation?: DecisionRecommendation | undefined;
  stage?: string | undefined;
  flow?: string | undefined;
  flowSource?: "env" | "branch" | "inferred" | undefined;
  /** Any non-empty tag marks the question as deciding an irreversible action: it is never blind. */
  action?: string | undefined;
  /** The caller says the question is about an irreversible action: never blind. */
  irreversible?: boolean | undefined;
  /** The session asking, recorded so a follow-up without an id can be held to its own session's decisions. */
  session?: string | undefined;
  /** Test seam: a random source in [0, 1). */
  random?: (() => number) | undefined;
  now?: (() => Date) | undefined;
  id?: string | undefined;
}

export interface OpenResult {
  id: string;
  mode: DecisionMode;
  /** Option ids in display order. */
  order: string[];
  showMark: boolean;
  irreversible: boolean;
  /** Set when blind was refused for an irreversible action. */
  blindRefused: boolean;
  flow: string | null;
}

export interface AnswerInput {
  cwd: string;
  id: string;
  /** An option id. A free-form answer needs `other: true`; anything else must be one of the options. */
  choice: string;
  other?: boolean | undefined;
  now?: (() => Date) | undefined;
}

export interface AnswerResult {
  id: string;
  seq: number;
  changed: boolean;
  choice: string;
  mode: DecisionMode;
  /** The reveal: what the agent recommended, shown right after the answer. */
  recommendation: DecisionRecommendation | null;
  /** Null when the question had no recommendation. */
  matched: boolean | null;
  deviation: boolean;
  timeToAnswerMs: number;
  /**
   * True when the human should now be asked, ONCE, for an optional reason: a
   * deviation, no reason on file, and no earlier answer already offered it. In the
   * TUI `ask_user` path the tool result waits for it (an empty answer releases the
   * wait); the `answer` command itself does not wait.
   */
  askReason: boolean;
  flow: string | null;
}
