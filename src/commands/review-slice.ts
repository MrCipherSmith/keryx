import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { writeFileAtomic } from "../lib/fs";
import { checkDispatch, renderDispatchCheck } from "../review/dispatch-check";
import { type RetryState, type ReviewerResult, emptyRetryState, planRetry } from "../review/retry-plan";
import { DEFAULT_SLICE_MAX_BYTES, type SliceManifest, buildSlices, renderSliceSummary, sliceSourceFromDiff, validateSliceMaxBytes } from "../review/slice";

/** The diff-fetching and flag helpers `review.ts` owns, passed in so this file does not import its caller. */
export type SliceDeps = {
  gitDiff: (ref: string | undefined, contextLines: number) => Promise<string>;
  readDiffSource: (source: string) => Promise<string>;
  parseContextLines: (raw: string | undefined) => number;
  rejectUnknownFlags: (args: readonly string[], allowed: readonly string[], usage: string) => void;
};

export const SLICE_FLAGS = ["--ref", "--base", "--diff", "--context", "--max-bytes", "--out", "--json", "--help", "-h"] as const;
export const DISPATCH_CHECK_FLAGS = ["--payload", "--manifest", "--max-bytes", "--json", "--help", "-h"] as const;
export const RETRY_PLAN_FLAGS = ["--manifest", "--result", "--reviewer", "--slices", "--state", "--dry-run", "--json", "--help", "-h"] as const;

const DEFAULT_SLICE_DIR = ".metaproject/data/review/slices";
const MANIFEST_NAME = "manifest.json";
const RETRY_STATE_NAME = "retry-state.json";

function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export function printSliceHelp(): void {
  console.log(`keryx review slice — usage:

  keryx review slice [--ref <base>] [--diff <file|->] [--context <n>]
                     [--max-bytes <n>] [--out <dir>] [--json]

Cuts the scoped diff into reviewer-sized slices, no model call. Each slice is a
file of at most --max-bytes (default ${DEFAULT_SLICE_MAX_BYTES}) holding whole domains where they fit; a domain over the
limit is cut by file, a file over it by hunk. Data ledgers (csv, tsv, jsonl,
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
                              [--max-bytes <n>] [--json]

Validates reviewer payload(s) before dispatch: one reviewer-input object, an
array of them, or { "dispatches": [...] }. Shape comes from
reviewer-input.schema.json; a scope_mode "diff" payload must name its \`slices\`
(ids from the manifest) or carry a \`diff\` that fits, and what it is assigned
must total at most --max-bytes (default: the manifest's, else ${DEFAULT_SLICE_MAX_BYTES}).

Codes: REVIEWER_INPUT_INVALID, REVIEWER_INPUT_NO_SLICE,
REVIEWER_INPUT_SLICE_UNKNOWN, REVIEWER_INPUT_TOO_LARGE.
Exit 0 ok, 1 payload refused, 2 payload or manifest unreadable.
`);
}

