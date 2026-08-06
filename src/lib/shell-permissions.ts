// Shell command allowlist for the interactive agent (inspired by OpenCode /
// Claude Code / Grok Build permission models).
//
// - OpenCode: bash rules with `*` wildcards; ask UI offers once / always / reject;
//   "always" stores a command-prefix pattern for the session (or config).
// - Claude Code: `permissions.allow: ["Bash(npm run *)"]` with Tool(specifier)
//   patterns; deny > ask > allow.
// - Grok Build: always-approve mode + remembered "always allow" for common
//   command prefixes.
//
// keryx stores shell allow patterns in `~/.local/share/keryx/permissions.json`
// (same XDG base as auth.json). Default is ask (prompt). Never throws.

import { existsSync } from "node:fs";
import path from "node:path";
import { ensureKeryxConfigDir, readConfigFile, writeOwnerOnlyFile } from "./config-dir";
import { shellConfigPath } from "./shell-config";
import { isDestructiveCommand, touchesAgentCredentials } from "./command-risk";
import { createHash } from "node:crypto";
import { hasUnquotedMetacharacter } from "./shell-syntax";

export { hasUnquotedMetacharacter };

/** On-disk shell permission file shape. */
export interface ShellPermissions {
  /**
   * Glob patterns that auto-allow `shell_exec` without prompting.
   * Matching is case-sensitive; `*` / `?` wildcards (OpenCode-style).
   * Examples: `keryx wiki index`, `keryx flow status*`, `git status*`.
   * NOT `keryx *` — see {@link KERYX_PREFIX_REASON}; the example used to say
   * otherwise, which is how the grant that motivated this rule got saved.
   */
  allow: string[];
}

/**
 * Command words whose first token says nothing about what will actually run:
 * interpreters, generic wrappers, package/build runners, remote-exec and
 * download tools, container runtimes. A `<word> *` grant for any of them is a
 * grant of arbitrary code execution.
 *
 * The ban applies ONLY to the "everything after this word" form (`bash *`).
 * A narrower pattern that constrains the arguments (`bun test*`) is still
 * offerable, because it no longer covers arbitrary invocations.
 *
 * This list is an EXPEDIENT, not a boundary: it is inevitably incomplete. Three
 * things apply to every pattern regardless of its first word and are the actual
 * boundaries: the metacharacter rule, the destructive classifier, and the refusal
 * to remember anything touching the agent's own credential/permission files. The
 * shape rule below (PLAIN_PROGRAM_NAME) is also not a list.
 */
