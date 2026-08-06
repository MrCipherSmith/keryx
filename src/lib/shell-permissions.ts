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
  // …and the util-linux scheduling/personality family, plus the environment
  // wrappers, all verified present in /usr/bin and executing their argument on
  // the machine a review checked. `ionice *` and `eatmydata *` were offerable
  // bare grants of arbitrary execution.
  "ionice", "taskset", "chrt", "numactl", "setarch", "eatmydata", "fakeroot",
  "ssh-agent", "dbus-run-session", "systemd-inhibit", "unbuffer", "xvfb-run",
  "proxychains", "torsocks", "firejail", "bwrap", "valgrind", "perf",
  "direnv", "poetry", "pipenv", "just", "rake", "mise", "asdf", "conda",
  "bunx", "uvx",
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
  // `diff /etc/shadow /dev/null` prints the file. A review demonstrated it on
  // this host while showing that `env diff *` was offerable; the launder was the
  // finding, but `diff *` at token 0 had always been offerable too, which is the
  // older half of the same gap.
  "diff", "cmp",
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
  const positional = wildcardOutOfPosition(trimmed, firstToken);
  if (positional !== undefined) {
    return { ok: false, reason: positional };
  }
  const keryxVerb = unpinnedKeryxVerb(trimmed);
  if (keryxVerb !== undefined) {
    return { ok: false, reason: keryxVerb };
  }
  const banned = bannedPrefixGrant(trimmed, firstToken);
  if (banned !== undefined) {
    return { ok: false, reason: banned.reason };
  }
  const openWildcard = openWildcardBehindWrapper(trimmed);
  if (openWildcard !== undefined) {
    return { ok: false, reason: openWildcard };
  }
  const laundered = launderedBroadGrant(trimmed);
  if (laundered !== undefined) {
    return { ok: false, reason: laundered };
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
 * Where a wildcard may appear in a pattern at all.
 *
 * FOUR review rounds got past the keryx verb rule, and the fourth reviewer ended
 * the argument with an exhaustive search: 1538 bypasses out of 551,880 generated
 * patterns, across six first-token shapes, none of which any name-based test can
 * reach. `????? ctx run*` is the one to remember — five question marks, no
 * letters, matching `keryx` purely by length.
 *
 * Rounds 2, 3 and 4 all refined the same idea: look at the letters in the token.
 * Compare globs to words, then literal prefixes, then literal runs. **The matcher
 * does not match names.** `*` is `[\s\S]*` and `?` is `.`; a wildcard in the
 * program position IS a program, whatever letters it does or does not contain.
 *
 * So the property enforced here is POSITIONAL, and it is two lines:
 *
 *  1. the FIRST token carries no wildcard — the program has to be named;
 *  2. only the LAST token may carry one — a wildcard in the middle crosses
 *     whitespace and can supply whole tokens, including `keryx ctx run`.
 *
 * Together these make every token but the last a literal, which is what lets the
 * verb scan below reason about positions at all: after this, a token's index in
 * the pattern really is its index in any command the pattern matches.
 *
 * They also make the earlier lexical tests small. `k*`, `ker*x`, `*keryx`,
 * `keryx?`, `* ctx run*` and `?* ctx run*` are all refused here, by shape, before
 * anything asks what they spell.
 *
 * Cost, stated: `t*`, `*x` and `git*` stop being offerable. None was safe —
 * `*x` was `*` with a one-character toll, and it slipped past the bare-grant gate
 * entirely because its remainder was empty and its token did not end in `*`.
 * What survives is every documented form: `bun test*`, `hostname *`,
 * `cat package.json*`, `rm build/*.tmp`, `ls k*`, `keryx ctx rg*`,
 * `keryx flow status*`, `keryx health run*`.
 */
function wildcardOutOfPosition(pattern: string, firstToken: string): string | undefined {
  if (hasWildcard(firstToken)) {
    return (
      `\`${firstToken}\` is not a program name: a wildcard in the first token can match any program, ` +
      "including `keryx ctx run`, so the pattern grants whatever the model chooses to type. Name the " +
      "program and put the wildcard after it"
    );
  }
  const tokens = pattern.split(/\s+/);
  const stray = tokens.findIndex((token, index) => index < tokens.length - 1 && hasWildcard(token));
  if (stray !== -1) {
    return (
      `\`${tokens[stray]}\` is a wildcard in the middle of \`${pattern}\`, and a wildcard matches ` +
      "whitespace — it can stand in for whole tokens, so the words after it do not constrain what runs. " +
      "Only the last part of a pattern may be a wildcard"
    );
  }
  return undefined;
}

/**
 * Words that do not run what follows them, so a glob after one is an argument
 * rather than a program.
 *
 * An INVERTED list, and the inversion is the point. The gate used to ask "is the
 * preceding word a known wrapper?", which meant a wrapper nobody had listed left
 * the gate shut: a review found `ionice`, `taskset`, `setarch`, `chrt`,
 * `numactl`, `eatmydata`, `fakeroot` and `ssh-agent` all present in /usr/bin on
 * the first machine it looked at, all executing their argument, and none on the
 * list. A missing word was a hole.
 *
 * Asking the opposite question makes a missing word an OVER-REFUSAL instead: a
 * program that cannot execute anything, but is not written here, costs its user
 * one pattern rather than costing everyone a bypass. That is the direction the
 * rest of this file already chose, and it is the only way to be wrong safely
 * about a list of outside-world names.
 */
const NON_EXECUTING_PREFIXES: ReadonlySet<string> = new Set([
  "ls", "cat", "echo", "printf", "ln", "cp", "mv", "touch", "mkdir", "rmdir",
  "head", "tail", "wc", "stat", "file", "du", "df", "basename", "dirname",
  "realpath", "readlink", "chmod", "chown", "diff", "cmp", "jq", "pwd", "date",
  // The read-only text family. Absent, these made the chain continue, so
  // `grep foo k*`, `sort keryx.log*` and `md5sum keryx.log*` were refused — with
  // a message claiming they name a program to run. In a repository called keryx
  // those are things people type.
  "grep", "egrep", "fgrep", "zgrep", "rg", "ag", "sort", "uniq", "cut", "tr",
  "rev", "nl", "tac", "comm", "join", "fold", "expand", "unexpand", "split",
  "shuf", "seq", "paste", "column", "fmt", "numfmt", "strings", "xxd", "od",
  "md5sum", "sha1sum", "sha256sum", "sha512sum", "b2sum", "cksum", "sum",
  "base64", "yq", "bat", "tree", "hostname", "printenv", "which", "type",
  "id", "whoami", "uname", "uptime", "free", "ps",
  // NOT here, deliberately: `less` and `more` have a `!command` shell escape,
  // and `tee` writes files. A review listed all three as over-refusals; they are
  // the ones where the over-refusal is earned.
]);

/**
 * The indices at which a token names a PROGRAM rather than an argument.
 *
 * Index 0 always. Then ONE hop: if the first word can execute what follows it,
 * the next token that is not a wildcard-free flag or a bare number is also a
 * program position — and the chain stops there, whatever that token turns out to
 * be. One hop is what separates `timeout 5 *` (the `*` IS the program) from
 * `docker ps *` (the `*` is an argument to `ps`, which is pinned). Following the
 * chain further would refuse `docker ps *`, `git log *`, `gh pr list *` and
 * `npm ls *`, which are ordinary read-only grants.
 *
 * `executes` is supplied by the caller, and the two callers ask OPPOSITE
 * questions on purpose, because being wrong costs them different things:
 *
 *  - the keryx rule asks "is this word known NOT to execute?" — an unlisted word
 *    is treated as a wrapper, so a missing entry over-refuses one pattern
 *    (`ionice k*` was live because `ionice` was not a known wrapper);
 *  - the open-wildcard rule asks "is this word a known wrapper?" — because there
 *    an unlisted word means every ordinary bare grant is refused, and `hostname *`
 *    and `myapp2 *` are exactly what the file has always kept.
 */
function programPositions(tokens: readonly string[], executes: (word: string) => boolean): ReadonlySet<number> {
  const positions = new Set<number>([0]);
  // Leading `VAR=value` tokens are neither the program nor a flag — they are the
  // environment the program runs in. Anchoring at token 0 regardless let
  // `LC_ALL=C bash *` through: `LC_ALL=C` is no known wrapper, so the chain never
  // started and `bash` at index 1 was never reached.
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start] ?? "")) {
    positions.add(start + 1);
    start += 1;
  }
  const first = normalizeCommandWord(tokens[start] ?? "");
  if (first.length === 0 || !executes(first)) {
    return positions;
  }
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    // A flag is a `-` followed by a NAME. `-tf*` names a flag and is skipped, so
    // `tar -tf*` keeps working; `-*` names nothing and is not skipped, so
    // `timeout 5 -*` cannot reach `timeout 5 -k 1 /bin/sh` unexamined.
    const wildcardAt = token.search(/[*?]/);
    const literal = wildcardAt === -1 ? token : token.slice(0, wildcardAt);
    const isFlag = literal.length > 1 && literal.startsWith("-");
    // A bare-number skip used to sit beside the flag skip. A mutation run showed
    // it was pinned by nothing, and it turned out redundant: a number is not an
    // inert subcommand, so the continue-branch below carries the chain past it
    // for the same result. Deleted rather than left reading like a guard — the
    // fifth such branch removed from this file.
    if (isFlag) {
      continue;
    }
    positions.add(index);
    // The chain continues only while the program it just named ALSO executes
    // what follows it. `env sh *` needs it — one hop stopped at `sh`, and `sh`
    // is an interpreter, so the `*` was still the program. `docker ps *` and
    // `git log *` stop here, because `ps` and `log` are subcommands and the glob
    // behind them is an argument.
    //
    // `.` and `..` never continue it: at index ≥ 1 they are paths, whatever `.`
    // means to a shell at index 0. Without that, `find . -name k*` was refused.
    const word = normalizeCommandWord(token);
    if (word === "." || word === ".." || hasWildcard(token)) {
      return positions;
    }
    // Past the first program word the question flips, and this is the asymmetry
    // a review found by aiming at SUBCOMMANDS rather than wrappers. Asking "is
    // this a known wrapper?" here stopped the chain at `run`, so `npm run *`,
    // `docker run *`, `cargo run *`, `aws s3 cp *` and `git submodule foreach *`
    // were all offerable — and `npm run *` grants execution of anything in a
    // package.json the agent can write.
    //
    // So a subcommand is assumed to execute unless it is known inert. Being
    // wrong about an inert word costs one refused pattern; being wrong about an
    // executing one was the bypass.
    if (index > start && !INERT_SUBCOMMANDS.has(word)) {
      continue;
    }
    if (!executes(word)) {
      return positions;
    }
  }
  return positions;
}

