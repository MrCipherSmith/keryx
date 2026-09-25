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
// or merges anything — every exported function is pure text/data, and the
// only IO this module performs is a read of `.metaproject/tasks.config.json`
// (the opt-in gate) and `redactSensitiveText` over a string already in
// memory. The CI read port (`./ci-port.ts`) has no write method at all.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "./cost";
import { redactSensitiveText } from "../security/redact";
import { REVIEW_GATE_CONFIG_PATH } from "../flow/review-gate";

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

/** One `noul` question per {@link CI_TRIAGE_CRITERIA} entry — see the file header for why not one `choice` question. */
export function buildCiTriageQuestions(): Readonly<Record<CiTriageCriterion, CiTriageQuestion>> {
  return {
    flaky: { type: "noul", instructions: CRITERION_INSTRUCTIONS.flaky },
    infra: { type: "noul", instructions: CRITERION_INSTRUCTIONS.infra },
    "real-regression": { type: "noul", instructions: CRITERION_INSTRUCTIONS["real-regression"] },
  };
}

/**
 * The bounded, redacted `state` text (AC11). `redactSensitiveText` runs
 * BEFORE truncation: truncating first could cut a secret in half at the
 * truncation point and let the redactor miss the half that remained, so
 * nothing leaves this function un-redacted regardless of where the tail cut
 * falls.
 */
export function buildCiTriageState(input: { readonly testName: string; readonly jobName: string; readonly rawLog: string }): string {
  const redacted = redactSensitiveText(input.rawLog);
  const tail = redacted.length > CI_TRIAGE_LOG_CHARS ? redacted.slice(-CI_TRIAGE_LOG_CHARS) : redacted;
  return [`job: ${input.jobName}`, `failing test: ${input.testName}`, "", "log excerpt (tail, redacted before leaving this machine):", tail].join(
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

/** The advisory text (AC7/AC12): console or PR-comment text, always labelled advisory. */
export function renderCiTriageAdvisory(input: {
  readonly runId: string;
  readonly jobName: string;
  readonly testName?: string;
  readonly verdict: CiTriageVerdict;
}): string {
  const { runId, jobName, testName, verdict } = input;
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  return [
    `# CI triage (advisory) — run ${runId}, job ${jobName}${testName !== undefined ? `, test ${testName}` : ""}`,
    "",
    `top: ${verdict.top} (≈${pct(verdict.topProbability)})`,
    ...CI_TRIAGE_CRITERIA.map((criterion) => `  ${criterion}: ${pct(verdict.probabilities[criterion])}`),
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