const PREFIX_BANNED: ReadonlySet<string> = new Set([
  // interpreters / runtimes
  "sh", "bash", "zsh", "ksh", "dash", "fish",
  "csh", "tcsh", "mksh", "yash", "posh", "rbash", "ash", "busybox-sh",
  "xonsh", "nu", "elvish", "osh", "oil",
  "python", "python2", "python3", "node", "bun", "deno", "perl", "ruby", "php", "lua",
  "java", "dotnet", "rscript", "tclsh",
  // generic wrappers that execute their argument
  "env", "eval", "exec", "xargs", "nice", "nohup", "time", "watch", "script",
  "sudo", "doas", "su", "pkexec", "runas",
  // shell builtins that execute a file's contents in the current shell. `.` is
  // the POSIX spelling of `source` and was missed while `sh`, `eval` and `exec`
  // were all banned — the same category, one character long.
  ".", "source", "builtin",
  // …and the ones this list did not have on 2026-08-05, when a review round ran
  // `timeout 5 sh -c 'cat ~/.ssh/id_rsa'` against a gate that banned `sh` and
  // `bash` and had never heard of `timeout`. Same category, same argument: the
  // first token names the wrapper, not the program.
  "timeout", "setsid", "stdbuf", "flock", "unshare", "strace", "ltrace",
  "busybox", "parallel", "command", "chroot", "expect", "pwsh", "powershell",
  "sshpass", "runuser", "setpriv",
  // our own CLI: `keryx ctx run -- <anything>` executes an arbitrary program,
  // and the destructive classifier reads the command line it is given rather
  // than the one after the `--`. See KERYX_PREFIX_REASON.
  "keryx",
  // remote execution and transfer
  "ssh", "scp", "rsync", "nc", "ncat", "socat", "telnet",
  // download tools (a fetched script is arbitrary code)
  "curl", "wget", "fetch", "aria2c", "httpie", "http",
  // container / cluster runtimes (equivalent to root on the host)
  "docker", "podman", "nerdctl", "kubectl", "helm", "systemd-run",
  // build/package runners that execute project-defined scripts
  "make", "npm", "npx", "yarn", "pnpm", "cargo", "go", "gradle", "mvn", "ant",
  // tools whose flags execute arbitrary commands
  "git", "find", "awk", "gawk", "sed", "vim", "vi", "ex", "emacs", "gdb", "lldb",
  "at", "batch", "crontab", "tmux", "screen", "osascript", "open", "tee", "cd",
  // …same category, found by the same review round through their own escapes:
  // `psql -c '\! …'`, `sqlite3 '.shell …'`, `tar --to-command`, `cmake -P`,
  // `pip install -e`, plus the cloud CLIs whose bare grant is a credential read
  // (`gh auth token`) or an exfiltration channel (`aws s3 cp .env s3://…`).
  "psql", "mysql", "sqlite3", "mongo", "mongosh", "redis-cli",
  "gh", "glab", "aws", "gcloud", "az",
  "pip", "pip3", "pipx", "uv", "gem", "brew", "apt", "apt-get",
  "tar", "cmake", "bazel", "terraform", "ansible", "ansible-playbook",
]);

/**
 * Why `keryx *` is refused, stated specifically rather than as "an interpreter
 * or wrapper". It is worth its own sentence: this repository's own `CLAUDE.md`
 * tells agents to route commands through `keryx ctx run`, so `keryx *` is
 * exactly the grant a user of this project would save — and with it saved,
 * `keryx ctx run -- rm -rf /` used to auto-approve with no prompt.
 */
const KERYX_PREFIX_REASON =
  "`keryx *` grants arbitrary execution: `keryx ctx run -- <command>` runs any program, and the " +
  "destructive-command check reads the line it is given rather than the one after the `--`. Save a " +
  "narrower pattern (`keryx flow status*`, `keryx ctx rg*`) instead";

/**
 * Broad file readers. A bare `<reader> *` grant auto-approves reading ANY path,
 * so once remembered, `cat ~/.ssh/id_rsa` / `grep -r . /etc` would never prompt —
 * an arbitrary-secret-read channel into the model transcript (findings F2/F4). A
 * NARROWER pattern (`cat package.json*`, `grep foo *`) still constrains the target
 * and stays offerable; only the "everything after this word" form is refused.
 */
const PREFIX_BANNED_READERS: ReadonlySet<string> = new Set([
  "cat", "tac", "nl", "head", "tail", "less", "more", "grep", "egrep", "fgrep",
  "zgrep", "rg", "ag", "sort", "uniq", "cut", "strings", "od", "xxd", "hexdump", "dd",
]);

/**
 * Destructive-capable file mutators that the destructive classifier does NOT
 * escalate for a non-catastrophic target (e.g. `rm somefile`, `mv a b`). A bare
 * `<mutator> *` grant would then auto-approve `rm <glob>` / `mv <glob>` anywhere
 * in the cwd — silent workspace data loss (finding F5). Only the bare
 * "everything after this word" form is refused; a narrower pattern is offerable.
 */
const PREFIX_BANNED_MUTATORS: ReadonlySet<string> = new Set([
  "rm", "rmdir", "unlink", "mv", "cp", "shred", "truncate", "ln",
]);

/** Reason a pattern was refused (never silently dropped). */
export interface PatternRejection {
  pattern: string;
  reason: string;
}

