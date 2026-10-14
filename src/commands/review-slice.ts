import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { resolveProjectRoot } from "../lib/contained-path";
import { writeFileAtomic } from "../lib/fs";
import { placeReviewPath, reviewPathFlagRefusal } from "../lib/review-path-flags";
import { hasStatus, parseReviewResult } from "../review/ledger";
import { layersSummaryLine } from "../review/layers-view";
import { ensurePackageLayers, resolvePackageDir } from "./review-layers";
import { checkDispatch, renderDispatchCheck } from "../review/dispatch-check";
import { MAX_RETRY_ROUNDS, type RetryState, type ReviewerResult, emptyRetryState, planRetry } from "../review/retry-plan";
import { DEFAULT_SLICE_MAX_BYTES, DEFAULT_WAVE_BYTES, type SliceManifest, buildSlices, renderSliceSummary, sliceSourceFromDiff, validateSliceMaxBytes, validateWaveBytes } from "../review/slice";
import { commentRuleScopeConfig } from "../review/comment-rule";

/** The diff-fetching and flag helpers `review.ts` owns, passed in so this file does not import its caller. */
export type SliceDeps = {
  gitDiff: (ref: string | undefined, contextLines: number) => Promise<string>;
  readDiffSource: (source: string) => Promise<string>;
  parseContextLines: (raw: string | undefined) => number;
  rejectUnknownFlags: (args: readonly string[], allowed: readonly string[], usage: string) => void;
};

export const SLICE_FLAGS = ["--ref", "--base", "--diff", "--context", "--max-bytes", "--wave-bytes", "--out", "--json", "--help", "-h"] as const;
export const DISPATCH_CHECK_FLAGS = ["--payload", "--manifest", "--max-bytes", "--pr-context", "--package", "--json", "--help", "-h"] as const;
export const RETRY_PLAN_FLAGS = ["--manifest", "--result", "--reviewer", "--slices", "--covered", "--next-wave", "--state", "--dry-run", "--json", "--help", "-h"] as const;

const DEFAULT_SLICE_DIR = ".metaproject/data/review/slices";
const MANIFEST_NAME = "manifest.json";
const RETRY_STATE_NAME = "retry-state.json";

function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/**
 * Refuse, before anything is read or written, a path flag that lands outside the project root,
 * and hand back `placed(flag, fallback?)`: the real path a flag (or its default) lands on, judged again at the
 * moment of use. The early check alone leaves a window between it and the read or write in which a directory can
 * become a symlink; a command that opens the placed path, not the string it was given, closes it.
 * A `-` value of a stdin flag comes back as `-`.
 */
function guardPaths(command: string, args: string[]): (flag: string, fallback?: string) => string | undefined {
  const cwd = process.cwd();
  const where = { projectRoot: resolveProjectRoot(cwd), cwd };
  const refusal = reviewPathFlagRefusal(command, args, where);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
  return (flag, fallback) => {
    const value = optionValue(args, flag) ?? fallback;
    if (value === undefined) return undefined;
    const placed = placeReviewPath(command, flag, value, where);
    if (!placed.ok) throw new Error(placed.message);
    return placed.path;
  };
}

export function printSliceHelp(): void {
  console.log(`keryx review slice — usage:

  keryx review slice [--ref <base>] [--diff <file|->] [--context <n>]
                     [--max-bytes <n>] [--wave-bytes <n>] [--out <dir>] [--json]

Cuts the scoped diff into reviewer-sized slices, no model call. Each slice is a
file of at most --max-bytes (default ${DEFAULT_SLICE_MAX_BYTES}) holding whole domains where they fit; a domain over the
limit is cut by file, a file over it by hunk. --wave-bytes (default ${DEFAULT_WAVE_BYTES}, at least
--max-bytes) is what one reviewer dispatch may carry in total: a role owning more
is dispatched in waves, so each dispatch fits the reviewer's child deadline. Data ledgers (csv, tsv, jsonl,
parquet), lockfiles, snapshots, generated and oversize json are never sliced:
they are listed under omissions with their reason and size.

Accepts a git diff or the output of \`keryx review scope --scoped-diff\`.
Writes slice-NN.diff and ${MANIFEST_NAME} into --out (default ${DEFAULT_SLICE_DIR}).
Manifest paths are relative to the manifest. Put each slice's TEXT in the
reviewer prompt; then \`keryx review dispatch-check\` the payload.
`);
}

