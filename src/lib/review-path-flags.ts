// The path flags of the review commands that read or write files named by the caller, and the one rule for
// where they may point: inside the project root, or inside `.metaproject/`. The commands refuse by this
// rule and the trust table (trust-routine-command.ts) asks it too, so the two cannot drift apart.

import { optionValues } from "./args";
import { placePathWithinSync } from "./contained-path";

export const REVIEW_CONFINED_PATH_FLAGS: Readonly<Record<string, readonly string[]>> = {
  slice: ["--out"],
  "retry-plan": ["--manifest", "--state"],
  "dispatch-check": ["--manifest"],
};

/** The first confined path flag of `command` (a `keryx review` subcommand) whose value lands outside the allowed roots, as a refusal message. */
export function reviewPathFlagRefusal(
  command: string,
  args: readonly string[],
  where: { projectRoot: string; cwd: string },
): string | undefined {
  for (const flag of REVIEW_CONFINED_PATH_FLAGS[command] ?? []) {
    for (const value of optionValues(args, flag)) {
      const placed = placePathWithinSync(where.projectRoot, value, where.cwd, [".metaproject"]);
      if (!placed.ok) return `keryx review ${command} ${flag}: ${placed.message}`;
    }
  }
  return undefined;
}