/** Result of {@link validateShellPattern}. */
export type PatternValidation = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether `pattern` may EVER auto-approve a command without prompting.
 *
 * Refuses, in order:
 *  1. empty / whitespace-only — matches nothing meaningful;
 *  2. a comment (`#` …) — `# *` matches `"# note\nrm -rf /"`;
 *  3. an unquoted shell metacharacter — the pattern would be matched against raw
 *     text that `/bin/sh -c` re-interprets;
 *  4. a destructive command (see `command-risk.ts`) — this is what a stored
 *     exact `rm -rf /` defeats;
 *  5. a bare `<interpreter> *` grant.
 *
 * Pure.
 */
export function validateShellPattern(pattern: string): PatternValidation {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty pattern" };
  }
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  if (firstToken.startsWith("#")) {
    return { ok: false, reason: "a comment is not a command: `# *` matches any text followed by any command" };
  }
  if (hasUnquotedMetacharacter(trimmed)) {
    return {
      ok: false,
      reason:
        "contains an unquoted shell metacharacter (; && || | ` $( < > &, or a newline); such a command can only be approved once, never remembered",
    };
  }
  if (isDestructiveCommand(trimmed)) {
    return { ok: false, reason: "destructive commands always require explicit confirmation and are never remembered" };
  }
  if (touchesAgentCredentials(trimmed)) {
    return {
      ok: false,
      reason:
        "touches the agent's own permission/credential files; remembering it would let one approved command disable the approval gate for every future session",
    };
  }
  const keryxVerb = unpinnedKeryxVerb(trimmed);
  if (keryxVerb !== undefined) {
    return { ok: false, reason: keryxVerb };
  }
  const banned = bannedPrefixGrant(trimmed, firstToken);
  if (banned !== undefined) {
    return { ok: false, reason: banned.reason };
  }
  return { ok: true };
}

/**
 * `keryx` verbs that take a program to run ON THE COMMAND LINE, and therefore
 * cannot be covered by a remembered pattern at all.
 *
 * Unlike the prefix lists this one is CLOSED and knowable: it enumerates keryx's
 * own argv-executing verbs, read off the dispatch table in `cli.ts`, not a guess
 * about the outside world.
 *
 * It is NOT a claim that nothing else in keryx runs a program. `keryx health run`
 * and `keryx test run` execute the repository's own configured test command, and
 * both stay offerable — the program there comes from the checkout rather than
 * from the pattern, which is a different threat and not one a permission pattern
 * can address.
 */
const KERYX_EXECUTING_VERBS: ReadonlyArray<readonly string[]> = [
  ["ctx", "run"],
  ["harness", "exec"],
];

/**
 * Why a `keryx …` pattern is refused when it does not literally pin a verb that
 * cannot execute a caller-supplied program.
 *
 * Banning the bare `keryx *` grant is not enough, and a review demonstrated it:
 * `keryx ctx run*`, `keryx ctx*`, `keryx c*` and `keryx ?*` all NARROW the
 * arguments — so they were offerable — and all still cover
 * `keryx ctx run -- rm -rf /`, because the destructive classifier reads the line
 * it is given rather than the one after the `--`.
 *
 * THREE rounds of review got past three versions of this rule, and the third
 * reviewer named the reason rather than the strings: the check reasoned about
 * TOKENS while the matcher it defends has none. `matchShellPattern` compiles `*`
 * to `[\s\S]*` and `?` to `.`, both of which cross whitespace, so a wildcard
 * anywhere at or before the verb dissolves the positions the check is counting.
 *
 *   round 1  `keryx ctx run*`, `keryx c*`      — token compared as a whole glob
 *   round 2  `keryx ctx run?*`, `keryx ctx ru*` — compared against the verb word
 *                                                 in isolation
 *   round 3  `keryx * rg*`, `k* ctx run*`       — an earlier `*` ate the boundary,
 *                                                 and a later token then claimed
 *                                                 the exclusion from a position it
 *                                                 no longer occupied
 *
 * Each round refused exactly the strings the previous reviewer typed. So this
 * version does not compare globs in a verb position at all:
 *
 *  - the verb span is scanned LEFT TO RIGHT, and the scan stops at the first
 *    token that excludes the verb word literally;
 *  - a token carrying a wildcard may end the scan only by EXCLUDING — its literal
 *    prefix must rule the verb word out. `rg*` does (`rg` is not `run`, neither is
 *    a prefix of the other), `run?*` and `ru*` do not, and `*` never does;
 *  - so a wildcard reached before the verb is excluded is fatal, which is what
 *    kills `keryx * rg*`: the `*` cannot exclude `ctx`, and nothing after it is
 *    trusted, because after a `*` there is no "after" to speak of.
 *
 * The keryx token itself is found the same way — by literal runs, not by string
 * equality — because `k*`, `ker*x`, `ke?yx` and `*keryx` all reach the same CLI
 * and none of them equals `keryx`. A candidate token that carries a wildcard is
 * refused outright: a name that is partly a glob names nothing.
 *
 * Strictly more conservative than every earlier version, and it would have
 * refused all seven inputs across the three rounds without anyone enumerating
 * them. The forms the documentation recommends — `keryx ctx rg*`,
 * `keryx flow status*`, `keryx health run*` — survive, because their wildcards
 * fall at or after a token that already excluded the verb.
 */