export function printDispatchCheckHelp(): void {
  console.log(`keryx review dispatch-check — usage:

  keryx review dispatch-check --payload <file|-> [--manifest <manifest.json>]
                              [--max-bytes <n>] [--pr-context] [--package <dir>] [--json]

--package <dir> refreshes the review's layers (graph, wiki, memory; no model) first when the
package has none for its head, so a dispatch never starts from stale layers.

--pr-context is for a pull-request review: every payload must carry \`pr_context\`,
the path of the pr-context.md that \`keryx review context-collect\` wrote.

Validates reviewer payload(s) before dispatch: one reviewer-input object, an
array of them, or { "dispatches": [...] }. Shape comes from
reviewer-input.schema.json; a scope_mode "diff" payload must name its \`slices\`
(ids from the manifest) or carry a \`diff\` that fits, and what it is assigned
must total at most --max-bytes (default: the manifest's wave budget, else
${DEFAULT_SLICE_MAX_BYTES}); more than that is dispatched in waves (\`retry-plan --next-wave\`).

Codes: REVIEWER_INPUT_INVALID, REVIEWER_INPUT_NO_SLICE,
REVIEWER_INPUT_SLICE_UNKNOWN, REVIEWER_INPUT_TOO_LARGE, REVIEWER_INPUT_NO_PR_CONTEXT.
Exit 0 ok, 1 payload refused, 2 payload or manifest unreadable.
`);
}

export function printRetryPlanHelp(): void {
  console.log(`keryx review retry-plan — usage:

  keryx review retry-plan --manifest <manifest.json> --result <file|->
                          [--reviewer <id>] [--slices a,b] [--covered a,b]
                          [--next-wave] [--state <file>] [--dry-run] [--json]

Decides what follows a reviewer result. --result is the reviewer's result JSON
({ "reviewer", "status", "slices"? , "needs_context"?, "attempt"? }); "slices" are the
ones the reviewer covered. An attempt is spent only by a result that covers no slice
the reviewer had not covered before: a reviewer that makes progress is handed the
next wave of what is still uncovered (decision "retry" or "wave") and is not
penalised. A result with no new coverage re-cuts the open slices at half the size
(r<n>-<reviewer>-NN.diff, appended to the manifest) and halves the wave; two such
results in a row, or ${MAX_RETRY_ROUNDS} failed rounds in all, are decision "not-run" and print the
report line "- **Not run:** <reviewer> — <status> after a smaller-slice retry; never
counted as a clean pass". NEEDS_CONTEXT is not terminal and closes no scope: decision
"context" lists the open questions ("- context <reviewer>: ...") for a re-dispatch;
asking again with nothing new covered is "not-run". A finished result with slices
still open is decision "wave". Any other finished result is "accepted".
--next-wave plans the next wave without a result (--result becomes optional), or
after a finished one; --covered adds slice ids covered by earlier results.
The dispatch list is the next wave, at most the manifest's wave budget; "remaining"
counts what is left. Only the operator can accept a smaller set than that, with
their own quote, at \`review complete\`.
Progress is remembered in ${RETRY_STATE_NAME} beside the manifest (--state to move it).
--dry-run plans without writing. Exit 0 for every decision.
`);
}

async function writeSliceFiles(dir: string, slices: ReadonlyArray<{ path: string; text: string }>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const slice of slices) {
    await writeFileAtomic(path.join(dir, slice.path), slice.text);
  }
}

export async function runSlice(args: string[], deps: SliceDeps): Promise<void> {
  if (wantsHelp(args)) {
    printSliceHelp();
    return;
  }
  deps.rejectUnknownFlags(args, SLICE_FLAGS, "slice");
  const placed = guardPaths("slice", args);
  const contextLines = deps.parseContextLines(optionValue(args, "--context"));
  const rawMax = optionValue(args, "--max-bytes");
  const maxBytes = validateSliceMaxBytes(rawMax === undefined ? DEFAULT_SLICE_MAX_BYTES : Number(rawMax));
  const diffFile = placed("--diff");
  const ref = optionValue(args, "--ref") ?? optionValue(args, "--base");

  const diff = diffFile !== undefined ? await deps.readDiffSource(diffFile) : await deps.gitDiff(ref, contextLines);
  const rawWave = optionValue(args, "--wave-bytes");
  const waveBytes = rawWave === undefined ? undefined : validateWaveBytes(Number(rawWave), maxBytes);
  const { manifest, slices } = buildSlices(sliceSourceFromDiff(diff, { contextLines, ...(await commentRuleScopeConfig(process.cwd())) }), { maxBytes, ...(waveBytes === undefined ? {} : { waveBytes }) });

  // Placed after the diff is fetched, which can take long: the directory is judged where it is now, right before it is written.
  const outDir = placed("--out", DEFAULT_SLICE_DIR) as string;
  await mkdir(outDir, { recursive: true });
  for (const entry of await readdir(outDir)) {
    if (/^slice-\d+\.diff$/.test(entry)) {
      await rm(path.join(outDir, entry), { force: true });
    }
  }
  await writeSliceFiles(outDir, slices);
  const manifestPath = path.join(outDir, MANIFEST_NAME);
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...manifest, dir: outDir, manifestPath }, null, 2));
    return;
  }
  console.log(renderSliceSummary(manifest));
  console.log(`\nmanifest: ${manifestPath}`);
}

