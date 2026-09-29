// Product module P1: the intent of the product as a derived, disposable index.
//
// An intent is read out of a flow package or a requirements package; nothing
// here is maintained by hand and nothing here gates anything. The index is a
// pure function of the tree it was read from, so it carries no clock.

import type { AcKindRecord } from "../flow/ac-kinds";

export type IntentSource = "flow" | "docpack";

export interface IntentOutcome {
  /** The outcome criterion the package states, or `null` when it states none. */
  readonly criterion: string | null;
  /** A line beginning `outcome-observed:` exists in the flow's journal. */
  readonly observed: boolean;
  /** A leading ISO date on that line, when it carries one. */
  readonly observedAt: string | null;
  /** The text of that line after the marker. */
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
}

export interface IntentIndex {
  readonly schemaVersion: 1;
  readonly intents: readonly Intent[];
  /** Entries with no extractable intent statement. */
  readonly unusable: number;
  /** Sources that could not be parsed at all. */
  readonly failures: readonly string[];
  readonly counts: IntentCounts;
}

export type IndexRead =
  | { readonly state: "absent" }
  | { readonly state: "malformed"; readonly reason: string }
  | { readonly state: "present"; readonly index: IntentIndex; readonly mtimeMs: number };

export interface OpenEntry {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly closedAt: string | null;
  /** The criterion, or the literal text saying none is stated. */
  readonly outcome: string;
  readonly hasCriterion: boolean;
}

export interface OpenReport {
  readonly closed: number;
  readonly neverChecked: number;
  readonly noCriterion: number;
  readonly notObserved: number;
  readonly observed: number;
  readonly entries: readonly OpenEntry[];
}

export type Staleness = { readonly stale: false } | { readonly stale: true; readonly reason: string };
