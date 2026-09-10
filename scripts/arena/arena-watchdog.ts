// Supervision for a run that takes hours and can fail in ways shaped like results.
//
// The pilot's whole supervision is one `setTimeout` per adapter followed by
// `proc.kill()`. That is a wall clock and nothing else: no stall detection, no
// token ceiling, no loop detection, no escalation past SIGTERM, and stderr piped
// but never drained so a child that fills the pipe buffer simply stops. There is
// no `scripts/watchdog.ts`, although `shared-definitions.mdc:72` refers to one.
//
// Two design choices here are worth stating because they are what make this
// testable at all:
//
// **The decision is pure.** `evaluate` takes a snapshot of signals and returns a
// verdict. It never reads a clock, a process table or a filesystem. So every
// threshold and every interaction between thresholds is exercised in
// milliseconds, including the case usually forgotten: an arm that works honestly
// right up to the edge of its budget and must NOT be killed.
//
// **Silence is suspended while a known-long child is alive.** `.metaproject/index.md`
// instructs the context arm to rebuild the graph when uncommitted code files are
// present, and a T2 tree is dirty from the agent's first edit. So every context
// arm on T2 is told to run `keryx gdgraph build` over 8,632 files inside its own
// budget, emitting nothing while it does. A naive silence detector kills exactly
// the behaviour under test, and the measurement would report keryx as the harness
// that hangs.

import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

export type KillReason =
  | "ceiling"
  | "silence"
  | "tokens"
  | "loop"
  | "escaped-tree"
  | "disk"
  | "dead-and-silent";

export interface WatchdogThresholds {
  /** Hard wall-clock ceiling for this arm. */
  readonly ceilingMs: number;
  /** No new events for this long, unless a known-long child is alive. */
  readonly silenceMs: number;
  /** Context tokens this arm may consume before it is considered runaway. */
  readonly tokenCeiling: number;
  /** Identical consecutive tool calls that count as a loop. */
  readonly loopLimit: number;
  /** Worktree growth that means a runaway build or log. */
  readonly diskCeilingBytes: number;
}

/**
 * Budgets per task type.
 *
 * `implement` gets three times `research` because it edits, builds and tests;
 * giving both the same ceiling would kill the long task and waste the short one's
 * patience. Token ceilings are generous on purpose: the ceiling catches a runaway,
 * not an expensive-but-working arm, and a ceiling that trims the tail of a normal
 * distribution silently truncates the measurement.
 */
export function thresholdsFor(taskType: "research" | "implement"): WatchdogThresholds {
  if (taskType === "implement") {
    return {
      ceilingMs: 45 * 60_000,
      silenceMs: 5 * 60_000,
      tokenCeiling: 4_000_000,
      loopLimit: 5,
      diskCeilingBytes: 2 * 1024 ** 3,
    };
  }
  return {
    ceilingMs: 15 * 60_000,
    silenceMs: 5 * 60_000,
    tokenCeiling: 1_500_000,
    loopLimit: 5,
    diskCeilingBytes: 2 * 1024 ** 3,
  };
}

/**
 * Commands whose silence is expected rather than suspicious.
 *
 * Matched as substrings of a live descendant's command line. Deliberately short:
 * every addition widens the window in which a genuine hang goes unnoticed, so a
 * name belongs here only when its silence is a known property of the work.
 */
export const LONG_RUNNING_CHILDREN: readonly string[] = [
  "gdgraph",
  "keryx",
  "tsc",
  "vite",
  "esbuild",
  "vitest",
  "oxlint",
  "pnpm",
  "node",
];

export interface WatchdogSnapshot {
  readonly elapsedMs: number;
  /** Since the last event was observed. */
  readonly silenceMs: number;
  /** Command lines of live descendants. Empty means the process tree is gone. */
  readonly children: readonly string[];
  readonly tokens: number;
  /** Identical consecutive `(tool, argument-hash)` pairs seen so far. */
  readonly repeatedCalls: number;
  /** Paths written outside the arm's allowed roots. Any entry is fatal. */
  readonly escapedWrites: readonly string[];
  readonly treeGrowthBytes: number;
}