function unpinnedKeryxVerb(pattern: string): string | undefined {
  const tokens = pattern.split(/\s+/);
  const advice =
    "Pin the verb literally instead (`keryx flow status*`, `keryx ctx rg*`), which today means editing " +
    "permissions.json by hand — the approval prompt only offers the exact command or `keryx *`.";
  for (const [position, token] of tokens.entries()) {
    if (!couldNameKeryx(token)) {
      continue;
    }
    if (hasWildcard(token)) {
      return (
        `\`${pattern}\` has a wildcard in the token that names keryx (\`${token}\`), so it can match ` +
        "`keryx ctx run -- <any command>`. A program name that is partly a glob names nothing. " +
        advice
      );
    }
    for (const verb of KERYX_EXECUTING_VERBS) {
      if (!verbSpanExcludes(tokens, position + 1, verb)) {
        return (
          `\`${pattern}\` can match \`keryx ${verb.join(" ")} -- <any command>\`, which runs an arbitrary ` +
          "program; the destructive-command check reads the line it is given, not the one after the `--`. " +
          advice
        );
      }
    }
  }
  return undefined;
}

/** Whether a pattern token contains a glob wildcard. */
function hasWildcard(token: string): boolean {
  return /[*?]/.test(token);
}

/**
 * Whether `token` could be the word `keryx` when the pattern is matched.
 *
 * Asked of every LITERAL RUN in the token, not of the token as a whole, so
 * `*keryx` and `ker*x` are candidates while `hostname`'s companion `*` is not —
 * a token that is only wildcards names nothing in particular and is an argument
 * position, not a program one.
 */
function couldNameKeryx(token: string): boolean {
  const word = normalizeCommandWord(token);
  if (word === "keryx") {
    return true;
  }
  return token
    .split(/[*?]+/)
    .filter((run) => run.length > 0)
    .some((run) => {
      const bare = (run.split("/").pop() ?? "").toLowerCase();
      return bare.length > 0 && (bare.startsWith("keryx") || "keryx".startsWith(bare));
    });
}

/**
 * Whether the tokens starting at `start` rule out `verb` — scanned left to right,
 * stopping at the first token that excludes.
 *
 * Returns true (safe) as soon as a token cannot be the verb word it sits at, and
 * false the moment a token could be it, including when a wildcard makes the
 * question unanswerable. Running out of tokens is safe: a wildcard-free pattern
 * shorter than the verb cannot match a command that continues past it, and a
 * pattern that DID carry a wildcard was already refused at the token holding it.
 */
function verbSpanExcludes(tokens: readonly string[], start: number, verb: readonly string[]): boolean {
  for (const [index, word] of verb.entries()) {
    const token = tokens[start + index];
    if (token === undefined) {
      return !hasWildcard(tokens[start + index - 1] ?? "");
    }
    const wildcardAt = token.search(/[*?]/);
    const literal = wildcardAt === -1 ? token : token.slice(0, wildcardAt);
    if (wildcardAt === -1) {
      if (literal !== word) {
        return true; // a literal that differs: the verb is unreachable from here
      }
      continue; // literally the verb word — keep scanning
    }
    // A wildcarded token may only end the scan by excluding. Its literal prefix
    // has to rule the word out; anything else and the wildcard is free to eat the
    // token boundary, which is how `keryx * rg*` got through.
    return !literal.startsWith(word) && !word.startsWith(literal);
  }
  return false; // every token matched the verb, literally
}

