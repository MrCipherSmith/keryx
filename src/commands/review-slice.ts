import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { resolveProjectRoot } from "../lib/contained-path";
import { writeFileAtomic } from "../lib/fs";
import { placeReviewPath, reviewPathFlagRefusal } from "../lib/review-path-flags";
import { explainUnparsedResult, parseReviewResult, sha } from "../review/ledger";
import { layersSummaryLine } from "../review/layers-view";
import { ensurePackageLayers, resolvePackageDir } from "./review-layers";
import { checkDispatch, renderDispatchCheck } from "../review/dispatch-check";
import { MAX_RETRY_ROUNDS, type ReviewerResult } from "../review/retry-plan";
import { DEFAULT_SLICE_MAX_BYTES, DEFAULT_WAVE_BYTES, type SliceManifest, buildSlices, manifestSizeProblem, renderSliceSummary, sliceSourceFromDiff, validateSliceMaxBytes, validateWaveBytes } from "../review/slice";
import { packagePlanGate } from "../review/estimate";
import { packageReviewers, writeWaveDrivers } from "../review/wave-drivers";
import { RETRY_STATE_NAME, UnreadableInput, commitRetryPlan, evaluateRetry, packageOfManifest, readJsonSource, wholeFileResult, writeSliceFiles } from "../review/retry-eval";

export { packageOfManifest };
import { resolveActiveReview } from "../review/active-review";
import { operatorGateApplies } from "../review/run-profile";
import { commentRuleScopeConfig } from "../review/comment-rule";
import { renderRoutingSummary, routeSlices, summarizeRouting } from "../review/slice-routing";
import { NOT_REVIEW_PACKAGES } from "../review/prior-round";
import { readPriorFindings, readRoundRecord, roundRecordTampered, type RoundRecord } from "../review/round-record";
import { classifyDeltaSlices, isDeltaRound, partitionRegionsByFix, regionInSecondLook, splitCounts, tagSecondLookSlices } from "../review/round-split";
import { defaultWaveBytes, detectReviewHost, HOST_WAVE_BYTES, parseReviewHost, REVIEW_HOSTS } from "../review/host-profile";

/** The diff-fetching and flag helpers `review.ts` owns, passed in so this file does not import its caller. */
export type SliceDeps = {
  gitDiff: (ref: string | undefined, contextLines: number) => Promise<string>;
  readDiffSource: (source: string) => Promise<string>;
  parseContextLines: (raw: string | undefined) => number;
  rejectUnknownFlags: (args: readonly string[], allowed: readonly string[], usage: string) => void;
};

export const SLICE_FLAGS = ["--ref", "--base", "--diff", "--context", "--max-bytes", "--wave-bytes", "--host", "--package", "--out", "--head", "--reach", "--jev-scores", "--json", "--help", "-h"] as const;
export const DISPATCH_CHECK_FLAGS = ["--payload", "--manifest", "--max-bytes", "--pr-context", "--package", "--json", "--help", "-h"] as const;
export const RETRY_PLAN_FLAGS = ["--manifest", "--result", "--reviewer", "--slices", "--covered", "--next-wave", "--package", "--state", "--dry-run", "--json", "--help", "-h"] as const;

const DEFAULT_SLICE_DIR = ".metaproject/data/review/slices";
const MANIFEST_NAME = "manifest.json";

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
                     [--max-bytes <n>] [--wave-bytes <n>] [--host ${REVIEW_HOSTS.join("|")}]
                     [--package <review-dir> | --out <dir>]
                     [--head <sha>] [--reach <file.json>] [--jev-scores <file.json>] [--json]

