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
import { chmod, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs";
import { resolveProjectRoot } from "./contained-path";
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
// commit-msg hook (ADR-0001 D3): refuses AI attribution in a commit message.
//
// Layout in the git hooks directory:
//   keryx-commit-msg  — the check itself: a standalone POSIX sh script, always
//                       (re)written by keryx, marked with CHECK_SCRIPT_MARKER.
//   commit-msg        — when absent, keryx creates it as `#!/bin/sh` plus a
//                       managed block that calls keryx-commit-msg; when it
//                       already carries that block, the block is refreshed.
//                       Any OTHER commit-msg (a user's hook, the pre-commit
//                       framework's, a symlink) is never edited: keryx cannot
//                       know where control flows in someone else's script, so
//                       it says which line to add instead (COMMIT_MSG_FIX_LINE).
//
// The matching lives in ONE place: the three regular expressions in
// ATTRIBUTION_PATTERNS, built from the tables below in a dialect JavaScript
// and POSIX awk read identically (bracket expressions and explicit [ \t] only:
// no [[:class:]], no backslash-escaped metacharacters). The shell check embeds
// them in an awk program; `findAttributionViolations` is its TypeScript twin,
// running the same patterns through the same line walk, and the tests run
// every sample through both.
// ---------------------------------------------------------------------------

/** Block id of the managed block inside `<hooks>/commit-msg`. */
export const COMMIT_MSG_BLOCK_ID = "commit-msg-attribution";
/** File name of the standalone check script next to `commit-msg`. */
export const COMMIT_MSG_CHECK_SCRIPT = "keryx-commit-msg";
const CHECK_SCRIPT_MARKER = "# keryx:managed commit-msg-attribution-check";
/** The line a user adds to their own commit-msg hook to run the keryx check. */
export const COMMIT_MSG_FIX_LINE = `"$(git rev-parse --git-path hooks)/${COMMIT_MSG_CHECK_SCRIPT}" "$1" || exit 1`;
/** git's scissors line, without the leading comment character. */
const SCISSORS = " ------------------------ >8 ------------------------";
/** Characters `core.commentChar=auto` may pick (git's own candidate list). */
const AUTO_COMMENT_CHARS = "#;@!$%^&|:";

/**
 * Known AI products, models and agents, lowercase. Each entry is a regular
 * expression fragment in the shared dialect; a space means "one or more spaces
 * or tabs". A Co-Authored-By display name is AI attribution when it EXACTLY
 * equals one of these (case-insensitive), optionally followed by a version
 * (` 4.5`, ` v2`) and a parenthesised note. "Claude" is AI; "Claude Monet" is
 * a person.
 */
export const AI_PRODUCT_NAMES: readonly string[] = [
  "claude",
  "claude code",
  "claude( [0-9][0-9.]*)? (opus|sonnet|haiku)",
  "anthropic",
  "chatgpt",
  "gpt-[0-9][0-9a-z.]*",
  "openai",
  "openai codex",
  "codex",
  "github copilot",
  "copilot",
  "gemini",
  "gemini( [0-9][0-9.]*)? (pro|flash|ultra)",
  "gemini code assist",
  "google gemini",
  "google jules",
  "jules",
  "bard",
  "google bard",
  "cursor",
  "cursor agent",
  "devin",
  "devin ai",
  "aider",
  "windsurf",
  "codeium",
  "amazon q",
  "amazon q developer",
  "codewhisperer",
  "amazon codewhisperer",
  "tabnine",
  "qwen",
  "qwen code",
  "keryx",
  "keryx agent",
];

/**
 * Email domains of AI vendors and agents. A Co-Authored-By address on one of
 * these (or on a subdomain) is AI attribution whatever the display name says.
 */
export const AI_EMAIL_DOMAINS: readonly string[] = [
  "anthropic.com",
  "openai.com",
  "cursor.com",
  "cursor.sh",
  "anysphere.co",
  "cognition.ai",
  "codeium.com",
  "windsurf.com",
  "tabnine.com",
  "aider.chat",
];

/** Local parts that make a `@google.com` address an agent (an optional `+tag` is allowed); every other google.com address is a person. */
export const AI_GOOGLE_AGENT_LOCAL_PARTS: readonly string[] = ["gemini", "jules", "bard"];

/**
 * GitHub App logins of AI coding agents. Their commit address is
 * `[<id>+]<login>[bot]@users.noreply.github.com`. Only these count: every
 * other `[bot]` (dependabot, renovate, github-actions, …) is not AI and passes.
 */
export const AI_GITHUB_BOT_LOGINS: readonly string[] = [
  "copilot-swe-agent",
  "copilot-pull-request-reviewer",
  "claude",
  "cursor",
  "devin-ai-integration",
  "chatgpt-codex-connector",
  "google-labs-jules",
  "gemini-code-assist",
];

/** GitHub user (non-App) logins of AI agents: `[<id>+]<login>@users.noreply.github.com`. */
export const AI_GITHUB_USER_LOGINS: readonly string[] = ["copilot", "cursoragent"];

const SP = "[ \\t]";
const EMAIL_CHAR = "[^@<> \\t]";
const VERSION = `(${SP}+v?[0-9][0-9a-z.-]*)?`;
const NAME = `(${AI_PRODUCT_NAMES.map((name) => name.split(" ").join(`${SP}+`)).join("|")})${VERSION}`;
const AI_EMAIL = [
  `${EMAIL_CHAR}+@([a-z0-9-]+[.])*(${AI_EMAIL_DOMAINS.map((domain) => domain.split(".").join("[.]")).join("|")})`,
  `(${AI_GOOGLE_AGENT_LOCAL_PARTS.join("|")})([+]${EMAIL_CHAR}*)?@google[.]com`,
  `([0-9]+[+])?(${AI_GITHUB_BOT_LOGINS.join("|")})[[]bot${EMAIL_CHAR}@users[.]noreply[.]github[.]com`,
  `([0-9]+[+])?(${AI_GITHUB_USER_LOGINS.join("|")})@users[.]noreply[.]github[.]com`,
  "copilot@github[.]com",
].join("|");
/** `Co-Authored-By:` key — case-insensitive (the line is lowercased first), optional spaces before the colon, optional leading whitespace or `#`. */
const TRAILER = `^(${SP}|#)*co-authored-by${SP}*:${SP}*`;

/**
 * The three attribution patterns, applied to an ASCII-lowercased line:
 *
 * - `coAuthorName`: the trailer's display name (the text before `<`) is
 *   exactly a product name from AI_PRODUCT_NAMES (optional quotes, version,
 *   `(note)`).
 * - `coAuthorEmail`: the trailer's address (inside `<>`, or the bare value) is
 *   on an AI_EMAIL_DOMAINS domain, is a google.com agent address, is the
 *   noreply address of an AI agent's GitHub App (AI_GITHUB_BOT_LOGINS, e.g.
 *   `…+copilot-swe-agent[bot]@users.noreply.github.com`) or GitHub user
 *   (AI_GITHUB_USER_LOGINS), or is `copilot@github.com`. Other bots pass.
 * - `generated`: the line starts (after any non-alphanumerics such as an emoji
 *   or `*`) with "Generated by", "Generated with" or "Generated-by", and the
 *   object after it (past punctuation such as `[` or `:`, and an optional
 *   "the ") IS a product name as a whole: after an optional version it must be
 *   followed by the end of the line or by a character that is not a letter,
 *   digit, space or hyphen (`.`, `,`, `]` as in `[Claude Code](…)`, ` (`,
 *   `<`, `*`, `'`). So "Generated by Codex" and "Generated with [Claude
 *   Code](…)" are attribution; "Generated with a cursor-based script",
 *   "Generated by protoc", "Generated by the OpenAPI generator" and "Generated
 *   by Gemini Ruiz's script" are not.
 */
export const ATTRIBUTION_PATTERNS = {
  coAuthorName: `${TRAILER}"?${NAME}(${SP}+[(][^)]*[)])?"?${SP}*(<|$)`,
  coAuthorEmail: `${TRAILER}(.*<${SP}*)?(${AI_EMAIL})${SP}*(>|$)`,
  generated: `^[^a-z0-9]*generated(${SP}+|-)(by|with)[^a-z0-9]+(the${SP}+)?${NAME}${SP}*($|[^ \\t0-9a-z-])`,
} as const;

const CO_AUTHOR_NAME_RE = new RegExp(ATTRIBUTION_PATTERNS.coAuthorName);
const CO_AUTHOR_EMAIL_RE = new RegExp(ATTRIBUTION_PATTERNS.coAuthorEmail);
const GENERATED_RE = new RegExp(ATTRIBUTION_PATTERNS.generated);

export interface AttributionViolation {
  /** 1-based line number in the message file. */
  readonly line: number;
  readonly reason: "co-author-trailer" | "generated-by-line";
  readonly text: string;
}

/** How git will clean the message up, as far as a commit-msg hook can know it. */
export interface CommitMessageContext {
  /** `git config commit.cleanup` (unset: `null`/omitted). A `--cleanup=` flag on the command line is invisible to a hook. */
  readonly cleanup?: string | null;
  /** `core.commentString` / `core.commentChar` (unset: `#`; `auto`: no line is treated as a comment). */
  readonly commentChar?: string | null;
  /** Whether git opened an editor for the message; git sets `GIT_EDITOR=:` for the hook when it did not (`-m`, `-F`, `--no-edit`). Default true. */
  readonly edited?: boolean;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/**
 * Which lines git will keep, decided exactly as the awk program's BEGIN block
 * decides it:
 * - comment lines are dropped only by `strip`, and by `default` when the
 *   message was edited (`default` without an editor behaves as `whitespace`).
 *   `whitespace`, `verbatim` and `scissors` keep them, so they are checked.
 * - the scissors line ends the message when an editor was used (`git commit
 *   -v` truncates there in every mode) or the mode is `scissors`.
 */
function messageRules(context: CommitMessageContext): {
  keepComments: boolean;
  stopAtScissors: boolean;
  commentChar: string;
  autoComment: boolean;
} {
  const mode = asciiLower(context.cleanup ?? "");
  const edited = context.edited ?? true;
  const commentChar = context.commentChar ? context.commentChar : "#";
  return {
    keepComments:
      mode === "verbatim" || mode === "whitespace" || mode === "scissors" || ((mode === "" || mode === "default") && !edited),
    stopAtScissors: edited || mode === "scissors",
    commentChar,
    autoComment: asciiLower(commentChar) === "auto",
  };
}

function isScissorsLine(line: string, commentChar: string, autoComment: boolean): boolean {
  if (autoComment) {
    return line.length === SCISSORS.length + 1 && AUTO_COMMENT_CHARS.includes(line.charAt(0)) && line.slice(1) === SCISSORS;
  }
  return line === `${commentChar}${SCISSORS}`;
}

/** Lines of `message` that carry AI attribution: the TypeScript twin of the awk program in `keryx-commit-msg`. */
export function findAttributionViolations(message: string, context: CommitMessageContext = {}): AttributionViolation[] {
  const rules = messageRules(context);
  const violations: AttributionViolation[] = [];
  const lines = message.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").replace(/\r$/, "");
    if (rules.stopAtScissors && isScissorsLine(line, rules.commentChar, rules.autoComment)) break;
    if (!rules.keepComments && !rules.autoComment && line.startsWith(rules.commentChar)) continue;
    const lower = asciiLower(line);
    if (CO_AUTHOR_NAME_RE.test(lower) || CO_AUTHOR_EMAIL_RE.test(lower)) {
      violations.push({ line: index + 1, reason: "co-author-trailer", text: line });
    } else if (GENERATED_RE.test(lower)) {
      violations.push({ line: index + 1, reason: "generated-by-line", text: line });
    }
  }
  return violations;
}

function renderAwkProgram(): string {
  const program = `BEGIN {
  mode = tolower(cleanup)
  if (cc == "") cc = "#"
  autocc = (tolower(cc) == "auto")
  keep_comments = (mode == "verbatim" || mode == "whitespace" || mode == "scissors" || ((mode == "" || mode == "default") && edited == "0"))
  stop_at_cut = (edited == "1" || mode == "scissors")
  cut = "${SCISSORS}"
  autochars = "${AUTO_COMMENT_CHARS}"
}
function is_cut(s) {
  if (autocc) return length(s) == length(cut) + 1 && index(autochars, substr(s, 1, 1)) > 0 && substr(s, 2) == cut
  return s == cc cut
}
{
  line = $0
  sub(/\\r$/, "", line)
  if (stop_at_cut && is_cut(line)) exit 0
  if (!keep_comments && !autocc && index(line, cc) == 1) next
  l = tolower(line)
  if (l ~ /${ATTRIBUTION_PATTERNS.coAuthorName}/ || l ~ /${ATTRIBUTION_PATTERNS.coAuthorEmail}/) {
    print "keryx commit-msg: line " NR " is AI attribution (a Co-Authored-By trailer naming an AI tool or agent); remove it"
    exit 1
  }
  if (l ~ /${ATTRIBUTION_PATTERNS.generated}/) {
    print "keryx commit-msg: line " NR " is AI attribution (a Generated by/with line naming an AI tool); remove it"
    exit 1
  }
}`;
  if (program.includes("'")) throw new Error("the commit-msg awk program must not contain a single quote");
  return program;
}

/** The standalone `keryx-commit-msg` check (POSIX sh + awk): `$1` is the message file; exit 1 on attribution, 2 or more when the check itself cannot run. */
export function renderCommitMsgCheckScript(): string {
  return `#!/bin/sh
${CHECK_SCRIPT_MARKER}
# Written by keryx (keryx init / keryx update); edits are overwritten.
# Refuses a commit message that carries AI attribution: a Co-Authored-By
# trailer identifying an AI tool or agent (by vendor/bot address or exact
# product name), or a "Generated by/with <AI product>" line.
# Usage: ${COMMIT_MSG_CHECK_SCRIPT} <commit-message-file>
msg_file=$1
if [ -z "$msg_file" ] || [ ! -r "$msg_file" ]; then
  echo "keryx commit-msg: no readable commit message file was given (got '$msg_file'); refusing the commit" >&2
  exit 2
fi
keryx_config_failed() {
  echo "keryx commit-msg: 'git config --get $1' failed (exit $2); refusing the commit" >&2
  exit 2
}
cleanup=$(git config --get commit.cleanup 2>/dev/null)
rc=$?
[ "$rc" -le 1 ] || keryx_config_failed commit.cleanup "$rc"
comment=$(git config --get core.commentString 2>/dev/null)
rc=$?
[ "$rc" -le 1 ] || keryx_config_failed core.commentString "$rc"
if [ "$rc" -eq 1 ]; then
  comment=$(git config --get core.commentChar 2>/dev/null)
  rc=$?
  [ "$rc" -le 1 ] || keryx_config_failed core.commentChar "$rc"
fi
# git sets GIT_EDITOR=: for the hook when it opened no editor (-m, -F, --no-edit).
edited=1
[ "\${GIT_EDITOR-}" = ":" ] && edited=0
LC_ALL=C awk -v cleanup="$cleanup" -v cc="$comment" -v edited="$edited" '${renderAwkProgram()}' "$msg_file" >&2
rc=$?
case $rc in
  0) exit 0 ;;
  1) exit 1 ;;
  *)
    echo "keryx commit-msg: the attribution check could not run (exit $rc); refusing the commit" >&2
    exit "$rc"
    ;;
esac
`;
}

/** Body of the managed block in `<hooks>/commit-msg`: it only calls the check script next to it. */
export function renderCommitMsgHook(): string {
  return `# Managed by keryx: refuses AI attribution; the check is ${COMMIT_MSG_CHECK_SCRIPT} next to this hook.
"$(dirname "$0")/${COMMIT_MSG_CHECK_SCRIPT}" "$1" || exit $?`;
}

const COMMIT_MSG_BLOCK_START = `# keryx:${COMMIT_MSG_BLOCK_ID}:begin`;
const COMMIT_MSG_BLOCK_END = `# keryx:${COMMIT_MSG_BLOCK_ID}:end`;

/** True when a non-comment line of `text` refers to the check script: the managed block's call, or a line the user added. */
function callsCheckScript(text: string): boolean {
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("#") && trimmed.includes(COMMIT_MSG_CHECK_SCRIPT);
  });
}

