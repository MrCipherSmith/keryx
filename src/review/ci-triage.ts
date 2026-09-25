// CI failure triage — flow 306, PRD.md Requirement 20 / PLAN.md Phase 1.
// Advisory-only: flaky vs. infra vs. real-regression, scored by Jev over one
// failed job's redacted, bounded log excerpt.
//
// THIS MODULE IS CORE (`src/review/`, `src/lib/import-zones.ts`) AND NEVER
// IMPORTS THE CLIENT-ZONE JEV CLIENT. A core owner never imports a client or
// adapter module (`src/lib/import-policy.ts`'s `owner-imports-client`, zero
// tolerance, no exception) — so this module produces plain, structurally
// typed question/answer shapes instead of importing `JevQuestion`/`JevAnswer`
// from `src/harness/decision/jev-client.ts`. The adapter that actually calls
// `callJevSystemOne` (`src/commands/review.ts`, an ADAPTER, which is allowed
// to import both core and client) glues the two together; this module's
// exported shapes are chosen to satisfy `JevQuestion`/`JevAnswer` structurally
// with no import needed.
//
// CHOICE-VS-NOUL DECISION (AC7): AC7's prose describes a single `choice`
// question with `criteria: ["flaky", "infra", "real-regression"]`. Per
// `jev-client.ts`'s own header, neither OpenRouter's TypeSafe SDK guide nor
// the sibling `keryx-jev-router` PRD's research documents a `choice` answer
// carrying a probability PER OPTION — only the single chosen option. AC7 also
// requires "a probability per option", so this module asks one `noul`
// question per criterion instead: three small requests whose three
// `{type:"noul", noul: 0..1}` answers together ARE the per-option
// probabilities AC7 wants, without depending on an undocumented response
// shape.
//
// ADVISORY ONLY (AC9): nothing here ever reruns a job, writes a status check,
// or merges anything — every exported function is pure text/data or a READ.
// This module's own IO is a read of `.metaproject/tasks.config.json` (the
// opt-in gate), `redactSensitiveText` over a string already in memory, and
// (flow 307, AC1) reads through the CI read port (`./ci-port.ts`, no write
// method at all) plus `git show <sha>:<path>` — also read-only, never a
// write, injectable for hermetic tests.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "./cost";
// Through the security facade, not `security/redact` directly.
//
// Flow 326, AC6 (CI-triage leftover from PR #713): this is NOT because the
// import-policy ratchet (`client-imports-core-internal`, checked by
// `src/lib/import-policy.live.test.ts`) would catch a direct import here —
// it would not. This module is a CORE owner (`src/review/`, see the header
// above) importing another CORE owner (`src/security/`); `client-imports-
// core-internal` only fires on a CLIENT/ADAPTER -> CORE edge
// (`src/lib/import-policy.ts`'s `findingFor`), and a core -> core edge is
// neither that nor `owner-imports-client` (core -> client/adapter). This
// import trips neither rule.
//
// The real reason is plain consistency: every caller outside `src/security/`
// itself — core or not — reaches redaction through `security/service.ts`,
// which exists precisely so that CALLERS NEVER HAVE TO KNOW which internal
// module (`redact.ts` today) actually implements it. Importing `redact.ts`
// directly from here would still work and would still pass every import
// check, but it would make this module the one exception to a convention the
// rest of the codebase holds uniformly, for no benefit.
import { redactSensitiveText } from "../security/service";
import { REVIEW_GATE_CONFIG_PATH } from "../flow/review-gate";
import {
  CI_SPAWN_OUTPUT_CAP_BYTES,
  type CiAttemptJobs,
  type CiBunSpawnFn,
  type CiPort,
  type CiRunHistoryEntry,
  type CiRunInfo,
} from "./ci-port";

/** The three verdict buckets AC7 asks about, in a stable, printed order. */
export const CI_TRIAGE_CRITERIA = ["flaky", "infra", "real-regression"] as const;
export type CiTriageCriterion = (typeof CI_TRIAGE_CRITERIA)[number];

/**
 * Characters of the failed-step log kept as `state`, after redaction,
 * tail-first (AC11: "the failing test's output and the job's tail, within the
 * 64k budget"). At ~4 chars/token (`estimateTokens`) this is ≈1.5k tokens —
 * comfortably inside the 64k combined `state`+`questions` budget even with
 * three questions packed alongside it.
 */
export const CI_TRIAGE_LOG_CHARS = 6_000;

/** A plain, structural stand-in for `JevQuestion` (`type: "noul"`) — see the file header. */
export interface CiTriageQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

