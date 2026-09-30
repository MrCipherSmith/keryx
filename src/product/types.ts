// Product module P1: the intent of the product as a derived, disposable index.
//
// An intent is read out of a flow package or a requirements package; nothing
// here is maintained by hand and nothing here gates anything. The index is a
// pure function of the tree it was read from, so it carries no clock.

import type { AcKindRecord } from "../flow/ac-kinds";
import type { OutcomeAuthorReading } from "../flow/service";

export type IntentSource = "flow" | "docpack";

export const OUTCOME_VERDICTS = ["helped", "no-effect", "harmed", "inconclusive"] as const;
export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number];

export interface IntentOutcome {
  /** The outcome criterion the package states, or `null` when it states none. */
  readonly criterion: string | null;
  /** A well-formed `outcome-observed: <verdict> — <note>` line exists in the flow's journal. */
  readonly observed: boolean;
  /** The verdict on that line; `null` when nothing was observed, or the line is malformed. */
  readonly verdict: OutcomeVerdict | null;
  /** A leading ISO date in the note, when it carries one. */
  readonly observedAt: string | null;
  /** The note after the em dash. */
  readonly note: string | null;
}

export interface Intent {
  /** Flow id, or requirements package name. */
  readonly id: string;
  readonly source: IntentSource;
  /** Repo-relative directory the intent was read from. */
  readonly path: string;
  readonly title: string;
  /** The intent in one sentence; `null` when the package states none. */
  readonly statement: string | null;
  readonly criteria: readonly AcKindRecord[];
  /** `closed` only for a flow whose status is `done`. */
  readonly status: "open" | "closed";
  /** The raw flow status; `null` for a requirements package. */
  readonly flowStatus: string | null;
  readonly closedAt: string | null;
  readonly outcome: IntentOutcome;
  /**
   * Who wrote the flow's outcome criterion: `agent`, `human`, or `unknown` when
   * `flow.json` does not carry the field. Optional: an index written before the
   * field existed stays valid, and a requirements package has no such author, so
   * it carries none. It labels; nothing gates on it.
   */
  readonly outcomeAuthor?: OutcomeAuthorReading | undefined;
}

export interface IntentCounts {
  readonly intents: number;
  readonly flows: number;
  readonly docpacks: number;
  readonly closed: number;
  /** Closed and unobserved, with no instrument stated. */
  readonly noCriterion: number;
  /** Closed and unobserved, with a criterion stated. */
  readonly notObserved: number;
  readonly observed: number;
  /** The four verdicts partition `observed`. */
  readonly helped: number;
  readonly noEffect: number;
  readonly harmed: number;
  readonly inconclusive: number;
}

export interface IntentIndex {
  readonly schemaVersion: 1;
  /**
   * sha256 of the sources the index was read from (their paths and contents,
   * and the package names). `product open` recomputes it: a different value
   * means the flows or requirements changed after the index was built.
   */
  readonly fingerprint: string;
  readonly intents: readonly Intent[];
  /** Entries with no extractable intent statement. */
  readonly unusable: number;
  /**
   * Sources that could not be parsed at all, and observation lines with no
   * recognized verdict. The second kind names an entry that is still in
   * `intents` (treated as not observed), so a typo never hides an intent.
   */
  readonly failures: readonly string[];
  readonly counts: IntentCounts;
}

export type IndexRead =
  | { readonly state: "absent" }
  | { readonly state: "malformed"; readonly reason: string }
  | { readonly state: "present"; readonly index: IntentIndex };

export interface OpenEntry {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly closedAt: string | null;
  /** The criterion, or the literal text saying none is stated. */
  readonly outcome: string;
  readonly hasCriterion: boolean;
  /** Who wrote the criterion, read from the intent record; `unknown` for an index that predates the field. */
  readonly outcomeAuthor: OutcomeAuthorReading;
}

export interface OpenReport {
  readonly closed: number;
  readonly neverChecked: number;
  readonly noCriterion: number;
  readonly notObserved: number;
  readonly observed: number;
  readonly helped: number;
  readonly noEffect: number;
  readonly harmed: number;
  readonly inconclusive: number;
  /** Sources the index could not read, or observation lines it could not parse. */
  readonly failures: number;
  readonly entries: readonly OpenEntry[];
}

export type Staleness = { readonly stale: false } | { readonly stale: true; readonly reason: string };