/**
 * Subcommands that report rather than run, so a glob behind one is an argument.
 *
 * Small on purpose and inverted like {@link NON_EXECUTING_PREFIXES}: a word
 * missing from here costs its user one refused pattern, while a word wrongly
 * added is a bypass. Everything in it is a read/report verb whose own job cannot
 * be to execute something else.
 */
const INERT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "ps", "ls", "log", "list", "status", "show", "diff", "version", "help",
  "get", "describe", "info", "view", "cat", "inspect", "history", "search",
  "outdated", "why", "tree", "blame", "branch", "tag", "remote",
  // `audit` was here and is not: `npm audit fix` is a mutating install whose own
  // help documents `--ignore-scripts` and `--foreground-scripts`, options that
  // exist because it runs package lifecycle scripts.
  //
  // Worth stating for whoever edits this next: inertness is a property of the
  // PROGRAM AND THE VERB TOGETHER, not of the verb. `ls`, `log`, `status`,
  // `list` and `ps` report in every CLI that has them. `get`, `view`, `search`
  // and `remote` report in some and act in others, and they are here on the
  // judgement that the CLIs this project meets treat them as reports. That
  // judgement is the thing to re-examine, not the spelling.
]);

/**
 * Wrappers that run their argument AS A PROGRAM, rather than taking a subcommand.
 *
 * The distinction matters for exactly one thing: whether the word after them is
 * the program the reader/mutator bans are about. `env cat *` is `cat *` with a
 * word in front — the argument is still whatever file the model names — while
 * `git diff *` is git's own diff, and its glob is a pathspec inside the repo.
 *
 * A subset of {@link PREFIX_BANNED}, and an expedient like it: a pass-through
 * nobody listed means a launder this rule does not catch. It is narrower than
 * the enclosing list on purpose, because being wrong here refuses `git diff *`.
 */
