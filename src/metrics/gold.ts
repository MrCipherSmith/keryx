// Pure, deterministic, I/O-free gold-label derivation for the metastore ladder's oracle
// metrics (see docs/requirements/keryx-benchmark-suite/specification.md §4 "Ground truth
// and leakage control" and metrics-and-validation.md's "gdgraph" / "testing" rows). These
// functions turn already-extracted inputs (parsed git co-change history, a parsed coverage
// map) into gold ID sets that `precision`/`recall`/`f1` (./ir.ts) can be scored against.
//
// Nothing here shells out to git, reads a file, or hits the network — that is the job of a
// thin producer (see scripts/benchmark/generate-express-gold.ts) that gathers the raw
// inputs and calls these functions. Keeping the derivation pure is what makes it
// unit-testable with in-memory fixtures and reproducible per spec AC-2 ("two runs produce
// identical numbers").

/** One commit's changed-file set, as extracted from `git log --name-only`. */
export type CoChangeCommit = {
  readonly sha: string;
  readonly files: readonly string[];
};

/** Per-file co-change statistics relative to a fixed target, for audit/reproducibility. */
export type CoChangeSupport = {
  readonly coChanges: number;
  readonly support: number;
};

export type GoldAffectedSetOptions = {
  /**
   * Minimum conditional co-change probability P(file changes | target changes) required
   * for a file to be considered gold-affected. Default 0.34 (~1 in 3 commits that touch
   * the target also touch the file) — chosen to catch files that reliably travel with the
   * target while excluding one-off, coincidental co-changes.
   */
  readonly minSupport?: number;
  /**
   * Minimum absolute number of co-changing commits required, independent of support. A
   * single shared commit can trivially clear a low support threshold when the target has
   * few commits; this guards against that. Default 2.
   */
  readonly minCoChanges?: number;
};

export type GoldAffectedSetResult = {
  /** Gold affected-set: files that co-change with `target` above the threshold, sorted. */
  readonly affected: string[];
  /** Number of commits (within the supplied history) that touched `target`. */
  readonly commitsWithTarget: number;
  /** Per-file co-change stats for every file seen alongside `target`, for audit. */
  readonly support: Readonly<Record<string, CoChangeSupport>>;
};

const DEFAULT_MIN_SUPPORT = 0.34;
const DEFAULT_MIN_CO_CHANGES = 2;

/**
 * Derive the gold "files that actually change together with `target`" set from git
 * co-change history, per specification.md §4 ("Gold labels are derived mechanically —
 * git history for affected-set") and metrics-and-validation.md's gdgraph row ("git
 * history (real co-change set)").
 *
 * Rule (documented so it is reproducible):
 * 1. Restrict to commits in `coChangeHistory` whose (deduped) file set contains `target`.
 *    Call this count `commitsWithTarget`.
 * 2. If `commitsWithTarget` is 0, there is no co-change evidence for `target` in the
 *    supplied history: return an empty affected-set (not an error, not a fabricated 0/0).
 * 3. For every other file `f` that appears in at least one of those commits, compute
 *    `coChanges(f)` = number of those commits containing `f`, and
 *    `support(f) = coChanges(f) / commitsWithTarget` — the conditional probability that
 *    `f` changes given that `target` changes, within this history.
 * 4. `f` is gold-affected iff `coChanges(f) >= minCoChanges` AND `support(f) >= minSupport`
 *    (both default thresholds documented above). Both conditions are required: support
 *    alone lets a target with very few commits admit a single coincidental co-change;
 *    an absolute floor alone lets a high-volume file with weak correlation sneak in.
 * 5. The result is sorted lexicographically for a stable, order-independent gold ID list
 *    (matches the array-of-stable-string-IDs shape `precision`/`recall` in ./ir.ts expect).
 *
 * A commit's file list is deduped internally before comparison, so a caller-supplied
 * duplicate path within one commit cannot double-count.
 */
