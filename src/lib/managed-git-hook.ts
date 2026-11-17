// Shared installManagedHook/removeManagedHook, deduplicated out of
// src/commands/init.ts and src/commands/update.ts (R1-F3): the two commands
// carried byte-for-byte identical copies of this pair, and the ratchet's
// ALLOWLIST worked at FILE granularity — exempting a whole file's raw
// mkdir/writeFile/chmod for the ".git/hooks by design" reason silently
// exempted every OTHER raw write either command might grow too, with the
// ratchet none the wiser (a mutation test confirmed this: 3 of 3 reintroduced
// raw writes in init.ts went uncaught). This module carries the one
// legitimate raw-write reason and the one allowlist entry; both commands
// import this instead of keeping their own copy.
//
// R2-F5: this is NOT the one and only place that writes a managed git hook
// block — src/lib/managed-hook.ts (used by `keryx trigger install`, for
// hooks this module's narrower `ManagedGitHookName` type doesn't cover,
// e.g. post-merge/post-checkout) is a second writer with the same on-disk
// block convention. It used to have no containment check of its own; it now
// reuses `resolveContainedHookPath` below instead of re-deriving one, so the
// escape check itself has exactly one implementation even though there are
// two callers of it.
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

/** The git hooks this module installs and removes managed blocks in. */
export type ManagedGitHookName = "post-commit" | "pre-push" | "commit-msg";

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
 * full symlink chain, to somewhere inside AT LEAST ONE of `containersReal`
 * (already `realpath`d directories). Mirrors the same escape check
 * `contained-write.ts`'s `assertContained` runs, applied to a fixed set of
 * candidate roots instead of an arbitrary `root`/`rel`.
 *
 * R2-F2: a dangling symlink (its target does not exist) used to surface as a
 * raw ENOENT out of `realpath`, which propagated out of `initCommand`/
 * `refreshServiceFiles` as an unlabeled crash. It is mapped to the same named
 * `ManagedGitHookEscapeError` here instead, so every caller has exactly one
 * error type to catch for "this hook could not be safely reached."
 */
