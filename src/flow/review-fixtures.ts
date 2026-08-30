/**
 * Managed review packages, written by hand, for tests.
 *
 * TEST SCAFFOLDING. Nothing in the shipped CLI imports this module; the real
 * writer is `createManagedReviewPackage` in `src/review/managed.ts`. It lives in
 * `src/flow/` rather than inside a `.test.ts` file because four test files need
 * it — the review gate's own tests plus the three suites that drive a flow all
 * the way to `complete()` and now have a sixth gate to satisfy — and importing
 * one test file from another would run its tests twice.
 *
 * It deliberately writes the SHAPE the gate reads (`manifest.json`,
 * `findings.json`, `scope.md`) rather than calling the real writer: the gate has
 * to keep working against packages written by earlier keryx versions and by
 * hand, and a fixture that can only produce today's exact output cannot express
 * a package with a missing artifact or a stale head, which is most of what these
 * tests are about.
 *
 * # What this file is NOT evidence of, and what it once concealed
 *
 * **A fixture proves the READER. It can never prove the WRITER.** This one wrote
 * `manifest.target.head` from its `head` option, so 35 tests of the review gate
 * passed against packages carrying a head — while `createManagedReviewPackage`,
 * the only thing that writes a real package, set that property NOWHERE. Every
 * flow the shipping CLI created was therefore un-completable
 * (`head-commit (unobserved)`) and the whole suite was green. The producer was
 * missing and no test over hand-built input could see it.
 *
 * The standing rule that follows: any criterion about what a package CONTAINS
 * needs at least one test that drives the real CLI end to end —
 * `flow init` -> `review ingest` -> `flow complete` — and that test lives in
 * `src/flow/review-gate.e2e.test.ts`. Fixtures stay for the cases a real run
 * cannot produce (a truncated manifest, a stale SHA, a package from an older
 * keryx), which is what they are good at and all they are good for.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { flowsRoot } from "./store";

export type ReviewFixtureFinding = {
  id: string;
  severity?: string;
  reviewer?: string;
  problem?: string;
  file?: string | null;
  global_id?: string;
  dedupe_key?: string;
  disposition?: { state: string; evidence?: string };
  verification?: { verdict: string; method?: string; evidence?: string; verifier?: string };
  source?: string;
  external_ref?: Record<string, unknown>;
};

export type ReviewFixtureOptions = {
  cwd: string;
  flowDir: string;
  reviewId: string;
  createdAt?: string;
  /** `manifest.target.head` — the commit the round ran against. */
  head?: string | null;
  mode?: string;
  coverage?: Array<{ reviewer: string; status: string; reason: string }>;
  findings?: ReviewFixtureFinding[];
  /** `null` writes a `scope.md` with NO `verification_mode:` line at all. */
  verificationMode?: string | null;
  /** Omit `manifest.json`, so the round reads as not ingested. */
  omitManifest?: boolean;
  /** Omit `findings.json`, likewise. */
  omitFindings?: boolean;
  /** Omit `scope.md` entirely. */
  omitScope?: boolean;
};