Cuts the scoped diff into reviewer-sized slices, no model call. Each slice is a
file of at most --max-bytes (default ${DEFAULT_SLICE_MAX_BYTES}) holding whole domains where they fit; a domain over the
limit is cut by file, a file over it by hunk. --wave-bytes (at least --max-bytes) is what one reviewer
dispatch may carry in total: a role owning more is dispatched in waves, so each dispatch fits the
reviewer's child deadline. Its default depends on --host (default: detected from the environment):
keryx-shell ${HOST_WAVE_BYTES["keryx-shell"]} (a child is killed after 5 minutes), claude-code, codex and other
${HOST_WAVE_BYTES["claude-code"]} (no child deadline; ${DEFAULT_WAVE_BYTES} was the old default for every host). The
manifest records host and waveBytes. Data ledgers (csv, tsv, jsonl,
parquet), lockfiles, snapshots, generated and oversize json are never sliced:
they are listed under omissions with their reason and size.

Each slice is routed: \`roles\` are the reviewers its content needs (review-logic on
every slice), \`depth\` is deep (every round role whose path gate allows its files
reads it) when the slice holds source code, agent instructions or a schema, a risk
class hits (auth, crypto, migrations, schema), a file's reach in --reach
({file: count}) is high, or a score in --jev-scores ({slice id or file: 0..1}) is
>= 0.7; light (logic + content roles) only when every file is docs, tests, config or
generated. A deterministic 10-15% of light slices (hash of --head, default HEAD, and
the slice id; none below 4 light slices) run deep as an audit sample (\`audit: true\`).

In a delta round (the package's round.json, written by \`review start\`, names a previous
round at an ancestor head) only the round's range prevHead..head is cut. The changed lines
that lie in a fix hunk (round.json \`fixHunks\`: a hunk over a prior finding's located lines,
or in a commit naming it) are cut apart from every other changed line, even in the same file.
A slice of fix lines is \`kind: "fix"\` with its \`findingIds\`, read deep by exactly review-logic,
review-regression, the reviewers that authored those findings, and review-security-code when
one is a security finding; every other slice is \`kind: "new"\` and routed as above. The delta diff takes the same context,
exclusions and pre-filters as a round-1 cut and is never larger than merge-base..head (when it
would be, merge-base..head is cut instead, still split fix/new). Code of merge-base..head that did not change since the previous round gets one more
look (round.json \`secondLookHunks\`): \`kind: "second-look"\` slices, read once by review-logic and
review-security-code, findings from them are ordinary findings. When the previous round was weak (not
completed, uncovered slices, skipped required reviewers, "Not run" lines, or a narrower scope) that code is
cut as \`new\` instead and round.json says "previous round weak: …". An empty range (base equals head, as
for a merged pull request read against its target branch) is refused. First and fallback-first
rounds are cut over --ref as before. A round.json edited after \`review start\` is refused.

Accepts a git diff or the output of \`keryx review scope --scoped-diff\`.
Writes slice-NN.diff and ${MANIFEST_NAME} into --out, else <review-dir>/slices with --package (where
retry-plan and the ledger look for them), else ${DEFAULT_SLICE_DIR} (shared by every review: pass
--package so one review's slices never mix with another's).
Manifest paths are relative to the manifest. Put each slice's TEXT in the
reviewer prompt; then \`keryx review dispatch-check\` the payload.

With --package it also writes <review-dir>/drivers/<reviewer>-w<n>.json for every reviewer x wave:
the slice ids (slices), their ABSOLUTE paths (slicePaths), the wave, the file the reply goes to
(result: raw/<reviewer>-w<n>.txt) and the reviewer's rule file (definition) when one exists. The
dispatcher adds "model"; a re-slice keeps it. \`keryx review next --package <review-dir>\` then lists
what is left to dispatch.
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

With --package, the round's plan is estimated (\`keryx review estimate\`); a plan over the
operator threshold (routing.config.json reviewPlan.maxDispatches, default 40 dispatches,
or reviewPlan.maxMinutes, default 90 min) is refused until the operator confirms it: the
review_confirm_plan card inside keryx shell, or \`keryx review estimate --package <dir>
--confirm --quote "<words>"\` at a terminal. A manifest with neither waveBytes nor maxBytes
is refused.

Codes: REVIEWER_INPUT_INVALID, REVIEWER_INPUT_NO_SLICE,
REVIEWER_INPUT_SLICE_UNKNOWN, REVIEWER_INPUT_TOO_LARGE, REVIEWER_INPUT_NO_PR_CONTEXT,
REVIEWER_INPUT_PATH_MISSING, REVIEWER_INPUT_MANIFEST_UNSIZED, REVIEWER_INPUT_PLAN_UNCONFIRMED.
Exit 0 ok, 1 payload refused, 2 payload or manifest unreadable.
`);
}