/**
 * The characters a plain program name is made of.
 *
 * This is a SHAPE, and it is the load-bearing half of the prefix rule — the word
 * lists below it are the expedient. A review of the first version of this change
 * demonstrated why: `\bash *` normalised to `\bash`, which is in no list, and the
 * approval UI offered it; under `/bin/sh` a leading backslash only suppresses
 * alias expansion, so `\bash -c 'cat ~/.ssh/id_rsa'` runs. One character defeated
 * all three lists at once, including the `keryx` entry this file had just added.
 * `'bash' *` and `"bash" *` did the same through quoting.
 *
 * Normalising harder would have answered those three and lost to the fourth. The
 * rule is therefore inverted: a bare `<token> *` grant is offerable only when the
 * token is RECOGNISABLY a program name. Anything else — a quote, a backslash, an
 * `=`, a wildcard in the middle — is refused without asking what it is.
 */
const PLAIN_PROGRAM_NAME = /^[A-Za-z0-9._+-]+$/;

/**
 * Strip the decorations a first token can carry before it is looked up: a
 * trailing wildcard, surrounding quotes, leading backslashes, and a directory
 * path. Lowercased.
 *
 * Only used to ASK WHICH word it is. Whether the token was allowed to be a bare
 * grant at all is decided by {@link PLAIN_PROGRAM_NAME} on the stripped form, so
 * this function cannot be used to launder a token past the shape check.
 */