async function readJsonSource<T>(source: string, label: string): Promise<T> {
  let raw: string;
  try {
    raw = source === "-" ? await Bun.stdin.text() : await readFile(source, "utf8");
  } catch (error) {
    throw new UnreadableInput(`${label} is unreadable: ${source} (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new UnreadableInput(`${label} is not valid JSON: ${source}`);
  }
}

class UnreadableInput extends Error {}

/** A reviewer result: a file that is plain JSON with a status, or a saved raw reply read by `parseReviewResult` (the shapes it accepts are listed in its doc). A truncated or ambiguous reply is refused. */
async function readResult(source: string): Promise<ReviewerResult> {
  let raw: string;
  try {
    raw = source === "-" ? await Bun.stdin.text() : await readFile(source, "utf8");
  } catch (error) {
    throw new UnreadableInput(`result is unreadable: ${source} (${error instanceof Error ? error.message : String(error)})`);
  }
  const parsed = wholeFileResult(raw) ?? parseReviewResult(raw);
  if (parsed === undefined) throw new UnreadableInput(`result holds no usable reviewer result (a JSON object with a status; a \`\`\`REVIEW_RESULT block with a status; or one object with a status and a reviewer or findings, bare or after a REVIEW_RESULT marker; a truncated or ambiguous reply is refused): ${source}`);
  return parsed as ReviewerResult;
}

/** A file that is one JSON object with a status is the documented plain-JSON input; `--reviewer` may name a reviewer it leaves out. */
function wholeFileResult(raw: string): ReviewerResult | undefined {
  try {
    const whole: unknown = JSON.parse(raw);
    return hasStatus(whole) ? whole as ReviewerResult : undefined;
  } catch { return undefined; }
}

function failUnreadable(error: unknown): void {
  if (error instanceof UnreadableInput) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  throw error;
}

function asPayloads(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value !== null && typeof value === "object" && Array.isArray((value as { dispatches?: unknown }).dispatches)) {
    return (value as { dispatches: unknown[] }).dispatches;
  }
  return [value];
}

export async function runDispatchCheck(args: string[], deps: Pick<SliceDeps, "rejectUnknownFlags">): Promise<void> {
  if (wantsHelp(args)) {
    printDispatchCheckHelp();
    return;
  }
  deps.rejectUnknownFlags(args, DISPATCH_CHECK_FLAGS, "dispatch-check");
  const placed = guardPaths("dispatch-check", args);
  const payloadSource = placed("--payload");
  if (payloadSource === undefined) {
    throw new Error("Missing --payload <file|->. See `keryx review dispatch-check --help`.");
  }
  const manifestSource = placed("--manifest");
  const rawMax = optionValue(args, "--max-bytes");

  if (optionValue(args, "--package") !== undefined) {
    // A dispatch starts from fresh layers: refresh them when the package has none for this head.
    const layers = await ensurePackageLayers(resolvePackageDir(args));
    console.error(`layers: ${layersSummaryLine(layers)}`);
  }

  try {
    const payloads = asPayloads(await readJsonSource<unknown>(payloadSource, "payload"));
    const manifest = manifestSource === undefined ? undefined : await readJsonSource<SliceManifest>(manifestSource, "manifest");
    const base = manifestSource === undefined ? process.cwd() : path.dirname(manifestSource);
    const result = await checkDispatch(payloads, {
      ...(manifest === undefined ? {} : { manifest }),
      ...(rawMax === undefined ? {} : { maxBytes: validateSliceMaxBytes(Number(rawMax)) }),
      ...(args.includes("--pr-context") ? { prContext: { exists: (contextPath: string) => existsSync(path.resolve(contextPath)) } } : {}),
      pathBytes: (slicePath) => {
        const file = path.resolve(base, slicePath);
        return existsSync(file) ? statSync(file).size : undefined;
      },
    });
    console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : renderDispatchCheck(result));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    failUnreadable(error);
  }
}

