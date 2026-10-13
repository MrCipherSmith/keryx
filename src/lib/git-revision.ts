/**
 * A revision the operator or a model typed (`--ref`, `--base`, `--since`, a manifest ref, a flow's `baseBranch`), checked
 * before it reaches git: none starts with `-`, and one that does would be read by git as an option (`--output=<file>`
 * makes `git diff` write a file). Needs git >= 2.24 for `--end-of-options`.
 */
export function assertGitRevision(ref: string): string {
  if (ref.startsWith("-")) throw new Error(`Refusing the revision "${ref}": a revision never starts with "-".`);
  return ref;
}

/** Options of `git diff` that write a file or run a program; a pass-through caller refuses them whatever the shell spelled. */
export function assertNoWritingDiffOption(args: readonly string[]): void {
  const bad = args.find((a) => a === "--output" || a.startsWith("--output=") || a === "--ext-diff");
  if (bad !== undefined) throw new Error(`Refusing the git diff option "${bad}": it writes a file or runs a program.`);
}

/**
 * The argv tail for a typed revision: `--end-of-options` and then the revision, so git reads it as a revision whatever its
 * spelling. The git calls that take a ref a person, a model or a repository file supplied (review, sync, wiki, gdgraph
 * staleness, the worktree ahead-count) put this where the revision goes, never the bare ref; a new such call must too.
 */
export function revisionOperand(ref: string): string[] {
  return ["--end-of-options", assertGitRevision(ref)];
}
