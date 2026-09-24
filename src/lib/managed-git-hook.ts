// Shared installManagedHook/removeManagedHook, deduplicated out of
// src/commands/init.ts and src/commands/update.ts (R1-F3): the two commands
// carried byte-for-byte identical copies of this pair, and the ratchet's
// ALLOWLIST worked at FILE granularity — exempting a whole file's raw
// mkdir/writeFile/chmod for the ".git/hooks by design" reason silently
// exempted every OTHER raw write either command might grow too, with the
// ratchet none the wiser (a mutation test confirmed this: 3 of 3 reintroduced
// raw writes in init.ts went uncaught). One shared module carries the one
// legitimate raw-write reason and the one allowlist entry; both commands now
// import this instead of keeping their own copy.
//
// R1-F6: the old per-command comment claimed "resolveGitHooksRoot's own
// symlink check" as the reason a symlinked hooks dir or hook file could not
// escape. That check does not exist — `resolveGitHooksRoot` only runs `git
// rev-parse --git-common-dir` (or, when git is unavailable, a plain `stat`
// of `.git`) to find the hooks ROOT; neither path rejects a `.git/hooks`
// that is itself a symlink, or a `.git/hooks/<hook-name>` that is. Before
// writing or removing a hook, `resolveContainedHookPath` below now
// lstat/realpath-checks both: the hooks directory must resolve inside the
// git common dir `resolveGitHooksRoot` derived it from, and the specific
// hook file must resolve inside the (already-verified) hooks directory.
// Either escape refuses with `ManagedGitHookEscapeError` rather than writing
// through the link.
//
// NOTE on `core.hooksPath`: it is not consulted here, and never was —
// `resolveGitHooksRoot` always derives the hooks root from
// `--git-common-dir` + `hooks`, never from a project's configured
// `core.hooksPath`. A project that sets `core.hooksPath` to somewhere else
// already gets its managed block written to a location git itself will not
// run hooks from — a pre-existing, separate behavior this fix does not
// change (fixing it would mean reading and trusting `core.hooksPath` itself,
// a repo-controlled setting, as a write destination — a different and larger
// change than this finding asks for). What THIS fix guarantees is narrower
// and is what the finding actually needs: whatever path this module resolves
// to write into, it does not escape the git common dir through a symlink
// planted on that path.
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs";
import { resolveGitHooksRoot } from "./git-hooks";

/** Thrown when the hooks directory or the target hook file resolves outside the git common dir through a symlink. */
export class ManagedGitHookEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedGitHookEscapeError";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Confirm `target` — already known to exist as a symlink — resolves, via its
 * full symlink chain, to somewhere inside `containerReal` (an already
 * `realpath`d directory). Mirrors the same escape check
 * `contained-write.ts`'s `assertContained` runs, applied to a fixed pair of
 * paths instead of an arbitrary `root`/`rel`.
 */
async function assertResolvesInside(target: string, containerReal: string, label: string): Promise<void> {
  const real = await realpath(target);
  const rel = path.relative(containerReal, real);
  const escapes = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (escapes) {
    throw new ManagedGitHookEscapeError(
      `${label} (${target}) resolves outside the git common dir (${containerReal}) — refusing to write through it`,
    );
  }
}

/**
 * Resolve the git hooks root and the path `hookName` would live at, and
 * confirm neither escapes the git common dir through a symlink (R1-F6).
 * Returns `null` when there is no git hooks root at all — mirrors
 * `resolveGitHooksRoot`'s own no-op contract, so a caller outside a git repo
 * (or one `git rev-parse`/`stat` genuinely cannot resolve) keeps behaving
 * exactly as before. Throws `ManagedGitHookEscapeError` on an escape.
 */
