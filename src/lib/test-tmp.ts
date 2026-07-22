import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

// Test-only helper. Several agent sessions run `bun test` at the same time from
// different worktrees, so a fixture rooted at a FIXED path — `tmpdir()/keryx-foo`
// or `<repo>/.tmp-foo` — is not private to one run: every concurrent run on the
// machine resolves it to the same directory. One run's `rm -rf` then deletes
// another run's fixture mid-test, which surfaces as an unrelated ENOENT, a
// "immutable run already exists" error from a leftover artifact, or a vanished
// spawn cwd (`posix_spawn 'git'` ENOENT).
//
// Give every fixture a unique leaf under the SAME parent directory it already
// used, so nothing path-sensitive about the fixture changes — only its identity
// becomes private to the run that created it.
export function uniqueTestRoot(parent: string, prefix: string): string {
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(path.join(parent, `${prefix}-`));
}
