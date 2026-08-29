import { appendFile } from "node:fs/promises";
import { optionValue } from "../lib/args";
import {
  completeManagedReview,
  createManagedReviewPackage,
  getManagedReviewStatus,
} from "../review/managed";
import {
  buildPathScope,
  buildReviewScope,
  DEFAULT_CONTEXT_LINES,
  renderReviewScopeMarkdown,
  renderScopedDiff,
  type ReviewScope,
} from "../review/scope";
import { MANAGED_REVIEW_MODES, REVIEW_TARGET_KINDS, type ManagedReviewMode, type ReviewTargetKind } from "../review/types";

export async function reviewCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  try {
    if (command === "attach") {
      await runCreate("attach-review", args.slice(1));
      return;
    }
    if (command === "start") {
      await runCreate("review-flow", args.slice(1));
      return;
    }
    if (command === "ingest") {
      await runCreate("ingest", args.slice(1));
      return;
    }
    if (command === "scope") {
      await runScope(args.slice(1));
      return;
    }
    if (command === "status") {
      await runStatus(args.slice(1));
      return;
    }
    if (command === "complete") {
      await runComplete(args.slice(1));
      return;
    }
    if (command === "lightweight") {
      console.log("lightweight review mode: report-only; no managed review artifacts created");
      return;
    }
    console.error(`Unknown review command: ${command}`);
    printHelp();
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runCreate(mode: ManagedReviewMode, args: string[]): Promise<void> {
  const targetKind = targetKindFromArgs(mode, args);
  const targetRef = optionValue(args, "--ref") ?? optionValue(args, "--target-ref");
  if (!targetRef) {
    throw new Error("Usage: keryx review <attach|start|ingest> --target <kind> --ref <ref>");
  }
  const reviewers = optionValue(args, "--reviewers")?.split(",").map((item) => item.trim()).filter(Boolean);
  const input = {
    cwd: process.cwd(),
    mode,
    target: { kind: targetKind, ref: targetRef },
    flowId: optionValue(args, "--flow"),
    reviewId: optionValue(args, "--review-id"),
    reviewers,
    reportPath: optionValue(args, "--report"),
  };
  const result = await createManagedReviewPackage(input);
  console.log(`# managed review: ${result.reviewId}`);
  console.log("");
  console.log(`mode: ${result.manifest.mode}`);
  console.log(`status: ${result.manifest.status}`);
  console.log(`path: ${result.path}`);
  console.log(`flow: ${result.manifest.flow?.id ?? "none"}`);
}

/**
 * `keryx review scope` — the deterministic pre-filter, run before reviewers are
 * dispatched (flow 202, AC3–AC5).
 *
 * This command exists so the orchestrator stops eyeballing a diff. Everything it
 * decides is decided in `review/scope.ts`, which is pure; the only work done
 * here is fetching the diff and choosing where the answer is written.
 */
async function runScope(args: string[]): Promise<void> {
  const contextLines = parseContextLines(optionValue(args, "--context"));
  const pathList = optionValue(args, "--path");
  const diffFile = optionValue(args, "--diff");
  const ref = optionValue(args, "--ref") ?? optionValue(args, "--base");

  let scope: ReviewScope;
  if (pathList !== undefined) {
    const paths = pathList
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    scope = buildPathScope(paths, { contextLines });
  } else {
    const diff = diffFile !== undefined ? await readDiffSource(diffFile) : await gitDiff(ref, contextLines);
    scope = buildReviewScope(diff, { contextLines });
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(scope, null, 2));
  } else if (args.includes("--scoped-diff")) {
    console.log(renderScopedDiff(scope));
  } else {
    console.log(renderReviewScopeMarkdown(scope));
  }

  // AC5: the drop list belongs in the review record, not only on a terminal.
  const append = optionValue(args, "--append");
  if (append !== undefined) {
    await appendFile(append, `\n${renderReviewScopeMarkdown(scope)}`, "utf8");
  }
}

function parseContextLines(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_CONTEXT_LINES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --context: ${raw}. Expected a non-negative integer.`);
  }
  return parsed;
}

async function readDiffSource(source: string): Promise<string> {
  if (source === "-") {
    return await Bun.stdin.text();
  }
  return await Bun.file(source).text();
}

/**
 * The diff the scope is built from.
 *
 * `-U${contextLines}` matters: the window the pre-filter reports is bounded by
 * what the diff actually carries, so asking git for less context than the window
 * would make every region report `context_truncated` and hand reviewers less
 * than the configured bound.
 */
async function gitDiff(ref: string | undefined, contextLines: number): Promise<string> {
  const command = ["git", "diff", "--no-color", `-U${contextLines}`, ...(ref === undefined ? [] : [ref])];
  const proc = Bun.spawn(command, { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

async function runStatus(args: string[]): Promise<void> {
  const ref = args[0];
  if (!ref) {
    throw new Error("Usage: keryx review status <review-id-or-path>");
  }
  const manifest = await getManagedReviewStatus(process.cwd(), ref);
  console.log(`# managed review: ${manifest.reviewId}`);
  console.log("");
  console.log(`mode: ${manifest.mode}`);
  console.log(`status: ${manifest.status}`);
  console.log(`target: ${manifest.target.kind} ${manifest.target.ref}`);
  console.log(`flow: ${manifest.flow?.id ?? "none"}`);
  console.log(`coverage: ${manifest.coverage.length}`);
}

async function runComplete(args: string[]): Promise<void> {
  const ref = args[0];
  if (!ref) {
    throw new Error("Usage: keryx review complete <review-id-or-path>");
  }
  const manifest = await completeManagedReview(process.cwd(), ref);
  console.log(`# managed review complete: ${manifest.reviewId}`);
  console.log(`status: ${manifest.status}`);
}

function targetKindFromArgs(mode: ManagedReviewMode, args: string[]): ReviewTargetKind {
  const value = optionValue(args, "--target") ?? (mode === "ingest" ? "report" : undefined);
  if (!value || !REVIEW_TARGET_KINDS.includes(value as ReviewTargetKind)) {
    throw new Error(`Invalid --target. Use one of: ${REVIEW_TARGET_KINDS.join(", ")}`);
  }
  return value as ReviewTargetKind;
}

function printHelp(): void {
  console.log(`keryx review

Usage:
  keryx review attach --flow <id> --target <kind> --ref <ref> [--reviewers a,b] [--report <path>]
  keryx review start --target <kind> --ref <ref> [--reviewers a,b] [--report <path>]
  keryx review ingest --report <path> [--flow <id>] --ref <ref>
  keryx review scope [--ref <base>] [--diff <file|->] [--path a,b] [--context <n>]
                     [--json | --scoped-diff] [--append <file>]
  keryx review status <review-id-or-path>
  keryx review complete <review-id-or-path>
  keryx review lightweight

Modes:
  ${MANAGED_REVIEW_MODES.join(", ")}

scope:
  Deterministic pre-filter, no model call. Drops generated, lockfile, snapshot,
  vendored and minified paths, drops whitespace-only and comment-only change
  blocks, and bounds each retained change to +/-${DEFAULT_CONTEXT_LINES} lines of context by default.
  Prints the retained scope AND every drop with its reason; --append writes the
  same record into the review package's scope.md.
`);
}