/** The flow 306 shape: no signals block exists in `state`, so nothing here asks about one. */
const CRITERION_INSTRUCTIONS: Readonly<Record<CiTriageCriterion, string>> = {
  flaky:
    "Given this CI job's failure log excerpt and the failing test's name, how likely is it that this failure is " +
    "FLAKY — one that would probably pass on an immediate rerun of the same commit, with no code change?",
  infra:
    "Given this CI job's failure log excerpt and the failing test's name, how likely is it that this failure is an " +
    "INFRASTRUCTURE problem — a runner, network, dependency-install or CI-platform issue unrelated to the code under test?",
  "real-regression":
    "Given this CI job's failure log excerpt and the failing test's name, how likely is it that this failure is a " +
    "REAL REGRESSION — a genuine bug introduced by this change that a rerun would not fix?",
};

/**
 * Flow 307 (AC2): the same three questions, rewritten to point explicitly at
 * the labelled signals block `buildCiTriageState` places above the log
 * excerpt when `signalLines` is non-empty.
 */
const CRITERION_INSTRUCTIONS_WITH_SIGNALS: Readonly<Record<CiTriageCriterion, string>> = {
  flaky:
    "Given this CI job's failure log excerpt, the failing test's name, and the signals block in state above the log, " +
    "how likely is it that this failure is FLAKY — one that would probably pass on an immediate rerun of the same " +
    "commit, with no code change? Weigh the rerun/history/same-head signals heavily: they are computed facts, not guesses.",
  infra:
    "Given this CI job's failure log excerpt, the failing test's name, and the signals block in state above the log " +
    "(especially any log-marker signal), how likely is it that this failure is an INFRASTRUCTURE problem — a runner, " +
    "network, dependency-install or CI-platform issue unrelated to the code under test?",
  "real-regression":
    "Given this CI job's failure log excerpt, the failing test's name, and the signals block in state above the log " +
    "(especially the diff-proximity and cross-branch-history signals), how likely is it that this failure is a REAL " +
    "REGRESSION — a genuine bug introduced by this change that a rerun would not fix?",
};

/**
 * One `noul` question per {@link CI_TRIAGE_CRITERIA} entry — see the file
 * header for why not one `choice` question. Flow 307 (AC2): `hasSignals`
 * switches to instructions that ask about the signals block explicitly;
 * omitted (the flow 306 shape, still used wherever no port is available),
 * the instructions read exactly as before flow 307.
 */
export function buildCiTriageQuestions(hasSignals = false): Readonly<Record<CiTriageCriterion, CiTriageQuestion>> {
  const instructions = hasSignals ? CRITERION_INSTRUCTIONS_WITH_SIGNALS : CRITERION_INSTRUCTIONS;
  return {
    flaky: { type: "noul", instructions: instructions.flaky },
    infra: { type: "noul", instructions: instructions.infra },
    "real-regression": { type: "noul", instructions: instructions["real-regression"] },
  };
}

/**
 * The bounded, redacted `state` text (AC11). `redactSensitiveText` runs
 * BEFORE truncation: truncating first could cut a secret in half at the
 * truncation point and let the redactor miss the half that remained, so
 * nothing leaves this function un-redacted regardless of where the tail cut
 * falls.
 *
 * `testName` and `jobName` are redacted too, as defence in depth (flow 306
 * review, LOW): today both are extracted from `--log-failed` text or CLI/TUI
 * flags, never free-form user text, so neither is expected to carry a
 * secret — but "not expected to" is exactly the gap a redaction boundary
 * exists to close, and the cost of also redacting two short strings is
 * negligible next to the log excerpt itself.
 *
 * Flow 307 (AC2): `signalLines`, when given, are redacted the same as every
 * other piece of `state` and placed in a short, labelled block ABOVE the log
 * excerpt — so Jev reads the deterministic evidence before the raw text, and
 * so a caller printing the same lines as advisory evidence (AC3/AC4) never
 * shows Jev something the human did not also see. Omitted or empty, the
 * output is byte-identical to the flow 306 shape (existing callers/tests
 * untouched).
 */
export function buildCiTriageState(input: {
  readonly testName: string;
  readonly jobName: string;
  readonly rawLog: string;
  readonly signalLines?: readonly string[];
}): string {
  const jobName = redactSensitiveText(input.jobName);
  const testName = redactSensitiveText(input.testName);
  const redactedLog = redactSensitiveText(input.rawLog);
  const tail = redactedLog.length > CI_TRIAGE_LOG_CHARS ? redactedLog.slice(-CI_TRIAGE_LOG_CHARS) : redactedLog;
  const signalsBlock =
    input.signalLines !== undefined && input.signalLines.length > 0
      ? ["signals (computed deterministically, before asking you):", ...input.signalLines.map((line) => redactSensitiveText(line)), ""]
      : [];
  return [`job: ${jobName}`, `failing test: ${testName}`, "", ...signalsBlock, "log excerpt (tail, redacted before leaving this machine):", tail].join(
    "\n",
  );
}