export function printRetryPlanHelp(): void {
  console.log(`keryx review retry-plan — usage:

  keryx review retry-plan --manifest <manifest.json> --result <file|->
                          [--reviewer <id>] [--slices a,b] [--covered a,b]
                          [--next-wave] [--package <dir>] [--state <file>] [--dry-run] [--json]

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
--package <dir> first collects late results: a reviewer that finished after its spawn
deadline still wrote raw/<file> into the package, which drivers/*.json name as that
dispatch's result. A result for this reviewer that parses as DONE or DONE_WITH_CONCERNS
with no open needs_context covers the slices its driver handed out, so they are not
dispatched again; the output reports "collected late: N" (\`collectedLate\` in --json).
A malformed or INCOMPLETE file covers nothing.
Progress is remembered in ${RETRY_STATE_NAME} beside the manifest (--state to move it).
A result whose findings include a major, blocker or critical one on a light (routed) slice
re-opens that slice deep: every core role now owns it (\`escalations\` in --json, the
manifest records \`escalated\`), and \`ledger build\` holds those roles to it.
--dry-run plans without writing. Exit 0 for every decision.
`);
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

  // Flow 458: a package whose `review start` found a previous round of this target at an ancestor head slices only the
  // round's range (prevHead..head), then tags each slice fix or new. A first or fallback-first round is cut as before.
  const packageFlag = optionValue(args, "--out") === undefined ? placed("--package") : undefined;
  const tampered = packageFlag === undefined ? undefined : roundRecordTampered(packageFlag);
  if (tampered !== undefined) throw new Error(`review slice refused: ${tampered}`);
  const round = packageFlag === undefined ? undefined : readRoundRecord(packageFlag);
  const delta = isDeltaRound(round) && diffFile === undefined ? round : undefined;
  if (delta !== undefined && ref !== undefined) console.error(`--ref ${ref} ignored: the package's round ${delta.round} is a delta round, sliced over ${delta.range.base}..${delta.range.head}`);
  let diff: string;
  if (diffFile !== undefined) diff = await deps.readDiffSource(diffFile);
  else if (delta !== undefined) {
    const cut = await deltaSliceDiff(delta, contextLines);
    if (cut.note !== undefined) console.error(cut.note);
    diff = cut.diff;
  } else diff = await deps.gitDiff(ref, contextLines);
  const hostArg = optionValue(args, "--host");
  const host = hostArg === undefined ? detectReviewHost() : parseReviewHost(hostArg);
  if (host === undefined) throw new Error(`--host must be one of ${REVIEW_HOSTS.join(", ")}, got "${hostArg}"`);
  const rawWave = optionValue(args, "--wave-bytes");
  const waveBytes = validateWaveBytes(rawWave === undefined ? defaultWaveBytes(host, maxBytes) : Number(rawWave), maxBytes);
  const scopeConfig = { contextLines, ...(await commentRuleScopeConfig(process.cwd())) };
  const source = sliceSourceFromDiff(diff, scopeConfig);
  // Flow 460 L6: a delta round cuts the lines that answer prior findings apart from the new lines before slicing, so a fix
  // slice holds only fix hunks (and gets the fix roster) while every new line, even in the same file, is routed as in round 1.
  const parts = delta === undefined ? undefined : partitionRegionsByFix(source.regions, delta.fixHunks);
  const built = buildSlices(parts === undefined ? source : { ...source, regions: parts.other }, { maxBytes, waveBytes });
  const fixBuilt = parts === undefined || parts.fix.length === 0 ? undefined : buildSlices({ ...source, regions: parts.fix, drops: [] }, { maxBytes, waveBytes });
  // Cheap second look: code of merge-base..head unchanged since the previous round, cut apart from the delta so each slice has one kind.
  const secondLook = delta === undefined ? undefined : await secondLookSource(delta, contextLines, scopeConfig);
  const secondBuilt = secondLook === undefined ? undefined : buildSlices(secondLook, { maxBytes, waveBytes });
  // Routing: each slice gets the roles its content needs and a depth by risk; the manifest carries both.
  const head = optionValue(args, "--head") ?? delta?.range.head ?? (await currentHead()) ?? "no-head";
  const reachFile = placed("--reach");
  const jevFile = placed("--jev-scores");
  const routing = {
    head,
    ...(reachFile === undefined ? {} : { reach: await readNumberMap(reachFile, "--reach") }),
    ...(jevFile === undefined ? {} : { jevScores: await readNumberMap(jevFile, "--jev-scores") }),
  };
  const routed = routeSlices(built.slices, routing);
  const prior = delta === undefined ? [] : readPriorFindings(packageFlag!);
  const fixSlices = fixBuilt === undefined || delta === undefined ? [] : classifyDeltaSlices(routeSlices(fixBuilt.slices, routing), delta, prior);
  const classified = delta === undefined ? routed : classifyDeltaSlices(routed, delta, prior);
  const second = secondBuilt === undefined || delta === undefined ? [] : tagSecondLookSlices(routeSlices(secondBuilt.slices, { head }), delta.round - 1);
  const slices = second.length === 0 && fixSlices.length === 0 ? classified : renumberSlices([...fixSlices, ...classified, ...second]);
  const omissions = [...built.manifest.omissions, ...(fixBuilt?.manifest.omissions ?? []), ...(secondBuilt?.manifest.omissions ?? [])].filter((omission, index, all) => all.findIndex((known) => known.path === omission.path) === index);
  const totals = {
    ...built.manifest.totals,
    slices: slices.length,
    bytes: slices.reduce((total, slice) => total + slice.bytes, 0),
    files: new Set(slices.flatMap((slice) => slice.files)).size,
    omittedFiles: omissions.length,
    omittedBytes: omissions.reduce((total, omission) => total + omission.bytes, 0),
  };
  // An empty range is refused, not planned: a merged pull request read against its own target branch (base == head) cuts no
  // slice at all, and `next: dispatch` over zero slices would look like a clean review.
  if (slices.length === 0 && diffFile === undefined && built.manifest.omissions.length === 0 && (delta !== undefined || round !== undefined || ref !== undefined)) {
    const base = delta?.range.base ?? round?.range.base ?? ref;
    throw new Error(`review slice refused: empty review range${base === undefined || base === null ? "" : `: base ${String(base).slice(0, 12)} equals head or changes nothing`} (${head === "no-head" ? "no head" : head.slice(0, 12)}); there is nothing to slice. For a merged pull request pass its recorded base (\`review start --base <sha|ref>\` / \`review plan --ref <base>\`).`);
  }
  const manifest = { ...built.manifest, host, waveBytes, omissions, totals, slices: slices.map(({ text: _text, ...entry }) => entry) };

  // Placed after the diff is fetched, which can take long: the directory is judged where it is now, right before it is written.
  const packageOut = optionValue(args, "--out") === undefined ? placed("--package") : undefined;
  if (packageOut !== undefined && (!existsSync(packageOut) || !statSync(packageOut).isDirectory())) throw new Error(`--package ${packageOut} is not a directory.`);
  const outDir = packageOut !== undefined ? path.join(packageOut, "slices") : (placed("--out", DEFAULT_SLICE_DIR) as string);
  await mkdir(outDir, { recursive: true });
  for (const entry of await readdir(outDir)) {
    if (/^slice-\d+\.diff$/.test(entry)) {
      await rm(path.join(outDir, entry), { force: true });
    }
  }
  await writeSliceFiles(outDir, slices);
  const manifestPath = path.join(outDir, MANIFEST_NAME);
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Flow 458 AC12: with a package, one driver per reviewer x wave, absolute slice paths and slice ids, so the dispatcher
  // and `review next` read the same files the ledger does.
  const drivers = packageOut === undefined ? [] : await writeWaveDrivers({ packageDir: packageOut, manifest: manifest as SliceManifest, sliceDir: outDir, reviewers: await packageReviewers(packageOut, manifest as SliceManifest) });
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...manifest, dir: outDir, manifestPath, ...(packageOut === undefined ? {} : { drivers }) }, null, 2));
    return;
  }
  console.log(renderSliceSummary(manifest));
  console.log(renderRoutingSummary(summarizeRouting(manifest.slices)));
  const split = delta === undefined ? undefined : splitCounts(manifest);
  if (delta !== undefined && split !== undefined) console.log(`round ${delta.round} delta ${delta.range.base!.slice(0, 12)}..${delta.range.head!.slice(0, 12)}: ${split.fix} fix slice(s) (logic, regression, finding authors), ${split.new} new slice(s)${split.secondLook === undefined ? "" : `, ${split.secondLook} second-look slice(s) (unchanged since round ${delta.round - 1}; logic and security-code read them once)`}`);
  console.log(`\nmanifest: ${manifestPath}`);
  if (packageOut !== undefined) console.log(`drivers: ${drivers.length} written to ${path.join(packageOut, "drivers")} (one per reviewer x wave; \`keryx review next --package <dir>\` lists what is left)`);
}

