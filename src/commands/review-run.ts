// `keryx review run --autonomous`: one unattended review of a pull request (flow 424).
//
// Everything past argument parsing lives in `src/review/autonomous-*.ts`. This file only turns the
// command line into options, prints the verdict and sets the exit code.

import path from "node:path";
import { optionValue } from "../lib/args";
import { createTelegramNotifier, endLine, NO_NOTIFIER, startLine, type RunNotifier } from "./review-notify";
import { AUTONOMOUS_PROFILE, parseAutonomousTarget } from "../review/autonomous-profile";
import { AutonomousRunLockedError, runAutonomousReview, type AutonomousRunOptions, type AutonomousRunResult } from "../review/autonomous-run";

export const RUN_FLAGS = [
  "--autonomous",
  "--target",
  "--ref",
  "--budget-minutes",
  "--budget-tokens",
  "--stall-minutes",
  "--out",
  "--provider",
  "--model",
  "--no-notify",
  "--json",
  "--help",
  "-h",
] as const;

export const RUN_USAGE =
  "keryx review run --autonomous --target pr --ref <pull request URL> [--budget-minutes N] [--budget-tokens N] [--stall-minutes N] [--out <dir>] [--provider p] [--model m] [--no-notify] [--json]";

export const RUN_HELP = `${RUN_USAGE}

Runs one review of a pull request with nobody at the keyboard, in the review-autonomous profile.
Exit codes: 0 complete, 2 incomplete, 3 stopped at a floor, 4 budget spent, 5 stalled, 1 refused
(bad arguments, or another run of the same pull request holds the lock).`;

export interface ParsedRun {
  readonly ref: string;
  readonly budgetMinutes?: number;
  readonly budgetTokens?: number;
  readonly stallMinutes: number;
  readonly out?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly notify: boolean;
  readonly json: boolean;
}

function positive(args: string[], name: string, integer: boolean): number | undefined {
  const raw = optionValue(args, name);
  if (raw === undefined) {
    if (args.some((a) => a === name || a.startsWith(`${name}=`))) throw new Error(`${name} needs a value`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a positive ${integer ? "whole " : ""}number, got "${raw}"`);
  }
  return value;
}

export function parseRunArgs(args: string[]): ParsedRun {
  const unknown = args.filter((a) => a.startsWith("-")).map((a) => (a.includes("=") ? a.slice(0, a.indexOf("=")) : a)).filter((a) => !(RUN_FLAGS as readonly string[]).includes(a));
  if (unknown.length > 0) {
    throw new Error(`Unknown option for \`keryx review run\`: ${[...new Set(unknown)].join(", ")}. Accepted: ${RUN_FLAGS.join(", ")}.`);
  }
  if (!args.includes("--autonomous")) {
    throw new Error(`\`keryx review run\` needs --autonomous: it is the only mode. Usage: ${RUN_USAGE}`);
  }
  const target = optionValue(args, "--target");
  if (target !== "pr") throw new Error(`--target must be "pr" (the only target an autonomous review takes), got ${target === undefined ? "nothing" : `"${target}"`}`);
  const ref = optionValue(args, "--ref");
  if (ref === undefined || ref.length === 0) throw new Error(`--ref <pull request URL> is required. Usage: ${RUN_USAGE}`);
  parseAutonomousTarget(ref);
  const budgetMinutes = positive(args, "--budget-minutes", false);
  const budgetTokens = positive(args, "--budget-tokens", true);
  const stallMinutes = positive(args, "--stall-minutes", false) ?? AUTONOMOUS_PROFILE.stallMinutes;
  const out = optionValue(args, "--out");
  const provider = optionValue(args, "--provider");
  const model = optionValue(args, "--model");
  return {
    ref,
    ...(budgetMinutes === undefined ? {} : { budgetMinutes }),
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
    stallMinutes,
    ...(out === undefined ? {} : { out }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    notify: !args.includes("--no-notify"),
    json: args.includes("--json"),
  };
}

export interface RunCommandDeps {
  readonly cwd?: string;
  readonly run?: (options: AutonomousRunOptions) => Promise<AutonomousRunResult>;
  readonly notifier?: RunNotifier;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
}

/** Returns the process exit code instead of setting it, so a test can read it. */
export async function runReviewRunCommand(args: string[], deps: RunCommandDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  if (args.includes("--help") || args.includes("-h")) {
    log(RUN_HELP);
    return 0;
  }
  let parsed: ParsedRun;
  try {
    parsed = parseRunArgs(args);
  } catch (problem) {
    error(problem instanceof Error ? problem.message : String(problem));
    return 1;
  }
  const cwd = deps.cwd ?? process.cwd();
  const target = parseAutonomousTarget(parsed.ref);
  const notifier = deps.notifier ?? (parsed.notify ? createTelegramNotifier({ project: path.basename(cwd), target }) : NO_NOTIFIER);
  const run = deps.run ?? runAutonomousReview;
  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await notifier.started(startLine(target, 1));
    const result = await run({
      cwd,
      ref: parsed.ref,
      signal: stop.signal,
      stallMs: parsed.stallMinutes * 60_000,
      ...(parsed.budgetMinutes === undefined ? {} : { budgetMinutes: parsed.budgetMinutes }),
      ...(parsed.budgetTokens === undefined ? {} : { budgetTokens: parsed.budgetTokens }),
      ...(parsed.out === undefined ? {} : { out: parsed.out }),
      ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
    });
    await notifier.finished(endLine(result.summary));
    if (parsed.json) log(JSON.stringify(result.summary, null, 2));
    else {
      log(`${result.reused ? "reused" : result.status}: ${result.summary.reason}`);
      log(`report: ${path.join(result.runDir, "report.md")}`);
    }
    return result.exitCode;
  } catch (problem) {
    if (problem instanceof AutonomousRunLockedError) {
      error(problem.message);
      return 1;
    }
    error(problem instanceof Error ? problem.message : String(problem));
    return 1;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await notifier.close();
  }
}

export async function runReviewRun(args: string[]): Promise<void> {
  process.exitCode = await runReviewRunCommand(args);
}