/** `state`'s estimated token count, for a caller that wants to report it (e.g. `--json`). */
export function estimateCiTriageStateTokens(state: string): number {
  return estimateTokens(state);
}

export interface CiTriageVerdict {
  readonly probabilities: Readonly<Record<CiTriageCriterion, number>>;
  readonly top: CiTriageCriterion;
  readonly topProbability: number;
  /**
   * Flow 307 (AC8): set only by {@link applyDeterministicOverride}, never by
   * {@link computeCiTriageVerdict} — the signals alone decided `top` here,
   * and the reason names which one. Jev's own `probabilities` are left
   * untouched beside it; this never replaces them.
   */
  readonly deterministic?: { readonly reason: string };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * `answers` is Jev's raw `noul` answers, keyed by the same criterion names
 * {@link buildCiTriageQuestions} used. A missing or non-finite answer clamps
 * to 0 rather than throwing — a malformed single answer should not crash the
 * whole triage when the other two are usable.
 */
export function computeCiTriageVerdict(answers: Readonly<Record<string, { readonly noul?: number }>>): CiTriageVerdict {
  const probabilities = Object.fromEntries(
    CI_TRIAGE_CRITERIA.map((criterion) => [criterion, clamp01(answers[criterion]?.noul ?? 0)]),
  ) as Record<CiTriageCriterion, number>;
  let top: CiTriageCriterion = CI_TRIAGE_CRITERIA[0];
  for (const criterion of CI_TRIAGE_CRITERIA) {
    if (probabilities[criterion] > probabilities[top]) {
      top = criterion;
    }
  }
  return { probabilities, top, topProbability: probabilities[top] };
}

function adviceFor(top: CiTriageCriterion): string {
  if (top === "flaky") return "Consider a rerun before investigating further.";
  if (top === "infra") return "Consider checking the runner/CI platform before investigating the code.";
  return "Consider investigating the diff before rerunning.";
}

/**
 * The advisory text (AC7/AC12): console or PR-comment text, always labelled
 * advisory. Flow 307: `signalLines` (AC3/AC4 — printed as evidence lines
 * alongside the verdict) and `verdict.deterministic` (AC8 — printed as its
 * own line, ABOVE the probabilities, which are still printed in full) are
 * both optional; omitted, the output is byte-identical to the flow 306 shape.
 */
export function renderCiTriageAdvisory(input: {
  readonly runId: string;
  readonly jobName: string;
  readonly testName?: string;
  readonly verdict: CiTriageVerdict;
  readonly signalLines?: readonly string[];
}): string {
  const { runId, jobName, testName, verdict, signalLines } = input;
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  // Post-merge review gap (flow 307 followups, item 1): `verdict.deterministic.reason`
  // embeds `jobName` verbatim (see `computeCiSignals`'s `deterministic` builder),
  // exactly the same shape `evidenceBlock` below already redacts on the same
  // "not expected to carry a secret is not the same as cannot" reasoning — this
  // line left it un-redacted, the one place `jobName` could still leave the
  // process un-scrubbed.
  const deterministicLine =
    verdict.deterministic !== undefined
      ? [
          `DETERMINISTIC: ${redactSensitiveText(verdict.deterministic.reason)} — the signals alone decide "${verdict.top}" here; Jev's ` +
            "probabilities below are shown beside that decision, not in place of it.",
          "",
        ]
      : [];
  // Defence in depth (same reasoning `buildCiTriageState` already applies to
  // `jobName`/`testName`, flow 306 review LOW): these lines are built from
  // computed facts, not free-form user text, but several of them embed
  // `jobName` verbatim (e.g. the same-head evidence line) — "not expected to
  // carry a secret" is exactly the gap a redaction boundary exists to close,
  // and printing this block is the one place these lines leave the process.
  const evidenceBlock =
    signalLines !== undefined && signalLines.length > 0
      ? ["", "evidence (computed signals, before Jev):", ...signalLines.map((line) => `  - ${redactSensitiveText(line)}`)]
      : [];
  return [
    `# CI triage (advisory) — run ${runId}, job ${jobName}${testName !== undefined ? `, test ${testName}` : ""}`,
    "",
    ...deterministicLine,
    `top: ${verdict.top} (≈${pct(verdict.topProbability)})`,
    ...CI_TRIAGE_CRITERIA.map((criterion) => `  ${criterion}: ${pct(verdict.probabilities[criterion])}`),
    ...evidenceBlock,
    "",
    "ADVISORY ONLY: a vendor-reported probability from a structured-decision model (Jev/TypeSafe System One), " +
      "not a verified diagnosis, and never a trigger for a rerun, a merge decision, or a status-check write. " +
      adviceFor(verdict.top),
  ].join("\n");
}

/**
 * AC10: opt-in per project, `review.jev.ci_triage` in
 * `.metaproject/tasks.config.json`, mirroring `completion.require_confirmation`'s
 * own opt-in shape (`src/flow/confirm-token.ts:readRequireConfirmationDefault`)
 * exactly — absent or unparsable reads `false`, never throws, never defaults on.
 */
export async function readCiTriageEnabled(cwd: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(cwd, REVIEW_GATE_CONFIG_PATH), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const review = (parsed as Record<string, unknown>)["review"];
    if (typeof review !== "object" || review === null) return false;
    const jev = (review as Record<string, unknown>)["jev"];
    if (typeof jev !== "object" || jev === null) return false;
    return (jev as Record<string, unknown>)["ci_triage"] === true;
  } catch {
    return false;
  }
}

