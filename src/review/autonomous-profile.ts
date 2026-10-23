// The autonomous review profile: one place that says how an unattended review run is shaped.
//
// The run is `keryx shell --print` in trust mode under review-auto, started by `keryx review run
// --autonomous` and observed through its events file. Nothing here starts a process; the runner
// (`autonomous-run`) and every surface (TUI, scheduler, docs) read the numbers from this module.

import path from "node:path";
import { REFUSED_EARLIER } from "./review-system";

export const AUTONOMOUS_PROFILE_ID = "review-autonomous";

/**
 * Reviewers dispatched in one wave, for every host and every surface: the autonomous prompt, the skill and the docs
 * read this one number (flow 457, T7; the prompt said 6 while the skill said 10).
 */
export const REVIEW_WAVE_SIZE = 10;

/**
 * Where an attended orchestrator writes `keryx review scope --json`. An autonomous run never uses it: two runs at
 * once (two targets, or a scheduler beside a manual run) would overwrite each other's scope between `scope` and
 * `required`. Each run writes its own, {@link autonomousScopeFile}.
 */
export const AUTONOMOUS_SCOPE_FILE = ".metaproject/data/review/scope.json";

/** The scope file of one autonomous run: `scope.json` in its own run directory, relative to `cwd` when inside it. */
export function autonomousScopeFile(runDir: string, cwd: string): string {
  const file = path.join(runDir, "scope.json");
  const relative = path.relative(cwd, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : file;
}

export const AUTONOMOUS_PROFILE = {
  id: AUTONOMOUS_PROFILE_ID,
  permissionMode: "trust",
  reviewSystem: "review-auto",
  /** Review the source only: a run with nobody to open a browser skips any check that needs one. */
  sourceOnly: true,
  /**
   * Review rounds one run opens on one head. A second round reviews the same commit with the same reviewers and finds
   * what the first found; only a head that moved during the run is worth another (flow 457, audit row 15).
   */
  roundLimit: 1,
  /** Reviewers dispatched in one wave: {@link REVIEW_WAVE_SIZE}. */
  waveSize: REVIEW_WAVE_SIZE,
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

/**
 * What an autonomous run reviews: a pull request, or (flow 457, audit row 3) a local range `base...head` for a host
 * with no pull request to name. A range target carries `repository: "local"` and `number: 0`, so every surface that
 * prints a pull request still has the fields; {@link describeAutonomousTarget} is the name to show.
 */
export type AutonomousTarget =
  | { readonly kind: "pr"; readonly ref: string; readonly repository: string; readonly number: number }
  | { readonly kind: "range"; readonly ref: string; readonly base: string; readonly head?: string | undefined; readonly repository: "local"; readonly number: 0 };

const PR_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/;
const RANGE_REF = /^([\w./@^~-]+?)(?:\.\.\.?([\w./@^~-]+))?$/;
const REVISION = /^(?!-)[\w./@^~-]{1,200}$/;

export function parseAutonomousTarget(ref: string): Extract<AutonomousTarget, { kind: "pr" }> {
  const match = PR_URL.exec(ref.trim());
  if (match === null) {
    throw new Error(`--ref must be a pull request URL (https://github.com/<owner>/<repo>/pull/<number>), got: ${ref}`);
  }
  return { kind: "pr", ref: ref.trim().replace(/\/$/, ""), repository: match[1]!, number: Number(match[2]) };
}

/**
 * A local range for `review run --autonomous --target branch`: `--ref <base>` (or `<base>...<head>`) and an optional
 * `--head`. Reviewed as `base...head`, head defaulting to the commit checked out.
 */
export function parseAutonomousRangeTarget(ref: string, head?: string): Extract<AutonomousTarget, { kind: "range" }> {
  const trimmed = ref.trim();
  const range = /^https?:/.test(trimmed) ? null : RANGE_REF.exec(trimmed);
  if (range === null || !REVISION.test(range[1]!)) {
    throw new Error(`--ref must be a local base for --target branch (a branch or commit, optionally <base>...<head>), got: ${ref}`);
  }
  const base = range[1]!;
  const tip = range[2] ?? head;
  if (range[2] !== undefined && head !== undefined && range[2] !== head) throw new Error(`--ref names head ${range[2]} and --head names ${head}; give one`);
  if (tip !== undefined && !REVISION.test(tip)) throw new Error(`--head must be a branch or commit, got: ${tip}`);
  return { kind: "range", ref: `${base}...${tip ?? "HEAD"}`, base, ...(tip === undefined ? {} : { head: tip }), repository: "local", number: 0 };
}

/** The name a person reads: `owner/repo PR #7`, or `range main...HEAD`. */
export function describeAutonomousTarget(target: { readonly kind: string; readonly ref: string; readonly repository: string; readonly number: number }): string {
  return target.kind === "pr" ? `${target.repository} PR #${target.number}` : `range ${target.ref}`;
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

export function buildAutonomousPrompt(input: {
  readonly ref: string;
  readonly resumePackage?: string | undefined;
  /** The pull request's head commit as the host reports it; null when it could not be read. */
  readonly head?: string | null | undefined;
  /** A local range target (flow 457): the base the range is reviewed against. */
  readonly base?: string | undefined;
  /** This run's own scope file ({@link autonomousScopeFile}); the shared attended path only when none is given. */
  readonly scopeFile?: string | undefined;
}): string {
  const scopeFile = input.scopeFile ?? AUTONOMOUS_SCOPE_FILE;
  const subject = input.base === undefined ? input.ref : `the local range ${input.ref} (start the package with \`keryx review start --target branch --ref ${input.base}\`)`;
  const lines = [
    `Run a full managed code review of ${subject} and finish it yourself: keryx review start, the reviewer waves, keryx review ingest, then keryx review complete.`,
    `Nobody is at the keyboard and nobody is answering questions. Do not wait for anyone: take the recommended option of any menu, and when an action is refused choose another path instead of repeating it.`,
    `When \`keryx review blast-radius\` says "Cut blast radius", run \`keryx review chunks plan\` and \`keryx review chunks estimate\` (never with --mode or --answer: those are the operator's), then \`chunks next\` and \`chunks record\` until none is left, then \`chunks merge\`. When \`chunks next\` says the run is over the ceiling, nobody here can answer it: stop the chunk run and report it as needing the operator, not as done. A review with files nobody read does not close: \`keryx review readiness\` lists what is missing.`,
    `Review the source only (source-only): skip any check that needs a browser or a running app and say that it was skipped.`,
    `Open ${AUTONOMOUS_PROFILE.roundLimit} review round on this head and dispatch at most ${AUTONOMOUS_PROFILE.waveSize} reviewers per wave. Do not open another round on the same head: a second round of the same reviewers on the same commit only repeats the first. Open one more round only if the head moved while you worked, and review the new head.`,
    `Dispatch the full reviewer set: write the scope with \`keryx review scope --json > ${scopeFile}\` (this run's own file: another run may be writing the shared one), then run \`keryx review required --mode all --scope ${scopeFile} --package <the package directory keryx review start printed>\` and dispatch every reviewer it prints, with dispatch mode "all". Without --scope and --package it can only name the whole set for a full round. Nobody can name a narrower review in a run like this, so do not use mode "diff".`,
    `Run the whole orchestration yourself in this session. A subagent has no shell and cannot dispatch reviewers (it answers BLOCKED nested_dispatch_unavailable), so hand a subagent only the review of one slice, never the orchestration, the ledger, the ingest or the complete.`,
    `The review skills live in this clone under \`.metaproject/skills/gdskills/review/\` (the orchestration is \`review-orchestrator/SKILL.md\` there): read them from that path and do not search the filesystem or \`$HOME/.keryx\` for them.`,
    `A guard refuses raw \`git diff\`, \`cat\`, \`sed\`, \`find\` and \`tail\` in the shell. Use \`keryx ctx diff\`, \`keryx ctx read <file>\` and \`keryx ctx run -- <command>\` instead, or end a command that must stay raw with \`# keryx:raw <why>\`.`,
    `The run is finished only when keryx review complete has closed the package.`,
  ];
  if (input.head !== undefined && input.head !== null && input.base === undefined) {
    lines.push(
      `The pull request head is ${input.head}. Review exactly that commit, in a detached worktree at it, and pass \`--head ${input.head}\` to \`keryx review start\` (or attach) to \`keryx review ingest\` and to \`keryx review complete\`: without it keryx records the commit checked out in this directory, which is not the commit you reviewed, and the close is checked against that commit.`,
    );
  }
  if (input.base !== undefined && input.head !== undefined && input.head !== null) {
    lines.push(
      `The range head is ${input.head}. Review exactly that commit against ${input.base} and pass \`--head ${input.head}\` to \`keryx review start\`, \`keryx review ingest\` and \`keryx review complete\`. There is no pull request: skip any step that reads or posts to one, and say that it was skipped.`,
    );
  }
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

const LOOP_GUARD_REFUSAL = /same tool call already tried \d+× \(hash budget\)/;

/** Whether a tool result is the loop guard turning away a call the agent already made too many times. */
export function isLoopGuardRefusal(output: string): boolean {
  return LOOP_GUARD_REFUSAL.test(output);
}