const PASSTHROUGH_WRAPPERS: ReadonlySet<string> = new Set([
  "env", "nice", "ionice", "timeout", "nohup", "setsid", "stdbuf", "taskset",
  "chrt", "numactl", "setarch", "eatmydata", "fakeroot", "unbuffer", "xargs",
  "command", "sudo", "doas", "su", "runuser", "setpriv", "proxychains",
  "torsocks", "firejail", "bwrap", "valgrind", "script", "watch", "time",
  "flock", "unshare", "ssh-agent", "dbus-run-session", "systemd-inhibit",
  "xvfb-run", "exec", "strace", "ltrace",
]);

/**
 * A broad-reader or broad-mutator grant with a pass-through wrapper in front.
 *
 * `cat *` is refused — it is an arbitrary-secret-read channel into the model
 * transcript, which is the finding this file's reader list exists for. `env cat
 * *` was not, and it reads the same files. The reader and mutator lists were
 * consulted only at token 0, so one word in front laundered them.
 *
 * The classification that let it through was not wrong: after `env`, the chain
 * stops at `cat` — an inert word — and the trailing `*` really is an argument TO
 * `cat`. The inference was wrong. For a reader, the argument is the secret, and
 * that is precisely why `cat *` is banned at token 0.
 *
 * Only {@link PASSTHROUGH_WRAPPERS} count, so `git diff *` keeps working: its
 * glob is a pathspec inside the repository, not a filename for `diff(1)`.
 *
 * Introduced as a round-7 regression and half-closed by round 8 — `env grep *`
 * came back under control because `grep` is not inert, while `env cat *` did not
 * because `cat` is. Leaving that would have left the file refusing one threat in
 * two places and permitting it in a third.
 */
