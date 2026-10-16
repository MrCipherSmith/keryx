// Operator-confirmed gate tools (review gates) — flow 456. Each spec is registered through operatorConfirmSpecs().
//
// Four decisions only the operator may take, each asked as a yes/no card in the shell and applied in process through the
// SAME library function its CLI counterpart calls (the CLI path needs a TTY, which `shell_exec` does not have):
//
//   review_chunks_answer    keryx review chunks estimate --answer yes|no --quote   -> answerChunkEstimate
//   review_publish          keryx review publish [--partial]                       -> publishReview
//   review_waive_coverage   keryx review complete --waive-coverage "<quote>"       -> recordCoverageWaiver
//   review_waive_readiness  keryx review complete --waive <item> "<quote>"         -> waiveReadiness
//
// Flow 457 (T7) adds four more, each with a terminal counterpart that refuses without a TTY:
//
//   review_waive_mutation      keryx review waive-mutation --package --reason          -> recordOperatorDecision
//   review_override_reviewers  keryx review override-reviewers --package --reason      -> recordOperatorDecision
//   review_comments_reply      keryx review comments reply --final                     -> commentsReplyPass
//   review_confirm_plan        keryx review confirm-plan --package                     -> recordPlanConfirmation
//
// Flow 459 adds one more: review_decide_premise (keryx review decide-premise --package --finding --answer --reason ->
// recordPremiseDecision), the operator's answer to a finding the premise judge held.
//
// The waiver tools record the waiver only. Closing the review is still `keryx review complete`, which finds the waiver in
// the package and passes the gate; the CLI flags record the waiver and close in one run.
//
// Every card is built from the package on disk, never from the model's input alone, and `apply` refuses when the package
// moved between the card and the yes.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { cardSafe } from "../trigger/schedules";
import { githubAdapter, githubPostReview, githubPrFiles } from "../flow/service";
import { placeReviewPath } from "../lib/review-path-flags";
import { DEFAULT_BLAST_RADIUS_MAX_FILES } from "../review/blast-radius";
import { readChunkPlan } from "../review/chunks";
import { answerChunkEstimate, chunkModeOf, estimateChunkRun, recordChunkEstimate } from "../review/chunks-estimate";
import { computeCoverage, recordCoverageWaiver } from "../review/coverage-complete";
import { resolveReviewPackagePath } from "../review/managed";
import { publishReview, reviewEvent, type PostResult, type ReviewEvent } from "../review/publish";
import { computeReadiness, readinessItemId, waiveReadiness, type ReadinessOptions } from "../review/readiness";
import type { PrLookup } from "../review/complete-head-gate";
import type { OperatorApplyResult, OperatorCardResult, OperatorConfirmSpec } from "./operator-confirm-tools";
import { operatorDecisionSubject, reviewersLeftOut } from "../review/coverage";
import { recordOperatorDecision, recordPremiseDecision, type OperatorDecisionKind, type OperatorDecisionSubject } from "../review/operator-decisions";
import { findHeldFinding } from "../review/premise-question";
import { estimatePlan, planKeyOf, planOverThreshold, recordPlanConfirmation } from "../review/plan-confirmation";

/** What the specs read outside the package: the PR tracker. Tests replace these; the defaults are the CLI's. */
export interface ReviewConfirmSeams {
  prLookup?: PrLookup;
  prFiles?: (ref: string) => Promise<string[] | null>;
  postReview?: (ref: string, event: ReviewEvent, body: string) => Promise<PostResult>;
}

const LISTED_FILES = 15;
const BODY_PREVIEW_LINES = 8;
const BODY_PREVIEW_CHARS = 140;

async function trackerPrLookup(ref: string): Promise<Awaited<ReturnType<PrLookup>>> {
  if (!(await githubAdapter.detect())) return null;
  return githubAdapter.prStatus(ref);
}

const packageSchema = { type: "string", description: "The review package: its directory or its review id." } as const;