export interface WatchdogVerdict {
  readonly kill: boolean;
  readonly reason?: KillReason;
  readonly detail?: string;
  /** True when silence was ignored because a known-long child is alive. */
  readonly silenceSuspended: boolean;
}

export function hasLongRunningChild(children: readonly string[]): boolean {
  return children.some((child) => {
    const lowered = child.toLowerCase();
    return LONG_RUNNING_CHILDREN.some((name) => lowered.includes(name));
  });
}

/**
 * Decide, from a snapshot alone, whether this arm should be killed.
 *
 * Order is deliberate and is part of the contract: the most specific and most
 * diagnostic reasons come first, so a run that escaped its tree is reported as
 * `escaped-tree` rather than as whatever timer happened to expire in the same
 * poll. A reason that says "ceiling" when the real story was "it wrote outside
 * its worktree" costs an hour of reading the wrong logs.
 */
export function evaluate(snapshot: WatchdogSnapshot, thresholds: WatchdogThresholds): WatchdogVerdict {
  const silenceSuspended = hasLongRunningChild(snapshot.children);

  if (snapshot.escapedWrites.length > 0) {
    return {
      kill: true,
      reason: "escaped-tree",
      detail: `wrote outside its allowed roots: ${snapshot.escapedWrites.slice(0, 5).join(", ")}`,
      silenceSuspended,
    };
  }
  if (snapshot.repeatedCalls >= thresholds.loopLimit) {
    return {
      kill: true,
      reason: "loop",
      detail: `${snapshot.repeatedCalls} identical consecutive tool calls`,
      silenceSuspended,
    };
  }
  if (snapshot.tokens > thresholds.tokenCeiling) {
    return {
      kill: true,
      reason: "tokens",
      detail: `${snapshot.tokens} context tokens over a ceiling of ${thresholds.tokenCeiling}`,
      silenceSuspended,
    };
  }
  if (snapshot.treeGrowthBytes > thresholds.diskCeilingBytes) {
    return {
      kill: true,
      reason: "disk",
      detail: `worktree grew ${snapshot.treeGrowthBytes} bytes`,
      silenceSuspended,
    };
  }
  if (snapshot.elapsedMs > thresholds.ceilingMs) {
    return {
      kill: true,
      reason: "ceiling",
      detail: `${Math.round(snapshot.elapsedMs / 1000)}s over a ceiling of ${Math.round(thresholds.ceilingMs / 1000)}s`,
      silenceSuspended,
    };
  }
  // A process tree with no descendants that is also emitting nothing is hung, and
  // this fires before the silence timer because it needs no patience: there is
  // nothing left that could break the silence.
  if (snapshot.children.length === 0 && snapshot.silenceMs > thresholds.silenceMs) {
    return {
      kill: true,
      reason: "dead-and-silent",
      detail: "no live descendants and no events",
      silenceSuspended: false,
    };
  }
  if (!silenceSuspended && snapshot.silenceMs > thresholds.silenceMs) {
    return {
      kill: true,
      reason: "silence",
      detail: `${Math.round(snapshot.silenceMs / 1000)}s without an event`,
      silenceSuspended: false,
    };
  }
  return { kill: false, silenceSuspended };
}

// ---------------------------------------------------------------------------
// Observation and process control. Impure by nature, kept thin so the decision
// above carries all the judgement.
// ---------------------------------------------------------------------------

function run(command: readonly string[]): string {
  const [executable, ...args] = command;
  if (executable === undefined) return "";
  const proc = Bun.spawnSync([executable, ...args]);
  return proc.stdout.toString();
}

/**
 * Command lines of live descendants of `pid`, walked breadth-first and bounded.
 *
 * Bounded because this runs on every poll and costs two subprocesses per node. An
 * arm's own tree is a handful of processes, but pointed at a shallow ancestor the
 * same walk enumerates the whole machine — measured at 18 seconds from pid 1,
 * which would make the watchdog the slowest thing in the run. The cap is not a
 * correctness compromise: the decision only asks whether SOME long-running child
 * is alive and whether the tree is empty, and neither answer changes past the
 * first few dozen nodes.
 */