function launderedBroadGrant(pattern: string): string | undefined {
  const tokens = pattern.split(/\s+/);
  for (const [index, token] of tokens.entries()) {
    if (index === 0) {
      continue; // token 0 is bannedPrefixGrant's job
    }
    const before = tokens.slice(0, index);
    const allPassThrough = before.every((earlier) => {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(earlier)) {
        return true; // an environment assignment passes through by definition
      }
      const word = normalizeCommandWord(earlier);
      return PASSTHROUGH_WRAPPERS.has(word) || /^-/.test(earlier) || /^\d+$/.test(earlier);
    });
    if (!allPassThrough) {
      return undefined; // a subcommand intervened; this token is not the program
    }
    const word = normalizeCommandWord(token);
    const rest = tokens.slice(index + 1).join(" ");
    if (!restIsUnconstraining(rest) || rest.length === 0) {
      continue;
    }
    if (PREFIX_BANNED_READERS.has(word)) {
      return (
        `\`${pattern}\` is \`${word} *\` with a wrapper in front, and \`${word} *\` would auto-approve ` +
        "reading any file, including secrets outside the project. A word before it changes nothing about " +
        "which file gets read"
      );
    }
    if (PREFIX_BANNED_MUTATORS.has(word)) {
      return (
        `\`${pattern}\` is \`${word} *\` with a wrapper in front, and \`${word} *\` would auto-approve ` +
        "modifying or deleting any path in the working directory"
      );
    }
  }
  return undefined;
}

/**
 * A wildcard that OPENS the last token, behind a word that runs what follows it.
 *
 * `timeout 5 *` and `env *x` are not bare grants — their remainder holds a
 * literal, so the bare-grant gate lets them through — and they grant arbitrary
 * execution anyway, because the wrapper runs whatever the wildcard turns out to
 * be. Found by widening the sweep alphabet with wrapper words: a class the
 * previous alphabet could not express, and therefore one it reported zero of.
 *
 * The literal PREFIX decides, so `bun test*` and `timeout 5 bun test*` are kept
 * exactly as they always have been — they pin the program after the wrapper.
 *
 * Runs after the shape rule and the word lists, so a pattern that is refused for
 * what its FIRST token is keeps saying so; this is the diagnosis for the case
 * where the first token is fine and the last one names nothing.
 */