async function resolveContainedHookPath(
  projectRoot: string,
  hookName: string,
): Promise<{ hooksRoot: string; hookPath: string } | null> {
  const hooksRoot = await resolveGitHooksRoot(projectRoot);
  if (!hooksRoot) {
    return null;
  }

  // The git common dir resolveGitHooksRoot derived hooksRoot from — hooksRoot
  // is always literally `<commonDir>/hooks`, so its parent is that dir.
  const commonDirReal = await realpath(path.dirname(hooksRoot)).catch(() => path.dirname(hooksRoot));

  // `lstat` first, never `stat`: a symlinked hooks directory must be judged
  // (and, if it escapes, refused) WITHOUT ever being entered — `mkdir`'d,
  // `readdir`'d, or written into — below.
  const hooksRootStat = await lstat(hooksRoot).catch(() => null);
  let hooksRootReal = hooksRoot;
  if (hooksRootStat?.isSymbolicLink()) {
    await assertResolvesInside(hooksRoot, commonDirReal, "the git hooks directory");
    hooksRootReal = await realpath(hooksRoot);
  }

  const hookPath = path.join(hooksRoot, hookName);
  const hookStat = await lstat(hookPath).catch(() => null);
  if (hookStat?.isSymbolicLink()) {
    await assertResolvesInside(hookPath, hooksRootReal, "the git hook file");
  }

  return { hooksRoot, hookPath };
}

/**
 * Write (or replace) the managed block identified by `blockId` into
 * `hookName` under this project's git hooks directory, extending rather than
 * replacing whatever else is already in the file — other managed blocks
 * (this function's own, or another installer's under the same
 * `# keryx:<id>:begin/end` convention) and hand-authored content are left
 * untouched.
 */
export async function installManagedHook(
  projectRoot: string,
  hookName: "post-commit" | "pre-push",
  blockId: string,
  content: string,
): Promise<void> {
  const resolved = await resolveContainedHookPath(projectRoot, hookName);
  if (!resolved) {
    return;
  }
  const { hooksRoot, hookPath } = resolved;

  await mkdir(hooksRoot, { recursive: true });

  const blockStart = `# keryx:${blockId}:begin`;
  const blockEnd = `# keryx:${blockId}:end`;
  const managedBlock = `${blockStart}\n${content.trim()}\n${blockEnd}`;
  const existing = (await pathExists(hookPath)) ? await readFile(hookPath, "utf8") : "#!/usr/bin/env sh\n";
  const blockPattern = new RegExp(`${escapeRegExp(blockStart)}[\\s\\S]*?${escapeRegExp(blockEnd)}`);
  // `() => managedBlock`, not `managedBlock`: the STRING form of
  // String.replace reads `$'`, "$`", `$&` and `$$` in the replacement as
  // substitution patterns, and these blocks are shell scripts full of `$`.
  // `$'` means "everything after the match", so a hook containing it spliced
  // the rest of the file back in and silently duplicated every managed block
  // below it. The function form has no such reading.
  const next = blockPattern.test(existing)
    ? existing.replace(blockPattern, () => managedBlock)
    : `${existing.trimEnd()}\n\n${managedBlock}\n`;

  await writeFile(hookPath, next, "utf8");
  await chmod(hookPath, 0o755);
}

/**
 * Strip a single keryx managed block from a git hook, leaving all other
 * managed blocks and user-authored content intact. No-op when the hook or
 * block is absent.
 */
export async function removeManagedHook(
  projectRoot: string,
  hookName: "post-commit" | "pre-push",
  blockId: string,
): Promise<void> {
  const resolved = await resolveContainedHookPath(projectRoot, hookName);
  if (!resolved) {
    return;
  }
  const { hookPath } = resolved;
  if (!(await pathExists(hookPath))) {
    return;
  }
  const existing = await readFile(hookPath, "utf8");
  const blockStart = `# keryx:${blockId}:begin`;
  const blockEnd = `# keryx:${blockId}:end`;
  const blockPattern = new RegExp(`\\n*${escapeRegExp(blockStart)}[\\s\\S]*?${escapeRegExp(blockEnd)}\\n*`);
  if (!blockPattern.test(existing)) {
    return;
  }
  const next = `${existing.replace(blockPattern, "\n").trimEnd()}\n`;
  await writeFile(hookPath, next, "utf8");
  await chmod(hookPath, 0o755);
}