function packageRef(input: Record<string, unknown>): string | undefined {
  const value = input["package"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The package directory, confined to the project like the CLI's `--package`; a bare review id is looked up. */
async function resolvePackage(ref: string, projectRoot: string): Promise<string> {
  const placed = placeReviewPath("chunks", "--package", ref, { projectRoot, cwd: projectRoot });
  if (placed.ok && placed.path !== "-" && existsSync(placed.path) && statSync(placed.path).isDirectory()) return placed.path;
  if (/[\\/]/.test(ref)) throw new Error(placed.ok ? `${ref} is not a directory.` : placed.message);
  return resolveReviewPackagePath(projectRoot, ref);
}

const label = (dir: string, projectRoot: string): string => path.relative(projectRoot, dir) || ".";

const failed = (error: unknown): { refusal: string } => ({ refusal: error instanceof Error ? error.message : String(error) });

function listFiles(files: readonly string[]): string[] {
  const shown = files.slice(0, LISTED_FILES).map((file) => `  ${file}`);
  return files.length > LISTED_FILES ? [...shown, `  … and ${files.length - LISTED_FILES} more`] : shown;
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. review_chunks_answer

type ChunksPrepared = { dir: string; planKey: string; answer: "yes" | "no" };

function chunksAnswerSpec(): OperatorConfirmSpec<ChunksPrepared> {
  return {
    name: "review_chunks_answer",
    description:
      "Record the operator's answer to the chunk-run question: a blast-radius chunk run needs more review passes than the ceiling allows. " +
      "Pass the review package and the answer you are asking for (yes lifts the ceiling for this plan, no stops the run). Same effect as `keryx review chunks estimate --answer`.",
    inputSchema: {
      type: "object",
      properties: { package: packageSchema, answer: { type: "string", enum: ["yes", "no"], description: "The answer to record if the operator confirms." } },
      required: ["package", "answer"],
      additionalProperties: false,
    },
    async buildCard(input, ctx): Promise<OperatorCardResult<ChunksPrepared>> {
      const ref = packageRef(input);
      const answer = input["answer"];
      if (ref === undefined) return { refusal: "package is required" };
      if (answer !== "yes" && answer !== "no") return { refusal: 'answer must be "yes" or "no"' };
      try {
        const dir = await resolvePackage(ref, ctx.projectRoot);
        // Read-only: asking must not write `chunks.json` into the package.
        if ((await readChunkPlan(dir)) === undefined) {
          return { refusal: `No chunk plan exists yet for ${label(dir, ctx.projectRoot)}. Run \`keryx review chunks plan --package <dir>\` first (it writes chunks.json), then ask again.` };
        }
        const estimate = await estimateChunkRun(dir, ctx.projectRoot, undefined, { readOnly: true });
        if (estimate === null) return { refusal: "No chunks: the blast radius dropped no files, so there is nothing to run and nothing to answer." };
        if (!estimate.overCeiling) {
          return { refusal: `The chunk run needs ${estimate.chunks} pass(es), within the ceiling of ${estimate.maxPasses}: it goes ahead without a question.` };
        }
        const name = label(dir, ctx.projectRoot);
        const over = estimate.chunks - estimate.maxPasses;
        return {
          title:
            answer === "yes"
              ? `Allow ${estimate.chunks} review passes, over the ${estimate.maxPasses}-pass ceiling, for ${name}?`
              : `Stop the ${estimate.chunks}-pass chunk run, over the ${estimate.maxPasses}-pass ceiling, for ${name}?`,
          lines: [
            `passes requested: ${estimate.chunks} (${estimate.files} files, at most ${DEFAULT_BLAST_RADIUS_MAX_FILES} per pass)`,
            `ceiling: ${estimate.maxPasses} passes (${estimate.ceilingFiles} files), from ${estimate.limitsSource === "default" ? "the default" : "routing.config.json"}; ${over} over`,
            `estimate: ~${estimate.tokens.input} input + ~${estimate.tokens.output} output tokens, ~$${estimate.costUsd.toFixed(2)}, ~${Math.round(estimate.seconds / 60)} min`,
            answer === "yes"
              ? "yes: the run may hand out chunks past the ceiling, for this chunk plan only"
              : "yes: the run is recorded as declined and no chunk runs",
          ],
          subject: `package ${name}`,
          prepared: { dir, planKey: estimate.planKey, answer },
        };
      } catch (error) {
        return failed(error);
      }
    },
    async apply(_input, ctx, confirmation, prepared): Promise<OperatorApplyResult> {
      if (prepared === undefined) return { output: "review_chunks_answer: nothing prepared for this card", isError: true };
      const estimate = await estimateChunkRun(prepared.dir, ctx.projectRoot, undefined, { readOnly: true });
      if (estimate === null || estimate.planKey !== prepared.planKey) {
        return { output: "The chunk plan changed after the card was shown; nothing was recorded. Ask again.", isError: true };
      }
      // The CLI records the estimate before it answers (`chunks estimate`), so a first answer finds a record to extend.
      await recordChunkEstimate(prepared.dir, estimate, chunkModeOf(prepared.dir));
      const record = await answerChunkEstimate(prepared.dir, prepared.answer, confirmation.quote, new Date(confirmation.at), confirmation.confirmedVia);
      return { output: `chunk run answered ${record.answer?.value ?? prepared.answer} by the operator (${confirmation.confirmedVia}, ${confirmation.at}); ${estimate.chunks} pass(es) against a ceiling of ${estimate.maxPasses}` };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. review_publish

type PublishPrepared = { dir: string; body: string; ref: string; event: ReviewEvent; partial: boolean };

function publishSpec(seams: ReviewConfirmSeams): OperatorConfirmSpec<PublishPrepared> {
  const readiness = (): ReadinessOptions => ({ prLookup: seams.prLookup ?? trackerPrLookup, prFiles: seams.prFiles ?? githubPrFiles });
  const post = (): ((ref: string, event: ReviewEvent, body: string) => Promise<PostResult>) => seams.postReview ?? githubPostReview;
  return {
    name: "review_publish",
    description:
      "Post a finished review to its pull request on GitHub. Pass the review package, optionally the event (COMMENT, REQUEST_CHANGES, APPROVE; default COMMENT) and partial=true to post a review whose readiness checklist still has failing items (the page then says what is missing). " +
      "Same effect as `keryx review publish`; the operator sees the target, the verdict and the start of the body first.",
    inputSchema: {
      type: "object",
      properties: {
        package: packageSchema,
        event: { type: "string", enum: ["COMMENT", "REQUEST_CHANGES", "APPROVE"], description: "The review verdict; default COMMENT." },
        partial: { type: "boolean", description: "Post despite failing readiness items, labelled as a partial review." },
      },
      required: ["package"],
      additionalProperties: false,
    },
    async buildCard(input, ctx): Promise<OperatorCardResult<PublishPrepared>> {
      const ref = packageRef(input);
      if (ref === undefined) return { refusal: "package is required" };
      try {
        const event = reviewEvent(typeof input["event"] === "string" ? input["event"] : undefined);
        const partialAsked = input["partial"] === true;
        const dir = await resolvePackage(ref, ctx.projectRoot);
        let target = "";
        // A dry run of the real function: it checks readiness, builds the body and asks `confirm`, which declines.
        const result = await publishReview(dir, {
          event,
          partial: partialAsked,
          readiness: readiness(),
          post: async () => ({ ok: false, detail: "dry run" }),
          confirm: async (_body, targetRef) => {
            target = targetRef;
            return false;
          },
        });
        const bodyLines = result.body.trimEnd().split(/\r?\n/);
        const preview = bodyLines.slice(0, BODY_PREVIEW_LINES).map((line) => `  ${cardSafe(line.length > BODY_PREVIEW_CHARS ? `${line.slice(0, BODY_PREVIEW_CHARS)}…` : line)}`);
        const failing = result.readiness.items.filter((item) => item.status === "fail").map((item) => item.id);
        const name = label(dir, ctx.projectRoot);
        return {
          title: `Post this ${result.event} review${result.partial ? " (PARTIAL)" : ""} to ${cardSafe(target)}?`,
          lines: [
            `target: ${cardSafe(target)}`,
            `verdict: ${result.event}`,
            result.partial ? `partial: yes — readiness is failing: ${cardSafe(failing.join(", "))}` : "partial: no — the readiness checklist passes",
            `body: ${result.body.length} characters, ${bodyLines.length} lines; the first ${Math.min(BODY_PREVIEW_LINES, bodyLines.length)}:`,
            ...preview,
            "yes: the review is posted to GitHub and cannot be taken back from here",
          ],
          subject: `${cardSafe(target)} (package ${name})`,
          prepared: { dir, body: result.body, ref: target, event: result.event, partial: result.partial },
        };
      } catch (error) {
        return failed(error);
      }
    },
    async apply(_input, _ctx, confirmation, prepared): Promise<OperatorApplyResult> {
      if (prepared === undefined) return { output: "review_publish: nothing prepared for this card", isError: true };
      let changed = false;
      const result = await publishReview(prepared.dir, {
        event: prepared.event,
        partial: prepared.partial,
        readiness: readiness(),
        post: post(),
        now: () => new Date(confirmation.at),
        confirmedVia: confirmation.confirmedVia,
        // Only the body, the target and the verdict the operator saw are posted. The event is fixed from `prepared`
        // above; the target is re-read from the manifest, which a background job may have retargeted.
        confirm: async (body, targetRef) => {
          changed = body !== prepared.body || targetRef !== prepared.ref;
          return !changed;
        },
      });
      if (!result.posted) {
        return { output: changed ? "The review body or target changed after the card was shown; nothing was posted. Ask again." : "review not published", isError: true };
      }
      return { output: `published: ${result.event}${result.partial ? " (partial review)" : ""} (${confirmation.confirmedVia}, ${confirmation.at})` };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. review_waive_coverage

type CoveragePrepared = { dir: string; files: string[] };

function waiveCoverageSpec(): OperatorConfirmSpec<CoveragePrepared> {
  return {
    name: "review_waive_coverage",
    description:
      "Accept that the in-scope files no review slice or chunk covered stay unreviewed, so `keryx review complete` passes its coverage gate. Pass the review package. " +
      "Same effect as `keryx review complete --waive-coverage`: records the waiver (the operator's yes, the time, the files); run `keryx review complete` afterwards to close the review.",
    inputSchema: { type: "object", properties: { package: packageSchema }, required: ["package"], additionalProperties: false },
    async buildCard(input, ctx): Promise<OperatorCardResult<CoveragePrepared>> {
      const ref = packageRef(input);
      if (ref === undefined) return { refusal: "package is required" };
      try {
        const dir = await resolvePackage(ref, ctx.projectRoot);
        const report = await computeCoverage(dir);
        const files = report.files.filter((entry) => entry.status === "uncovered").map((entry) => entry.file);
        if (!report.tracked) return { refusal: "Coverage is not tracked for this package (no slice manifest, no dropped blast-radius files): there is nothing to waive." };
        if (files.length === 0) return { refusal: "No in-scope file is uncovered: there is nothing to waive." };
        const name = label(dir, ctx.projectRoot);
        return {
          title: `Accept ${files.length} uncovered file(s) as not reviewed in ${name}?`,
          lines: [
            `${files.length} of ${report.counts.inScope} in-scope files were not looked at by any slice or chunk:`,
            ...listFiles(files.map(cardSafe)),
            "yes: review complete will pass its coverage gate, and the package records that these files were not reviewed",
          ],
          subject: `package ${name}`,
          prepared: { dir, files },
        };
      } catch (error) {
        return failed(error);
      }
    },
    async apply(_input, _ctx, confirmation, prepared): Promise<OperatorApplyResult> {
      if (prepared === undefined) return { output: "review_waive_coverage: nothing prepared for this card", isError: true };
      const now = (await computeCoverage(prepared.dir)).files.filter((entry) => entry.status === "uncovered").map((entry) => entry.file);
      if (now.length !== prepared.files.length || now.some((file, index) => file !== prepared.files[index])) {
        return { output: "The uncovered files changed after the card was shown; nothing was recorded. Ask again.", isError: true };
      }
      const waiver = await recordCoverageWaiver(prepared.dir, confirmation.quote, new Date(confirmation.at), confirmation.confirmedVia);
      if (waiver === undefined) return { output: "No coverage waiver was recorded: the package holds no dispatch record or nothing is uncovered.", isError: true };
      return { output: `coverage waived by the operator (${waiver.confirmedVia ?? "unknown"}, ${waiver.time}): ${waiver.files.length} file(s) not reviewed. Run \`keryx review complete\` to close the review.` };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. review_waive_readiness

type ReadinessPrepared = { dir: string; item: string; evidence: string };

function waiveReadinessSpec(seams: ReviewConfirmSeams): OperatorConfirmSpec<ReadinessPrepared> {
  const readiness = (): ReadinessOptions => ({ prLookup: seams.prLookup ?? trackerPrLookup, prFiles: seams.prFiles ?? githubPrFiles });
  return {
    name: "review_waive_readiness",
    description:
      "Accept one failing item of the review readiness checklist as it is, so the review can complete or be published as a partial review. Pass the review package and the item (its number or id). " +
      "Same effect as `keryx review complete --waive <item>`: records the waiver (the operator's yes, the time) in the manifest and the report header; run `keryx review complete` afterwards to close the review.",
    inputSchema: {
      type: "object",
      properties: { package: packageSchema, item: { type: "string", description: "The readiness item: its number (1-10) or id, e.g. head or pr-files." } },
      required: ["package", "item"],
      additionalProperties: false,
    },
    async buildCard(input, ctx): Promise<OperatorCardResult<ReadinessPrepared>> {
      const ref = packageRef(input);
      const selector = input["item"];
      if (ref === undefined) return { refusal: "package is required" };
      if (typeof selector !== "string" || selector.trim() === "") return { refusal: "item is required" };
      try {
        const id = readinessItemId(selector);
        if (id === undefined) return { refusal: `"${selector}" is not a readiness item.` };
        const dir = await resolvePackage(ref, ctx.projectRoot);
        const report = await computeReadiness(dir, readiness());
        const item = report.items.find((entry) => entry.id === id);
        if (item === undefined) return { refusal: `"${selector}" is not a readiness item.` };
        if (item.status === "pass") return { refusal: `Readiness item ${item.number} ${item.id} passes: there is nothing to waive.` };
        if (item.status === "waived") return { refusal: `Readiness item ${item.number} ${item.id} is already waived.` };
        const name = label(dir, ctx.projectRoot);
        return {
          title: `Accept failing readiness item ${item.number} (${item.id}) of ${name} as it is?`,
          lines: [
            `item ${item.number} ${item.id}: ${cardSafe(item.title)}`,
            `failing: ${cardSafe(item.evidence)}`,
            ...(item.repair === undefined ? [] : [`repair would be: ${cardSafe(item.repair)}`]),
            "yes: the item is recorded as waived by the operator, in the manifest and at the top of the report",
          ],
          subject: `package ${name}, item ${item.id}`,
          prepared: { dir, item: item.id, evidence: item.evidence },
        };
      } catch (error) {
        return failed(error);
      }
    },
    async apply(_input, _ctx, confirmation, prepared): Promise<OperatorApplyResult> {
      if (prepared === undefined) return { output: "review_waive_readiness: nothing prepared for this card", isError: true };
      const current = (await computeReadiness(prepared.dir, readiness())).items.find((entry) => entry.id === prepared.item);
      if (current === undefined || current.status !== "fail" || current.evidence !== prepared.evidence) {
        return { output: "The readiness item changed after the card was shown; nothing was recorded. Ask again.", isError: true };
      }
      const added = await waiveReadiness(prepared.dir, [prepared.item], confirmation.quote, { ...readiness(), now: new Date(confirmation.at), confirmedVia: confirmation.confirmedVia });
      return { output: `readiness item waived by the operator (${confirmation.confirmedVia}, ${confirmation.at}): ${added.map((waiver) => waiver.item).join(", ")}. Run \`keryx review complete\` to close the review.` };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 5-6. review_waive_mutation, review_override_reviewers (flow 457)

type DecisionPrepared = { dir: string; reason: string; detail: string; subject: OperatorDecisionSubject };

const reasonOf = (input: Record<string, unknown>): string | undefined => {
  const value = input["reason"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

function decisionSpec(kind: OperatorDecisionKind): OperatorConfirmSpec<DecisionPrepared> {
  const mutation = kind === "mutation-waiver";
  return {
    name: mutation ? "review_waive_mutation" : "review_override_reviewers",
    description: mutation
      ? "Record the operator's waiver of the mutation pass: the proposed mutants stay unrun and the review records `Not run: mutation pass`. Pass the review package and the reason. " +
        "Same effect as `keryx review waive-mutation` at a terminal. A mutationWaiver quote you write into the dispatch is not accepted on its own."
      : "Record the operator's decision to run a smaller reviewer set than `keryx review required` names (an override, or mode diff). Pass the review package, the reason and, optionally, the reviewers that will run. " +
        "Same effect as `keryx review override-reviewers` at a terminal. An override quote you write into the dispatch is not accepted on its own.",
    inputSchema: {
      type: "object",
      properties: {
        package: packageSchema,
        reason: { type: "string", description: "Why, in a sentence the operator will read." },
        ...(mutation ? {} : { selected: { type: "array", items: { type: "string" }, description: "The reviewers that will run." } }),
      },
      required: ["package", "reason"],
      additionalProperties: false,
    },
    async buildCard(input, ctx): Promise<OperatorCardResult<DecisionPrepared>> {
      const ref = packageRef(input);
      const reason = reasonOf(input);
      if (ref === undefined) return { refusal: "package is required" };
      if (reason === undefined) return { refusal: "reason is required" };
      try {
        const dir = await resolvePackage(ref, ctx.projectRoot);
        const name = label(dir, ctx.projectRoot);
        if (mutation) {
          const subject = await operatorDecisionSubject(dir, kind);
          const pending = subject.items.length;
          if (pending === 0) return { refusal: "No proposed mutant is unrun: there is no mutation pass to waive." };
          return {
            title: `Waive the mutation pass for ${name}: ${pending} proposed mutant(s) stay unrun?`,
            lines: [
              `unrun mutants: ${pending} (research-evidence/mutants.json): ${cardSafe(subject.items.slice(0, LISTED_FILES).join(", "))}${pending > LISTED_FILES ? ` … and ${pending - LISTED_FILES} more` : ""}`,
              `head: ${cardSafe(subject.head ?? "not recorded")}`,
              `reason: ${cardSafe(reason)}`,
              "yes: the review records `Not run: mutation pass` with your words for these mutants at this head; a new head or a new mutant asks again",
            ],
            subject: `package ${name}`,
            prepared: { dir, reason, detail: `${pending} mutant(s)`, subject },
          };
        }
        const selected = Array.isArray(input["selected"]) ? (input["selected"] as unknown[]).filter((v): v is string => typeof v === "string") : undefined;
        const { required } = await reviewersLeftOut(dir, selected);
        const subject = await operatorDecisionSubject(dir, kind, selected);
        const missing = subject.items;
        return {
          title: `Run a smaller reviewer set than required for ${name}?`,
          lines: [
            `required (mode all): ${required.length} reviewer(s)`,
            `head: ${cardSafe(subject.head ?? "not recorded")}`,
            selected === undefined ? "selected: not named" : `selected: ${cardSafe(selected.join(", "))}`,
            `not run: ${cardSafe(missing.slice(0, LISTED_FILES).join(", ") || "none")}${missing.length > LISTED_FILES ? ` … and ${missing.length - LISTED_FILES} more` : ""}`,
            `reason: ${cardSafe(reason)}`,
            "yes: the gate accepts leaving out exactly these reviewers at this head; dropping another one or a new head asks again",
          ],
          subject: `package ${name}`,
          prepared: { dir, reason, detail: missing.join(","), subject },
        };
      } catch (error) {
        return failed(error);
      }
    },
    async apply(input, _ctx, confirmation, prepared): Promise<OperatorApplyResult> {
      if (prepared === undefined) return { output: `${mutation ? "review_waive_mutation" : "review_override_reviewers"}: nothing prepared for this card`, isError: true };
      const selected = Array.isArray(input["selected"]) ? (input["selected"] as unknown[]).filter((v): v is string => typeof v === "string") : undefined;
      const again = await operatorDecisionSubject(prepared.dir, kind, mutation ? undefined : selected);
      if (JSON.stringify(again) !== JSON.stringify(prepared.subject)) {
        return { output: "The head, the unrun mutants or the reviewer set changed after the card was shown; nothing was recorded. Ask again.", isError: true };
      }
      await recordOperatorDecision(prepared.dir, { kind, quote: confirmation.quote, reason: prepared.reason, confirmedVia: confirmation.confirmedVia, at: confirmation.at, subject: prepared.subject });
      return { output: `${mutation ? "mutation pass waived" : "reviewer-set override recorded"} by the operator (${confirmation.confirmedVia}, ${confirmation.at}) in operator-decisions.json` };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. review_comments_reply (flow 457)

type ReplyPrepared = { argv: string[]; requests: string };

const REPLY_PREVIEW = 6;

function replyArgv(input: Record<string, unknown>): string[] | { refusal: string } {
  const repo = input["repo"];
  const pr = input["pr"];
  const sha = input["sha"];
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { refusal: "repo must be <owner>/<repo>" };
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) return { refusal: "pr must be the pull request number" };
  if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(sha)) return { refusal: "sha must be the pull request head commit" };
  const argv = ["--repo", repo, "--pr", String(pr), "--sha", sha, "--final"];
  for (const [key, flag] of [["outcomes", "--outcomes"], ["review", "--review"], ["result", "--result"], ["flow_link", "--flow-link"]] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") argv.push(flag, value.trim());
  }
  if (typeof input["round"] === "number") argv.push("--round", String(input["round"]));
  return argv;
}

function replySpec(): OperatorConfirmSpec<ReplyPrepared> {
  return {
    name: "review_comments_reply",
    description:
      "Post the final review-comment replies on a pull request (`keryx review comments reply --final`). Pass the repo, the PR number, its head sha, the outcomes file and the review package or result. " +
      "The operator sees every reply before anything is posted.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/repo" },
        pr: { type: "integer", description: "The pull request number." },
        sha: { type: "string", description: "The pull request head commit." },
        outcomes: { type: "string", description: "The outcomes file (--outcomes)." },
        review: { type: "string", description: "The managed review package (--review)." },
        result: { type: "string", description: "The review result file (--result)." },
        round: { type: "integer", description: "The review round (--round)." },
        flow_link: { type: "string", description: "A flow link to add to replies (--flow-link)." },
      },
      required: ["repo", "pr", "sha"],
      additionalProperties: false,
    },
    async buildCard(input): Promise<OperatorCardResult<ReplyPrepared>> {
      const argv = replyArgv(input);
      if (!Array.isArray(argv)) return argv;
      try {
        const { commentsReplyPass } = await import("./review");
        const dry = await commentsReplyPass([...argv], true);
        const requests = dry.result.requests;
        if (requests.length === 0) return { refusal: "The reply pass has nothing to post." };
        const bodies = requests.slice(0, REPLY_PREVIEW).map((request) => `  ${cardSafe(((request.body as { body?: string }).body ?? "").slice(0, BODY_PREVIEW_CHARS))}`);
        return {
          title: `Post ${requests.length} reply(ies) on ${cardSafe(dry.repo)}#${dry.number}?`,
          lines: [`replies: ${requests.length}; the first ${Math.min(REPLY_PREVIEW, requests.length)}:`, ...bodies, "yes: the replies are posted on the pull request and cannot be taken back from here"],
          subject: `${cardSafe(dry.repo)}#${dry.number}`,
          prepared: { argv, requests: JSON.stringify(requests) },
        };
      } catch (error) {
        return failed(error);
      }
    },
    async apply(_input, _ctx, confirmation, prepared): Promise<OperatorApplyResult> {
      if (prepared === undefined) return { output: "review_comments_reply: nothing prepared for this card", isError: true };
      const { commentsReplyPass } = await import("./review");
      const again = await commentsReplyPass([...prepared.argv], true);
      if (JSON.stringify(again.result.requests) !== prepared.requests) return { output: "The replies changed after the card was shown; nothing was posted. Ask again.", isError: true };
      const posted = await commentsReplyPass([...prepared.argv], false);
      return { output: `posted ${posted.result.posted.length} reply(ies) (${confirmation.confirmedVia}, ${confirmation.at}); skipped ${posted.result.skipped.length}` };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 8. review_confirm_plan (flow 457, AC6)

type PlanPrepared = { dir: string; planKey: string };

function confirmPlanSpec(): OperatorConfirmSpec<PlanPrepared> {
  return {
    name: "review_confirm_plan",
    description:
      "Confirm a review plan over the threshold: the operator sees the dispatches and minutes `keryx review estimate` computes and says yes before any wave runs. Pass the review package. " +
      "Same effect as `keryx review confirm-plan` at a terminal; records plan-confirmation.json for exactly this plan.",
    inputSchema: { type: "object", properties: { package: packageSchema }, required: ["package"], additionalProperties: false },
    async buildCard(input, ctx): Promise<OperatorCardResult<PlanPrepared>> {
      const ref = packageRef(input);
      if (ref === undefined) return { refusal: "package is required" };
      try {
        const dir = await resolvePackage(ref, ctx.projectRoot);
        const estimate = await estimatePlan(dir);
        if (!planOverThreshold(estimate)) {
          return { refusal: `The plan needs ${estimate.dispatches} dispatch(es), ${estimate.minutes.min}-${estimate.minutes.max} min: within the threshold (${estimate.thresholds.maxDispatches} dispatches, ${estimate.thresholds.maxMinutes} min), so it runs without a confirmation.` };
        }
        const name = label(dir, ctx.projectRoot);
        return {
          title: `Run ${estimate.dispatches} reviewer dispatches (${estimate.minutes.min}-${estimate.minutes.max} min) for ${name}?`,
          lines: [
            `dispatches: ${estimate.dispatches} (${estimate.roles} roles, ${estimate.slices} slices, ${estimate.sequentialBatches} batch(es) one after another)`,
            `expected duration: ${estimate.minutes.min}-${estimate.minutes.max} min`,
            `threshold: ${estimate.thresholds.maxDispatches} dispatches or ${estimate.thresholds.maxMinutes} min (${estimate.overReasons.join("; ")})`,
            ...estimate.perRole.slice(0, LISTED_FILES).map((role) => `  ${cardSafe(role.role)}: ${role.slices} slice(s), ${role.waves} wave(s)`),
            "yes: this plan may run; a re-cut plan asks again",
          ],
          subject: `package ${name}`,
          prepared: { dir, planKey: planKeyOf(estimate) },
        };
      } catch (error) {
        return failed(error);
      }
    },
    async apply(_input, _ctx, confirmation, prepared): Promise<OperatorApplyResult> {
      if (prepared === undefined) return { output: "review_confirm_plan: nothing prepared for this card", isError: true };
      const estimate = await estimatePlan(prepared.dir);
      if (planKeyOf(estimate) !== prepared.planKey) return { output: "The plan changed after the card was shown; nothing was recorded. Ask again.", isError: true };
      const record = await recordPlanConfirmation(prepared.dir, estimate, { quote: confirmation.quote, confirmedVia: confirmation.confirmedVia, at: confirmation.at });
      return { output: `plan confirmed by the operator (${record.confirmedVia}, ${record.at}): ${record.dispatches} dispatch(es), ${record.minutes[0]}-${record.minutes[1]} min` };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 9. review_decide_premise (flow 459)

type PremisePrepared = { dir: string; finding: string; answer: "uphold" | "dismiss"; reason: string; severity: string; verdict: string };

function decidePremiseSpec(): OperatorConfirmSpec<PremisePrepared> {
  return {
    name: "review_decide_premise",
    description:
      "Record the operator's answer to a finding the premise judge held (verdict challenged or owner-decision): uphold keeps it at its original severity, dismiss records it dismissed-incorrect with the reason as evidence. " +
      "Pass the review package, the finding (its global_id or id), the answer you are asking for and the reason. Same effect as `keryx review decide-premise` at a terminal. A held finding never goes to a fixer before this is answered.",
    inputSchema: {
      type: "object",
      properties: {
        package: packageSchema,
        finding: { type: "string", description: "The held finding: its global_id or id." },
        answer: { type: "string", enum: ["uphold", "dismiss"], description: "The answer to record if the operator confirms." },
        reason: { type: "string", description: "Why, in a sentence the operator will read." },
      },
      required: ["package", "finding", "answer", "reason"],
      additionalProperties: false,
    },
    async buildCard(input, ctx): Promise<OperatorCardResult<PremisePrepared>> {
      const ref = packageRef(input);
      const reason = reasonOf(input);
      const finding = typeof input["finding"] === "string" ? input["finding"].trim() : "";
      const answer = input["answer"];
      if (ref === undefined) return { refusal: "package is required" };
      if (finding === "") return { refusal: "finding is required" };
      if (answer !== "uphold" && answer !== "dismiss") return { refusal: 'answer must be "uphold" or "dismiss"' };
      if (reason === undefined) return { refusal: "reason is required" };
      try {
        const dir = await resolvePackage(ref, ctx.projectRoot);
        const held = await findHeldFinding(dir, finding);
        if (!held.ok) return { refusal: held.refusal };
        const found = held.finding;
        const name = label(dir, ctx.projectRoot);
        return {
          title: answer === "uphold" ? `Uphold finding ${cardSafe(found.key)} in ${name} at ${cardSafe(found.severity)}?` : `Dismiss finding ${cardSafe(found.key)} in ${name} as incorrect?`,
          lines: [
            `finding: ${cardSafe(found.key)} (${cardSafe(found.severity)}): ${cardSafe(found.problem)}`,
            `premise judge: ${cardSafe(found.verdict)}: ${cardSafe(found.question)}`,
            ...(found.answered === undefined ? [] : [`already answered: ${found.answered}; this answer replaces it`]),
            `reason: ${cardSafe(reason)}`,
            answer === "uphold"
              ? `yes: the finding is kept at ${cardSafe(found.severity)} and goes to the fixer again`
              : "yes: the finding is recorded dismissed-incorrect with your reason as the evidence",
          ],
          subject: `package ${name}, finding ${cardSafe(found.key)}`,
          prepared: { dir, finding: found.key, answer, reason, severity: found.severity, verdict: found.verdict },
        };
      } catch (error) {
        return failed(error);
      }
    },
    async apply(_input, _ctx, confirmation, prepared): Promise<OperatorApplyResult> {
      if (prepared === undefined) return { output: "review_decide_premise: nothing prepared for this card", isError: true };
      const again = await findHeldFinding(prepared.dir, prepared.finding);
      if (!again.ok || again.finding.severity !== prepared.severity || again.finding.verdict !== prepared.verdict) {
        return { output: "The finding changed after the card was shown; nothing was recorded. Ask again.", isError: true };
      }
      await recordPremiseDecision(prepared.dir, { kind: "premise-question", finding: prepared.finding, answer: prepared.answer, reason: prepared.reason, at: confirmation.at, actor: "operator", confirmedVia: confirmation.confirmedVia });
      return { output: `premise question on ${prepared.finding} answered ${prepared.answer} by the operator (${confirmation.confirmedVia}, ${confirmation.at}) in operator-decisions.json` };
    },
  };
}

/** The specs with the tracker seams a test replaces; `reviewConfirmSpecs()` is this with the CLI's defaults. */
export function buildReviewConfirmSpecs(seams: ReviewConfirmSeams = {}): readonly OperatorConfirmSpec[] {
  return [
    chunksAnswerSpec(),
    publishSpec(seams),
    waiveCoverageSpec(),
    waiveReadinessSpec(seams),
    decisionSpec("mutation-waiver"),
    decisionSpec("reviewer-override"),
    replySpec(),
    confirmPlanSpec(),
    decidePremiseSpec(),
  ] as readonly OperatorConfirmSpec[];
}

export function reviewConfirmSpecs(): readonly OperatorConfirmSpec[] {
  return buildReviewConfirmSpecs();
}