function openWildcardBehindWrapper(pattern: string): string | undefined {
  const tokens = pattern.split(/\s+/);
  const lastIndex = tokens.length - 1;
  const last = tokens[lastIndex] ?? "";
  // Known-wrapper gate: an unlisted word here would refuse every ordinary bare
  // grant, `hostname *` included.
  if (lastIndex === 0 || !programPositions(tokens, (word) => PREFIX_BANNED.has(word)).has(lastIndex)) {
    return undefined;
  }
  // The literal PREFIX decides, not the first character. Looking only at
  // position 0 meant one literal character skipped the rule while the token
  // still named no program: `env /b*` reached `/bin/sh`, and `timeout 5 .*`,
  // `timeout 5 -*` and `env ~*` did the same with `.`, `-` and `~`.
  const wildcardAt = last.search(/[*?]/);
  if (wildcardAt === -1) {
    return undefined;
  }
  const literal = last.slice(0, wildcardAt);
  if (/^[A-Za-z0-9_+]/.test(literal) && !literal.includes("/")) {
    return undefined; // `bun test*` — the program after the wrapper is named
  }
  // A `/` before the wildcard leaves the program unpinned however alphabetic the
  // prefix looks: `env /b*` reaches `/bin/sh`, and `env a/*` reaches anything in
  // `a/`. A path plus a glob is a directory, not a program.
  return (
    `\`${last}\` names no program, and \`${pattern}\` puts it behind a word that runs what follows ` +
    "it — so the pattern grants whatever the wildcard turns out to be. Pin the first word after the " +
    "wrapper (`bun test*`, `timeout 5 bun test*`)"
  );
}

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
  // Inverted gate: an unlisted word is assumed to execute, so a wrapper nobody
  // wrote down costs one over-refused pattern rather than opening a hole.
  const positions = programPositions(tokens, (word) => !NON_EXECUTING_PREFIXES.has(word));
  for (const [position, token] of tokens.entries()) {
    if (!couldNameKeryx(token, position, positions)) {
      continue;
    }
    if (hasWildcard(token)) {
      return (
        `\`${token}\` sits where \`${pattern}\` names a program to run, and a wildcard there can be ` +
        "`keryx`, which reaches `keryx ctx run -- <any command>`. A program name that is partly a glob " +
        "names nothing. " +
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
 * Whether `token` names keryx, given the literal tokens that precede it.
 *
 * Two questions, because a previous round answered only one of them at a time
 * and each answer reopened the other:
 *
 *  - **Does it say `keryx`?** Plain equality on the normalised word. At index 0
 *    that is enough, because the positional rule has already refused every first
 *    token carrying a wildcard.
 *  - **Could it BE `keryx` without saying so?** `env k*` is the case: the
 *    positional rule permits a wildcard in the LAST token, and a keryx token can
 *    sit there when something precedes it. So for a token that is not first, the
 *    literal-run test is applied as well — but only when the tokens before it can
 *    execute what follows them, which is what makes the position a program
 *    position at all.
 *
 * That gate is {@link PREFIX_BANNED}, reused deliberately: it is already the
 * list of words whose first token says nothing about what runs, already declared
 * an expedient, and using it here narrows what may be REMEMBERED rather than
 * claiming a boundary.
 *
 * The cost, stated rather than discovered: `git add k*` is refused, because
 * `git` can execute its arguments and nothing here knows that `add` neutralises
 * it. `ls k*`, `echo k*`, `cat keryx.log*` and `ls keryx*` are all offerable —
 * an earlier version refused those too, and told the user that `k*` "names
 * keryx", which is buying safety by taking away ordinary grants.
 */
function couldNameKeryx(token: string, index: number, positions: ReadonlySet<number>): boolean {
  if (!positions.has(index)) {
    // An argument, not a program. `ls keryx*` lists files; it does not run keryx,
    // and neither does `cat keryx.log*`. The position question comes FIRST: asking
    // it second let the equality branch refuse `ls keryx*` on its own.
    return false;
  }
  // An explicit equality branch used to sit here. A mutation run showed it was
  // pinned by NOTHING, and it turned out to be fully shadowed: the literal-run
  // test below already matches an exact `keryx`, because a wildcard-free token is
  // one run and `"keryx".startsWith("keryx")` is true. Deleted rather than left
  // to read like a guard — the fourth such branch on this file.
  return token
    .split(/[*?]+/)
    .filter((run) => run.length > 0)
    .some((run) => {
      const bare = (run.split("/").pop() ?? "").toLowerCase();
      // `bare.length > 0` matters: without it a run ending in `/` normalises to
      // the empty string, `"keryx".startsWith("")` is true, and `env /*` was
      // refused for "naming keryx" — a true refusal with a false reason, and the
      // only thing refusing that shape.
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
      // The pattern ends before the verb does. Everything scanned so far was a
      // wildcard-free literal (the loop returns at the first wildcard), and the
      // positional rule guarantees no earlier token carried one, so this pattern
      // is a fixed string shorter than the command it would have to match.
      //
      // A previous version consulted the preceding token here. That branch was
      // provably constant — a mutation run failed zero tests — which is what a
      // guard that guards nothing looks like.
      return true;
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
  // A wildcard in the first token used to be refused here, with its own message.
  // `wildcardOutOfPosition` now refuses every such pattern earlier and for a
  // stronger reason, so the branch became unreachable — and an unreachable guard
  // that still reads like one is exactly what a mutation run keeps finding on
  // this file. Deleted rather than left to look load-bearing.
  //
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