/** Write one review package into `.metaproject/flows/<flowDir>/reviews/<reviewId>/`. */
export async function writeReviewPackage(options: ReviewFixtureOptions): Promise<string> {
  const dir = path.join(flowsRoot(options.cwd), options.flowDir, "reviews", options.reviewId);
  await mkdir(dir, { recursive: true });

  if (options.omitManifest !== true) {
    const manifest = {
      schemaVersion: 1,
      reviewId: options.reviewId,
      mode: options.mode ?? "ingest",
      status: "reviewed",
      target: {
        kind: "pr",
        ref: "https://github.com/acme/app/pull/1",
        ...(options.head === null || options.head === undefined ? {} : { head: options.head }),
      },
      artifacts: {
        scope: "scope.md",
        coverage: "coverage.md",
        report: "report.md",
        findings: "findings.json",
        learning: "learning.md",
        decisions: "decisions.md",
      },
      coverage: options.coverage ?? [{ reviewer: "review-logic", status: "run", reason: "dispatched" }],
      createdAt: options.createdAt ?? "2026-08-29T10:00:00.000Z",
      updatedAt: options.createdAt ?? "2026-08-29T10:00:00.000Z",
    };
    await writeFileAtomic(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  if (options.omitFindings !== true) {
    const findings = (options.findings ?? []).map((finding) => ({
      id: finding.id,
      reviewer: finding.reviewer ?? "review-logic",
      severity: finding.severity ?? "major",
      problem: finding.problem ?? `problem for ${finding.id}`,
      impact: "impact",
      suggested_fix: "fix",
      evidence: "evidence",
      confidence: "high",
      ...(finding.global_id === undefined ? {} : { global_id: finding.global_id }),
      ...(finding.dedupe_key === undefined ? {} : { dedupe_key: finding.dedupe_key }),
      ...(finding.file === undefined ? {} : { file: finding.file }),
      ...(finding.disposition === undefined ? {} : { disposition: finding.disposition }),
      ...(finding.verification === undefined ? {} : { verification: finding.verification }),
      ...(finding.source === undefined ? {} : { source: finding.source }),
      ...(finding.external_ref === undefined ? {} : { external_ref: finding.external_ref }),
    }));
    await writeFileAtomic(path.join(dir, "findings.json"), `${JSON.stringify(findings, null, 2)}\n`);
  }

  if (options.omitScope !== true) {
    const mode = options.verificationMode === undefined ? "filter" : options.verificationMode;
    const verificationBlock =
      mode === null
        ? "_no verifier ran against this round_"
        : [
            `verification_mode: ${mode}`,
            "claims_received: 1",
            "claims_applied: 1",
            "claims_rejected: 0",
            "verdicts_capped_to_unverifiable: 0",
            "confirmed: 1",
            "refuted: 0",
            "unverifiable: 0",
            "unverified: 0",
            "",
            "### Retained",
            "",
            `findings_in: ${(options.findings ?? []).length}`,
            "findings_removed_by_verifier: 0",
            `findings_retained: ${(options.findings ?? []).length}`,
          ].join("\n");
    await writeFileAtomic(
      path.join(dir, "scope.md"),
      ["# Review Scope", "", "## Stage counts", "", "### Refuted by the verifier", "", verificationBlock, ""].join("\n"),
    );
  }

  return dir;
}

/**
 * The durable external-comment record, as `keryx review comments collect|reply`
 * writes it.
 *
 * Condition 4 reads THIS, and no longer reads `manifest.coverage`: a coverage
 * entry is written straight from `--reviewers`, so naming a collector there
 * satisfied the condition without collecting anything. A test that wants "the
 * collection ran and nothing is outstanding" has to say so where the collector
 * says it.
 *
 * `unanswered` names comments that were seen and never handled — the state the
 * gate must refuse.
 */
export async function writePrCommentFixtureState(input: {
  cwd: string;
  prUrl: string;
  roundsCollected?: number;
  answered?: Array<{ id: string; author?: string; url?: string }>;
  unanswered?: Array<{ id: string; author?: string; url?: string }>;
}): Promise<string> {
  const match = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(input.prUrl);
  if (!match?.[1] || !match[2]) {
    throw new Error(`writePrCommentFixtureState needs a GitHub pull request URL, got: ${input.prUrl}`);
  }
  const repo = match[1];
  const number = Number(match[2]);
  const answered = input.answered ?? [];
  const unanswered = input.unanswered ?? [];
  const seen = [...answered, ...unanswered].map((comment) => ({
    id: comment.id,
    thread_id: null,
    author: comment.author ?? "someone",
    url: comment.url ?? `${input.prUrl}#discussion_r${comment.id}`,
    first_seen_round: 1,
    last_seen_round: 1,
    submitted_at: "2026-08-29T09:00:00.000Z",
  }));
  const state = {
    schemaVersion: 1,
    repo,
    number,
    self: "keryx-bot",
    rounds_collected: input.roundsCollected ?? 1,
    replies_posted_at: answered.length === 0 ? null : "2026-08-29T13:00:00.000Z",
    seen,
    handled_comments: answered.map((comment) => ({
      id: comment.id,
      thread_id: null,
      author: comment.author ?? "someone",
      url: comment.url ?? `${input.prUrl}#discussion_r${comment.id}`,
      first_seen_round: 1,
      handled_at: "2026-08-29T13:00:00.000Z",
      sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      disposition: "answered-disagree",
      reply_url: `${input.prUrl}#issuecomment-${comment.id}`,
      via: "inline",
    })),
    backlog: [],
    escalated: [],
  };
  const file = path.join(input.cwd, ".metaproject", "reviews", "pr-comments", `${repo.replace(/\//g, "__")}__${number}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

/**
 * The shortest package that satisfies all five conditions.
 *
 * Used by the suites whose subject is a DIFFERENT gate and which merely need the
 * review gate out of the way — stated as a satisfied gate rather than as a
 * disabled one, so those suites keep exercising the real path. That includes the
 * external-comment record: `prUrl` is required — `null` for a flow that has no
 * pull request — rather than defaulted, because a flow with a PR and no comment
 * record is a FAILING gate and a helper that silently produced one would be
 * hiding the same defect again.
 */
export async function writeCleanReviewPackage(input: {
  cwd: string;
  flowDir: string;
  head: string;
  /** The flow's PR, or `null` when it has none (the merged-commit path). */
  prUrl: string | null;
  reviewId?: string;
}): Promise<string> {
  if (input.prUrl !== null) {
    await writePrCommentFixtureState({ cwd: input.cwd, prUrl: input.prUrl });
  }
  return writeReviewPackage({
    cwd: input.cwd,
    flowDir: input.flowDir,
    reviewId: input.reviewId ?? "round-1",
    head: input.head,
    findings: [],
    verificationMode: "filter",
    coverage: [{ reviewer: "review-logic", status: "run", reason: "dispatched" }],
  });
}