const POSIX_SHELL_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?(?:\S*\/)?(?:sh|bash|dash|zsh|ksh)(?:\s|$)/;
const BLOCKING_WORDS = new Set(["exec", "exit", "return", ".", "source", "eval"]);
const OPENING_WORDS = new Set(["if", "case", "for", "while", "until", "select", "{"]);
const CLOSING_WORDS = new Set(["fi", "esac", "done", "}"]);
/** What may follow the call's command word: the message file, then `|| exit …`. */
const CALL_REST = /^\s+("\$1"|\$1|"\$@"|\$@)\s*\|\|\s*exit(\s|;|$)/;
const CALL_REST_LAST_LINE = /^\s+("\$1"|\$1|"\$@"|\$@)\s*$/;

/**
 * The first shell word of `line` (quotes and `$(…)` honoured), or null when it
 * cannot be read simply (a backtick, a bare subshell, an unbalanced quote).
 */
function firstShellWord(line: string): string | null {
  const stack: string[] = [];
  let index = 0;
  for (; index < line.length; index += 1) {
    const char = line.charAt(index);
    const top = stack[stack.length - 1];
    if (top === "'") {
      if (char === "'") stack.pop();
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") return null;
    if (top === '"') {
      if (char === '"') stack.pop();
      else if (char === "$" && line.charAt(index + 1) === "(") {
        stack.push("(");
        index += 1;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      stack.push(char);
      continue;
    }
    if (char === "$" && line.charAt(index + 1) === "(") {
      stack.push("(");
      index += 1;
      continue;
    }
    if (char === "(") {
      if (top !== "(") return null;
      stack.push("(");
      continue;
    }
    if (char === ")") {
      if (top !== "(") return null;
      stack.pop();
      continue;
    }
    if (stack.length === 0 && /[\s;&|<>]/.test(char)) break;
  }
  if (stack.length > 0) return null;
  return line.slice(0, index);
}

/** The words of a code line with quoted text removed, for counting compound commands and spotting exec/exit. */
function lineWords(line: string): string[] {
  const unquoted = line.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " q ");
  return unquoted.split(/[\s;&|]+/).filter((word) => word !== "");
}

/** The physical lines joined across trailing-backslash continuations. */
function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let pending = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/\\$/.test(line)) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    lines.push(pending + line);
    pending = "";
  }
  if (pending) lines.push(pending);
  return lines;
}