export async function runRetryPlan(args: string[], deps: Pick<SliceDeps, "rejectUnknownFlags">): Promise<void> {
  if (wantsHelp(args)) {
    printRetryPlanHelp();
    return;
  }
  deps.rejectUnknownFlags(args, RETRY_PLAN_FLAGS, "retry-plan");
  const placed = guardPaths("retry-plan", args);
  const manifestSource = placed("--manifest");
  const resultSource = placed("--result");
  const nextWave = args.includes("--next-wave");
  if (manifestSource === undefined || (resultSource === undefined && !nextWave)) {
    throw new Error("Missing --manifest <file> or --result <file|-> (--result is optional with --next-wave). See `keryx review retry-plan --help`.");
  }

  try {
    const manifestDir = path.dirname(manifestSource);
    const manifest = await readJsonSource<SliceManifest>(manifestSource, "manifest");
    const result = resultSource === undefined ? {} : await readResult(resultSource);
    const statePath = placed("--state", path.join(manifestDir, RETRY_STATE_NAME)) as string;
    const state = existsSync(statePath) ? await readJsonSource<RetryState>(statePath, "state") : emptyRetryState();
    const reviewer = optionValue(args, "--reviewer") ?? result.reviewer;
    if (reviewer === undefined || reviewer === "") {
      throw new Error("The result names no reviewer; pass --reviewer <id>.");
    }
    const sliceList = optionValue(args, "--slices");
    const coveredList = optionValue(args, "--covered");
    const plan = planRetry({
      manifest,
      result,
      reviewer,
      ...(sliceList === undefined ? {} : { sliceIds: sliceList.split(",").map((item) => item.trim()).filter(Boolean) }),
      ...(coveredList === undefined ? {} : { covered: coveredList.split(",").map((item) => item.trim()).filter(Boolean) }),
      ...(nextWave ? { nextWave } : {}),
      state,
      readSliceText: (entry) => {
        const file = path.resolve(manifestDir, entry.path);
        if (!existsSync(file)) {
          throw new UnreadableInput(`slice file is missing: ${file}`);
        }
        return readFileSync(file, "utf8");
      },
    });

    if (!args.includes("--dry-run")) {
      if (plan.newSlices.length > 0) {
        await writeSliceFiles(manifestDir, plan.newSlices);
        const added = plan.newSlices.map(({ text: _text, ...entry }) => entry);
        await writeFileAtomic(manifestSource, `${JSON.stringify({ ...manifest, slices: [...manifest.slices, ...added] }, null, 2)}\n`);
      }
      await writeFileAtomic(statePath, `${JSON.stringify(plan.state, null, 2)}\n`);
    }

    const dispatch = plan.wave.map((slice) => ({ reviewer, slice: slice.id, path: slice.path, bytes: slice.bytes }));
    if (args.includes("--json")) {
      console.log(
        JSON.stringify(
          {
            decision: plan.decision,
            reviewer,
            status: plan.status,
            scopeFingerprint: plan.state.scopeFingerprint ?? null,
            priorAttempts: plan.priorAttempts,
            reason: plan.reason,
            reportLine: plan.reportLine ?? null,
            dispatch,
            remaining: plan.remaining,
            progress: plan.progress,
            stalls: plan.stalls,
            needsContext: plan.needsContext ?? null,
            dryRun: args.includes("--dry-run"),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`retry-plan: ${plan.decision} — ${reviewer} (${plan.status || "no status"}): ${plan.reason}`);
    if (plan.remaining.slices > 0) {
      console.log(`remaining: ${plan.remaining.slices} slice(s), ${plan.remaining.bytes} bytes, ${plan.remaining.waves} wave(s) including this one`);
    }
    for (const item of dispatch) {
      console.log(`- dispatch ${item.reviewer} on ${item.slice} (${item.bytes} bytes): ${item.path}`);
    }
    for (const question of plan.needsContext ?? []) {
      console.log(`- context ${reviewer}: ${question}`);
    }
    if (plan.reportLine !== undefined) {
      console.log(plan.reportLine);
    }
  } catch (error) {
    failUnreadable(error);
  }
}