export const DESCENDANT_SCAN_LIMIT = 64;

export function descendantCommands(pid: number, limit: number = DESCENDANT_SCAN_LIMIT): string[] {
  const seen = new Set<number>();
  const queue = [pid];
  const commands: string[] = [];
  while (queue.length > 0 && seen.size <= limit) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const line of run(["pgrep", "-P", String(current)]).split("\n")) {
      const child = Number.parseInt(line.trim(), 10);
      if (Number.isNaN(child)) continue;
      queue.push(child);
      const args = run(["ps", "-o", "command=", "-p", String(child)]).trim();
      if (args.length > 0) commands.push(args);
      if (commands.length >= limit) return commands;
    }
  }
  return commands;
}

/** Milliseconds since the events file last grew, or 0 when it does not exist yet. */
export function silenceOf(eventsFile: string, now: number = Date.now()): number {
  if (!existsSync(eventsFile)) return 0;
  return Math.max(0, now - statSync(eventsFile).mtimeMs);
}

export interface KillOutcome {
  readonly signalled: readonly string[];
  /** Descendants still alive after escalation. Recorded rather than waited on forever. */
  readonly survivors: readonly string[];
}

const sleepSync = (ms: number): void => {
  Bun.spawnSync(["sleep", (ms / 1000).toFixed(2)]);
};

/**
 * Take down a process group, then anything that escaped it.
 *
 * `proc.kill()` sends SIGTERM to one pid, and `claude`, `grok` and `pnpm` all
 * spawn children that outlive it — which is how a killed arm leaves a `vite` or
 * `tsc` holding the worktree so `rm -rf` fails. So: signal the group, escalate to
 * SIGKILL, then sweep by worktree path for anything reparented out of the group.
 *
 * Survivors are reported rather than waited on. Hanging the sweep to guarantee a
 * clean tree would trade a leaked process for a stuck run, which is the worse
 * failure in a run measured in hours.
 */
export function killProcessTree(pgid: number, worktreePath: string, graceMs = 5000): KillOutcome {
  const signalled: string[] = [];

  const groupAlive = (): boolean => run(["pgrep", "-g", String(pgid)]).trim().length > 0;

  try {
    process.kill(-pgid, "SIGTERM");
    signalled.push("SIGTERM(group)");
  } catch {
    // Already gone, or never led a group. Either way there is nothing to term.
  }
  if (groupAlive()) sleepSync(graceMs);

  if (groupAlive()) {
    try {
      process.kill(-pgid, "SIGKILL");
      signalled.push("SIGKILL(group)");
    } catch {
      // Raced with its own exit.
    }
    sleepSync(graceMs);
  }

  // Anything reparented away from the group, found by the one thing it cannot
  // hide: it is running inside this arm's worktree.
  const strays = run(["pgrep", "-f", worktreePath]).split("\n").map((line) => line.trim()).filter(Boolean);
  for (const stray of strays) {
    const pid = Number.parseInt(stray, 10);
    if (Number.isNaN(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGKILL");
      signalled.push(`SIGKILL(${pid})`);
    } catch {
      // Exited between listing and killing.
    }
  }

  const survivors = run(["pgrep", "-f", worktreePath]).split("\n").map((line) => line.trim()).filter(Boolean);
  return { signalled, survivors };
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface WatchdogLogLine extends WatchdogSnapshot {
  readonly t: string;
  readonly cell: string;
  readonly phase: string;
  readonly budgetMs: number;
  readonly verdict: "ok" | "killed";
  readonly reason?: KillReason;
  readonly silenceSuspended: boolean;
}

/**
 * Append one line per poll, unbuffered.
 *
 * Same rationale as the shell's own event sink: a run killed mid-poll must leave
 * the observations it already made. And a six-hour run that cannot be read while
 * it happens is a six-hour run that gets restarted — so this file is the thing a
 * human tails, not a post-mortem artifact.
 */
export function appendWatchdogLine(file: string, line: WatchdogLogLine): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
}