/**
 * Whether a line calling keryx-commit-msg provably runs and fails the hook.
 * Conservative static reading of a POSIX-shell hook (anything else is
 * "cannot show"): the call must be a top-level simple command whose command
 * word is the script path, given `"$1"`/`$1`/`"$@"`, followed by `|| exit …`
 * (or be the hook's last line); and every line before it must be outside any
 * compound command (if/case/loop/function/`{`/subshell all closed) and contain
 * no `exec`, `exit`, `return`, `.`/`source`, `eval` word and no here-document.
 * Returns the first call line found and whether it runs; `line` is null when
 * no line calls the script.
 */
export function analyzeCommitMsgCall(text: string): { readonly line: string | null; readonly runs: boolean } {
  const lines = logicalLines(text);
  const first = lines[0] ?? "";
  const shellOk = !first.startsWith("#!") || POSIX_SHELL_SHEBANG.test(first);
  const codeLines = lines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  let depth = 0;
  let blocked = false;
  for (let index = 0; index < codeLines.length; index += 1) {
    const line = codeLines[index] ?? "";
    const word = firstShellWord(line);
    if (word !== null && /keryx-commit-msg["']?$/.test(word)) {
      const rest = line.slice(word.length);
      const isLast = index === codeLines.length - 1;
      const restOk = CALL_REST.test(rest) || (isLast && CALL_REST_LAST_LINE.test(rest));
      return { line, runs: shellOk && !blocked && depth === 0 && restOk };
    }
    if (line.includes("<<")) blocked = true;
    for (const token of lineWords(line)) {
      if (BLOCKING_WORDS.has(token)) blocked = true;
      if (OPENING_WORDS.has(token) || token.startsWith("(")) depth += 1;
      if (CLOSING_WORDS.has(token) || token === ")") depth -= 1;
    }
    if (depth < 0) blocked = true;
  }
  return { line: null, runs: false };
}

/** Single-quote `value` for a POSIX shell command line. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

interface CommitMsgHookFile {
  readonly exists: boolean;
  readonly symlink: boolean;
  readonly hasBlock: boolean;
  /** A non-comment line mentions keryx-commit-msg (decides what removal may delete). */
  readonly wired: boolean;
  /** A line calling keryx-commit-msg provably runs (see analyzeCommitMsgCall). */
  readonly runs: boolean;
  /** The first line calling keryx-commit-msg, when there is one. */
  readonly callLine: string | null;
  readonly text: string;
}

