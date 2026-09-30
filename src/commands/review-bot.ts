// `keryx review bot run|post` and `keryx review metrics`: the review bot's command surface.
// Registration in `review.ts` is two `if` branches; everything else lives here and in
// `src/review/bot/`.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { optionValue } from "../lib/args";
import { runModelTurn } from "../harness/provider/single-turn";
import { computeBotMetrics, refreshPullStates, renderBotMetrics } from "../review/bot/metrics";
import { postBotReview, renderPostSummary } from "../review/bot/post";
import { DEFAULT_MAX_DIFF_BYTES, renderRunSummary, runReviewBot } from "../review/bot/run";
import { createFixturePort, createGhPort, type GitHubPort } from "../review/pr-comments";

const RUN_USAGE = `keryx review bot run --pr <n> [--repo <owner/repo>] [--max-diff-bytes <n>]
                     [--provider <id>] [--model <id>] [--fixtures <dir>] [--json]
  Reviews the pull request diff (one reviewer turn, one verifier turn per finding),
  drops findings the verifier refutes, and records the rest as a managed review.
  Refuses a fork pull request before any model call. Nothing is posted.
  The diff is cut at --max-diff-bytes (default ${DEFAULT_MAX_DIFF_BYTES.toLocaleString("en-US")}); the cut is stated in the output.`;

const POST_USAGE = `keryx review bot post --pr <n> [--repo <owner/repo>] [--sha <head-sha>] [--review <id>]
                      [--post] [--fixtures <dir>] [--json]
  Builds ONE pull request review (event COMMENT, commit_id = the pull request head) with
  an inline comment per finding inside the diff and the rest in the review body.
  A dry run by default: it prints the payload. --post sends it.
  Refused when the pull request is closed, merged or from a fork, when --sha is not the
  head, or when the review was made at an older commit.`;

const METRICS_USAGE = `keryx review metrics [--json] [--refresh] [--fixtures <dir>]
  Findings raised, acted on, dismissed by kind, answered, still open; precision
  (acted on / acted on + dismissed incorrect); resolved-before-merge. A ratio with
  no data prints n/a. --refresh reads merge state from GitHub first.`;

function reject(args: readonly string[], valued: readonly string[], boolean: readonly string[], usage: string): void {
  const problems: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (!argument.startsWith("--")) {
      problems.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument : argument.slice(0, equals);
    if (valued.includes(name)) {
      if (equals === -1) index += 1;
    } else if (!boolean.includes(name)) {
      problems.push(name);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Unexpected argument(s) for \`${usage.split("\n")[0]?.split(" [")[0]}\`: ${problems.join(", ")}. Refused rather than ignored.`);
  }
}

async function portFor(args: string[]): Promise<GitHubPort> {
  const fixtures = optionValue(args, "--fixtures");
  if (fixtures === undefined) return createGhPort();
  let pull: unknown;
  try {
    pull = JSON.parse(await readFile(join(fixtures, "pull.json"), "utf8")) as unknown;
  } catch {
    pull = {};
  }
  return createFixturePort({ pull });
}

function repoFrom(args: string[]): string | undefined {
  return optionValue(args, "--repo") ?? process.env.GITHUB_REPOSITORY;
}

function pullNumber(args: string[]): number {
  const raw = optionValue(args, "--pr");
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error("--pr <positive number> is required.");
  return value;
}

function wantsHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export async function runReviewBotCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "run") {
    if (wantsHelp(rest)) {
      console.log(RUN_USAGE);
      return;
    }
    reject(rest, ["--pr", "--repo", "--max-diff-bytes", "--provider", "--model", "--fixtures"], ["--json"], RUN_USAGE);
    const repo = repoFrom(rest);
    if (repo === undefined) throw new Error("--repo <owner/repo> is required (or set GITHUB_REPOSITORY).");
    const cap = optionValue(rest, "--max-diff-bytes");
    const provider = optionValue(rest, "--provider");
    const model = optionValue(rest, "--model");
    const result = await runReviewBot({
      cwd: process.cwd(),
      repo,
      number: pullNumber(rest),
      port: await portFor(rest),
      runTurn: runModelTurn,
      ...(cap !== undefined ? { maxDiffBytes: Number(cap) } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
    });
    if (rest.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else if (result.ok) process.stdout.write(renderRunSummary(result));
    else console.error(`review bot run stopped at ${result.stage}: ${result.reason}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === "post") {
    if (wantsHelp(rest)) {
      console.log(POST_USAGE);
      return;
    }
    reject(rest, ["--pr", "--repo", "--sha", "--review", "--fixtures"], ["--post", "--json"], POST_USAGE);
    const repo = repoFrom(rest);
    if (repo === undefined) throw new Error("--repo <owner/repo> is required (or set GITHUB_REPOSITORY).");
    const sha = optionValue(rest, "--sha");
    const review = optionValue(rest, "--review");
    const result = await postBotReview({
      cwd: process.cwd(),
      repo,
      number: pullNumber(rest),
      port: await portFor(rest),
      send: rest.includes("--post"),
      ...(sha !== undefined ? { sha } : {}),
      ...(review !== undefined ? { review } : {}),
    });
    if (rest.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else if (result.ok) process.stdout.write(renderPostSummary(result));
    else console.error(`review bot post stopped at ${result.stage}: ${result.reason}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  console.log(`keryx review bot\n\nUsage:\n  ${RUN_USAGE}\n  ${POST_USAGE}`);
  if (sub !== undefined && sub !== "--help" && sub !== "-h") process.exitCode = 1;
}

export async function runReviewMetricsCommand(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    console.log(METRICS_USAGE);
    return;
  }
  reject(args, ["--fixtures"], ["--json", "--refresh"], METRICS_USAGE);
  if (args.includes("--refresh")) {
    const refreshed = await refreshPullStates(process.cwd(), await portFor(args), new Date());
    for (const failure of refreshed.failed) console.error(`could not refresh ${failure}`);
  }
  const metrics = await computeBotMetrics(process.cwd());
  if (args.includes("--json")) console.log(JSON.stringify(metrics, null, 2));
  else process.stdout.write(renderBotMetrics(metrics));
}