export function printRetryPlanHelp(): void {
  console.log(`keryx review retry-plan — usage:

  keryx review retry-plan --manifest <manifest.json> --result <file|->
                          [--reviewer <id>] [--slices a,b] [--state <file>]
                          [--dry-run] [--json]

Decides what follows a reviewer result. --result is the reviewer's result JSON
({ "reviewer", "status", "slices"? , "attempt"? }). INCOMPLETE and BLOCKED get
exactly one retry on slices half the size (r1-<reviewer>-NN.diff, appended to the
manifest); a second failure is decision "not-run" and prints the report line
"- **Not run:** <reviewer> — <status> after a smaller-slice retry; never counted
as a clean pass". Any other status is "accepted".
Attempts are remembered in ${RETRY_STATE_NAME} beside the manifest (--state to move it).
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
  const contextLines = deps.parseContextLines(optionValue(args, "--context"));
  const rawMax = optionValue(args, "--max-bytes");
  const maxBytes = validateSliceMaxBytes(rawMax === undefined ? DEFAULT_SLICE_MAX_BYTES : Number(rawMax));
  const diffFile = optionValue(args, "--diff");
  const ref = optionValue(args, "--ref") ?? optionValue(args, "--base");
  const outDir = path.resolve(optionValue(args, "--out") ?? DEFAULT_SLICE_DIR);

  const diff = diffFile !== undefined ? await deps.readDiffSource(diffFile) : await deps.gitDiff(ref, contextLines);
  const { manifest, slices } = buildSlices(sliceSourceFromDiff(diff, { contextLines }), { maxBytes });

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
  const payloadSource = optionValue(args, "--payload");
  if (payloadSource === undefined) {
    throw new Error("Missing --payload <file|->. See `keryx review dispatch-check --help`.");
  }
  const manifestSource = optionValue(args, "--manifest");
  const rawMax = optionValue(args, "--max-bytes");

  try {
    const payloads = asPayloads(await readJsonSource<unknown>(payloadSource, "payload"));
    const manifest = manifestSource === undefined ? undefined : await readJsonSource<SliceManifest>(manifestSource, "manifest");
    const base = manifestSource === undefined ? process.cwd() : path.dirname(path.resolve(manifestSource));
    const result = await checkDispatch(payloads, {
      ...(manifest === undefined ? {} : { manifest }),
      ...(rawMax === undefined ? {} : { maxBytes: validateSliceMaxBytes(Number(rawMax)) }),
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
  const manifestSource = optionValue(args, "--manifest");
  const resultSource = optionValue(args, "--result");
  if (manifestSource === undefined || resultSource === undefined) {
    throw new Error("Missing --manifest <file> or --result <file|->. See `keryx review retry-plan --help`.");
  }

  try {
    const manifestPath = path.resolve(manifestSource);
    const manifestDir = path.dirname(manifestPath);
    const manifest = await readJsonSource<SliceManifest>(manifestPath, "manifest");
    const result = await readJsonSource<ReviewerResult>(resultSource, "result");
    const statePath = path.resolve(optionValue(args, "--state") ?? path.join(manifestDir, RETRY_STATE_NAME));
    const state = existsSync(statePath) ? await readJsonSource<RetryState>(statePath, "state") : emptyRetryState();
    const reviewer = optionValue(args, "--reviewer") ?? result.reviewer;
    if (reviewer === undefined || reviewer === "") {
      throw new Error("The result names no reviewer; pass --reviewer <id>.");
    }
    const sliceList = optionValue(args, "--slices");
    const plan = planRetry({
      manifest,
      result,
      reviewer,
      ...(sliceList === undefined ? {} : { sliceIds: sliceList.split(",").map((item) => item.trim()).filter(Boolean) }),
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
        await writeFileAtomic(manifestPath, `${JSON.stringify({ ...manifest, slices: [...manifest.slices, ...added] }, null, 2)}\n`);
      }
      await writeFileAtomic(statePath, `${JSON.stringify(plan.state, null, 2)}\n`);
    }

    const dispatch = plan.newSlices.map((slice) => ({ reviewer, slice: slice.id, path: slice.path, bytes: slice.bytes }));
    if (args.includes("--json")) {
      console.log(
        JSON.stringify(
          {
            decision: plan.decision,
            reviewer,
            status: plan.status,
            priorAttempts: plan.priorAttempts,
            reason: plan.reason,
            reportLine: plan.reportLine ?? null,
            dispatch,
            dryRun: args.includes("--dry-run"),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`retry-plan: ${plan.decision} — ${reviewer} (${plan.status || "no status"}): ${plan.reason}`);
    for (const item of dispatch) {
      console.log(`- dispatch ${item.reviewer} on ${item.slice} (${item.bytes} bytes): ${item.path}`);
    }
    if (plan.reportLine !== undefined) {
      console.log(plan.reportLine);
    }
  } catch (error) {
    failUnreadable(error);
  }
}