async function readCommitMsgHook(hookPath: string): Promise<CommitMsgHookFile> {
  const hookStat = await lstat(hookPath).catch(() => null);
  if (!hookStat) return { exists: false, symlink: false, hasBlock: false, wired: false, runs: false, callLine: null, text: "" };
  // Reading through a symlink is safe; only writing through one is refused.
  const text = await readFile(hookPath, "utf8").catch(() => "");
  return {
    exists: true,
    symlink: hookStat.isSymbolicLink(),
    hasBlock: text.includes(COMMIT_MSG_BLOCK_START),
    wired: callsCheckScript(text),
    ...(({ line, runs }) => ({ callLine: line, runs }))(analyzeCommitMsgCall(text)),
    text,
  };
}

function commitMsgBlockPattern(withSurroundingNewlines: boolean): RegExp {
  const edge = withSurroundingNewlines ? "\\n*" : "";
  return new RegExp(`${edge}${escapeRegExp(COMMIT_MSG_BLOCK_START)}[\\s\\S]*?${escapeRegExp(COMMIT_MSG_BLOCK_END)}${edge}`);
}

/** A hook whose only non-blank line is its shebang does nothing; keryx may replace it (and leaves none behind on removal). */
function isEmptyHook(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.length === 0 || (lines.length === 1 && (lines[0] ?? "").startsWith("#!"));
}