/**
 * A best-effort failing-test name, read out of `--log-failed` text. `gh`
 * prefixes every line with `<job>\t<step>\t<text>`; this looks for the first
 * line naming this job whose text looks like a source path with a line
 * number (`src/foo/bar.test.ts:115`), which is how both Bun's own test
 * reporter and a Node stack frame name a failing assertion. Returns
 * `undefined` rather than guessing when nothing matches — the caller falls
 * back to an explicit `--test` flag or an "(unknown test)" label.
 */
export function extractFailingTestName(rawLog: string, jobName: string): string | undefined {
  const pathRe = /([\w./-]+\.(?:test|spec)\.tsx?):(\d+)(?::\d+)?/;
  for (const line of rawLog.split("\n")) {
    const tab = line.indexOf("\t");
    const job = tab === -1 ? undefined : line.slice(0, tab);
    if (job !== undefined && job !== jobName) continue;
    const match = pathRe.exec(line);
    if (match !== null) {
      return `${match[1]}:${match[2]}`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Flow 307 — deterministic signals, computed before Jev is ever asked
// (AC1/AC2/AC8). Every read below goes through `CiPort` (`./ci-port.ts`, no
// write method) or through the injectable `gitShow` (a `git show <sha>:<path>`
// read, never a write). A failure anywhere here degrades that ONE signal to
// "not checked" rather than failing the whole triage — a triage that cannot
// read history should still triage on the log alone, same as flow 306 did.
// ---------------------------------------------------------------------------

/** AC1(b): how many of `recentRuns`' entries are even considered. */
export const CI_SIGNAL_HISTORY_WINDOW = 50;
/** AC1(b): of those, how many OTHER failed runs actually get a `runInfo` read. */
const HISTORY_RUNINFO_CAP = 8;
/** AC1(b): of THOSE, how many actually get a `failedLog` read (the expensive one). */
const HISTORY_LOG_FETCH_CAP = 5;

const INFRA_LOG_MARKERS: ReadonlyArray<{ readonly re: RegExp; readonly label: string }> = [
  { re: /runner has received a shutdown signal|lost communication with the (server|runner)/i, label: "runner lost/shutdown" },
  { re: /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH/i, label: "network error" },
  { re: /out of memory|oom[- ]?killed|exit code 137\b/i, label: "OOM" },
  {
    re: /\btimed out after \d+ms|has exceeded the maximum execution time|the operation was canceled\b/i,
    label: "timeout",
  },
  // Flow 307 evaluation found this exact shape on a real self-hosted macOS
  // runner (`bun install` failing to parse a dependency's own package.json):
  // a corrupted install cache/lockfile state unrelated to the code under test.
  { re: /failed to enqueue lifecycle scripts|parsererror[\s\S]{0,120}package\.json/i, label: "dependency-install corruption" },
];

/** AC1(d)'s "timeout" marker specifically — used to decide `logMarkers.timeout` below. */
const TIMEOUT_LABEL = "timeout";

export interface CiTriageSignals {
  readonly rerun: { readonly attemptsChecked: number; readonly samePassedOnPriorAttempt: boolean };
  readonly history: {
    readonly windowSize: number;
    readonly runsInspected: number;
    readonly sameTestFailuresOnOtherBranches: number;
    readonly sameTestFailuresThenPassed: number;
  };
  readonly diff: {
    readonly changedFileCount: number;
    readonly touchesFailingFile: boolean;
    readonly touchesFailingDir: boolean;
    readonly touchesImportedFile: boolean;
  };
  readonly logMarkers: { readonly infra: readonly string[]; readonly timeout: boolean };
  readonly sameHeadLaterPassed: boolean;
  /** AC8: set only when the signals ALONE are strong enough to decide the verdict. */
  readonly deterministic?: { readonly verdict: Extract<CiTriageCriterion, "flaky" | "real-regression">; readonly reason: string };
  /** Rendered, ready to place in `state` (via `buildCiTriageState`) or print as advisory evidence (via `renderCiTriageAdvisory`). */
  readonly lines: readonly string[];
}

export type GitShow = (sha: string, filePath: string) => Promise<string | undefined>;

/**
 * Wall-clock ceiling for one `git show` call (flow 307 review, item 1) —
 * shorter than `./ci-port.ts`'s `DEFAULT_GH_SPAWN_TIMEOUT_MS` (30s) because
 * this is a local, offline read (no network round trip), so a hang here is
 * either a huge object or a genuinely broken worktree, not a slow remote.
 */
export const DEFAULT_GIT_SHOW_TIMEOUT_MS = 10_000;

/**
 * The same fake-able shape `./ci-port.ts`'s `CiBunSubprocess`/`CiBunSpawnFn`
 * give `defaultCiSpawn` — reused here so `defaultGitShow`'s timeout/cap
 * degrade path also has a hermetic unit test that spawns nothing real.
 */
export type GitShowBunSpawnFn = CiBunSpawnFn;

/**
 * Builds the real `GitShow` adapter around whatever spawns a process —
 * `Bun.spawn` by default, or an injected fake in a test.
 */
export function makeDefaultGitShow(bunSpawn: GitShowBunSpawnFn = Bun.spawn.bind(Bun) as unknown as GitShowBunSpawnFn): GitShow {
  return async (sha: string, filePath: string): Promise<string | undefined> => {
    try {
      const proc = bunSpawn(["git", "show", `${sha}:${filePath}`], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: DEFAULT_GIT_SHOW_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: CI_SPAWN_OUTPUT_CAP_BYTES,
      });
      const [stdout, exitCode] = await Promise.all([proc.stdout === null ? Promise.resolve("") : new Response(proc.stdout).text(), proc.exited]);
      // Killed by our own timeout/output cap (`proc.signalCode` set) never
      // reports `exitCode === 0`, so it already falls through to `undefined`
      // here — no separate branch needed, but named in the doc comment above
      // so the degrade path is not accidental.
      return exitCode === 0 ? stdout : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * `git show <sha>:<path>` — read-only, defaults to a real `git` subprocess;
 * injectable for hermetic tests. Diff proximity is one signal among several
 * (see the file header), never a hard dependency, so this degrades to
 * `undefined` ("not checked") on ANY failure — a timeout, an output-cap kill,
 * a missing path, a spawn error — rather than raising: never hangs, and
 * never fails the whole triage over one signal.
 */
export const defaultGitShow: GitShow = makeDefaultGitShow();

/**
 * Runner-path prefixes (`/home/runner/work/<repo>/<repo>/…`,
 * `/Users/runner/work/<repo>/<repo>/…` — macOS self-hosted legs) strip down
 * to a repo-relative path so log-extracted test paths can be compared against
 * `CiPort.changedFiles`' repo-relative paths. A path that already looks
 * repo-relative (no such prefix) is returned unchanged.
 */
export function normalizeRepoRelativePath(raw: string): string {
  const marker = raw.lastIndexOf("/src/");
  return marker === -1 ? raw.replace(/^\/+/, "") : raw.slice(marker + 1);
}

function stripTestLineSuffix(testName: string): string {
  return testName.replace(/:\d+(?::\d+)?$/, "");
}

/** Best-effort relative-import targets of `content`, resolved against `fileDir` — a heuristic, not a real resolver. */
function extractRelativeImportTargets(content: string, fileDir: string): ReadonlySet<string> {
  const out = new Set<string>();
  const re = /from\s+["'](\.[^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const raw = match[1];
    if (raw === undefined) continue;
    const resolved = path.posix.normalize(path.posix.join(fileDir, raw));
    for (const ext of ["", ".ts", ".tsx"]) out.add(`${resolved}${ext}`);
  }
  return out;
}

function isLaterTimestamp(candidate: string | null, than: string | null): boolean {
  if (candidate === null || than === null) return false;
  const a = Date.parse(candidate);
  const b = Date.parse(than);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}

/**
 * The three run-level reads `computeCiSignals` would otherwise make ONCE PER
 * FAILED JOB even though every one of them answers identically for every job
 * of the same run (flow 307 review, item 2): `priorAttempts`/`changedFiles`/
 * `runsForHeadSha` all key on `runId`/`headSha`, never on `jobName`. A caller
 * triaging several failed jobs from one run (`src/commands/review.ts`'s
 * `runCiTriage`) reads each of these exactly once and passes the same object
 * to every `computeCiSignals` call; a caller triaging a single job (the
 * `--eval` harness) can omit this entirely and let `computeCiSignals` read
 * them itself, unchanged from before this field existed.
 */
export interface CiSignalsPrecomputed {
  readonly priorAttempts?: readonly CiAttemptJobs[];
  readonly changedFiles?: readonly string[];
  readonly runsForHeadSha?: readonly CiRunHistoryEntry[];
  /**
   * Flow 307 followups (item 4): a cache for `port.runInfo` reads of OTHER
   * runs — both the cross-branch-history loop (AC1(b), below) and the
   * same-head loop (AC8, below) call `runInfo` keyed only by that OTHER run's
   * id, which has nothing to do with the job under triage. Without this,
   * triaging several failed jobs of the SAME run repeated every one of those
   * reads once PER JOB. A caller triaging several jobs from one run
   * (`src/commands/review.ts`'s `runCiTriage`) constructs one `Map` and
   * passes the same object — and therefore the same cache — to every
   * `computeCiSignals` call; omitted, each call reads the port directly and
   * caches nothing beyond its own lifetime, unchanged from before this field
   * existed.
   */
  readonly runInfoCache?: Map<string, Promise<CiRunInfo>>;
}

/** AC1: compute every signal for one failed job, through `port` and `gitShow` only — never a write. */
export async function computeCiSignals(
  port: CiPort,
  input: {
    readonly runId: string;
    readonly jobName: string;
    readonly testName: string | undefined;
    readonly rawLog: string;
    readonly headSha: string;
    readonly workflowName: string;
  },
  gitShow: GitShow = defaultGitShow,
  precomputed?: CiSignalsPrecomputed,
): Promise<CiTriageSignals> {
  // Flow 307 followups (item 4): every OTHER-run `runInfo` read below goes
  // through this instead of `port.runInfo` directly, so a shared
  // `precomputed.runInfoCache` (when the caller gave one) is consulted and
  // filled exactly once per run id, no matter how many of THIS run's jobs ask
  // for it. A rejected read is cached too — a run whose job list could not be
  // read stays unreadable for every job asking about it in the same triage,
  // which is the same answer a fresh, uncached read would have given each of
  // them anyway.
  function getRunInfo(runId: string): Promise<CiRunInfo> {
    const cache = precomputed?.runInfoCache;
    if (cache === undefined) {
      return port.runInfo(runId);
    }
    const cached = cache.get(runId);
    if (cached !== undefined) {
      return cached;
    }
    const promise = port.runInfo(runId);
    cache.set(runId, promise);
    return promise;
  }

  // (a) same run, another attempt.
  let attemptsChecked = 0;
  let samePassedOnPriorAttempt = false;
  try {
    const attempts = precomputed?.priorAttempts ?? (await port.priorAttempts(input.runId));
    attemptsChecked = attempts.length;
    for (const attempt of attempts) {
      if (attempt.jobs.some((j) => j.name === input.jobName && j.conclusion === "success")) {
        samePassedOnPriorAttempt = true;
      }
    }
  } catch {
    // Best-effort: no rerun evidence rather than a failed triage.
  }

  // (b) other recent runs failing the SAME test, and whether they later passed.
  let runsInspected = 0;
  let sameTestFailuresOnOtherBranches = 0;
  let sameTestFailuresThenPassed = 0;
  try {
    const history = await port.recentRuns(input.workflowName, CI_SIGNAL_HISTORY_WINDOW);
    const candidates = history.filter((h) => h.runId !== input.runId && h.conclusion === "failure").slice(0, HISTORY_RUNINFO_CAP);
    let logFetches = 0;
    const needle = input.testName !== undefined ? normalizeRepoRelativePath(stripTestLineSuffix(input.testName)) : undefined;
    for (const candidate of candidates) {
      runsInspected += 1;
      let candidateInfo;
      try {
        candidateInfo = await getRunInfo(candidate.runId);
      } catch {
        continue;
      }
      const job = candidateInfo.jobs.find((j) => j.name === input.jobName);
      if (job === undefined || job.conclusion !== "failure") continue;
      if (needle === undefined || logFetches >= HISTORY_LOG_FETCH_CAP) continue;
      logFetches += 1;
      let log: string;
      try {
        log = await port.failedLog(candidate.runId);
      } catch {
        continue;
      }
      if (log.includes(needle)) {
        sameTestFailuresOnOtherBranches += 1;
        const laterPass = history.some(
          (h) => h.headBranch === candidate.headBranch && h.conclusion === "success" && isLaterTimestamp(h.createdAt, candidate.createdAt),
        );
        if (laterPass) sameTestFailuresThenPassed += 1;
      }
    }
  } catch {
    // Best-effort: no history evidence rather than a failed triage.
  }

  // (c) diff proximity: this commit's changed files vs. the failing test's
  // file/dir/imports. An empty `headSha` names no commit at all — `gh api
  // repos/.../commits/` and `git show <sha>:<path>` both need a real sha, so
  // this step is skipped outright rather than spent on a read that could
  // only ever answer empty/undefined (flow 307 review, minor).
  let changedFileCount = 0;
  let touchesFailingFile = false;
  let touchesFailingDir = false;
  let touchesImportedFile = false;
  try {
    if (input.headSha !== "") {
      const changed = precomputed?.changedFiles ?? (await port.changedFiles(input.headSha));
      changedFileCount = changed.length;
      if (input.testName !== undefined) {
        const testPath = normalizeRepoRelativePath(stripTestLineSuffix(input.testName));
        touchesFailingFile = changed.includes(testPath);
        const dir = path.posix.dirname(testPath);
        touchesFailingDir = !touchesFailingFile && changed.some((f) => path.posix.dirname(f) === dir);
        if (!touchesFailingFile && !touchesFailingDir) {
          const content = await gitShow(input.headSha, testPath);
          if (content !== undefined) {
            const imports = extractRelativeImportTargets(content, dir);
            touchesImportedFile = changed.some((f) => imports.has(f));
          }
        }
      }
    }
  } catch {
    // Best-effort: no diff evidence rather than a failed triage.
  }

  // (d) timeout/infra markers, over the log already in hand — no extra read.
  const infra = INFRA_LOG_MARKERS.filter((m) => m.re.test(input.rawLog)).map((m) => m.label);
  const timeout = infra.includes(TIMEOUT_LABEL);

  // AC8: the same head commit, run again later (a manual re-trigger, not a
  // new push), passing — at the JOB LEVEL (flow 307 review, item 3). A later
  // run that is green AT THE RUN LEVEL does not prove THIS job passed: the
  // run could have skipped it, dropped it, or it could be the one job still
  // failing while everything else went green. Only a same-named job that
  // itself concluded "success" in that later run counts as verified evidence
  // — read through the existing read-only `runInfo`, never a new API shape.
  // When a later run is green at run level but the job cannot be confirmed
  // (missing/skipped in it, or its own `runInfo` read fails), the
  // deterministic override is withheld; an advisory-only evidence line is
  // still added, printed by `renderCiTriageAdvisory` but never promoted to a
  // forced "flaky" verdict.
  let sameHeadLaterPassed = false;
  let sameHeadLaterPassedRunId: string | undefined;
  let sameHeadRunLevelGreenUnverified = false;
  // Post-merge review gap (flow 307 followups, item 2): several jobs can
  // share one `name` in the same run (a matrix leg, a reused workflow) —
  // `.find()` used to pick whichever one happened to come first and treat ITS
  // conclusion as authoritative, which could credit a rerun as "passed" off a
  // DIFFERENT job of the same name than the one that actually failed. Ambiguous
  // is treated the same as unreadable: no override, advisory line only.
  let sameHeadJobNameAmbiguous = false;
  let sameHeadPaginationGapLine: string | undefined;
  try {
    const runs = precomputed?.runsForHeadSha ?? (await port.runsForHeadSha(input.headSha, input.workflowName));
    const current = runs.find((r) => r.runId === input.runId);
    // Post-merge review gap (flow 307 followups, item 3): `runsForHeadSha` is
    // capped/paginated (`-L 10` in the live `gh run list` adapter) and can
    // come back without the triaged run's OWN entry in it at all. The old
    // filter's `current === undefined || isLaterTimestamp(...)` short-
    // circuited to "every success in the list counts as later" whenever that
    // happened — which could credit a run that actually ran BEFORE this one
    // (just missing from this particular page) as same-head rerun evidence.
    // With no baseline timestamp for THIS run, "later" cannot be answered, so
    // the whole signal is skipped rather than guessed; `sameHeadCurrentRunMissing`
    // below still surfaces this as an advisory line when there was evidence to skip.
    const sameHeadCurrentRunMissing = current === undefined && runs.length > 0;
    const laterGreenRuns =
      current === undefined ? [] : runs.filter((r) => r.runId !== input.runId && r.conclusion === "success" && isLaterTimestamp(r.createdAt, current.createdAt));
    for (const laterRun of laterGreenRuns) {
      try {
        const laterInfo = await getRunInfo(laterRun.runId);
        const matchingJobs = laterInfo.jobs.filter((j) => j.name === input.jobName);
        if (matchingJobs.length > 1) {
          sameHeadJobNameAmbiguous = true;
          continue;
        }
        const job = matchingJobs[0];
        if (job !== undefined && job.conclusion === "success") {
          sameHeadLaterPassed = true;
          sameHeadLaterPassedRunId = laterRun.runId;
          break;
        }
      } catch {
        // This later run's own job list could not be read; keep checking the others.
      }
    }
    if (!sameHeadLaterPassed && !sameHeadJobNameAmbiguous && laterGreenRuns.length > 0) {
      sameHeadRunLevelGreenUnverified = true;
    }
    if (sameHeadCurrentRunMissing) {
      sameHeadPaginationGapLine =
        "same head: other run(s) of this exact commit were found, but this run's own entry was not among them " +
        "(pagination) — cannot tell whether they are later, so no override applied.";
    }
  } catch {
    // Best-effort: no same-head evidence rather than a failed triage.
  }

  const deterministic: CiTriageSignals["deterministic"] = samePassedOnPriorAttempt
    ? { verdict: "flaky", reason: `job "${input.jobName}" passed on an earlier attempt of this same run (run ${input.runId}).` }
    : sameHeadLaterPassed
      ? {
          verdict: "flaky",
          reason:
            `a later run of the exact same commit (head ${input.headSha.slice(0, 7)}, run ${sameHeadLaterPassedRunId}) had job ` +
            `"${input.jobName}" itself conclude success.`,
        }
      : undefined;

  const lines = [
    `rerun: ${attemptsChecked} prior attempt(s) of this run checked; ` +
      (samePassedOnPriorAttempt ? "the SAME job passed on an earlier attempt." : "no earlier attempt of this job passed."),
    `history: of ${runsInspected} other recent failed run(s) inspected (window ${CI_SIGNAL_HISTORY_WINDOW}), ` +
      `${sameTestFailuresOnOtherBranches} failed the SAME test` +
      (sameTestFailuresOnOtherBranches > 0 ? `, and ${sameTestFailuresThenPassed} of those later passed.` : "."),
    `diff: ${changedFileCount} file(s) changed by this commit; ` +
      (touchesFailingFile
        ? "the commit changes the failing test file itself."
        : touchesFailingDir
          ? "the commit changes a file in the failing test's own directory."
          : touchesImportedFile
            ? "the commit changes a file the failing test imports."
            : "the commit does not touch the failing test file, its directory, or (best-effort) anything it imports."),
    `log markers: ${infra.length > 0 ? infra.join(", ") : "none detected"}.`,
    ...(sameHeadLaterPassed
      ? [`same head: a later run of this exact commit passed, and job "${input.jobName}" itself concluded success in it.`]
      : sameHeadJobNameAmbiguous
        ? [
            `same head: a later run of this exact commit was green at run level, but more than one job was named ` +
              `"${input.jobName}" in it — which one is authoritative cannot be told apart, so no override applied.`,
          ]
        : sameHeadRunLevelGreenUnverified
          ? [
              `same head: a later run of this exact commit was green at run level, but job "${input.jobName}" could not be ` +
                "confirmed to have passed in it (missing, skipped, or unreadable) — no override applied.",
            ]
          : sameHeadPaginationGapLine !== undefined
            ? [sameHeadPaginationGapLine]
            : []),
  ];

  return {
    rerun: { attemptsChecked, samePassedOnPriorAttempt },
    history: { windowSize: CI_SIGNAL_HISTORY_WINDOW, runsInspected, sameTestFailuresOnOtherBranches, sameTestFailuresThenPassed },
    diff: { changedFileCount, touchesFailingFile, touchesFailingDir, touchesImportedFile },
    logMarkers: { infra, timeout },
    sameHeadLaterPassed,
    ...(deterministic !== undefined ? { deterministic } : {}),
    lines,
  };
}

/**
 * AC8: fold {@link CiTriageSignals.deterministic} into a verdict Jev already
 * scored. Jev's `probabilities` (and its own `top`, when there is no
 * deterministic override) are always returned untouched — this only ever
 * overrides `top`/`topProbability` to point at the criterion the signals
 * decided, and adds the `deterministic` reason `renderCiTriageAdvisory`
 * prints. No signals → the verdict is returned exactly as Jev produced it.
 */
export function applyDeterministicOverride(verdict: CiTriageVerdict, signals: CiTriageSignals): CiTriageVerdict {
  if (signals.deterministic === undefined) return verdict;
  const { verdict: forcedTop, reason } = signals.deterministic;
  return { ...verdict, top: forcedTop, topProbability: verdict.probabilities[forcedTop], deterministic: { reason } };
}
