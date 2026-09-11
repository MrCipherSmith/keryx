// The watchdog, running.
//
// `arena-watchdog.ts` decides; this polls. Every `pollMs` it takes a snapshot of
// the arm — elapsed time, how long the child has been silent, which descendants
// are alive — asks `evaluate` for a verdict, appends the verdict to the watchdog
// log, and kills the tree when the verdict says so.
//
// Two signals the decision knows about are deliberately NOT fed yet, and are held
// at values that can never trigger:
//
// - **tokens.** The research ceiling is 1,500,000 context tokens, and the smoke's
//   honest grok-build control arm used 1,495,992. Feeding the live count would have
//   killed a working arm 4,008 tokens from the end — the ceiling has to be
//   recalibrated against the smoke before it can be trusted with a kill.
// - **repeated calls.** No adapter exposes a live tool-call stream yet.
//
// Wall clock, silence (suspended while a known-long child such as `gdgraph build`
// is alive) and dead-and-silent are live. Those are the three that bound a hang.

import {
  appendWatchdogLine,
  descendantCommands,
  evaluate,
  killPidTree,
  type WatchdogThresholds,
  type WatchdogVerdict,
} from "./arena-watchdog";
import type { SupervisedChild, Supervision } from "../benchmark/retrieval-supervision";

export interface ArmSupervisorOptions {
  readonly thresholds: WatchdogThresholds;
  readonly worktreePath: string;
  /** `<task>-<harness>-<arm>`, written on every log line. */
  readonly cell: string;
  /** One JSON line per poll. Omitted in tests. */
  readonly logFile?: string;
  readonly pollMs?: number;
  readonly now?: () => number;
  /** Injectable for tests; defaults to the real process-table walk and kill. */
  readonly observeChildren?: (pid: number) => readonly string[];
  readonly kill?: (pid: number, worktreePath: string) => void;
}

export function superviseArm(child: SupervisedChild, options: ArmSupervisorOptions): Supervision {
  const now = options.now ?? Date.now;
  const observe = options.observeChildren ?? ((pid: number) => descendantCommands(pid));
  const kill = options.kill ?? ((pid: number, tree: string) => void killPidTree(pid, tree));
  const started = now();
  let verdict: WatchdogVerdict | undefined;

  const poll = (): void => {
    if (verdict !== undefined) return;
    const snapshot = {
      elapsedMs: now() - started,
      silenceMs: child.silenceMs(),
      children: observe(child.pid),
      tokens: 0,
      repeatedCalls: 0,
      escapedWrites: [],
      treeGrowthBytes: 0,
    };
    const decided = evaluate(snapshot, options.thresholds);
    if (options.logFile !== undefined) {
      appendWatchdogLine(options.logFile, {
        ...snapshot,
        t: new Date(now()).toISOString(),
        cell: options.cell,
        phase: "agent",
        budgetMs: options.thresholds.ceilingMs,
        verdict: decided.kill ? "killed" : "ok",
        ...(decided.reason === undefined ? {} : { reason: decided.reason }),
        silenceSuspended: decided.silenceSuspended,
      });
    }
    if (decided.kill) {
      verdict = decided;
      clearInterval(timer);
      kill(child.pid, options.worktreePath);
    }
  };

  const timer = setInterval(poll, options.pollMs ?? 5000);

  return {
    stop: () => clearInterval(timer),
    get killReason() {
      return verdict?.reason;
    },
    get killDetail() {
      return verdict?.detail;
    },
  };
}