/**
 * The diff a delta round is sliced from. It goes through exactly what a round-1 cut of the same head goes through — the
 * same context lines, the same review-package pathspec, and afterwards the same scope pre-filters and omissions in
 * `sliceSourceFromDiff` — and it is never larger than the round-1 diff merge-base..head: prevHead..head also carries the
 * lines the fix removed from code the branch itself added (absent from merge-base..head), and when that makes it the
 * bigger of the two the round is cut from merge-base..head instead, its slices still tagged fix or new by the fix hunks
 * (which are head-side lines, the same in both).
 */
export async function deltaSliceDiff(
  round: Pick<RoundRecord, "range" | "mergeBase"> & { weakPrevious?: string | undefined },
  contextLines: number,
  rangeDiff: (base: string, head: string, contextLines: number) => Promise<string> = gitRangeDiff,
): Promise<{ diff: string; note?: string | undefined }> {
  const mergeBase = round.mergeBase;
  // A weak previous round cannot vouch for the code it left unchanged: the whole merge-base..head is read as in round 1.
  if (round.weakPrevious !== undefined && mergeBase !== undefined && mergeBase !== null) {
    return { diff: await rangeDiff(mergeBase, round.range.head!, contextLines), note: `${round.weakPrevious}: sliced over merge-base..head ${mergeBase.slice(0, 12)}..${round.range.head!.slice(0, 12)}, unchanged code read as new, still split fix/new` };
  }
  const delta = await rangeDiff(round.range.base!, round.range.head!, contextLines);
  if (mergeBase === undefined || mergeBase === null || mergeBase === round.range.base) return { diff: delta };
  const full = await rangeDiff(mergeBase, round.range.head!, contextLines);
  if (Buffer.byteLength(delta) <= Buffer.byteLength(full)) return { diff: delta };
  return {
    diff: full,
    note: `delta ${round.range.base!.slice(0, 12)}..${round.range.head!.slice(0, 12)} (${Buffer.byteLength(delta)} bytes) is larger than the round-1 diff ${mergeBase.slice(0, 12)}..${round.range.head!.slice(0, 12)} (${Buffer.byteLength(full)} bytes): sliced over merge-base..head, still split fix/new`,
  };
}