export function goldAffectedSet(
  coChangeHistory: readonly CoChangeCommit[],
  target: string,
  options: GoldAffectedSetOptions = {},
): GoldAffectedSetResult {
  const minSupport = options.minSupport ?? DEFAULT_MIN_SUPPORT;
  const minCoChanges = options.minCoChanges ?? DEFAULT_MIN_CO_CHANGES;

  const targetCommitFileSets: Set<string>[] = [];
  for (const commit of coChangeHistory) {
    const files = new Set(commit.files);
    if (files.has(target)) targetCommitFileSets.push(files);
  }
  const commitsWithTarget = targetCommitFileSets.length;

  const coChangeCounts = new Map<string, number>();
  if (commitsWithTarget > 0) {
    for (const files of targetCommitFileSets) {
      for (const file of files) {
        if (file === target) continue;
        coChangeCounts.set(file, (coChangeCounts.get(file) ?? 0) + 1);
      }
    }
  }

  const support: Record<string, CoChangeSupport> = {};
  const affected: string[] = [];
  for (const [file, coChanges] of coChangeCounts) {
    const fileSupport = coChanges / commitsWithTarget;
    support[file] = { coChanges, support: fileSupport };
    if (coChanges >= minCoChanges && fileSupport >= minSupport) affected.push(file);
  }
  affected.sort();

  return { affected, commitsWithTarget, support };
}

/**
 * Parse `git log --name-only --pretty=format:"commit %H"` (or equivalent) output into
 * the `CoChangeCommit[]` shape `goldAffectedSet` expects. Pure text-in/structured-out
 * parsing, no I/O — the actual `git log` invocation belongs in a producer script (see
 * scripts/benchmark/generate-express-gold.ts).
 *
 * Expected input shape, oldest-or-newest order doesn't matter to the derivation:
 * ```
 * commit <sha1>
 *
 * <path>
 * <path>
 * commit <sha2>
 *
 * <path>
 * ```
 * Blank lines and non-"commit "-prefixed, non-path lines (e.g. an empty commit-message
 * line) are ignored other than as separators. A commit with zero changed files (merge
 * commit with `--name-only` producing nothing, or a commit that touched nothing this
 * function was told about) is still emitted, with an empty `files` array.
 */
export function parseGitLogNameOnly(gitLogOutput: string): CoChangeCommit[] {
  const commits: CoChangeCommit[] = [];
  let currentSha: string | null = null;
  let currentFiles: string[] = [];

  const flush = (): void => {
    if (currentSha !== null) commits.push({ sha: currentSha, files: currentFiles });
  };

  for (const rawLine of gitLogOutput.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = /^commit\s+([0-9a-fA-F]+)$/.exec(line);
    if (match) {
      flush();
      currentSha = match[1] as string;
      currentFiles = [];
      continue;
    }
    if (currentSha !== null) currentFiles.push(line);
  }
  flush();

  return commits;
}

/**
 * Coverage map as extracted from a coverage report: test id -> the files that test
 * exercised. Shape matches "coverage map (test id -> covered files)" from the task spec
 * and the testing ladder's TIA gold source in metrics-and-validation.md ("coverage /
 * changed tests").
 */
export type CoverageMap = Readonly<Record<string, readonly string[]>>;

/**
 * Derive the gold impacted-test set for a change from a coverage map, per
 * metrics-and-validation.md's testing row: "gold source: coverage / changed tests".
 *
 * Rule (documented so it is reproducible):
 * A test id is gold-impacted iff the set of files it covers (per `coverageMap`) has a
 * non-empty intersection with `changedFiles` — i.e. the change touched at least one file
 * that test exercises. Both the per-test covered-file list and `changedFiles` are deduped
 * via `Set` before comparison (duplicate paths cannot change the verdict).
 *
 * Edge cases:
 * - empty `coverageMap`: no tests are known, so the result is `[]` (there is nothing to
 *   report as impacted, not an error).
 * - empty `changedFiles`: no file changed, so no test can be impacted by "nothing" — `[]`.
 * - a test covering zero files never appears in the result (it cannot intersect anything).
 *
 * Result is sorted lexicographically by test id for a stable, order-independent gold ID
 * list (matches the array-of-stable-string-IDs shape `precision`/`recall` expect).
 */
export function goldTestImpact(coverageMap: CoverageMap, changedFiles: readonly string[]): string[] {
  const changedSet = new Set(changedFiles);
  if (changedSet.size === 0) return [];

  const impacted: string[] = [];
  for (const [testId, coveredFiles] of Object.entries(coverageMap)) {
    for (const file of coveredFiles) {
      if (changedSet.has(file)) {
        impacted.push(testId);
        break;
      }
    }
  }
  impacted.sort();
  return impacted;
}
