// The flags of the review commands that read or write a file named by the caller, and the one rule for
// where they may point: inside the project root. The commands refuse by this rule and the trust table
// (trust-routine-command.ts) asks it too, so the two cannot drift apart.
//
// Every flag of a command is listed once, as a path flag or as a flag that names no path. The guard test in
// src/commands/review-slice-paths.test.ts ties both lists to the `*_FLAGS` arrays of review-slice.ts, so a
// new flag cannot join a command without being sorted into one of them.

import { optionValues } from "./args";
import { type PlacedPathResult, placePathWithinSync } from "./contained-path";

export const REVIEW_CONFINED_PATH_FLAGS: Readonly<Record<string, readonly string[]>> = {
  slice: ["--diff", "--out"],
  "retry-plan": ["--manifest", "--result", "--state"],
  "dispatch-check": ["--manifest", "--payload", "--package"],
  layers: ["--package"],
  chunks: ["--package", "--result"],
  coverage: ["--package"],
};

/** The flags of the same commands that name no path (ids, numbers, switches). Not confined by design. */
export const REVIEW_NON_PATH_FLAGS: Readonly<Record<string, readonly string[]>> = {
  slice: ["--ref", "--base", "--context", "--max-bytes", "--wave-bytes", "--json", "--help", "-h"],
  "retry-plan": ["--reviewer", "--slices", "--covered", "--next-wave", "--dry-run", "--json", "--help", "-h"],
  "dispatch-check": ["--max-bytes", "--pr-context", "--json", "--help", "-h"],
  layers: ["--head", "--base", "--write-wiki", "--files", "--max-bytes", "--json", "--help", "-h"],
  chunks: ["--chunk", "--status", "--mode", "--answer", "--quote", "--json", "--help", "-h"],
  coverage: ["--json", "--help", "-h"],
};

/** `-` means standard input for these flags and names no file. */
const STDIN_FLAGS: ReadonlySet<string> = new Set(["--diff", "--payload", "--result"]);

/** The confined path flags of a `keryx review` subcommand; empty for any other name, `constructor` and `__proto__` included. */
export function confinedPathFlags(command: string): readonly string[] {
  return Object.hasOwn(REVIEW_CONFINED_PATH_FLAGS, command) ? (REVIEW_CONFINED_PATH_FLAGS[command] as readonly string[]) : [];
}

/** Where the value of a confined flag really lands, or why it is refused. Standard input (`-`) is not a path. */
export function placeReviewPath(
  command: string,
  flag: string,
  value: string,
  where: { projectRoot: string; cwd: string },
): PlacedPathResult {
  if (value === "-" && STDIN_FLAGS.has(flag)) return { ok: true, path: "-" };
  const placed = placePathWithinSync(where.projectRoot, value, where.cwd);
  return placed.ok ? placed : { ok: false, message: `keryx review ${command} ${flag}: ${placed.message}` };
}

/** The first confined path flag of `command` (a `keryx review` subcommand) whose value lands outside the project root, as a refusal message. */
export function reviewPathFlagRefusal(
  command: string,
  args: readonly string[],
  where: { projectRoot: string; cwd: string },
): string | undefined {
  for (const flag of confinedPathFlags(command)) {
    for (const value of optionValues(args, flag)) {
      const placed = placeReviewPath(command, flag, value, where);
      if (!placed.ok) return placed.message;
    }
  }
  return undefined;
}