/** Renumber slices `slice-NN` in order, so ids and file names stay one sequence after two cuts are joined. */
export function renumberSlices<T extends { id: string; path: string }>(slices: readonly T[]): T[] {
  const width = Math.max(2, String(slices.length).length);
  return slices.map((slice, index) => {
    const id = `slice-${String(index + 1).padStart(width, "0")}`;
    return { ...slice, id, path: `${id}.diff` };
  });
}

/**
 * The regions of merge-base..head that the delta round does not cover and the previous round already read (the round's
 * `secondLookHunks`), cut with the same context and pre-filters as every other cut. Undefined when the round has none.
 */
export async function secondLookSource(
  round: Pick<RoundRecord, "range" | "mergeBase" | "secondLookHunks">,
  contextLines: number,
  config: Parameters<typeof sliceSourceFromDiff>[1],
  rangeDiff: (base: string, head: string, contextLines: number) => Promise<string> = gitRangeDiff,
): Promise<ReturnType<typeof sliceSourceFromDiff> | undefined> {
  const hunks = round.secondLookHunks ?? [];
  if (hunks.length === 0 || round.mergeBase === undefined || round.mergeBase === null) return undefined;
  const source = sliceSourceFromDiff(await rangeDiff(round.mergeBase, round.range.head!, contextLines), config);
  const regions = source.regions.filter((region) => regionInSecondLook(region, hunks));
  return regions.length === 0 ? undefined : { ...source, regions };
}