function normalizeCommandWord(firstToken: string): string {
  let word = firstToken.replace(/\*+$/, "");
  word = word.replace(/^["']+/, "").replace(/["']+$/, "");
  word = word.replace(/^\\+/, "");
  return stripVersionSuffix((word.split("/").pop() ?? "").toLowerCase());
}

/**
 * Interpreters whose real installed name usually carries a version.
 *
 * `python3 *` was refused and `python3.12 *` was OFFERED, on a host where
 * `/usr/bin/python3.12` exists and runs — a review demonstrated it reading
 * `/etc/hostname` through the grant. The suffix is stripped before lookup so one
 * entry covers every spelling, which is narrower than adding a row per release
 * and does not go stale.
 *
 * Every name here must also be in {@link PREFIX_BANNED}, or the stripping is
 * inert and reads as coverage that is not there — a later review found
 * `gcc|clang|erl|scala|julia` in this list and in no other, so `gcc13 *` was
 * offerable exactly as `gcc *` was. Pinned by a test.
 */
const VERSIONED_INTERPRETERS = /^(python|node|ruby|perl|php|lua)[\d.]+$/;

/** Strip a trailing version from an interpreter name (`python3.12` → `python`). */
function stripVersionSuffix(word: string): string {
  const match = VERSIONED_INTERPRETERS.exec(word);
  return match?.[1] ?? word;
}

/**
 * Whether `rest` (everything after the first token) constrains the arguments.
 *
 * `timeout ?*` is a bare grant wearing a different hat: `?` matches one
 * character and `*` matches the remainder, so it covers
 * `timeout 5 sh -c 'cat ~/.ssh/id_rsa'` exactly as `timeout *` would. So does
 * `timeout -- *`, and `timeout -*`. A remainder built only of wildcards,
 * whitespace and dashes pins nothing.
 */
function restIsUnconstraining(rest: string): boolean {
  return /^[*?\s-]*$/.test(rest);
}

/**
 * When `pattern` is a bare "everything after this word" grant we refuse to
 * remember, the word and a reason; else undefined. A pattern that narrows the
 * arguments (`bun test*`, `cat package.json*`) is not a bare grant and is allowed.
 */
function bannedPrefixGrant(pattern: string, firstToken: string): { word: string; reason: string } | undefined {
  const rest = pattern.slice(firstToken.length).trim();
  const wildcardOnly =
    restIsUnconstraining(rest) && (rest.length > 0 || /\*+$/.test(firstToken));
  if (!wildcardOnly) return undefined;
  const word = normalizeCommandWord(firstToken);

  // The shape check, BEFORE any list. An env-assignment first token is the case
  // that settles the argument: `LC_ALL=C *` auto-approves
  // `LC_ALL=C bash -c 'cat ~/.ssh/id_rsa'`, and the token is attacker-chosen text
  // rather than a program name — there is no list that could ever contain it.
  if (firstToken.includes("=")) {
    return {
      word,
      reason:
        "an environment assignment does not name a program: `VAR=value *` grants whatever command follows " +
        "the assignment, and no list of program names can cover it",
    };
  }
  // A wildcard inside the first token makes the PROGRAM NAME a glob: `t*` is a
  // bare grant over `timeout`, `tar` and everything else beginning with `t`, and
  // `timeout*` also covers `timeoutfoo`. Refused by shape, before the word is
  // looked up, because there is no word to look up — there is a pattern.
  if (/[*?]/.test(firstToken)) {
    return {
      word,
      reason:
        `\`${firstToken}\` is a wildcard over program NAMES, not a program: it grants whatever command ` +
        "happens to match it. Name the program exactly and narrow its arguments instead",
    };
  }
  // Tested on the token AS WRITTEN, not on the normalised word. Normalising
  // first is what let `\bash *` through: the backslash was stripped, `bash` was
  // looked up, and a word NOT in any list — `\mytool *` — would have sailed past
  // the shape check too. A path is still allowed, one segment at a time, so
  // `/usr/bin/timeout *` and `./timeout *` reach the word lists as before.
  const segments = firstToken.split("/");
  const shapeOk = segments.every((segment, index) =>
    segment.length === 0 ? index === 0 : PLAIN_PROGRAM_NAME.test(segment),
  );
  if (!shapeOk) {
    return {
      word,
      reason:
        `\`${firstToken} *\` does not begin with a plain program name (letters, digits, and \`. _ + -\`). ` +
        "A quoted or escaped first token hides which program runs — `\\bash` is `bash` to the shell and " +
        "nothing at all to a word list — so it can be approved once, never remembered",
    };
  }
  if (PREFIX_BANNED.has(word)) {
    return {
      word,
      reason:
        word === "keryx"
          ? KERYX_PREFIX_REASON
          : `\`${word} *\` grants arbitrary execution: ${word} is an interpreter or wrapper, so its first token does not constrain what runs`,
    };
  }
  if (PREFIX_BANNED_READERS.has(word)) {
    return {
      word,
      reason: `\`${word} *\` would auto-approve reading any file (including secrets outside the project); such a broad reader can be approved once, never remembered`,
    };
  }
  if (PREFIX_BANNED_MUTATORS.has(word)) {
    return {
      word,
      reason: `\`${word} *\` would auto-approve modifying/deleting any path in the working directory; such a broad mutator can be approved once, never remembered`,
    };
  }
  return undefined;
}

/** Empty permissions (prompt everything). */
export function emptyShellPermissions(): ShellPermissions {
  return { allow: [] };
}

/** Absolute path to `permissions.json` next to `auth.json`. */
export function shellPermissionsPath(dir?: string): string {
  return path.join(path.dirname(shellConfigPath(dir)), "permissions.json");
}

/** A load that also reports which stored patterns were refused, and why. */
export interface ShellPermissionsAudit {
  permissions: ShellPermissions;
  rejected: PatternRejection[];
}

/**
 * Load permissions and partition them through {@link validateShellPattern}.
 *
 * Refused patterns are reported, NOT deleted: the file on disk is left untouched
 * so the user can see and edit it, and so a load can never silently destroy a
 * grant the user might still want in a narrower form. The UI surfaces
 * `rejected` before the first auto-approve of a session.
 *
 * Never throws.
 */
export function loadShellPermissionsWithAudit(dir?: string): ShellPermissionsAudit {
  try {
    const file = shellPermissionsPath(dir);
    if (!existsSync(file)) {
      return { permissions: emptyShellPermissions(), rejected: [] };
    }
    // `readConfigFile`, not `readFileSync`: an oversized file aborts the process
    // with SIGABRT, which the `catch` below cannot see, and this module's header
    // promises it never throws. A file that cannot be read grants nothing, which
    // is the fail-closed answer for an allowlist.
    const read = readConfigFile(file);
    if (!read.ok) {
      return { permissions: emptyShellPermissions(), rejected: [] };
    }
    const raw: unknown = JSON.parse(read.text);
    if (raw === null || typeof raw !== "object") {
      return { permissions: emptyShellPermissions(), rejected: [] };
    }
    const allowRaw = (raw as { allow?: unknown }).allow;
    const stored = Array.isArray(allowRaw)
      ? allowRaw.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
      : [];

    const allow: string[] = [];
    const rejected: PatternRejection[] = [];
    for (const pattern of stored) {
      const verdict = validateShellPattern(pattern);
      if (verdict.ok) allow.push(pattern);
      else rejected.push({ pattern, reason: verdict.reason });
    }
    return { permissions: { allow }, rejected };
  } catch {
    return { permissions: emptyShellPermissions(), rejected: [] };
  }
}

/**
 * Load the ACTIVE permissions. Patterns that fail validation are excluded — a
 * caller cannot opt out of the migration, only observe it via
 * {@link loadShellPermissionsWithAudit}. Never throws.
 */
export function loadShellPermissions(dir?: string): ShellPermissions {
  return loadShellPermissionsWithAudit(dir).permissions;
}

/** Options for {@link saveShellPermissions}. */
export interface SaveShellPermissionsOptions {
  /**
   * Write patterns verbatim without validating them. ONLY for tests that need to
   * reproduce a file written by an older keryx; never set on a user path.
   */
  skipValidation?: boolean;
}

/** Persist permissions (0600). Invalid patterns are dropped. Never throws. */
export function saveShellPermissions(
  perms: ShellPermissions,
  dir?: string,
  options: SaveShellPermissionsOptions = {},
): void {
  try {
    const file = shellPermissionsPath(dir);
    // Through the shared helpers, not `mkdirSync` + `writeFileSync(..., mode)`.
    // Both of those apply their mode at CREATION only, and this writer sits in
    // the same directory as `auth.json` — under `umask 002` it CREATED that
    // directory at 0775, which is the precondition for replacing the credential
    // store. This file is the worse half: it decides which shell commands are
    // auto-approved, so a group member who appends `*` to the allowlist gets
    // silent approval of arbitrary commands in the operator's shell.
    ensureKeryxConfigDir(path.dirname(file));
    const cleaned = Array.from(new Set(perms.allow.map((p) => p.trim()).filter((p) => p.length > 0)));
    const body: ShellPermissions = {
      allow: options.skipValidation === true ? cleaned : cleaned.filter((p) => validateShellPattern(p).ok),
    };
    writeOwnerOnlyFile(file, `${JSON.stringify(body, null, 2)}\n`);
  } catch {
    // best-effort
  }
}

/**
 * Append one allow pattern (deduped) and save. Best-effort; never throws.
 * Returns the pattern that was stored, or `""` when it was REFUSED — the caller
 * must treat `""` as "this command can be approved once, but not remembered".
 */
export function allowShellPattern(pattern: string, dir?: string): string {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (!validateShellPattern(trimmed).ok) {
    return "";
  }
  const current = loadShellPermissions(dir);
  if (!current.allow.includes(trimmed)) {
    current.allow.push(trimmed);
    saveShellPermissions(current, dir);
  }
  return trimmed;
}

/**
 * OpenCode-style glob: `*` = any run of chars **including newlines** (heredoc /
 * multiline shell_exec), `?` = one char (any, including newline), other chars literal.
 * Pure.
 *
 * Note: JS `RegExp` `.` does not match `\n` by default — we map `*` → `[\s\S]*`
 * so remembered prefixes like `cat *` match `cat > file <<'EOF'\n…\nEOF`.
 */
export function matchShellPattern(pattern: string, command: string): boolean {
  const p = pattern.trim();
  const c = command.trim();
  if (p.length === 0) {
    return false;
  }
  // Escape regex specials except our wildcards, then map * / ?.
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*") {
      // Dot-all: any run of characters including newlines.
      re += "[\\s\\S]*";
    } else if (ch === "?") {
      re += "[\\s\\S]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  try {
    return new RegExp(`^${re}$`).test(c);
  } catch {
    return p === c;
  }
}

/**
 * True when `command` may be auto-approved from the allowlist.
 *
 * Two barriers apply to the COMMAND before any pattern is consulted, and they
 * are independent of how the pattern was created — that is the point, because a
 * pattern saved by an older keryx (or hand-edited into the file) has not passed
 * {@link validateShellPattern}:
 *
 *  - an unquoted metacharacter means the string will be re-interpreted by
 *    `/bin/sh -c`, so a pattern match says nothing about what will run;
 *  - a destructive command always requires explicit confirmation.
 *
 * Pure.
 */
export function isShellCommandAllowed(command: string, allow: readonly string[]): boolean {
  const cmd = command.trim();
  if (cmd.length === 0) {
    return false;
  }
  if (hasUnquotedMetacharacter(cmd)) {
    return false;
  }
  if (isDestructiveCommand(cmd)) {
    return false;
  }
  if (touchesAgentCredentials(cmd)) {
    return false;
  }
  return allow.some((pat) => matchShellPattern(pat, cmd));
}

/**
 * Content fingerprint of the stored permission file (`""` when it does not
 * exist). A session captures this once and compares before each auto-approve:
 * a change mid-session means the allowlist was rewritten by something other
 * than the approval UI, which is exactly the self-grant path this flow closes.
 *
 * Never throws.
 */
export function shellPermissionsFingerprint(dir?: string): string {
  try {
    const file = shellPermissionsPath(dir);
    if (!existsSync(file)) {
      return "";
    }
    const read = readConfigFile(file);
    if (!read.ok) {
      return "";
    }
    return createHash("sha256").update(read.text, "utf8").digest("hex");
  } catch {
    return "";
  }
}

/** What the approval UI may offer for one command. */
export interface ShellPatternSuggestion {
  exact: string;
  prefix: string;
  /** The UI may offer "always allow this exact command". */
  offerExact: boolean;
  /** The UI may offer "always allow anything starting with this word". */
  offerPrefix: boolean;
}

/**
 * Suggested patterns for the approval UI (OpenCode-style "always" grants), each
 * with a flag saying whether it may be OFFERED at all.
 *
 * - exact: full command (preserves newlines so heredoc matches on re-use)
 * - prefix: first token of the first line + ` *`
 *
 * A destructive command offers neither grant, whatever its shape: "always" on a
 * destructive command is the exact path that put a literal `rm -rf /` into a
 * live allowlist (flow 115).
 */
export function suggestShellPatterns(command: string): ShellPatternSuggestion {
  const trimmed = command.trim();
  // Preserve newlines for heredoc exact-match; collapse spaces on single-line only.
  const multiline = /[\r\n]/.test(trimmed);
  const exact = multiline ? trimmed : trimmed.replace(/\s+/g, " ");
  // First token from the first non-empty line only (ignore heredoc body).
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  const first = collapsed.split(" ")[0] ?? collapsed;
  const prefix = first.length > 0 ? `${first} *` : exact;
  const destructive = trimmed.length > 0 && isDestructiveCommand(trimmed);
  return {
    exact,
    prefix,
    offerExact: !destructive && validateShellPattern(exact).ok,
    offerPrefix: !destructive && validateShellPattern(prefix).ok,
  };
}

/** Parse `shell_exec` tool input JSON (or a raw command string) → command text. */
export function parseShellExecCommand(inputJson: string): string {
  try {
    const parsed: unknown = JSON.parse(inputJson);
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { command?: unknown }).command === "string") {
      return (parsed as { command: string }).command.trim();
    }
  } catch {
    // raw string
  }
  return inputJson.trim();
}
