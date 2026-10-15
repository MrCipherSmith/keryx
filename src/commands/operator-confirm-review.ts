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
// The waiver tools record the waiver only. Closing the review is still `keryx review complete`, which finds the waiver in
// the package and passes the gate; the CLI flags record the waiver and close in one run.
//
// Every card is built from the package on disk, never from the model's input alone, and `apply` refuses when the package
// moved between the card and the yes.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { githubAdapter, githubPostReview, githubPrFiles } from "../flow/tracker/github";
import { placeReviewPath } from "../lib/review-path-flags";
import { DEFAULT_BLAST_RADIUS_MAX_FILES } from "../review/blast-radius";
import { answerChunkEstimate, chunkModeOf, estimateChunkRun, recordChunkEstimate } from "../review/chunks-estimate";
import { computeCoverage, recordCoverageWaiver } from "../review/coverage-complete";
import { resolveReviewPackagePath } from "../review/managed";
import { publishReview, reviewEvent, type PostResult, type ReviewEvent } from "../review/publish";
import { computeReadiness, readinessItemId, waiveReadiness, type ReadinessOptions } from "../review/readiness";
import type { PrLookup } from "../review/complete-head-gate";
import type { OperatorApplyResult, OperatorCardResult, OperatorConfirmSpec } from "./operator-confirm-tools";

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
        const estimate = await estimateChunkRun(dir, ctx.projectRoot);
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
      const estimate = await estimateChunkRun(prepared.dir, ctx.projectRoot);
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

type PublishPrepared = { dir: string; body: string; event: ReviewEvent; partial: boolean };

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
        const preview = bodyLines.slice(0, BODY_PREVIEW_LINES).map((line) => `  ${line.length > BODY_PREVIEW_CHARS ? `${line.slice(0, BODY_PREVIEW_CHARS)}…` : line}`);
        const failing = result.readiness.items.filter((item) => item.status === "fail").map((item) => item.id);
        const name = label(dir, ctx.projectRoot);
        return {
          title: `Post this ${result.event} review${result.partial ? " (PARTIAL)" : ""} to ${target}?`,
          lines: [
            `target: ${target}`,
            `verdict: ${result.event}`,
            result.partial ? `partial: yes — readiness is failing: ${failing.join(", ")}` : "partial: no — the readiness checklist passes",
            `body: ${result.body.length} characters, ${bodyLines.length} lines; the first ${Math.min(BODY_PREVIEW_LINES, bodyLines.length)}:`,
            ...preview,
            "yes: the review is posted to GitHub and cannot be taken back from here",
          ],
          subject: `${target} (package ${name})`,
          prepared: { dir, body: result.body, event: result.event, partial: result.partial },
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
        // Only the body the operator saw is posted.
        confirm: async (body) => {
          changed = body !== prepared.body;
          return !changed;
        },
      });
      if (!result.posted) {
        return { output: changed ? "The review body changed after the card was shown; nothing was posted. Ask again." : "review not published", isError: true };
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
            ...listFiles(files),
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
            `item ${item.number} ${item.id}: ${item.title}`,
            `failing: ${item.evidence}`,
            ...(item.repair === undefined ? [] : [`repair would be: ${item.repair}`]),
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

/** The four specs with the tracker seams a test replaces; `reviewConfirmSpecs()` is this with the CLI's defaults. */
export function buildReviewConfirmSpecs(seams: ReviewConfirmSeams = {}): readonly OperatorConfirmSpec[] {
  return [chunksAnswerSpec(), publishSpec(seams), waiveCoverageSpec(), waiveReadinessSpec(seams)] as readonly OperatorConfirmSpec[];
}

export function reviewConfirmSpecs(): readonly OperatorConfirmSpec[] {
  return buildReviewConfirmSpecs();
}