async function isManagedCheckScript(scriptPath: string): Promise<boolean> {
  return (await readFile(scriptPath, "utf8").catch(() => "")).includes(CHECK_SCRIPT_MARKER);
}

/**
 * Write `keryx-commit-msg`, and wire it into `commit-msg` when keryx owns that
 * file (absent, or already carrying the keryx block). Returns a warning rather
 * than throwing when it cannot: an escaping or dangling link, a symlinked or
 * foreign `keryx-commit-msg`, or a foreign `commit-msg` (left untouched; the
 * warning names the line to add to it). `null` means the check is wired in.
 */
export async function installCommitMsgHookOrWarn(projectRoot: string): Promise<string | null> {
  const skipped = (reason: string): string => `Skipped the "${COMMIT_MSG_BLOCK_ID}" commit-msg hook: ${reason}`;
  let resolved: Awaited<ReturnType<typeof resolveContainedHookPath>>;
  try {
    resolved = await resolveContainedHookPath(projectRoot, "commit-msg");
    if (resolved) await resolveContainedHookPath(projectRoot, COMMIT_MSG_CHECK_SCRIPT);
  } catch (err) {
    if (err instanceof ManagedGitHookEscapeError) return skipped(err.message);
    throw err;
  }
  if (!resolved) return null;
  const { hooksRoot, hookPath } = resolved;
  const scriptPath = path.join(hooksRoot, COMMIT_MSG_CHECK_SCRIPT);

  await mkdir(hooksRoot, { recursive: true });
  const scriptStat = await lstat(scriptPath).catch(() => null);
  if (scriptStat?.isSymbolicLink()) return skipped(`${scriptPath} is a symlink; refusing to write through it`);
  if (scriptStat && !(await isManagedCheckScript(scriptPath))) return skipped(`${scriptPath} exists and was not written by keryx`);
  await writeFile(scriptPath, renderCommitMsgCheckScript(), "utf8");
  await chmod(scriptPath, 0o755);

  const hook = await readCommitMsgHook(hookPath);
  const block = `${COMMIT_MSG_BLOCK_START}\n${renderCommitMsgHook()}\n${COMMIT_MSG_BLOCK_END}`;
  if (!hook.exists || (!hook.symlink && isEmptyHook(hook.text))) {
    await writeFile(hookPath, `#!/bin/sh\n\n${block}\n`, "utf8");
    await chmod(hookPath, 0o755);
    return null;
  }
  if (!hook.symlink && hook.hasBlock) {
    // Function replacement: the block is shell full of `$`, which the string form would expand.
    await writeFile(hookPath, hook.text.replace(commitMsgBlockPattern(false), () => block), "utf8");
    await chmod(hookPath, 0o755);
    return null;
  }
  if (hook.wired && hook.runs) return null;
  if (hook.wired) {
    return (
      `Wrote ${scriptPath}; ${hookPath} mentions ${COMMIT_MSG_CHECK_SCRIPT} but keryx cannot show that the call runs. ` +
      `Put this line right after the shebang, before any exec or exit: ${COMMIT_MSG_FIX_LINE}`
    );
  }
  const kind = hook.symlink ? "a symlink" : "not managed by keryx";
  return (
    `Wrote ${scriptPath} but left the existing commit-msg hook ${hookPath} untouched (${kind}). ` +
    `To enable the AI-attribution check, add this line to that hook, before any exec or exit: ${COMMIT_MSG_FIX_LINE}`
  );
}

