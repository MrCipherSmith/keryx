// Shared shapes for `src/learning/signals/*.ts` (W3 spec, "Deterministic
// extraction signals" + "Optional model-backed extractor"). Each signal is a
// pure(ish) function over the observation window (plus, for
// `reviewer-comment`/`health-regression`, existing durable artifacts it only
// reads) that returns zero or more drafts; `extract.ts` owns turning a draft
// into a stored `learned-pattern` record (deterministic id, seed confidence,
// evidence dedup, security scan).
import type { EvidenceItem, LearningDomain, ObservationEvent, ReviewerProfile } from "../types";

/** One parsed observation-log line, with the project-relative `sourceRef` extract needs for evidence provenance. */
export interface ObservationLine {
  event: ObservationEvent;
  /** `.metaproject/data/learning/observations/<date>.jsonl#L<n>` (project-relative, 1-based line number). */
  sourceRef: string;
}

/** A signal's proposed candidate, before `extract.ts` assigns an id, seed confidence, project identity, ttl, etc. */
export interface SignalDraft {
  domain: LearningDomain;
  trigger: string;
  action: string;
  /** At least one item; `extract.ts` dedups by `sourceRef` against any existing record. */
  evidence: EvidenceItem[];
  extractor: string;
  /** Defaults to `"deterministic"` in `extract.ts` when absent. */
  extractorKind?: "deterministic" | "model-backed";
  /** Non-null only for `domain: "review-conventions"` drafts backed by a `reviewerProfiles`-configured author. */
  reviewerProfile?: ReviewerProfile | null;
}

export interface SignalRunOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** One deterministic (or, for the model-backed port, capability-gated) signal. */
export interface SignalRunner {
  name: string;
  domain: LearningDomain;
  run(root: string, window: ObservationLine[], options: SignalRunOptions): Promise<SignalDraft[]>;
}