/** `git diff <base> <head>` of a delta round, without committed review packages (the same pathspec the round's hunks were cut with). */
async function gitRangeDiff(base: string, head: string, contextLines: number): Promise<string> {
  for (const sha of [base, head]) if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error(`round.json range ${base}..${head} is not a pair of commit SHAs; re-run \`keryx review start\``);
  const proc = Bun.spawn(["git", "diff", "--no-color", `-U${contextLines}`, "--no-ext-diff", "--end-of-options", base, head, "--", ...NOT_REVIEW_PACKAGES], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`git diff ${base.slice(0, 12)}..${head.slice(0, 12)} failed (exit ${exitCode}): ${stderr.trim()}`);
  return stdout;
}

/** The commit the working tree is at; seeds the audit sample. Undefined outside a git checkout. */
async function currentHead(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--verify", "HEAD"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 && out.trim() !== "" ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** A JSON object of `key -> number` (file -> reach count, slice id or file -> Jev score); anything else is refused. */
async function readNumberMap(file: string, flag: string): Promise<Record<string, number>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${flag} ${file} is not readable JSON (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${flag} ${file} must be a JSON object of key -> number`);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** A reviewer result: a file that is plain JSON with a status, or a saved raw reply read by `parseReviewResult` (the shapes it accepts are listed in its doc). A truncated or ambiguous reply is refused. */
async function readResult(source: string): Promise<ReviewerResult> {
  let raw: string;
  try {
    raw = source === "-" ? await Bun.stdin.text() : await readFile(source, "utf8");
  } catch (error) {
    throw new UnreadableInput(`result is unreadable: ${source} (${error instanceof Error ? error.message : String(error)})`);
  }
  const parsed = wholeFileResult(raw) ?? parseReviewResult(raw);
  if (parsed === undefined) throw new UnreadableInput(`result holds no usable reviewer result (a JSON object with a status; a \`\`\`REVIEW_RESULT block with a status; or one object with a status and a reviewer or findings, bare or after a REVIEW_RESULT marker; a truncated or ambiguous reply is refused). Why: ${explainUnparsedResult(raw)}. Also read: a \`\`\`json block, prose around the object, a JSON array of one reviewer's results (one per wave), an object wrapped in result / review_result: ${source}`);
  return parsed as ReviewerResult;
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

  // Security review minor: the plan gate needs the package. It is --package, else the package the manifest lives in;
  // without either, an open review package (the active-review pointer) refuses the check instead of skipping its gate.
  let packageDir = optionValue(args, "--package") === undefined ? undefined : resolvePackageDir(args);
  if (packageDir === undefined && manifestSource !== undefined && manifestSource !== "-") packageDir = packageOfManifest(path.dirname(path.resolve(manifestSource)));
  if (packageDir === undefined) {
    const active = await resolveActiveReview(resolveProjectRoot(process.cwd()));
    if (active !== undefined && operatorGateApplies(active.dir)) {
      throw new Error(`dispatch-check needs --package: review package ${path.relative(process.cwd(), active.dir) || active.dir} is open, and its plan gate is checked against the package. Pass --package ${path.relative(process.cwd(), active.dir) || active.dir}.`);
    }
  }
  if (packageDir !== undefined) {
    // A dispatch starts from fresh layers: refresh them when the package has none for this head.
    const layers = await ensurePackageLayers(packageDir);
    console.error(`layers: ${layersSummaryLine(layers)}`);
  }

  try {
    const payloads = asPayloads(await readJsonSource<unknown>(payloadSource, "payload"));
    const manifest = manifestSource === undefined ? undefined : await readJsonSource<SliceManifest>(manifestSource, "manifest");
    const base = manifestSource === undefined ? process.cwd() : path.dirname(manifestSource);
    // An expensive plan runs only once the operator confirmed it; the estimate reads the same manifest this check does.
    const unsized = manifest === undefined ? undefined : manifestSizeProblem(manifest);
    const plan = packageDir === undefined || unsized !== undefined ? undefined : await packagePlanGate(packageDir, { manifest: manifestSource });
    const result = await checkDispatch(payloads, {
      ...(plan === undefined ? {} : { plan: { refusal: plan.refusal } }),
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
    const result = resultSource === undefined ? {} : await readResult(resultSource);
    const reviewer = optionValue(args, "--reviewer") ?? result.reviewer;
    if (reviewer === undefined || reviewer === "") {
      throw new Error("The result names no reviewer; pass --reviewer <id>.");
    }
    const sliceList = optionValue(args, "--slices");
    const coveredList = optionValue(args, "--covered");
    const packageSource = placed("--package") ?? packageOfManifest(manifestDir);
    const statePath = placed("--state", path.join(manifestDir, RETRY_STATE_NAME)) as string;
    const evaluation = await evaluateRetry({
      manifestSource,
      result,
      reviewer,
      statePath,
      ...(packageSource === undefined ? {} : { packageSource }),
      ...(sliceList === undefined ? {} : { sliceList: sliceList.split(",").map((item) => item.trim()).filter(Boolean) }),
      ...(coveredList === undefined ? {} : { coveredList: coveredList.split(",").map((item) => item.trim()).filter(Boolean) }),
      nextWave,
    });
    const { plan, late } = evaluation;

    if (!args.includes("--dry-run")) {
      const processed = resultSource === undefined || resultSource === "-" ? undefined : sha(await readFile(resultSource, "utf8"));
      await commitRetryPlan(evaluation, processed);
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
            escalations: plan.escalations,
            ...(packageSource === undefined ? {} : { collectedLate: late.collected }),
            dryRun: args.includes("--dry-run"),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`retry-plan: ${plan.decision} — ${reviewer} (${plan.status || "no status"}): ${plan.reason}`);
    if (packageSource !== undefined) {
      console.log(`collected late: ${late.collected}`);
    }
    if (plan.remaining.slices > 0) {
      console.log(`remaining: ${plan.remaining.slices} slice(s), ${plan.remaining.bytes} bytes, ${plan.remaining.waves} wave(s) including this one`);
    }
    for (const item of dispatch) {
      console.log(`- dispatch ${item.reviewer} on ${item.slice} (${item.bytes} bytes): ${item.path}`);
    }
    for (const question of plan.needsContext ?? []) {
      console.log(`- context ${reviewer}: ${question}`);
    }
    for (const item of plan.escalations) {
      console.log(`- escalate ${item.slice}: ${item.severity} finding ${item.finding} from ${item.by} on a light slice; it is re-opened deep and every core role now owns it`);
    }
    if (plan.reportLine !== undefined) {
      console.log(plan.reportLine);
    }
  } catch (error) {
    failUnreadable(error);
  }
}