async function assertResolvesInside(target: string, containersReal: readonly string[], label: string): Promise<void> {
  let real: string;
  try {
    real = await realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new ManagedGitHookEscapeError(`${label} (${target}) is a dangling symlink — refusing to write through it`);
    }
    throw err;
  }
  const insideAny = containersReal.some((containerReal) => {
    const rel = path.relative(containerReal, real);
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
  if (!insideAny) {
    throw new ManagedGitHookEscapeError(
      `${label} (${target}) resolves outside the git common dir and the project root (${containersReal.join(", ")}) — refusing to write through it`,
    );
  }
}

/**
 * Resolve the git hooks root and the path `hookName` would live at, and
 * confirm neither escapes the git common dir OR the project root through a
 * symlink (R1-F6, widened by R2-F2). Returns `null` when there is no git
 * hooks root at all — mirrors `resolveGitHooksRoot`'s own no-op contract, so
 * a caller outside a git repo (or one `git rev-parse`/`stat` genuinely cannot
 * resolve) keeps behaving exactly as before. Throws `ManagedGitHookEscapeError`
 * on an escape or a dangling link — callers decide whether that means "abort"
 * or "skip this hook and warn" (see `installManagedHookOrWarn` below).
 *
 * R2-F2: `.git/hooks/<hook> -> ../../scripts/<hook>`, a tracked script inside
 * the project, is a common and legitimate setup. It is outside the git common
 * dir by construction (scripts live in the working tree, not `.git`), so
 * accepting only the common-dir container made init/update abort on it. A
 * target resolving inside the PROJECT root is accepted too; anything else
 * still refuses.
 */
export async function resolveContainedHookPath(
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
  const projectRootReal = await realpath(projectRoot).catch(() => projectRoot);
  const acceptedContainers = [commonDirReal, projectRootReal];

  // `lstat` first, never `stat`: a symlinked hooks directory must be judged
  // (and, if it escapes, refused) WITHOUT ever being entered — `mkdir`'d,
  // `readdir`'d, or written into — below.
  const hooksRootStat = await lstat(hooksRoot).catch(() => null);
  // R2-F6: always realpath hooksRoot, not only when it is itself a symlink —
  // an ancestor directory can be a symlink (e.g. `projectRoot` handed in
  // through a symlinked path such as /var vs /private/var) without hooksRoot
  // itself being one, which would otherwise leave `hooksRootReal` out of sync
  // with what `realpath` actually resolves for the hook-file check below.
  const hooksRootReal = await realpath(hooksRoot).catch(() => hooksRoot);
  if (hooksRootStat?.isSymbolicLink()) {
    await assertResolvesInside(hooksRoot, acceptedContainers, "the git hooks directory");
  }

  const hookPath = path.join(hooksRoot, hookName);
  const hookStat = await lstat(hookPath).catch(() => null);
  if (hookStat?.isSymbolicLink()) {
    await assertResolvesInside(hookPath, [hooksRootReal, projectRootReal], "the git hook file");
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
  hookName: ManagedGitHookName,
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
  hookName: ManagedGitHookName,
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

/**
 * R2-F2: `installManagedHook` throws `ManagedGitHookEscapeError` fail-closed —
 * exactly right for "never write through an escaping link", wrong for `keryx
 * init`/`keryx update` to let bubble out uncaught. A single unreachable hook
 * (a dangling link, or a genuine escape outside both the git common dir and
 * the project root) used to abort the WHOLE command. This wraps the call: on
 * that one named error it returns a human-readable warning string instead of
 * throwing, so the caller can skip just that hook and keep going — the same
 * "warn and skip" posture `checkInstallDestination` already uses elsewhere in
 * this codebase. Any OTHER error (a real I/O failure) still throws.
 */
export async function installManagedHookOrWarn(
  projectRoot: string,
  hookName: ManagedGitHookName,
  blockId: string,
  content: string,
): Promise<string | null> {
  try {
    await installManagedHook(projectRoot, hookName, blockId, content);
    return null;
  } catch (err) {
    if (err instanceof ManagedGitHookEscapeError) {
      return `Skipped the "${blockId}" ${hookName} hook: ${err.message}`;
    }
    throw err;
  }
}

/** `removeManagedHook`'s counterpart to {@link installManagedHookOrWarn} — same warn-and-skip posture on an escape/dangling link. */
export async function removeManagedHookOrWarn(
  projectRoot: string,
  hookName: ManagedGitHookName,
  blockId: string,
): Promise<string | null> {
  try {
    await removeManagedHook(projectRoot, hookName, blockId);
    return null;
  } catch (err) {
    if (err instanceof ManagedGitHookEscapeError) {
      return `Skipped removing the "${blockId}" ${hookName} hook: ${err.message}`;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// commit-msg hook (ADR-0001 D3): refuses an agent-attribution line in a commit
// message. The shell patterns in `renderCommitMsgHook` and the regexes in
// `findAttributionViolations` express the same two rules; the test file runs
// the real script against the same samples so the two cannot drift apart.
// ---------------------------------------------------------------------------

/** Block id of the managed `commit-msg` block inside `.git/hooks/commit-msg`. */
export const COMMIT_MSG_BLOCK_ID = "commit-msg-attribution";

export interface AttributionViolation {
  /** 1-based line number in the message file. */
  readonly line: number;
  readonly reason: "co-author-trailer" | "generated-by-line";
  readonly text: string;
}

const COAUTHOR_RE = /^Co-Authored-By:/i;
// Optional leading whitespace, emoji, symbols or markdown (`*`, `_`), then the phrase.
const GENERATED_RE = /^[^\p{L}\p{N}]*Generated\s+(?:by|with)(?![\p{L}\p{N}])/iu;
const SCISSORS = "# ------------------------ >8 ------------------------";

/** Lines of `message` that carry a co-author trailer or a "Generated by/with" line. Git comment lines are skipped; everything below the scissors line is ignored. */
export function findAttributionViolations(message: string): AttributionViolation[] {
  const violations: AttributionViolation[] = [];
  const lines = message.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").replace(/\r$/, "");
    if (line.startsWith(SCISSORS)) break;
    if (line.startsWith("#")) continue;
    if (COAUTHOR_RE.test(line)) {
      violations.push({ line: index + 1, reason: "co-author-trailer", text: line });
    } else if (GENERATED_RE.test(line)) {
      violations.push({ line: index + 1, reason: "generated-by-line", text: line });
    }
  }
  return violations;
}

/** Body of the managed `commit-msg` block (POSIX sh; `$1` is the message file). */
export function renderCommitMsgHook(): string {
  return `keryx_commit_msg_attribution() {
  # Refuse a commit message that carries an agent-attribution line: a
  # Co-Authored-By trailer, or a line starting "Generated by" / "Generated with"
  # (after optional whitespace, emoji or markdown). Product names alone
  # (Claude, Codex, CLAUDE.md) and "generated" elsewhere in a line are fine.
  msg_file="$1"
  [ -n "$msg_file" ] && [ -f "$msg_file" ] || return 0
  line_no=0
  while IFS= read -r msg_line || [ -n "$msg_line" ]; do
    line_no=$((line_no + 1))
    case "$msg_line" in
      "# ------------------------ >8 ------------------------"*) break ;;
      "#"*) continue ;;
    esac
    if printf '%s\\n' "$msg_line" | grep -qiE '^Co-Authored-By:'; then
      echo "keryx commit-msg: line $line_no is a Co-Authored-By trailer; remove it (no attribution in commit messages)" >&2
      return 1
    fi
    if printf '%s\\n' "$msg_line" | grep -qiE '^[^[:alnum:]]*Generated[[:space:]]+(by|with)([^[:alnum:]]|$)'; then
      echo "keryx commit-msg: line $line_no is a 'Generated by/with' attribution line; remove it" >&2
      return 1
    fi
  done < "$msg_file"
  return 0
}
keryx_commit_msg_attribution "$@" || exit $?`;
}

export async function installCommitMsgHookOrWarn(projectRoot: string): Promise<string | null> {
  return installManagedHookOrWarn(projectRoot, "commit-msg", COMMIT_MSG_BLOCK_ID, renderCommitMsgHook());
}

export async function removeCommitMsgHookOrWarn(projectRoot: string): Promise<string | null> {
  return removeManagedHookOrWarn(projectRoot, "commit-msg", COMMIT_MSG_BLOCK_ID);
}

/** True when `.git/hooks/commit-msg` still carries the managed block. */
export async function commitMsgHookInstalled(projectRoot: string): Promise<boolean> {
  const hooksRoot = await resolveGitHooksRoot(projectRoot);
  if (!hooksRoot) return false;
  const hookPath = path.join(hooksRoot, "commit-msg");
  if (!(await pathExists(hookPath))) return false;
  return (await readFile(hookPath, "utf8")).includes(`# keryx:${COMMIT_MSG_BLOCK_ID}:begin`);
}

export type CommitMsgHookState =
  | { readonly state: "no-git" }
  | { readonly state: "missing" }
  | { readonly state: "active" }
  | { readonly state: "inactive"; readonly effectiveHooksDir: string; readonly managedHooksDir: string };

/**
 * Whether git will actually run the managed `commit-msg` block: the block must
 * be present AND git's effective hooks directory (`git rev-parse --git-path
 * hooks`, which honours a configured `core.hooksPath`) must be the directory
 * the block was written to.
 */
export async function inspectCommitMsgHook(projectRoot: string): Promise<CommitMsgHookState> {
  const hooksRoot = await resolveGitHooksRoot(projectRoot);
  if (!hooksRoot) return { state: "no-git" };
  if (!(await commitMsgHookInstalled(projectRoot))) return { state: "missing" };
  let effective: string | undefined;
  if (Bun.which("git")) {
    const proc = Bun.spawn(["git", "rev-parse", "--git-path", "hooks"], { cwd: projectRoot, stdout: "pipe", stderr: "ignore" });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code === 0 && stdout.trim()) {
      effective = path.resolve(projectRoot, stdout.trim());
    }
  }
  if (effective === undefined) return { state: "active" };
  const effectiveReal = await realpath(effective).catch(() => effective as string);
  const managedReal = await realpath(hooksRoot).catch(() => hooksRoot);
  if (effectiveReal === managedReal) return { state: "active" };
  return { state: "inactive", effectiveHooksDir: effectiveReal, managedHooksDir: managedReal };
}
