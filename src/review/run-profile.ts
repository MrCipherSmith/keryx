// What `keryx review start|attach` records about how a review runs (flow 457, T7): `<package>/run-profile.json`.
//
// - `operatorGate` stamps the package as created by a keryx that gates operator decisions (mutation waiver,
//   reviewer-set override) on a card or a terminal. A package without the stamp predates the gate and keeps the
//   old rules, so an old round still closes the way it was recorded.
// - `mode` is attended unless the start said `--unattended`; an unattended round records "Not run: mutation pass"
//   instead of being refused for it. The autonomous runner's environment is unattended whatever the file says.
// - `host` is the agent host the round runs on; item 10 of the readiness checklist reads it.
// - `callerToken` is the token `review start` also writes into the active-review pointer, so a CLI call that
//   carries it in `KERYX_REVIEW_CALLER_TOKEN` is attributed to the orchestrator on hosts that pass env.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { ENV_AUTONOMOUS_ANSWERS_FILE } from "./autonomous-answers";
import { detectReviewHost, parseReviewHost, type ReviewHost } from "./host-profile";

export const RUN_PROFILE_FILE = "run-profile.json";
/** The operator-gate version a new package is stamped with. */
export const OPERATOR_GATE_VERSION = 1;

export type RunMode = "attended" | "unattended";

export type RunProfile = {
  schemaVersion: 1;
  operatorGate: number;
  mode: RunMode;
  /** How the mode was decided: `--unattended`, the autonomous runner, or the default. */
  declaredVia: "--unattended" | "autonomous-runner" | "default";
  host: ReviewHost;
  callerToken: string;
  createdAt: string;
};

export function newCallerToken(): string {
  return randomBytes(12).toString("hex");
}

export function isAutonomousEnv(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[ENV_AUTONOMOUS_ANSWERS_FILE] !== undefined;
}

/**
 * Security review M1: `review start --unattended` turns the mutation gate off, so the agent cannot declare it on its
 * own say. It needs a person at a terminal, or the autonomous runner (whose child is unattended whatever the flag
 * says, as before flow 457). Returns the refusal, or undefined when the start may proceed.
 */
export function unattendedStartRefusal(input: {
  unattended: boolean;
  isTerminal: () => boolean;
  env?: Readonly<Record<string, string | undefined>> | undefined;
}): string | undefined {
  if (!input.unattended || input.isTerminal() || isAutonomousEnv(input.env ?? process.env)) return undefined;
  return (
    "--unattended needs a terminal: it records that nobody is at the keyboard, which lets the round close with the mutation pass Not run, " +
    "and an agent cannot declare that on its own say (stdin or stdout is not a TTY). Run `keryx review start ... --unattended` in a terminal, " +
    "or run the whole review unattended with `keryx review run --autonomous`. Inside keryx shell, start the round without --unattended: " +
    "a skipped mutation pass is then waived by the operator on the review_waive_mutation card."
  );
}

export function buildRunProfile(input: {
  unattended?: boolean | undefined;
  host?: string | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  now?: Date | undefined;
  callerToken?: string | undefined;
}): RunProfile {
  const env = input.env ?? process.env;
  const autonomous = isAutonomousEnv(env);
  const host = parseReviewHost(input.host) ?? detectReviewHost(env);
  return {
    schemaVersion: 1,
    operatorGate: OPERATOR_GATE_VERSION,
    mode: input.unattended === true || autonomous ? "unattended" : "attended",
    declaredVia: input.unattended === true ? "--unattended" : autonomous ? "autonomous-runner" : "default",
    host,
    callerToken: input.callerToken ?? newCallerToken(),
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export async function writeRunProfile(packageDir: string, profile: RunProfile): Promise<void> {
  await writeFileAtomic(path.join(packageDir, RUN_PROFILE_FILE), `${JSON.stringify(profile, null, 2)}\n`);
}

/** The package's run profile, or undefined for a package created before it existed (or an unreadable one). */
export function readRunProfile(packageDir: string): RunProfile | undefined {
  const file = path.join(packageDir, RUN_PROFILE_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RunProfile>;
    if (parsed === null || typeof parsed !== "object" || typeof parsed.operatorGate !== "number") return undefined;
    const host = parseReviewHost(typeof parsed.host === "string" ? parsed.host : undefined) ?? "other";
    return {
      schemaVersion: 1,
      operatorGate: parsed.operatorGate,
      mode: parsed.mode === "unattended" ? "unattended" : "attended",
      declaredVia: parsed.declaredVia === "--unattended" || parsed.declaredVia === "autonomous-runner" ? parsed.declaredVia : "default",
      host,
      callerToken: typeof parsed.callerToken === "string" ? parsed.callerToken : "",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return undefined;
  }
}

/** Whether the package is held to the operator gate: created by a keryx that stamps it. */
export function operatorGateApplies(packageDir: string | undefined): boolean {
  if (packageDir === undefined) return false;
  return (readRunProfile(packageDir)?.operatorGate ?? 0) >= OPERATOR_GATE_VERSION;
}

/**
 * Whether a round is attended. Unattended when the autonomous runner's env is set, or when the package's run
 * profile records an unattended start (`review start --unattended`). Attended otherwise, which is the default.
 */
export function isAttendedRun(env: Readonly<Record<string, string | undefined>> = process.env, packageDir?: string): boolean {
  if (isAutonomousEnv(env)) return false;
  if (packageDir !== undefined && readRunProfile(packageDir)?.mode === "unattended") return false;
  return true;
}