/** Doctor detail (and log wording) when the project opted out of the commit-msg check. */
export const COMMIT_MSG_HOOK_DISABLED_DETAIL = "disabled by config (hooks.commitMsg: false in .metaproject/metaproject.json)";

/** What `.metaproject/metaproject.json` says about the commit-msg check. */
export type CommitMsgHookSetting =
  | { readonly state: "on" | "off"; readonly manifestPath: string }
  | { readonly state: "invalid"; readonly manifestPath: string; readonly reason: string };

/**
 * Read `"hooks": { "commitMsg": … }` from the project's
 * `.metaproject/metaproject.json`. The project root is found by walking up from
 * `start` (a subdirectory works) to the nearest `.metaproject/` or `.git/`.
 * - `on`: no manifest, no `hooks`, or `commitMsg` absent or `true` (the default).
 * - `off`: `commitMsg` is the boolean `false`.
 * - `invalid`: the manifest cannot be read or is not a JSON object, `hooks` is
 *   not an object, or `commitMsg` is anything but a boolean. Callers then warn
 *   and leave the hook as it is: neither install nor remove.
 */
export async function readCommitMsgHookSetting(start: string): Promise<CommitMsgHookSetting> {
  const manifestPath = path.join(resolveProjectRoot(start), ".metaproject", "metaproject.json");
  const invalid = (reason: string): CommitMsgHookSetting => ({ state: "invalid", manifestPath, reason });
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "on", manifestPath };
    return invalid(`could not be read (${err instanceof Error ? err.message : String(err)})`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return invalid("is not valid JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return invalid("is not a JSON object");
  const hooks = (manifest as { hooks?: unknown }).hooks;
  if (hooks === undefined) return { state: "on", manifestPath };
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return invalid('has a "hooks" value that is not an object');
  const commitMsg = (hooks as { commitMsg?: unknown }).commitMsg;
  if (commitMsg === undefined || commitMsg === true) return { state: "on", manifestPath };
  if (commitMsg === false) return { state: "off", manifestPath };
  return invalid('has a "hooks.commitMsg" value that is not true or false');
}

function invalidSettingWarning(setting: { manifestPath: string; reason: string }): string {
  return (
    `Left the "${COMMIT_MSG_BLOCK_ID}" commit-msg hook as it is: ${setting.manifestPath} ${setting.reason}, ` +
    "so hooks.commitMsg cannot be read. Fix the file, then run this again."
  );
}

/**
 * Bring the commit-msg check in line with the project setting: install it when
 * on, remove an existing keryx block and script (same symlink guard as
 * {@link removeCommitMsgHookOrWarn}) when off, and touch nothing (with a
 * warning) when the setting cannot be read. `installed` is true only when the
 * check is wired in; `warning` is for the caller to print.
 */
export async function applyCommitMsgHookSetting(projectRoot: string): Promise<{
  readonly setting: CommitMsgHookSetting["state"];
  readonly installed: boolean;
  readonly removed: boolean;
  readonly warning: string | null;
}> {
  const setting = await readCommitMsgHookSetting(projectRoot);
  if (setting.state === "invalid") {
    return { setting: "invalid", installed: false, removed: false, warning: invalidSettingWarning(setting) };
  }
  if (setting.state === "on") {
    const warning = await installCommitMsgHookOrWarn(projectRoot);
    return { setting: "on", installed: warning === null && (await resolveGitHooksRoot(projectRoot)) !== null, removed: false, warning };
  }
  const removal = await removeCommitMsgHookOrWarn(projectRoot);
  return { setting: "off", installed: false, removed: removal.removed, warning: removal.warning };
}

export interface CommitMsgHookRemoval {
  /** The keryx block and/or the check script was removed. */
  readonly removed: boolean;
  readonly warning: string | null;
}

/**
 * Remove the keryx block from `commit-msg` and delete `keryx-commit-msg`.
 * Never edits a symlinked `commit-msg`, and keeps the script while any hook
 * line still calls it (deleting it would make that hook refuse every commit).
 */
export async function removeCommitMsgHookOrWarn(projectRoot: string): Promise<CommitMsgHookRemoval> {
  let resolved: Awaited<ReturnType<typeof resolveContainedHookPath>>;
  try {
    resolved = await resolveContainedHookPath(projectRoot, "commit-msg");
  } catch (err) {
    if (err instanceof ManagedGitHookEscapeError) {
      return { removed: false, warning: `Skipped removing the "${COMMIT_MSG_BLOCK_ID}" commit-msg hook: ${err.message}` };
    }
    throw err;
  }
  if (!resolved) return { removed: false, warning: null };
  const { hooksRoot, hookPath } = resolved;
  const scriptPath = path.join(hooksRoot, COMMIT_MSG_CHECK_SCRIPT);

  const hook = await readCommitMsgHook(hookPath);
  if (hook.symlink && (hook.hasBlock || hook.wired)) {
    return {
      removed: false,
      warning:
        `Did not edit ${hookPath}: it is a symlink and keryx does not edit a hook through a link. ` +
        `Remove the keryx call from its target yourself; ${scriptPath} was kept because that hook still calls it.`,
    };
  }
  let removed = false;
  let stillWired = hook.wired;
  if (hook.hasBlock) {
    // Not a symlink here: a symlinked hook carrying the block returned above.
    const next = `${hook.text.replace(commitMsgBlockPattern(true), "\n").trimEnd()}\n`;
    // Nothing but a shebang left: the file was keryx's own, so it goes too.
    if (isEmptyHook(next)) await rm(hookPath, { force: true });
    else await writeFile(hookPath, next, "utf8");
    removed = true;
    stillWired = callsCheckScript(next);
  }
  if (stillWired) {
    return {
      removed,
      warning: `${hookPath} still calls ${COMMIT_MSG_CHECK_SCRIPT}; kept ${scriptPath} so that hook keeps working. Remove that line, then run this again.`,
    };
  }
  const scriptStat = await lstat(scriptPath).catch(() => null);
  if (scriptStat && (scriptStat.isSymbolicLink() || (await isManagedCheckScript(scriptPath)))) {
    // rm on a symlink removes the link itself, never its target.
    await rm(scriptPath, { force: true });
    removed = true;
  }
  return { removed, warning: null };
}

/** True when the keryx check script exists and the `commit-msg` hook in the managed hooks directory calls it. */
export async function commitMsgHookInstalled(projectRoot: string): Promise<boolean> {
  const hooksRoot = await resolveGitHooksRoot(projectRoot);
  if (!hooksRoot) return false;
  if (!(await isManagedCheckScript(path.join(hooksRoot, COMMIT_MSG_CHECK_SCRIPT)))) return false;
  return (await readCommitMsgHook(path.join(hooksRoot, "commit-msg"))).wired;
}

export type CommitMsgHookState =
  | { readonly state: "no-git" }
  | { readonly state: "disabled" }
  | { readonly state: "setting-invalid"; readonly reason: string }
  | {
      readonly state: "unverified";
      /** Starts with "unverified — check that this line runs before any exec". */
      readonly reason: string;
      readonly fix: string;
    }
  | { readonly state: "missing" }
  | { readonly state: "active" }
  | {
      readonly state: "inactive";
      /** Why git will not (or cannot be shown to) run the check. */
      readonly reason: string;
      readonly fix?: string;
      readonly effectiveHooksDir?: string;
      readonly managedHooksDir?: string;
    };

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

/**
 * Whether git actually runs the keryx check: the script must exist and be
 * executable, and the `commit-msg` hook in git's EFFECTIVE hooks directory
 * (`git rev-parse --git-path hooks`, which honours `core.hooksPath`) must be
 * executable and call it, through the keryx block or a line the user added.
 * When that cannot be confirmed (git missing or failing) the state is
 * `inactive` with the reason, never `active`.
 */
export async function inspectCommitMsgHook(projectRoot: string): Promise<CommitMsgHookState> {
  const setting = await readCommitMsgHookSetting(projectRoot);
  if (setting.state === "off") return { state: "disabled" };
  if (setting.state === "invalid") return { state: "setting-invalid", reason: invalidSettingWarning(setting) };
  const hooksRoot = await resolveGitHooksRoot(projectRoot);
  if (!hooksRoot) return { state: "no-git" };
  const scriptPath = path.join(hooksRoot, COMMIT_MSG_CHECK_SCRIPT);
  const managedHookPath = path.join(hooksRoot, "commit-msg");
  const managedHook = await readCommitMsgHook(managedHookPath);
  const scriptStat = await stat(scriptPath).catch(() => null);
  if (!scriptStat && !managedHook.hasBlock) return { state: "missing" };
  if (!scriptStat) {
    return {
      state: "inactive",
      reason: `${managedHookPath} calls ${COMMIT_MSG_CHECK_SCRIPT} but ${scriptPath} is missing, so git refuses every commit`,
      fix: "keryx update",
    };
  }
  if (!isExecutable(scriptStat.mode)) {
    return { state: "inactive", reason: `${scriptPath} is not executable`, fix: `chmod +x ${shellQuote(scriptPath)}` };
  }
  if (!Bun.which("git", { PATH: process.env.PATH ?? "" })) {
    return { state: "inactive", reason: "the git executable was not found, so whether git runs the hook cannot be confirmed" };
  }
  const proc = Bun.spawn(["git", "rev-parse", "--git-path", "hooks"], { cwd: projectRoot, stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0 || !stdout.trim()) {
    return { state: "inactive", reason: "git could not report its effective hooks directory, so whether it runs the hook cannot be confirmed" };
  }
  const effective = path.resolve(projectRoot, stdout.trim());
  const effectiveReal = await realpath(effective).catch(() => effective);
  const managedReal = await realpath(hooksRoot).catch(() => hooksRoot);
  const effectiveHookPath = path.join(effectiveReal, "commit-msg");
  const hook = effectiveReal === managedReal ? managedHook : await readCommitMsgHook(effectiveHookPath);

  if (hook.wired) {
    const hookStat = await stat(effectiveHookPath).catch(() => null);
    if (!hookStat || !isExecutable(hookStat.mode)) {
      return { state: "inactive", reason: `${effectiveHookPath} is not executable, so git does not run it`, fix: `chmod +x ${shellQuote(effectiveHookPath)}` };
    }
    if (!hook.runs) {
      return {
        state: "unverified",
        reason: `unverified — check that this line runs before any exec or exit in ${effectiveHookPath}: ${hook.callLine ?? COMMIT_MSG_CHECK_SCRIPT}`,
        fix: `put this line in ${shellQuote(effectiveHookPath)} right after the shebang, before any exec or exit: ${COMMIT_MSG_FIX_LINE}`,
      };
    }
    return { state: "active" };
  }
  if (effectiveReal !== managedReal) {
    return {
      state: "inactive",
      reason: `git runs hooks from ${effectiveReal} (core.hooksPath), not ${managedReal} where ${COMMIT_MSG_CHECK_SCRIPT} is installed, and ${effectiveHookPath} does not call it`,
      fix: `add this line to ${shellQuote(effectiveHookPath)}, before any exec or exit: "$(git rev-parse --git-common-dir)/hooks/${COMMIT_MSG_CHECK_SCRIPT}" "$1" || exit 1 (or unset core.hooksPath)`,
      effectiveHooksDir: effectiveReal,
      managedHooksDir: managedReal,
    };
  }
  if (!hook.exists) {
    return { state: "inactive", reason: `no commit-msg hook calls ${COMMIT_MSG_CHECK_SCRIPT}`, fix: "keryx update" };
  }
  return {
    state: "inactive",
    reason: `foreign commit-msg hook: ${effectiveHookPath} is not managed by keryx and does not call ${COMMIT_MSG_CHECK_SCRIPT}`,
    fix: `add this line to ${shellQuote(effectiveHookPath)}, before any exec or exit: ${COMMIT_MSG_FIX_LINE}`,
  };
}
