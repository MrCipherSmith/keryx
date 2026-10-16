// The commit range a package's blast radius is measured over (flow 457, AC7).
//
// A package pins the commit it reviews (`layers.prHead`, from the manifest's
// `target.head`). Reading the changed files from the working tree instead
// measures whatever the checkout happens to hold — another branch, a later
// commit, an uncommitted edit — and the radius then answers for a change
// nobody is reviewing. So with a pinned head the changed files and the diff are
// `git diff base...head`, and the base is the caller's `--ref/--base`, else the
// PR base the layers resolved, with the `<head>~1` fallback stated aloud.

import { assertGitRevision, revisionOperand } from "../lib/git-revision";
import type { BaseSource, LayersFile } from "./layers";

export type RadiusRange = { base: string; head: string; baseSource: BaseSource | "flag"; warning?: string };

/** The pinned range, or `undefined` when the package pins no head (the working tree is then the only answer). */
export function radiusRange(input: {
  ref?: string | undefined;
  layers: Pick<LayersFile, "prHead" | "base" | "baseSource"> | null;
}): RadiusRange | undefined {
  const head = input.layers?.prHead ?? null;
  if (head === null) return undefined;
  if (input.ref !== undefined) return { base: input.ref, head, baseSource: "flag" };
  const base = input.layers?.base ?? null;
  if (base === null) {
    return {
      base: `${head}~1`,
      head,
      baseSource: "fallback",
      warning: `blast-radius: the package records no base; measuring ${head.slice(0, 12)}~1...${head.slice(0, 12)} (the head commit only). Pass --base <sha> for the whole change.`,
    };
  }
  const source = input.layers?.baseSource ?? (base === `${head}~1` ? "fallback" : "input");
  return {
    base,
    head,
    baseSource: source,
    ...(source === "fallback"
      ? {
          warning: `blast-radius: no pull request base is known for this package; measuring ${head.slice(0, 12)}~1...${head.slice(0, 12)} (the head commit only). Pass --base <sha> for the whole change.`,
        }
      : {}),
  };
}

/** The revision operand of a radius `git diff`: the pinned range, the typed ref, or nothing (the working tree). Validated: a dash-leading revision is refused. */
function revisionOperandOfRange(range: RadiusRange | undefined, ref: string | undefined): string[] {
  if (range !== undefined) return revisionOperand(`${assertGitRevision(range.base)}...${range.head}`);
  return ref === undefined ? [] : revisionOperand(ref);
}

/** `git diff` argv for the changed files of a range (deleted paths excluded), or of the working tree against `ref`. */
export function changedFilesArgv(range: RadiusRange | undefined, ref: string | undefined): string[] {
  return ["git", "diff", "--name-only", "--diff-filter=d", ...revisionOperandOfRange(range, ref)];
}

/** `git diff` argv for the zero-context patch the symbol reach and the text links read. */
export function radiusDiffArgv(range: RadiusRange | undefined, ref: string | undefined): string[] {
  return ["git", "diff", "--no-color", "--no-ext-diff", "--unified=0", ...revisionOperandOfRange(range, ref)];
}
