// Flow 392: the recommendation journal's records. One decision is an `open`
// record (written BEFORE the question is shown, so the recommendation can never
// be edited in hindsight), then one or more `answer` records, then at most one
// `reason` record. The file only ever grows; a report folds the records by id.

import type { Arm } from "./arms";

/** Derived from the arm so old readers keep working: A is ordinary, D is blind, B and C are partial. */
export type DecisionMode = "ordinary" | "blind" | "partial";

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
  /** Derived from `arm` (A ordinary, D blind, B and C partial). Kept so records and readers from before the arms still work. */
  mode: DecisionMode;
  /**
   * Flow 400: which arm the question was put in (A agent order, mark, preselected; B no preselection;
   * C shuffled, mark, no preselection; D shuffled, no mark, no preselection). Absent on a record from before
   * the arms: read it through `effectiveArm` (ordinary was A, blind was D).
   */
  arm?: Arm;
  /** The 32-bit seed the arm was drawn from, derived from the repository salt and `seq`. */
  seed?: number;
  /** The position of this decision in the journal that the seed was derived with. */
  seq?: number;
  /** Whether the recommended option started highlighted (arm A with a recommendation only). */
  preselected?: boolean;
  /** True when the arm is A only because the question is irreversible, an action, or matched blind.ts. Every other A is false. */
  forced?: boolean;
  /**
   * Flow 400: true for a record from before the arms (no seeded assignment, so it is not part of the randomized
   * comparison). `import` stamps it on the records it writes; a record already on disk without `arm` is read as
   * legacy through `stampLegacy` (the journal file is append-only and is not rewritten).
   */
  legacy?: true;
  /** Where the question was asked: "tui" (the default, also for a record without the field), "telegram", ... */
  channel?: string;
  /** Option ids in the order they are shown to the human (shuffled in arms C and D). */
  order: string[];
  /** Whether the "recommended" mark is shown (arms A, B and C; never in D). */
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
  /**
   * Flow 400: where the decision came from. A live record carries the surface that asked it (one of
   * `DECISION_SOURCES`: "ask_user", "round-limit", "tui-wiki-enrich", ...); a backfilled decision carries its
   * origin (e.g. "poll 17"). Absent on a record from before the field.
   */
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
  /** Where the question is asked ("tui" by default). */
  channel?: string | undefined;
  /** The surface that asked it (see `DECISION_SOURCES`); recorded as `source` on the open record. */
  source?: string | undefined;
  /** Test seam: the shuffle's random source in [0, 1). The arm itself is seeded, never drawn from this. */
  random?: (() => number) | undefined;
  /** Test seam: take this arm as the draw. An irreversible question is still moved to A with `forced: true`. */
  arm?: Arm | undefined;
  /** Test seam: the position in the journal the seed is derived with (default: the number of open records + 1). */
  seq?: number | undefined;
  /** Test seam: the repository salt (default: the one under the user config directory, see loadRepoSalt). */
  salt?: string | undefined;
  now?: (() => Date) | undefined;
  id?: string | undefined;
}

export interface OpenResult {
  id: string;
  mode: DecisionMode;
  arm: Arm;
  seed: number;
  /** Whether the host should start with the recommended option highlighted (arm A with a recommendation). */
  preselected: boolean;
  /** True when the arm is A because the question is irreversible (see OpenRecord.forced). */
  forced: boolean;
  channel: string;
  /** Option ids in display order. */
  order: string[];
  showMark: boolean;
  irreversible: boolean;
  /** Set when the draw gave arm D (blind) but the question was irreversible, so it was asked as A. */
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
