// The autonomous review profile: one place that says how an unattended review run is shaped.
//
// The run is `keryx shell --print` in trust mode under review-auto, started by `keryx review run
// --autonomous` and observed through its events file. Nothing here starts a process; the runner
// (`autonomous-run`) and every surface (TUI, scheduler, docs) read the numbers from this module.

import { REFUSED_EARLIER } from "./review-system";

export const AUTONOMOUS_PROFILE_ID = "review-autonomous";

export const AUTONOMOUS_PROFILE = {
  id: AUTONOMOUS_PROFILE_ID,
  permissionMode: "trust",
  reviewSystem: "review-auto",
  /** Review the source only: a run with nobody to open a browser skips any check that needs one. */
  sourceOnly: true,
  /** The most review rounds one run may open. */
  roundLimit: 5,
  /** Reviewers dispatched in one wave. */
  waveSize: 6,
  /** Minutes without a new event before the run is called stalled. */
  stallMinutes: 10,
} as const;

export const AUTONOMOUS_STATUSES = ["complete", "incomplete", "floor", "budget", "stalled"] as const;
export type AutonomousStatus = (typeof AUTONOMOUS_STATUSES)[number];

export const AUTONOMOUS_EXIT: Readonly<Record<AutonomousStatus, number>> = {
  complete: 0,
  incomplete: 2,
  floor: 3,
  budget: 4,
  stalled: 5,
};

export function exitCodeFor(status: AutonomousStatus): number {
  return AUTONOMOUS_EXIT[status];
}

export interface AutonomousTarget {
  readonly kind: "pr";
  readonly ref: string;
  readonly repository: string;
  readonly number: number;
}

const PR_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/;

export function parseAutonomousTarget(ref: string): AutonomousTarget {
  const match = PR_URL.exec(ref.trim());
  if (match === null) {
    throw new Error(`--ref must be a pull request URL (https://github.com/<owner>/<repo>/pull/<number>), got: ${ref}`);
  }
  return { kind: "pr", ref: ref.trim().replace(/\/$/, ""), repository: match[1]!, number: Number(match[2]) };
}

export interface AutonomousArgvInput {
  readonly prompt: string;
  readonly eventsFile: string;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
}

/** The argv after `keryx`. */
export function buildAutonomousShellArgv(input: AutonomousArgvInput): string[] {
  const argv = [
    "shell",
    "--no-tui",
    "--trust",
    "--review-system",
    AUTONOMOUS_PROFILE.reviewSystem,
    "--events-file",
    input.eventsFile,
  ];
  if (input.provider !== undefined) argv.push("--provider", input.provider);
  if (input.model !== undefined) argv.push("--model", input.model);
  argv.push("--print", input.prompt);
  return argv;
}

export function buildAutonomousPrompt(input: { readonly ref: string; readonly resumePackage?: string | undefined }): string {
  const lines = [
    `Run a full managed code review of ${input.ref} and finish it yourself: keryx review start, the reviewer waves, keryx review ingest, then keryx review complete.`,
    `Nobody is at the keyboard and nobody is answering questions. Do not wait for anyone: take the recommended option of any menu, and when an action is refused choose another path instead of repeating it.`,
    `Review the source only (source-only): skip any check that needs a browser or a running app and say that it was skipped.`,
    `Open at most ${AUTONOMOUS_PROFILE.roundLimit} review rounds and dispatch at most ${AUTONOMOUS_PROFILE.waveSize} reviewers per wave. Stop opening rounds when a round finds no new blocker or major.`,
    `Run the whole orchestration yourself in this session. A subagent has no shell and cannot dispatch reviewers (it answers BLOCKED nested_dispatch_unavailable), so hand a subagent only the review of one slice, never the orchestration, the ledger, the ingest or the complete.`,
    `The run is finished only when keryx review complete has closed the package.`,
  ];
  if (input.resumePackage !== undefined) {
    lines.push(`A package for this pull request request already exists: ${input.resumePackage}. Resume it and continue from where it stopped instead of starting a new one.`);
  }
  return lines.join("\n");
}

const FLOOR_REFUSAL_PATTERNS: readonly RegExp[] = [
  /not approved by the user; not executed/i,
  new RegExp(REFUSED_EARLIER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
];

/** Whether a tool result is the refusal an unattended floor ask produces (nobody could approve it). */
export function isFloorRefusal(output: string): boolean {
  return FLOOR_REFUSAL_PATTERNS.some((pattern) => pattern.test(output));
}
