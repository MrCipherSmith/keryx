/**
 * A revision the operator or a model typed (`--ref`, `--base`), checked before it reaches git: none starts with `-`, and one
 * that does would be read by git as an option (`--output=<file>` makes `git diff` write a file). Callers also put
 * `--end-of-options` before it, so git reads it as a revision whatever its spelling.
 */
export function assertGitRevision(ref: string): string {
  if (ref.startsWith("-")) throw new Error(`Refusing the revision "${ref}": a revision never starts with "-".`);
  return ref;
}
