// Flow 331 — shared types for the Jev review benchmark.
//
// One vocabulary, used by the dataset builder, the adapters, the metrics and
// the report generator, so a field renamed in one place is a compile error
// everywhere else rather than a silently-stale JSON key.

/** The finding's own recorded outcome — mirrors `review-finding.schema.json`'s `disposition.state` enum. */
export type DispositionState =
  | "unknown"
  | "acted-on"
  | "dismissed-incorrect"
  | "dismissed-wont-fix"
  | "dismissed-out-of-scope"
  | "dismissed-deprioritised"
  | "answered-disagree";

/** Where a finding's disposition was read from — see `scripts/review-precision-baseline.ts`'s file header for the discipline this mirrors. */
export type DispositionSource = "record" | "report-closed-by" | "ledger" | "none";

/**
 * AC1's label mapping, documented once, read everywhere (the report AND
 * `bench/jev-review/README.md` restate this — this is the source of truth
 * the restatement must not drift from):
 *
 *   true-positive  <- disposition.state === "acted-on"
 *   false-positive <- disposition.state === "dismissed-incorrect"
 *   unlabeled      <- everything else ("dismissed-wont-fix",
 *                      "dismissed-out-of-scope", "dismissed-deprioritised",
 *                      "answered-disagree", "unknown")
 *
 * Only `acted-on` and `dismissed-incorrect` say anything about whether a
 * finding was RIGHT — the same reasoning `review-finding.schema.json` and
 * `scripts/review-precision-baseline.ts` already use for the precision
 * ratio. A finding dismissed as out-of-scope was never wrong; it was never
 * asked to be right. Counting it as a false positive would make "add more
 * scope-B rejections" a way to improve precision without improving
 * anything. `unlabeled` findings are excluded from precision/recall
 * denominators; they are still counted and reported (AC4: n next to every
 * percentage), just not scored.
 */
export type FindingLabel = "true-positive" | "false-positive" | "unlabeled";

export function labelFor(state: DispositionState): FindingLabel {
  if (state === "acted-on") return "true-positive";
  if (state === "dismissed-incorrect") return "false-positive";
  return "unlabeled";
}

export interface DatasetDisposition {
  readonly state: DispositionState;
  readonly source: DispositionSource;
  readonly evidence: string;
}

/** One finding, joined to its outcome and reduced to the fields AC1 asks for. */
export interface DatasetFinding {
  readonly globalId: string;
  readonly reviewId: string;
  readonly findingId: string;
  readonly flowId: string | null;
  /** The PR this review package targeted (`manifest.target.ref`), when the target is a PR. */
  readonly prRef: string | null;
  /** The commit the review was taken against (`manifest.target.head`), when recorded — AC1's "diff reference". */
  readonly diffRef: string | null;
  readonly severity: string;
  readonly reviewer: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly disposition: DatasetDisposition;
  readonly label: FindingLabel;
}

/** One flow's frozen acceptance criteria and how many are confirmed — AC1's "plus the flow's frozen AC and confirmations". */
export interface DatasetFlowAc {
  readonly flowId: string;
  readonly title: string;
  readonly status: string;
  readonly acChecksum: string | null;
  readonly criteria: readonly string[];
  readonly confirmedCount: number;
  readonly totalCount: number;
}

export interface DatasetCounts {
  readonly packages: number;
  readonly findings: number;
  readonly byLabel: Record<FindingLabel, number>;
}

export interface Dataset {
  readonly schemaVersion: 1;
  /** Set by the builder at write time; deliberately excluded from the determinism check (see `build-dataset.test.ts`). */
  readonly generatedAt: string;
  readonly sourceRepo: "keryx (this repository, public)";
  readonly labelMapping: {
    readonly "true-positive": string;
    readonly "false-positive": string;
    readonly unlabeled: string;
  };
  readonly findings: readonly DatasetFinding[];
  readonly flows: readonly DatasetFlowAc[];
  readonly counts: DatasetCounts;
  /** Non-fatal build-time problems (e.g. a `closed by` marker naming a commit this repo does not have) — surfaced, never silently dropped. */
  readonly problems: readonly string[];
}

// ---------------------------------------------------------------------------
// Adapters (AC2)
// ---------------------------------------------------------------------------

export type Arm = "without-jev" | "with-jev";

/** One clause/finding/case-level prediction an adapter made, for metric scoring against the dataset's labels. */
export interface ComponentPrediction {
  /** Joins to `DatasetFinding.globalId` when this prediction is about a recorded finding; otherwise a case/clause id local to the component. */
  readonly id: string;
  /** True when the component flagged this as a real issue (a positive prediction). */
  readonly flagged: boolean;
  /** True when the component's flag/verdict was correct against ground truth, when known. `null` when there is no ground truth to check against. */
  readonly correct: boolean | null;
}

export interface ComponentUsage {
  readonly jevCalls: number;
  readonly inputTokens: number;
  readonly cost: number;
  readonly wallClockMs: number;
}

export interface ComponentArmResult {
  readonly component: string;
  readonly arm: Arm;
  readonly available: true;
  readonly n: number;
  readonly predictions: readonly ComponentPrediction[];
  readonly usage: ComponentUsage;
  /**
   * AC3's "added true positives not found by the existing reviewers (hand-
   * labelled sample)". `null` when this run did not hand-label a sample —
   * which is every run this codebase can produce unattended, since hand
   * labelling is, definitionally, a human act. A non-null count on disk
   * means a human ran the labelling pass documented in `README.md` and
   * recorded it; nothing in this benchmark fabricates one.
   */
  readonly addedTruePositives: number | null;
  /** Free-text notes a reader needs to interpret the numbers honestly (e.g. "offline replay; no --live path exists for this component"). */
  readonly notes: readonly string[];
}

export interface ComponentNotAvailable {
  readonly component: string;
  readonly arm: Arm;
  readonly available: false;
  readonly reason: string;
}

export type ComponentResult = ComponentArmResult | ComponentNotAvailable;

export interface AdapterRunContext {
  readonly root: string;
  readonly dataset: Dataset;
  readonly live: boolean;
  /** `bun`'s executable path, so the adapter shells to the CLI under test rather than an installed build (known constraint — see flow 331 context.md item 3). */
  readonly bunPath: string;
  readonly cliPath: string;
}

export interface ComponentAdapter {
  readonly id: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  run(arm: Arm, ctx: AdapterRunContext): Promise<ComponentResult>;
}
