// `keryx review run --autonomous`: one unattended review of a pull request (flow 424).
//
// Everything past argument parsing lives in `src/review/autonomous-*.ts`. This file only turns the
// command line into options, prints the verdict and sets the exit code.

import path from "node:path";
import { optionValue } from "../lib/args";
import { createTelegramNotifier, arbiterEscalateLine, endLine, NO_NOTIFIER, startLine, type RunNotifier } from "./review-notify";
import { AUTONOMOUS_PROFILE, parseAutonomousRangeTarget, parseAutonomousTarget, type AutonomousTarget } from "../review/autonomous-profile";
import { ARBITER_LOG_NAME, readArbiterLog } from "../review/arbiter-log";
import { AutonomousRunLockedError, runAutonomousReview, type AutonomousRunOptions, type AutonomousRunResult } from "../review/autonomous-run";

export const RUN_FLAGS = [
  "--autonomous",
  "--target",
  "--ref",
  "--head",
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
  "keryx review run --autonomous (--target pr --ref <pull request URL> | --target branch --ref <base> [--head <commit>]) [--budget-minutes N] [--budget-tokens N] [--stall-minutes N] [--out <dir>] [--provider p] [--model m] [--no-notify] [--json]";

export const RUN_HELP = `${RUN_USAGE}

Runs one review of a pull request with nobody at the keyboard, in the review-autonomous profile.
--target branch reviews a local range base...head instead (head defaults to the commit checked out): the
path for a host that cannot spawn reviewers itself and has no pull request to name.
Exit codes: 0 complete, 2 incomplete, 3 stopped at a floor, 4 budget spent, 5 stalled, 1 refused
(bad arguments, or another run of the same pull request holds the lock).
While it runs it writes a "heartbeat:" line to stderr when the phase, round count or token count
changes (at most one a minute), and again whenever a minute passes with no line, so a wrapper with an
idle timeout sees the run is alive. Also with --json, whose verdict is the only thing on stdout.
A run that really stalls is still stopped by --stall-minutes (exit 5), and the lines end with it.`;

export interface ParsedRun {
  readonly ref: string;
  readonly target: AutonomousTarget;
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
  const kind = optionValue(args, "--target");
  if (kind !== "pr" && kind !== "branch") throw new Error(`--target must be "pr" or "branch" (a local base...head range), got ${kind === undefined ? "nothing" : `"${kind}"`}`);
  const ref = optionValue(args, "--ref");
  if (ref === undefined || ref.length === 0) throw new Error(`--ref <${kind === "pr" ? "pull request URL" : "base"}> is required. Usage: ${RUN_USAGE}`);
  const head = optionValue(args, "--head");
  if (kind === "pr" && head !== undefined) throw new Error("--head is for --target branch; a pull request's head is read from the pull request");
  const target: AutonomousTarget = kind === "pr" ? parseAutonomousTarget(ref) : parseAutonomousRangeTarget(ref, head);
  const budgetMinutes = positive(args, "--budget-minutes", false);
  const budgetTokens = positive(args, "--budget-tokens", true);
  const stallMinutes = positive(args, "--stall-minutes", false) ?? AUTONOMOUS_PROFILE.stallMinutes;
  const out = optionValue(args, "--out");
  const provider = optionValue(args, "--provider");
  const model = optionValue(args, "--model");
  return {
    ref,
    target,
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

/** Minimum gap between two change-driven heartbeat lines; the token count moves on nearly every poll. */
export const HEARTBEAT_MIN_GAP_MS = 60_000;

/** A line is written at least this often while the run is alive, change or no change. */
export const HEARTBEAT_KEEPALIVE_MS = 60_000;

type HeartbeatProgress = { state: string; phase: string; rounds: number; tokens: number };
export type Heartbeat = ((progress: HeartbeatProgress) => void) & { stop: () => void };

/**
 * stderr lines that show a review run is alive: one per change of phase, round count or token count
 * (at most one per gap), and, when `keepAliveMs` is given, one more whenever that long passes with
 * no line, repeating the latest known state.
 *
 * `--json` keeps stdout for the verdict, so a caller that wraps this command in a shell task sees
 * nothing for the whole run and its idle rail kills it; stderr is what keeps that task alive. The
 * timer only writes. Stall detection stays with the runner, which watches the child's events file,
 * so a line from here never counts as progress of the child. `stop()` ends the timer; it never
 * keeps the process alive.
 */
export function createHeartbeat(
  write: (line: string) => void,
  now: () => number = Date.now,
  minGapMs: number = HEARTBEAT_MIN_GAP_MS,
  keepAliveMs?: number,
): Heartbeat {
  let lastKey = "";
  let lastAt = Number.NEGATIVE_INFINITY;
  let latest: HeartbeatProgress = { state: "running", phase: "starting", rounds: 0, tokens: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const emit = (progress: HeartbeatProgress): void => {
    lastKey = `${progress.phase}|${progress.rounds}|${progress.tokens}`;
    lastAt = now();
    write(`heartbeat: phase ${progress.phase}, ${progress.rounds} round(s), ${progress.tokens} tokens`);
    arm();
  };
  const arm = (): void => {
    if (keepAliveMs === undefined || stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => emit(latest), keepAliveMs);
    timer.unref?.();
  };

  const beat = ((progress: HeartbeatProgress): void => {
    if (stopped || progress.state !== "running") return;
    latest = progress;
    const key = `${progress.phase}|${progress.rounds}|${progress.tokens}`;
    if (key === lastKey || now() - lastAt < minGapMs) return;
    emit(progress);
  }) as Heartbeat;
  beat.stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  arm();
  return beat;
}

export interface RunCommandDeps {
  readonly cwd?: string;
  readonly run?: (options: AutonomousRunOptions) => Promise<AutonomousRunResult>;
  readonly notifier?: RunNotifier;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
  readonly now?: () => number;
  /** Keep-alive period for the stderr heartbeat; a test shortens it. */
  readonly keepAliveMs?: number;
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
  const target = parsed.target;
  const notifier = deps.notifier ?? (parsed.notify ? createTelegramNotifier({ project: path.basename(cwd), target }) : NO_NOTIFIER);
  const run = deps.run ?? runAutonomousReview;
  const heartbeat = createHeartbeat(error, deps.now, undefined, deps.keepAliveMs ?? HEARTBEAT_KEEPALIVE_MS);
  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await notifier.started(startLine(target, 1));
    const result = await run({
      cwd,
      ref: parsed.ref,
      target,
      signal: stop.signal,
      onProgress: heartbeat,
      stallMs: parsed.stallMinutes * 60_000,
      ...(parsed.budgetMinutes === undefined ? {} : { budgetMinutes: parsed.budgetMinutes }),
      ...(parsed.budgetTokens === undefined ? {} : { budgetTokens: parsed.budgetTokens }),
      ...(parsed.out === undefined ? {} : { out: parsed.out }),
      ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
    });
    await notifier.finished(endLine(result.summary));
    const escalated = arbiterEscalateLine(result.summary, readArbiterLog(path.join(result.runDir, ARBITER_LOG_NAME)));
    if (escalated !== undefined) await notifier.finished(escalated);
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
    heartbeat.stop();
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await notifier.close();
  }
}

export async function runReviewRun(args: string[]): Promise<void> {
  process.exitCode = await runReviewRunCommand(args);
}
