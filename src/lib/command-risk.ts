// Command risk classification for the interactive agent's shell gate (flow 115).
//
// WHAT THIS IS FOR
// ----------------
// `shell_exec` carries a single static `risk: "shell"`, so the policy engine and
// the approval UI cannot tell `ls` from `rm -rf /`. This module adds the missing
// per-COMMAND dimension: a pure, deterministic classifier that marks a command
// as `destructive` so the gate can ESCALATE the confirmation.
//
// WHAT THIS IS NOT
// ----------------
// It is NOT a security boundary and it MUST NOT be used to block a command.
// Any list of dangerous commands is incomplete by construction — a shell has
// unbounded ways to express the same destruction, and treating an "it passed the
// classifier" result as "this command is safe" would create exactly the false
// confidence this module is meant to avoid. See
// docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md.
//
// The real boundaries are, in order:
//   1. the human approval gate (default-deny),
//   2. the metacharacter restriction on allowlist patterns (shell-permissions.ts),
//   3. OS containment when enabled (KERYX_SANDBOX_SHELL).
//
// This classifier only decides how LOUDLY to ask.
//
// Determinism: pure string analysis. No clock, RNG, filesystem, env, or network.

import { optionValues } from "./args";
import { commandWord, splitSegments, splitWords, stripAssignments, structuralCommands } from "./shell-syntax";
import type { Segment } from "./shell-syntax";

/** Risk class of a concrete command string. */
export type CommandRiskClass = "shell" | "destructive";

/** Basename of the command word: `/usr/bin/rm` → `rm`. */
function head(words: readonly string[]): string {
  return commandWord(words);
}

/** Positional (non-flag) arguments of a segment, command word excluded. */
function positionals(words: readonly string[]): string[] {
  return stripAssignments(words)
    .slice(1)
    .filter((w) => !w.startsWith("-"));
}

/** All arguments (flags included), command word excluded. */
function args(words: readonly string[]): string[] {
  return stripAssignments(words).slice(1);
}

/**
 * Paths whose recursive destruction is categorically different from deleting a
 * project directory. Matched EXACTLY (after trimming a trailing `/` or `/*`), so
 * `/var/folders/xyz` — a legitimate temp path — does not match `/var`.
 */
const CATASTROPHIC_TARGETS: ReadonlySet<string> = new Set([
  "/",
  ".",
  "~",
  "$home",
  "${home}",
  "/etc",
  "/usr",
  "/var",
  "/bin",
  "/sbin",
  "/lib",
  "/boot",
  "/opt",
  "/home",
  "/root",
  "/users",
  "/system",
  "/library",
  "/applications",
]);

/** True when an argument denotes the filesystem root, home, or a system root. */
function isCatastrophicTarget(arg: string): boolean {
  let t = arg.trim().toLowerCase();
  if (t.length === 0) return false;
  t = t.replace(/\/\*+$/, "").replace(/\/+$/, "");
  if (t.length === 0) t = "/"; // the trailing-slash trim ate a bare "/"
  return CATASTROPHIC_TARGETS.has(t);
}

const RECURSIVE_FLAG = /^-(?:[a-z]*r[a-z]*)$|^--recursive$/i;

function hasRecursive(words: readonly string[]): boolean {
  return args(words).some((a) => RECURSIVE_FLAG.test(a));
}

/** Privilege-escalating command words. */
const PRIVILEGE: ReadonlySet<string> = new Set(["sudo", "doas", "su", "pkexec", "runas"]);

/** Command words that execute arbitrary script from stdin. */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "ksh", "dash", "fish",
  "python", "python2", "python3", "perl", "ruby", "node", "bun", "deno", "php", "lua",
]);

/** Command words that fetch remote content. */
const DOWNLOADERS: ReadonlySet<string> = new Set(["curl", "wget", "fetch", "aria2c", "httpie", "http"]);

/** Container runtimes whose flags can hand out the host. */
const CONTAINER_RUNTIMES: ReadonlySet<string> = new Set(["docker", "podman", "nerdctl"]);

/** Branches where a force push destroys shared history. */
const PROTECTED_BRANCHES: readonly string[] = ["main", "master", "develop", "development", "trunk"];

/** Block-device path (`/dev/sda`, `/dev/nvme0n1`, `/dev/disk2`), not `/dev/null`. */
const BLOCK_DEVICE = /\/dev\/(?:sd[a-z]|nvme\d|disk\d|hd[a-z]|vd[a-z]|mmcblk\d)/i;

/** Everything a rule needs about one simple command. */
interface SegmentView {
  /** Raw segment text (for rules that must see redirects). */
  raw: string;
  /** Lowercased basename of the command word. */
  cmd: string;
  /** Arguments including flags. */
  args: string[];
  /** Positional (non-flag) arguments. */
  positionals: string[];
  /** Original words, for flag helpers. */
  words: readonly string[];
  /**
   * This segment or an earlier one on the line assigns a variable that moves git's config (`HOME=/x; git push`,
   * `export XDG_CONFIG_HOME=/x && git push`, `env GIT_DIR=/x git push`).
   */
  configRelocated?: boolean;
}

/**
 * One destructive-command rule. Rules are independent and ORed: each names a
 * single category, so a reader can check them one at a time and a new category
 * is added without touching the others.
 */
type Rule = (v: SegmentView) => boolean;

/** Privilege escalation is escalated whatever it runs. */
const rulePrivilege: Rule = (v) => PRIVILEGE.has(v.cmd);

/** Writing onto a raw block device via a redirect. */
const ruleBlockDeviceRedirect: Rule = (v) =>
  BLOCK_DEVICE.test(v.raw) && /(?:^|\s)(?:>|>>)\s*\/dev\//.test(v.raw);

/** Recursive delete of the filesystem root, home, or a system root. */
const ruleRm: Rule = (v) => v.cmd === "rm" && v.positionals.some(isCatastrophicTarget);

/** `dd` writing onto a block device. */
const ruleDd: Rule = (v) => v.cmd === "dd" && v.args.some((x) => /^of=/i.test(x) && BLOCK_DEVICE.test(x));

/** Recursive ownership/permission change of a system root. */
const rulePermissionSweep: Rule = (v) =>
  (v.cmd === "chmod" || v.cmd === "chown" || v.cmd === "chgrp") &&
  hasRecursive(v.words) &&
  v.positionals.some(isCatastrophicTarget);

/** Host power state. */
const ruleHostState: Rule = (v) => {
  if (v.cmd === "shutdown" || v.cmd === "reboot" || v.cmd === "halt" || v.cmd === "poweroff") return true;
  return v.cmd === "init" && v.positionals.some((p) => p === "0" || p === "6");
};

/** Formatting a filesystem. */
const ruleMkfs: Rule = (v) => v.cmd === "mkfs" || v.cmd.startsWith("mkfs.");

/**
 * Container flags that hand over the host. With a reachable daemon these are
 * equivalent to root, and they bypass every OS-containment layer above.
 */
const ruleContainerEscape: Rule = (v) => {
  if (!CONTAINER_RUNTIMES.has(v.cmd)) return false;
  const joined = ` ${v.args.join(" ")}`;
  return (
    /--privileged\b/.test(joined) ||
    /--pid[= ]host\b/.test(joined) ||
    /--(?:userns|ipc|uts|network|net)[= ]host\b/.test(joined) ||
    /docker\.sock/.test(joined) ||
    /(?:^|\s)(?:-v|--volume)[= ]\/:/.test(joined) ||
    /source=\/(?:,|\s|$)/.test(joined)
  );
};

/** git's own options (before the subcommand, git.c `handle_options`) that take the next word as their value. */
const GIT_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source",
]);
/** git's own options that take no value; `--exec-path` and `--list-cmds` take one only glued with `=`. */
const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "-p", "--paginate", "-P", "--no-pager", "--no-replace-objects", "--bare", "--literal-pathspecs", "--glob-pathspecs",
  "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-lazy-fetch", "--no-advice", "--html-path",
  "--man-path", "--info-path", "--exec-path", "--list-cmds", "-v", "--version", "-h", "--help",
]);

/**
 * git's own command names: `git --list-cmds=main` of git 2.51 (the builtins plus the commands in its exec-path), with
 * a few builtins older releases had. git runs one of these before it looks up an alias (git.c `run_argv`), so an
 * `alias.<name>` that shadows one is ignored (git-config(1) `alias.*`). A builtin a newer git adds and this list lacks
 * is read through its alias: if the alias names `push`, the line is classified as a push (a false positive); every
 * command a rule here keys on (`push`, `config`, `remote`) is listed.
 */
const GIT_COMMANDS: ReadonlySet<string> = new Set([
  "add", "am", "annotate", "apply", "archimport", "archive", "backfill", "bisect", "blame", "branch", "bugreport",
  "bundle", "cat-file", "check-attr", "check-ignore", "check-mailmap", "check-ref-format", "checkout", "checkout--worker",
  "checkout-index", "cherry", "cherry-pick", "clean", "clone", "column", "commit", "commit-graph", "commit-tree", "config",
  "count-objects", "credential", "credential-cache", "credential-cache--daemon", "credential-netrc", "credential-osxkeychain",
  "credential-store", "cvsexportcommit", "cvsimport", "cvsserver", "daemon", "describe", "diagnose", "diff", "diff-files",
  "diff-index", "diff-pairs", "diff-tree", "difftool", "difftool--helper", "env--helper", "fast-export", "fast-import",
  "fetch", "fetch-pack", "filter-branch", "fmt-merge-msg", "for-each-ref", "for-each-repo", "format-patch", "fsck",
  "fsck-objects", "fsmonitor--daemon", "gc", "get-tar-commit-id", "grep", "hash-object", "help", "hook", "http-backend",
  "http-fetch", "http-push", "imap-send", "index-pack", "init", "init-db", "instaweb", "interpret-trailers", "log",
  "ls-files", "ls-remote", "ls-tree", "mailinfo", "mailsplit", "maintenance", "merge", "merge-base", "merge-file",
  "merge-index", "merge-octopus", "merge-one-file", "merge-ours", "merge-recursive", "merge-recursive-ours",
  "merge-recursive-theirs", "merge-resolve", "merge-subtree", "merge-tree", "mergetool", "mktag", "mktree",
  "multi-pack-index", "mv", "name-rev", "notes", "p4", "pack-objects", "pack-redundant", "pack-refs", "patch-id",
  "pickaxe", "prune", "prune-packed", "pull", "push", "quiltimport", "range-diff", "read-tree", "rebase",
  "rebase--interactive", "receive-pack", "reflog", "refs", "remote", "remote-ext", "remote-fd", "remote-ftp",
  "remote-ftps", "remote-http", "remote-https", "repack", "replace", "replay", "request-pull", "rerere", "reset",
  "restore", "rev-list", "rev-parse", "revert", "rm", "send-email", "send-pack", "serve", "sh-i18n--envsubst", "shell",
  "shortlog", "show", "show-branch", "show-index", "show-ref", "sparse-checkout", "stage", "stash", "status",
  "stripspace", "submodule", "submodule--helper", "subtree", "switch", "symbolic-ref", "tag", "unpack-file",
  "unpack-objects", "update-index", "update-ref", "update-server-info", "upload-archive", "upload-archive--writer",
  "upload-pack", "var", "verify-commit", "verify-pack", "verify-tag", "version", "web--browse", "whatchanged", "worktree",
  "write-tree",
]);

/**
 * Environment variables that move where git reads its config from (the repository, the global or system file, or
 * `GIT_CONFIG_*` entries): with one set, a `git push` may carry a refspec, a mirror or an alias the line does not show.
 * A leading `(` or `{` is a subshell or group opener in front of the assignment.
 */
const GIT_CONFIG_SOURCE_ASSIGNMENT = /^[({]*(?:HOME|XDG_CONFIG_HOME|GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE|GIT_CONFIG\w*)=/i;

/** git's own options that point it at a repository (and so a config file) other than the one the shell is in. */
const GIT_REPOSITORY_OPTIONS: ReadonlySet<string> = new Set(["--git-dir", "--work-tree"]);

/** One `-c key=value` (or `--config-env key=ENV`, whose value the classifier cannot see). */
interface GitConfigEntry {
  key: string;
  value: string | undefined;
  opaque: boolean;
}

/** A git invocation with git's own options and `-c` aliases resolved: the subcommand and its arguments. */
interface GitInvocation {
  /** The subcommand, or undefined when there is none or it cannot be known (an expansion, an unresolvable alias). */
  sub: string | undefined;
  args: string[];
  config: GitConfigEntry[];
  /** The subcommand is a word the shell or a `-c alias.*` still has to produce: what runs is unknown. */
  opaqueSub: boolean;
  /** An option before the subcommand that git's table does not list: where the subcommand starts is unknown. */
  unknownGlobal: boolean;
  /**
   * git reads config the line does not show: a `HOME=`, `XDG_CONFIG_HOME=`, `GIT_DIR=` or `GIT_CONFIG_*` assignment in
   * front of the command, or `--git-dir`/`--work-tree`. Any config, push refspecs, mirror and aliases included, may be set.
   */
  envConfig: boolean;
  /** A `-c alias.<sub>=!…` shell alias: the shell text it runs. */
  shellAlias?: string;
}

function gitConfigEntry(spec: string, fromEnv: boolean): GitConfigEntry {
  const eq = spec.indexOf("=");
  return { key: (eq < 0 ? spec : spec.slice(0, eq)).toLowerCase(), value: eq < 0 ? undefined : spec.slice(eq + 1), opaque: fromEnv || wordIsOpaque(spec) };
}

/**
 * Parse `[VAR=… ] git [global options] <sub> <args…>`, expanding a `-c alias.<sub>=…` the way git does: only for a
 * name that is not one of git's own commands, which git runs before it looks at aliases. Pure.
 */
function parseGitInvocation(input: readonly string[]): GitInvocation {
  const bare = stripAssignments(input);
  let envConfig = input.slice(0, input.length - bare.length).some((w) => GIT_CONFIG_SOURCE_ASSIGNMENT.test(w));
  const words = bare.map(unescapeWord);
  const config: GitConfigEntry[] = [];
  let unknownGlobal = false;
  let i = 1;
  for (; i < words.length; i += 1) {
    const w = words[i]!;
    if (!w.startsWith("-")) break;
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    const name = eq > 0 ? w.slice(0, eq) : w;
    if (GIT_GLOBAL_VALUE_OPTIONS.has(name)) {
      if (GIT_REPOSITORY_OPTIONS.has(name)) envConfig = true;
      const value = eq > 0 ? w.slice(eq + 1) : words[++i];
      if (name === "-c" || name === "--config-env") config.push(gitConfigEntry(value ?? "", name === "--config-env"));
      continue;
    }
    if (!GIT_GLOBAL_FLAGS.has(name)) unknownGlobal = true;
  }
  let rest = words.slice(i);
  const invocation = (sub: string | undefined, opaqueSub: boolean, shellAlias?: string): GitInvocation => ({
    sub, args: rest.slice(1), config, opaqueSub, unknownGlobal, envConfig, ...(shellAlias !== undefined ? { shellAlias } : {}),
  });
  for (let guard = 0; guard < 8 && rest.length > 0; guard += 1) {
    const head = rest[0]!;
    if (wordIsOpaque(head)) return invocation(undefined, true);
    // git's own command runs whatever alias shadows it; a case variant (`PUSH`) is read as the command, failing closed.
    if (GIT_COMMANDS.has(head.toLowerCase())) return invocation(head.toLowerCase(), false);
    const alias = [...config].reverse().find((c) => c.key === `alias.${head.toLowerCase()}`);
    if (alias === undefined) return invocation(head, false);
    if (alias.opaque || alias.value === undefined) return invocation(undefined, true);
    if (alias.value.trimStart().startsWith("!")) return invocation(undefined, true, [alias.value.trimStart().slice(1), ...rest.slice(1)].join(" "));
    const expanded = splitWords(alias.value);
    // git refuses an alias that starts with an option; one that does is not classified.
    if (expanded.length === 0 || expanded[0]!.startsWith("-")) return invocation(undefined, true);
    rest = [...expanded, ...rest.slice(1)];
  }
  return invocation(undefined, rest.length > 0);
}

/** How a `git push` long option takes a value: never, as the next word or glued (`value`), or only glued (`optional`). */
type PushOptionKind = "flag" | "value" | "optional";
/** `git push`'s option table (builtin/push.c, as `git push -h` lists it in git 2.51). */
const PUSH_LONG_OPTIONS: ReadonlyMap<string, PushOptionKind> = new Map<string, PushOptionKind>([
  ["verbose", "flag"], ["quiet", "flag"], ["repo", "value"], ["all", "flag"], ["branches", "flag"], ["mirror", "flag"],
  ["delete", "flag"], ["tags", "flag"], ["dry-run", "flag"], ["porcelain", "flag"], ["force", "flag"],
  ["force-with-lease", "optional"], ["force-if-includes", "flag"], ["recurse-submodules", "value"], ["thin", "flag"],
  ["receive-pack", "value"], ["exec", "value"], ["set-upstream", "flag"], ["progress", "flag"], ["prune", "flag"],
  ["no-verify", "flag"], ["verify", "flag"], ["follow-tags", "flag"], ["signed", "optional"], ["atomic", "flag"],
  ["push-option", "value"], ["ipv4", "flag"], ["ipv6", "flag"],
]);
const PUSH_SHORT_FLAGS: ReadonlySet<string> = new Set(["v", "q", "d", "n", "f", "u", "4", "6"]);

/** The long option a `--name` spelling selects: the exact name, or the one option it is an unambiguous prefix of. */
function resolvePushOption(name: string): string | undefined {
  if (PUSH_LONG_OPTIONS.has(name)) return name;
  const candidates = [...PUSH_LONG_OPTIONS.keys()].filter((option) => option.startsWith(name));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** What a `git push` command line asks git to do, read the way git's parse-options reads it. */
interface PushRequest {
  force: boolean;
  del: boolean;
  mirror: boolean;
  all: boolean;
  prune: boolean;
  /** An option git does not list, or an ambiguous abbreviation: the line cannot be classified. */
  unknown: boolean;
  /** Positional words: the repository, then the refspecs. */
  positionals: string[];
}

function parsePushArgs(args: readonly string[]): PushRequest {
  const request: PushRequest = { force: false, del: false, mirror: false, all: false, prune: false, unknown: false, positionals: [] };
  const set = (option: string): void => {
    if (option === "force" || option === "force-with-lease" || option === "force-if-includes") request.force = true;
    else if (option === "delete") request.del = true;
    else if (option === "mirror") request.mirror = true;
    else if (option === "all" || option === "branches") request.all = true;
    else if (option === "prune") request.prune = true;
  };
  let options = true;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i]!;
    if (!options || w === "-" || !w.startsWith("-")) {
      request.positionals.push(w);
      continue;
    }
    if (w === "--") {
      options = false;
      continue;
    }
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq > 0 ? w.slice(2, eq) : w.slice(2);
      // Every `--no-…` spelling (and `--n…`, which only abbreviates one) turns something off and takes no value.
      if (name.startsWith("n")) continue;
      const option = resolvePushOption(name);
      if (option === undefined) {
        request.unknown = true;
        continue;
      }
      if (PUSH_LONG_OPTIONS.get(option) === "value" && eq < 0) i += 1;
      set(option);
      continue;
    }
    // A short cluster (`-fu`); `-o` takes the rest of the cluster or the next word as its value.
    for (let at = 1; at < w.length; at += 1) {
      const ch = w[at]!;
      if (ch === "o") {
        if (at === w.length - 1) i += 1;
        break;
      }
      if (!PUSH_SHORT_FLAGS.has(ch)) {
        request.unknown = true;
        break;
      }
      if (ch === "f") request.force = true;
      if (ch === "d") request.del = true;
    }
  }
  return request;
}

/**
 * True when writing (or deleting) this destination ref could hit a protected branch: a protected name, a glob (`*`
 * reaches every branch), or no name at all (`HEAD`, `@`, empty: whatever is checked out).
 */
function isDangerousDestination(destination: string): boolean {
  const name = (destination.split("/").pop() ?? "").toLowerCase();
  return destination.includes("*") || PROTECTED_BRANCHES.includes(name) || name === "" || name === "head" || name === "@";
}

/** Does one refspec, under the line's `--force`/`--delete`, force-overwrite or delete a ref that may be protected? */
function refspecDestroys(spec: string, force: boolean, del: boolean): boolean {
  if (wordIsOpaque(spec)) return true;
  const plus = spec.startsWith("+");
  const body = plus ? spec.slice(1) : spec;
  // `--delete` takes plain ref names: each one is deleted.
  if (del) return isDangerousDestination(body);
  // `:` alone is the matching push: every branch the remote also has, main included; forced, it overwrites them.
  if (body === ":") return force || plus;
  const deletes = body.startsWith(":");
  if (!(force || plus || deletes)) return false;
  const destination = body.slice(body.lastIndexOf(":") + 1);
  if (deletes && destination !== "" && !destination.includes("*")) {
    return PROTECTED_BRANCHES.includes((destination.split("/").pop() ?? "").toLowerCase());
  }
  return isDangerousDestination(destination);
}

/** Config keys that make a `git push` force-write or mirror without a word on its command line. */
const PUSH_SHAPING_KEY = /^remote\..+\.(push|mirror)$/;

/** git's boolean reading of a config value: a key with no value is true. */
function isConfigTrue(value: string | undefined): boolean {
  return value === undefined || !/^(?:false|no|off|0|)$/i.test(value.trim());
}

/** Config keys that pull in another config file (`include.path`, `includeIf.<condition>.path`), which the classifier cannot read. */
const CONFIG_INCLUDE_KEY = /^include(?:if\..*)?\.path$/;

/**
 * Does setting this config key to this value make a push force-write, delete or mirror a protected branch? An include
 * is a file the classifier cannot read, so it may set anything.
 */
function configArmsPush(entry: GitConfigEntry): boolean {
  if (CONFIG_INCLUDE_KEY.test(entry.key)) return true;
  const match = PUSH_SHAPING_KEY.exec(entry.key);
  if (match === null) return false;
  if (entry.opaque) return true;
  return match[1] === "mirror" ? isConfigTrue(entry.value) : refspecDestroys(entry.value ?? "", false, false);
}

/**
 * Does WRITING this entry (`git config …`) arm a later command the classifier will not see as destructive? Everything
 * {@link configArmsPush} reads, plus an alias: one that runs `push` turns a later `git <alias>` into a push the line does
 * not name, and a `!` alias runs its shell text.
 */
function configWriteArmsPush(entry: GitConfigEntry): boolean {
  if (!entry.key.startsWith("alias.")) return configArmsPush(entry);
  if (entry.opaque || entry.value === undefined) return true;
  const value = entry.value.trimStart();
  return /\bpush\b/i.test(value) || (value.startsWith("!") && isDestructiveCommand(value.slice(1)));
}

/**
 * Force push, branch deletion or mirror against a protected branch, decided on a parse of the git command line:
 * git's own options and `-c` config (a `remote.<r>.push` refspec, `remote.<r>.mirror`, an `alias.*`), then `git
 * push`'s option table with git's unambiguous-prefix abbreviations (`--del`, `--mirr`) and value-taking options
 * (`-o ci.skip`, `--receive-pack X`, `--repo X`), then the repository and refspecs. A line that cannot be read with
 * confidence is destructive: an unknown or ambiguous option, an expansion the shell has yet to make, a subcommand
 * from an alias git would run through the shell, `GIT_CONFIG_*` in the environment. A forced push that names no
 * branch (only a remote, or `HEAD`) pushes the CURRENT branch, so its target is unknown and it asks.
 */
const ruleForcePush: Rule = (v) => {
  const words = gitWords(v);
  if (words === undefined) return false;
  const git = parseGitInvocation(words);
  if (git.shellAlias !== undefined) return isDestructiveCommand(git.shellAlias) || /\bpush\b/.test(git.shellAlias);
  if (git.opaqueSub) return true;
  if (git.unknownGlobal && positionals(words).includes("push")) return true;
  if (git.sub !== "push") return false;
  // Config from a source the line does not show (an include, another repository, a relocated global file).
  if (git.envConfig || v.configRelocated === true || git.args.some(wordIsOpaque) || git.config.some(configArmsPush)) return true;
  const push = parsePushArgs(git.args);
  if (push.unknown || push.mirror) return true;
  const refspecs = push.positionals.slice(1); // positionals[0] is the repository
  if (push.all && (push.force || push.prune)) return true;
  if (push.prune && (refspecs.length === 0 || refspecs.some((spec) => spec.includes("*")))) return true;
  if (refspecs.length === 0) return push.force;
  return refspecs.some((spec) => refspecDestroys(spec, push.force, push.del));
};

/**
 * Writing the config a later, plain `git push` reads: `git config remote.<r>.push '+refs/heads/*:refs/heads/*'`,
 * `git config remote.<r>.mirror true`, `git remote add --mirror[=push]`, `git config include.path <file>` (or
 * `includeIf.<cond>.path`), `git config alias.<x> 'push -f origin main'`. The push that follows names nothing forced,
 * so the arming step is where the classifier can still see it.
 */
const ruleArmsForcePush: Rule = (v) => {
  const words = gitWords(v);
  if (words === undefined) return false;
  const git = parseGitInvocation(words);
  if (git.sub === "remote") {
    if (git.args[0] !== "add") return false;
    return git.args.some((w) => {
      const [name = "", value] = w.split("=", 2);
      return name.length > 3 && "--mirror".startsWith(name) && value !== "fetch";
    });
  }
  if (git.sub !== "config") return false;
  const operands = git.args.filter((w) => !w.startsWith("-"));
  return operands.some((w, i) => i + 1 < operands.length && configWriteArmsPush(gitConfigEntry(`${w}=${operands[i + 1]!}`, false)));
};

/**
 * The words of a git command, behind the wrappers that run the rest of the line (`env HOME=/x git push`, `nohup git …`),
 * or undefined when the segment is not git. `sudo`/`doas` are destructive on their own.
 */
function gitWords(v: SegmentView): readonly string[] | undefined {
  if (v.cmd === "git") return v.words;
  if (!WRAPPER_COMMANDS.has(v.cmd)) return undefined;
  const peeled = peelWrappers(v.words);
  return peeled.inner === undefined && baseName(peeled.words[0]) === "git" ? peeled.words : undefined;
}

const RULES: readonly Rule[] = [
  rulePrivilege,
  ruleBlockDeviceRedirect,
  ruleRm,
  ruleDd,
  rulePermissionSweep,
  ruleHostState,
  ruleMkfs,
  ruleContainerEscape,
  ruleForcePush,
  ruleArmsForcePush,
];

/** Builtins whose arguments assign shell variables (`export HOME=/x`). */
const ASSIGNING_BUILTINS: ReadonlySet<string> = new Set(["export", "declare", "typeset", "readonly", "local"]);

/**
 * Does this simple command assign a variable that moves git's config, for itself or for the commands after it: a
 * leading `HOME=/x`, `export XDG_CONFIG_HOME=/x`, `env GIT_DIR=/x …`? An argument that merely reads like one
 * (`git commit -m "HOME=/x"`) does not count.
 */
function assignsGitConfigSource(words: readonly string[]): boolean {
  const bare = stripAssignments(words);
  // `bare[0]` too: an assignment behind a subshell or group opener (`(HOME=/x; git push)`) is not stripped.
  if (words.slice(0, words.length - bare.length + 1).some((w) => GIT_CONFIG_SOURCE_ASSIGNMENT.test(w))) return true;
  const cmd = commandWord(bare);
  if (!ASSIGNING_BUILTINS.has(cmd) && !WRAPPER_COMMANDS.has(cmd)) return false;
  return bare.slice(1).some((w) => GIT_CONFIG_SOURCE_ASSIGNMENT.test(w));
}

/** Classify ONE simple command: destructive when ANY rule matches. */
function classifySegment(seg: Segment, configRelocated: boolean): boolean {
  const view: SegmentView = {
    raw: seg.raw,
    cmd: head(seg.words),
    args: args(seg.words),
    positionals: positionals(seg.words),
    words: seg.words,
    configRelocated,
  };
  return RULES.some((rule) => rule(view));
}

/**
 * Classify a full command line. `destructive` when ANY simple command in the
 * chain is destructive, or when remote content is piped into an interpreter.
 * Pure and deterministic.
 */
export function classifyCommand(command: string): CommandRiskClass {
  if (command.trim().length === 0) return "shell";
  const segments = splitSegments(command);

  let configRelocated = false;
  for (const seg of segments) {
    configRelocated ||= assignsGitConfigSource(seg.words);
    if (classifySegment(seg, configRelocated)) return "destructive";
  }

  // Cross-segment: `curl … | sh`. Only a PIPE counts — `curl …; sh script.sh`
  // is two unrelated commands.
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.precededBy !== "|") continue;
    if (!INTERPRETERS.has(head(seg.words))) continue;
    const upstream = segments.slice(0, i);
    if (upstream.some((s) => DOWNLOADERS.has(head(s.words)))) return "destructive";
  }

  return "shell";
}

/** Boolean projection of {@link classifyCommand}. Pure. */
export function isDestructiveCommand(command: string): boolean {
  return classifyCommand(command) === "destructive";
}

/**
 * Files and directories that hold the agent's OWN permission and credential
 * state. A command that touches any of them can grant the agent new authority
 * (or read its keys), so it must never be auto-approved and never remembered.
 *
 * Matched on the command TEXT, not on a resolved path, because the resolution
 * happens inside `sh -c` where we cannot see it: `$HOME/.local/share/keryx`,
 * `~/.local/share/keryx`, and a `cd`-relative `permissions.json` must all be
 * caught. The file basenames alone are therefore enough to trigger.
 */
const CREDENTIAL_MARKERS: readonly string[] = [
  "permissions.json",
  "auth.json",
  ".local/share/keryx",
  ".config/keryx",
  // Flow 295 (F1/F3): the per-machine key that signs confirmed schedules, the
  // schedule store itself, and the OS scheduler's unit directories. Writing any
  // of them is how a confirmed schedule would be forged or widened, so they sit
  // with the agent's own credentials: always asked, never remembered.
  "schedule-hmac.key",
  "trigger/schedules.json",
  "systemd/user",
  "library/launchagents",
];

/**
 * Command words a publishing lease (specification §4.3 `git-publish` scope, §4.4)
 * must catch. Pure string analysis, same posture as the rest of this module:
 * incomplete by construction, meant to widen a prompt, never to grant one.
 */
function isGitPushSegment(v: SegmentView): boolean {
  return v.cmd === "git" && v.positionals.includes("push");
}

function isGhReleaseSegment(v: SegmentView): boolean {
  return v.cmd === "gh" && v.positionals.includes("release");
}

function isGhPrMergeSegment(v: SegmentView): boolean {
  return v.cmd === "gh" && v.positionals.includes("pr") && v.positionals.includes("merge");
}

function isNpmPublishSegment(v: SegmentView): boolean {
  return v.cmd === "npm" && v.positionals.includes("publish");
}

function isBunPublishSegment(v: SegmentView): boolean {
  return v.cmd === "bun" && v.positionals.includes("publish");
}

const PUBLISH_RULES: readonly Rule[] = [
  isGitPushSegment,
  isGhReleaseSegment,
  isGhPrMergeSegment,
  isNpmPublishSegment,
  isBunPublishSegment,
];

/**
 * True when `command` contains a segment that publishes something: `git push`
 * (any form, including `git -C <dir> push` and a `git tag … && git push …`
 * chain — each simple command in the chain is checked independently, exactly
 * like {@link classifyCommand}), `gh release`, `gh pr merge`, `npm publish` or
 * `bun publish`. `git pull`, `git status` and a quoted string that merely
 * mentions "git push" (e.g. `echo "git push"`, where the whole quoted text is
 * one argument to `echo`, never a command word) do not match. Pure and
 * deterministic; a sibling classifier to {@link isDestructiveCommand}, and,
 * like it, not a security boundary — it only decides when the publish-lease
 * floor (specification §4.4) escalates to a prompt.
 */
export function isPublishCommand(command: string): boolean {
  if (command.trim().length === 0) return false;
  const segments = splitSegments(command);
  return segments.some((seg) => {
    const view: SegmentView = {
      raw: seg.raw,
      cmd: head(seg.words),
      args: args(seg.words),
      positionals: positionals(seg.words),
      words: seg.words,
    };
    return PUBLISH_RULES.some((rule) => rule(view));
  });
}

/**
 * True when `command` mentions the agent's own permission/credential state.
 *
 * Deliberately over-broad: it matches the file name anywhere in the command,
 * including inside a quoted argument, and it does not care whether the command
 * reads or writes. A false positive costs one confirmation; a false negative
 * costs the approval gate itself, permanently and for every future session.
 *
 * This is the barrier that holds in the DEFAULT configuration, where OS
 * containment is off (ADR-0006) or unavailable. Pure.
 */
export function touchesAgentCredentials(command: string): boolean {
  return textSpellings(command).some((text) => CREDENTIAL_MARKERS.some((marker) => text.includes(marker)));
}

/**
 * The command text as written and with its shell quoting resolved (`.config/ke''ryx`, `auth\.json`, `$'\x61uth.json'`
 * collapse to the literal), lowercased, runs of whitespace folded to one space. A marker that is matched on text is
 * matched on both, so a spelling that changes the text without changing what runs is seen too.
 */
function textSpellings(command: string): string[] {
  return [command, collapseQuoting(joinContinuations(command))].map((text) => text.toLowerCase().replace(/\s+/g, " "));
}

/**
 * SAC's own proof that a human is present, not the agent (`review-confirm-
 * token.ts`): a proposal's `decision: "accepted"` requires a `confirmToken`
 * minted by running `keryx workspace confirm-review` as a real, approval-
 * gated shell command — deliberately never exposed as an agent-native tool
 * or MCP tool, specifically so that step cannot happen without a human
 * answering an approval prompt. That guarantee lives entirely in the prompt
 * actually firing; a permission mode that skips it for "just another
 * non-destructive shell command" defeats the whole mechanism as completely
 * as leaking a credential would.
 *
 * Matched broadly on the command family (`confirm-review` and `workspace
 * review`, which also covers the harmless reject/dismiss decisions) rather
 * than parsing out `--decision accepted` specifically — same "a false
 * positive costs one confirmation; a false negative costs the guarantee
 * itself" posture as {@link touchesAgentCredentials}, and parsing a shell
 * string for one specific flag value is exactly the kind of classification
 * ADR-0009 says this layer must not be trusted to do perfectly.
 */
const SAC_REVIEW_MARKERS: readonly string[] = ["confirm-review", "workspace review"];

/** True when `command` mentions SAC's proposal-review/confirm-token family. Pure. */
export function touchesSacConfirmReview(command: string): boolean {
  if (textSpellings(command).some((text) => SAC_REVIEW_MARKERS.some((marker) => text.includes(marker)))) return true;
  return parsedSacReview(command);
}

/**
 * Parsed-word net for {@link touchesSacConfirmReview}: a keryx command (through wrappers, `bash -c`, `eval`, a terminal
 * driver) whose words, once quoting and escapes are resolved, name `confirm-review` or `workspace … review`, or whose
 * `workspace` verb is a word the shell has yet to expand.
 */
function parsedSacReview(command: string): boolean {
  return anySimpleCommand(joinContinuations(command), (words) => {
    const args = keryxArgs(words);
    if (args === undefined) return false;
    const lower = args.map((w) => w.toLowerCase());
    if (lower[0] === "ctx" && lower[1] === "rg") return false;
    if (lower.includes("confirm-review")) return true;
    const workspace = lower.indexOf("workspace");
    if (workspace < 0) return false;
    const rest = args.slice(workspace + 1);
    return lower.slice(workspace + 1).includes("review") || (rest[0] !== undefined && wordIsOpaque(rest[0]));
  });
}

/**
 * The flow-completion counterpart of {@link SAC_REVIEW_MARKERS} (flow 299,
 * AC4). `keryx flow confirm` mints the token that a flow opted into the
 * confirmation gate needs before `flow complete` passes. Like `confirm-review`,
 * its whole value is that a person answers a prompt for it. `flow ac confirm`
 * does not match: its text is `flow ac confirm`, not `flow confirm`.
 *
 * Text-matched, with the same limit as the SAC markers: a spelling that avoids
 * the literal words (a variable, a script file, `bun -e`) is not caught. TM-03
 * states this. The floor is friction for a cooperating agent. It is not a
 * barrier against one working around it.
 */
const FLOW_CONFIRM_MARKER = /\bflow\s+confirm\b/i;

/**
 * True when `command` mentions `keryx flow confirm`. Pure. Word-bounded, so
 * `workflow confirmation` or `overflow confirmed` does not match. Accepted
 * false positive: a command that merely quotes the words, such as
 * `grep "flow confirm" docs`, still asks.
 */
export function touchesFlowConfirm(command: string): boolean {
  return FLOW_CONFIRM_MARKER.test(command);
}

/**
 * Flow 295 (F2): commands that create, change or run a scheduled background
 * task, or that drive the OS scheduler directly. A schedule runs unattended,
 * spends money and uses the operator's granted credentials, so it exists only
 * after the operator confirms a card (`keryx schedule add`, `/schedule`,
 * `schedule_create`). A `shell_exec` of `keryx schedule add … --yes`, or a
 * `systemctl --user enable` of a hand-written unit, would skip that card, so
 * this family gets the human-confirmation floor: every permission mode asks
 * (`auto` included), the answer is never remembered, and a pattern for it is refused.
 *
 * Matched on whole words (`\b`), not substrings: `reschedule add` is not a
 * match, while `bun run src/cli.ts schedule add` is. Over-broad in the other
 * direction on purpose (`echo "crontab"` asks), for the same reason as every
 * other marker here: a false positive costs one prompt, and a false negative
 * costs the confirmation.
 */
const SCHEDULER_CONTROL_PATTERNS: readonly RegExp[] = [
  /\bschedule\s+(?:add|remove|pause|resume|run)\b/,
  /\btrigger\s+(?:schedule|install)\b/,
  /\btrigger\s+run\b[^\n;&|]*--schedule\b/,
  /\bcrontab\b/,
  /\bsystemctl\b[^\n;&|]*\b(?:enable|reenable|link|start|restart|reload-or-restart|try-restart|daemon-reload|edit|disable|stop|mask|unmask|preset|revert|set-property|set-environment|import-environment)\b/,
  /\blaunchctl\b/,
  /\bloginctl\b/,
  /\bsystemd\/user\b/,
  /\blibrary\/launchagents\b/,
];

/** `systemctl` verbs that change what runs (install, start, reload or remove units). */
const SYSTEMCTL_CONTROL_VERBS: ReadonlySet<string> = new Set([
  "enable", "reenable", "link", "start", "restart", "reload-or-restart", "try-restart", "daemon-reload",
  "edit", "disable", "stop", "mask", "unmask", "preset", "revert", "set-property", "set-environment", "import-environment",
]);

/** `keryx schedule <verb>` verbs that create, change or run a schedule. */
const SCHEDULE_VERBS: ReadonlySet<string> = new Set(["add", "remove", "pause", "resume", "run"]);

/** Command words that run the rest of the line as another command. */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
  "env", "sudo", "doas", "nice", "nohup", "command", "exec", "time", "timeout", "stdbuf", "ionice", "setsid", "chrt", "caffeinate", "xargs", "builtin",
]);

/** Wrapper flags that consume the next word (`env -u NAME`, `sudo -u user`, `nice -n 5`, `env -C dir`). */
const WRAPPER_FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(["-u", "-g", "-n", "-C", "-p", "-U", "-h", "--unset", "--user", "--group", "--chdir", "-s", "-k", "-o", "-e", "-i0"]);

/** Shells whose `-c '<script>'` argument is another command line to inspect. */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "busybox"]);

/** Directories the OS scheduler reads units from; a write into one installs a timer. */
const UNIT_DIR_MARKERS: readonly string[] = ["systemd/user", "config/systemd", "launchagents"];

/** How keryx is named on a command line: the binary, or its entry script run by a JS runtime. */
const KERYX_ENTRY_NAMES: ReadonlySet<string> = new Set(["keryx", "cli.ts", "cli.js"]);
/** Runtimes that run keryx's entry script (`bun src/cli.ts shell`, `npx keryx shell`). */
const JS_RUNNERS: ReadonlySet<string> = new Set(["bun", "bunx", "node", "npx", "pnpx", "tsx", "deno"]);
/** Programs that give another program a terminal, so the caller can type into it. */
const TERMINAL_DRIVERS: ReadonlySet<string> = new Set(["script", "screen", "tmux", "unbuffer", "dtach", "abduco", "expect", "socat", "zpty"]);

function baseName(word: string | undefined): string {
  return ((word ?? "").split("/").pop() ?? "").toLowerCase();
}

/**
 * Flow 295 (M3b): does this simple command start an INTERACTIVE keryx — `keryx` with no
 * subcommand, or `keryx shell` in any interactive form? `keryx shell -p/--print` runs one
 * headless turn: it has no TUI, no `/schedule`, no `/schedules` and no schedule tools,
 * so it is not caught.
 */
function launchesInteractiveKeryx(words: readonly string[]): boolean {
  let at = 0;
  if (JS_RUNNERS.has(baseName(words[0]))) {
    at = words.findIndex((w, i) => i > 0 && !w.startsWith("-") && !["run", "x", "exec"].includes(w));
    if (at < 0) return false;
  }
  if (!KERYX_ENTRY_NAMES.has(baseName(words[at]))) return false;
  const after = words.slice(at + 1);
  const sub = after.find((w) => !w.startsWith("-"));
  if (sub === undefined) return !after.some((w) => w === "--help" || w === "-h" || w === "--version" || w === "-v");
  if (sub !== "shell") return false;
  return !after.some((w) => w === "-p" || w === "--print" || w.startsWith("--print="));
}

/**
 * M3b: a terminal driver (`script`, `screen`, `tmux`, `unbuffer`, …) that starts an
 * interactive keryx, or types into a running session (`tmux send-keys`, `screen -X stuff`).
 * An agent could otherwise drive a nested keryx TUI through a pseudo-terminal and answer
 * its `/schedule` card or press its `/schedules` keys itself.
 */
function drivesKeryxTerminal(words: readonly string[], depth: number): boolean {
  const cmd = baseName(words[0]);
  if (!TERMINAL_DRIVERS.has(cmd)) return false;
  const rest = words.slice(1);
  if (cmd === "tmux" && rest.some((w) => w === "send-keys" || w === "send" || w === "paste-buffer" || w === "pasteb")) return true;
  if (cmd === "screen" && rest.some((w, i) => w === "-X" && ["stuff", "paste", "eval"].includes((rest[i + 1] ?? "").toLowerCase()))) return true;
  // A command string argument (`script -qfc 'keryx shell' /dev/null`, `tmux new 'keryx'`).
  for (let i = 0; i < rest.length; i += 1) {
    const w = rest[i]!;
    const commandFlag = /^-[a-z]*c$/i.test(w) || w === "--command";
    const value = commandFlag ? rest[i + 1] : w.startsWith("--command=") ? w.slice("--command=".length) : /\s/.test(w) ? w : undefined;
    if (value !== undefined && depth < MAX_SHELL_NESTING && parsedSchedulerControl(value, depth + 1)) return true;
  }
  // The rest of the line as a program and its arguments (`screen keryx shell`, BSD
  // `script -q /dev/null keryx`, `unbuffer bun src/cli.ts shell`).
  for (let i = 1; i < words.length; i += 1) {
    if (launchesInteractiveKeryx(words.slice(i))) return true;
  }
  return false;
}

/** Remove backslash escapes a shell would drop (`sys\temctl` → `systemctl`). Quotes are already gone. */
function unescapeWord(word: string): string {
  return word.replace(/\\(.)/g, "$1");
}

/**
 * Peel wrappers off a word list (`env -u X VAR=1 sudo -u me nice -n 5 <cmd …>`), returning
 * the real command's words, or the inner script when the command is `sh|bash -c '<script>'`.
 */
function peelWrappers(input: readonly string[]): { words: string[]; inner?: string } {
  let words = stripAssignments(input.map(unescapeWord));
  for (let guard = 0; guard < 16 && words.length > 0; guard++) {
    const cmd = (words[0]!.split("/").pop() ?? "").toLowerCase();
    if (SHELLS.has(cmd)) {
      const at = words.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/i.test(w));
      const script = at > 0 ? words[at + 1] : undefined;
      if (script !== undefined) return { words, inner: script };
      return { words };
    }
    if (cmd === "eval") return { words, inner: words.slice(1).join(" ") };
    if (!WRAPPER_COMMANDS.has(cmd)) return { words };
    let i = 1;
    while (i < words.length) {
      const w = words[i]!;
      if (w === "--") {
        i++;
        break;
      }
      if (w.startsWith("-")) {
        i += WRAPPER_FLAGS_WITH_VALUE.has(w) ? 2 : 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
        i++;
        continue;
      }
      // `timeout 30 cmd`, `nice 5 cmd` (rare): a bare number before the command.
      if ((cmd === "timeout" || cmd === "nice") && /^[0-9.]+[smhd]?$/.test(w)) {
        i++;
        continue;
      }
      break;
    }
    words = words.slice(i);
  }
  return { words };
}

/** One parsed segment: does it control a schedule or the OS scheduler? */
function segmentControlsScheduler(input: readonly string[], cwdHint: string, depth: number): boolean {
  const peeled = peelWrappers(input);
  if (peeled.inner !== undefined) return depth < MAX_SHELL_NESTING && parsedSchedulerControl(peeled.inner, depth + 1);
  const words = peeled.words;
  if (words.length === 0) return false;
  const cmd = (words[0]!.split("/").pop() ?? "").toLowerCase();
  const rest = words.slice(1).map((w) => w.toLowerCase());
  const positional = rest.filter((w) => !w.startsWith("-"));
  if (cmd === "crontab" || cmd === "launchctl" || cmd === "loginctl") return true;
  if (launchesInteractiveKeryx(words) || drivesKeryxTerminal(words, depth)) return true;
  if (cmd === "systemctl" && positional.some((w) => SYSTEMCTL_CONTROL_VERBS.has(w))) return true;
  for (let i = 0; i + 1 < positional.length; i++) {
    if (positional[i] === "schedule" && SCHEDULE_VERBS.has(positional[i + 1]!)) return true;
    if (positional[i] === "trigger" && (positional[i + 1] === "schedule" || positional[i + 1] === "install")) return true;
    if (positional[i] === "trigger" && positional[i + 1] === "run" && rest.includes("--schedule")) return true;
  }
  // A unit directory named anywhere in the segment (a cp/mv/ln/install/tee target, a
  // redirect, an editor), directly or relative to a directory an earlier `cd` entered.
  const named = [words.join(" "), ...words.map((w) => (w.startsWith("/") || w.startsWith("~") ? w : `${cwdHint}/${w}`))]
    .map((w) => w.toLowerCase());
  return named.some((w) => UNIT_DIR_MARKERS.some((marker) => w.includes(marker)));
}

/** Parsed-word check over every simple command, `cd` targets carried forward. */
function parsedSchedulerControl(command: string, depth = 0): boolean {
  let cwdHint = "";
  for (const seg of splitSegments(command)) {
    const words = seg.words.map(unescapeWord);
    if ((words[0] ?? "") === "cd") {
      cwdHint = words[1] ?? "";
      if (UNIT_DIR_MARKERS.some((marker) => cwdHint.toLowerCase().includes(marker))) return true;
      continue;
    }
    if (segmentControlsScheduler(words, cwdHint, depth)) return true;
  }
  return false;
}

/**
 * True when `command` creates, changes or runs a schedule, drives the OS scheduler, or
 * (M3b) starts an interactive keryx or a terminal driver around one. Pure.
 *
 * Flow 295 (N1): matched on PARSED words, the way `isPublishCommand` is, so quoting
 * (`keryx 'schedule' add`, `sys''temctl`, `cron''tab`), backslash escapes, wrappers
 * (`env -u KERYX_TOOL_CALL …`, `sudo`, `nohup`, `bash -c '…'`) and a `cd` into a unit
 * directory followed by a relative copy are all seen. The raw-text regexes stay as a
 * second net. HONEST LIMIT: this is a text floor. A same-uid shell can still reach the
 * scheduler through a variable, a script file or an interpreter one-liner. The real
 * gates are that `keryx schedule add|resume|run` require a terminal, and that stored
 * schedules are signed with the per-machine key.
 */
export function touchesSchedulerControl(command: string): boolean {
  const text = command.toLowerCase();
  if (SCHEDULER_CONTROL_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return parsedSchedulerControl(command);
}

/**
 * Every command whose purpose is to show that a person, not the agent, took a
 * step: SAC's review confirmation, flow 299's completion confirmation (`flow
 * confirm`), and flow 295's scheduler control (a schedule exists only after the
 * operator confirms its card). The approval gate's `sacReviewConfirmation` floor is
 * fed from this, so every family forces `ask` in every permission mode, `auto`
 * included; no answer is remembered, and a pattern for any of them is refused.
 */
export function touchesHumanConfirmation(command: string): boolean {
  return touchesSacConfirmReview(command) || touchesFlowConfirm(command) || touchesSchedulerControl(command) || touchesCoverageWaiver(command) || touchesChunkEstimateAnswer(command) || touchesReviewPublish(command) || touchesOperatorDecision(command) || touchesHcDialogControl(command);
}

/**
 * `hc` (herdr's terminal CLI) can answer another terminal's dialog: `hc keys <t> enter` presses the keys, and `hc send
 * <t> <text> --force` types into a program that is blocked on a dialog. An agent that does either approves its own (or
 * a peer's) confirmation, so both sit in the human-confirmation floor with the other families here. Naming a terminal
 * id by assignment makes hc believe the caller is that terminal; that is decided on the WHOLE line (an assignment
 * anywhere, plus hc anywhere: `export HC_TERMINAL_ID=t1; hc send …`, `HC_TERMINAL_ID=t1 sh -c 'hc ls'`), on the raw
 * words, because `stripAssignments`/`peelWrappers` drop the assignment before a visitor sees the command. A word the
 * shell has yet to expand may be any of this: `hc $v …`, `$HC keys …`, `hc send t7 "$x"`. `hc send` without `--force`,
 * `hc read`, `hc wait`, `hc interrupt` (it stops a program, it cannot approve a dialog) and `hc run` of anything but hc
 * do not match here (`hc run` has its own floor, {@link hcAgentLaunchesOf}).
 *
 * HONEST LIMIT: these inspect the command line. A script that calls hc is not covered.
 */
export function touchesHcDialogControl(command: string): boolean {
  let assignsIdentity = false;
  let runsHc = false;
  const controls = anySimpleCommand(command, (words, expands, rawWords) => {
    assignsIdentity ||= rawWords.some((w) => HC_TERMINAL_ASSIGNMENT.test(w));
    const headExpands = expands[0] === true;
    if (!headExpands && baseName(words[0]) !== "hc") return false;
    runsHc = true;
    return hcWordsControlDialog(words, expands, headExpands);
  });
  return controls || (assignsIdentity && runsHc);
}

const HC_TERMINAL_ASSIGNMENT = /^HC_TERMINAL_ID\+?=/i;

/** Do these words, whose head is hc or an expansion that may be hc, press a key or force text into a terminal? */
function hcWordsControlDialog(words: readonly string[], expands: readonly boolean[], headExpands: boolean): boolean {
  const rest = words.slice(1);
  const restExpands = expands.slice(1);
  const subAt = rest.findIndex((w) => !w.startsWith("-"));
  if (subAt < 0) return false;
  // `$PY $SCRIPT` is not caught, as in `hasOpaqueCommandPath`: with both unknown nothing says this is hc.
  if (restExpands[subAt] === true) return !headExpands;
  const sub = rest[subAt]!.toLowerCase();
  if (sub === "keys") return true;
  if (sub === "send") {
    if (headExpands || restExpands.slice(subAt + 1).some(Boolean)) return true;
    return rest.slice(subAt + 1).some((w) => w === "--force" || w.startsWith("--force="));
  }
  if (!HC_PROGRAM_VERBS.has(sub) || headExpands) return false;
  const at = hcRunProgramAt(rest, subAt);
  const peeled = peelWrappers(rest.slice(at));
  if (baseName(peeled.words[0]) !== "hc") return false;
  return hcWordsControlDialog(peeled.words, restExpands.slice(restExpands.length - peeled.words.length), false);
}

/** Agents whose launch through `hc run` hands another agent a terminal outside keryx's limits. */
const HC_LAUNCHABLE_AGENTS: ReadonlySet<string> = new Set(["keryx", "claude", "codex", "opencode", "gemini", "agy"]);
/** Package names of those agents where the last path part is not the agent's own name (`@anthropic-ai/claude-code`). */
const HC_AGENT_PACKAGES: ReadonlyMap<string, string> = new Map([
  ["claude-code", "claude"],
  ["gemini-cli", "gemini"],
  ["opencode-ai", "opencode"],
]);
/** Programs that fetch or run a named package; wider than {@link JS_RUNNERS}, which reads keryx's own entry only. */
const HC_LAUNCH_RUNNERS: ReadonlySet<string> = new Set([...JS_RUNNERS, "npm", "pnpm", "yarn"]);
/** Words between a runner and what it runs (`npm exec x`, `pnpm dlx x`, `deno run x`). */
const RUNNER_VERBS: ReadonlySet<string> = new Set(["run", "x", "exec", "dlx"]);
/** The hc verbs that start a program: `hc run` in a terminal, `hc exec` without one. */
const HC_PROGRAM_VERBS: ReadonlySet<string> = new Set(["run", "exec"]);
/** `hc run` options that take the next word as their value (`hc run --help`). */
const HC_RUN_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--name", "--cwd", "--on", "--label", "--parent", "--timeout"]);
/**
 * What an `hc run` starts when the shell has yet to expand its program (`hc run $(which claude)`), or when it sits too
 * deep to read. It always asks and is never granted: nothing says the next one is the same program.
 */
export const HC_UNKNOWN_AGENT = "unknown agent";

/**
 * The agents every `hc run` in the line starts, in order of appearance, without repeats. This is the wide reading the
 * floor asks on: a quoted argument that reads like a command line counts, and so does anything after a terminal driver.
 * Pure.
 */
export function hcAgentLaunchesOf(command: string): string[] {
  const found: string[] = [];
  collectHcLaunches(command, found, true);
  return found;
}

/**
 * The agents an approved {@link hcAgentLaunchesOf} may record as granted: those the command itself starts, read from its
 * own segments and `sh -c` bodies. `echo 'hc run claude'` asks, but its approval grants nothing, and
 * {@link HC_UNKNOWN_AGENT} is never here. Pure.
 */
export function hcGrantableLaunchesOf(command: string): string[] {
  const found: string[] = [];
  collectHcLaunches(command, found, false);
  return found;
}

/** Index in `rest` (the words after `hc`) of the program of the `run` or `exec` at `subAt`. */
function hcRunProgramAt(rest: readonly string[], subAt: number): number {
  let i = subAt + 1;
  for (; i < rest.length; i += 1) {
    const w = rest[i]!;
    if (w === "--") return i + 1;
    if (!w.startsWith("-")) return i;
    if (HC_RUN_VALUE_OPTIONS.has(w)) i += 1;
  }
  return i;
}

function collectHcLaunches(command: string, found: string[], wide: boolean): void {
  const visit = (words: string[], expands: readonly boolean[]): boolean => {
    if (baseName(words[0]) !== "hc" && !(wide && expands[0] === true)) return false;
    const rest = words.slice(1);
    const subAt = rest.findIndex((w) => !w.startsWith("-"));
    if (subAt < 0 || !HC_PROGRAM_VERBS.has(rest[subAt]!.toLowerCase())) return false;
    const at = hcRunProgramAt(rest, subAt);
    collectAgentsOfProgram(rest.slice(at), expands.slice(1 + at), found, 0, wide, wide);
    return false;
  };
  anySimpleCommand(command, visit, 0, wide);
}

/**
 * The agents a program word list starts, through wrappers, `sh -c`, JS runners and (`scanDriver`) terminal drivers,
 * pushed onto `found`. {@link HC_UNKNOWN_AGENT} is pushed only under `wide`, the reading the floor asks on.
 */
function collectAgentsOfProgram(program: readonly string[], expands: readonly boolean[], found: string[], depth: number, wide: boolean, scanDriver: boolean): void {
  const add = (agent: string | undefined): void => {
    if (agent !== undefined && !found.includes(agent) && (wide || agent !== HC_UNKNOWN_AGENT)) found.push(agent);
  };
  const peeled = peelWrappers(program);
  const words = peeled.words;
  const body = peeled.inner ?? (/\s/.test(words[0] ?? "") ? words[0] : undefined);
  if (body !== undefined) {
    if (depth >= MAX_SHELL_NESTING) return add(HC_UNKNOWN_AGENT);
    for (const seg of walkedSegments(body)) collectAgentsOfProgram(seg.words, expansionsOf(seg), found, depth + 1, wide, scanDriver);
    return;
  }
  if (words.length === 0) return;
  const wordExpands = expands.slice(expands.length - words.length);
  if (wordExpands[0] === true) return add(HC_UNKNOWN_AGENT);
  const name = baseName(words[0]);
  if (HC_LAUNCH_RUNNERS.has(name)) {
    for (const at of runnerEntries(words)) add(wordExpands[at] === true ? HC_UNKNOWN_AGENT : agentOfEntry(words[at]!));
    return;
  }
  add(agentOfEntry(words[0]!));
  if (!scanDriver || !TERMINAL_DRIVERS.has(name)) return;
  // A terminal driver runs part of its line as a program; which part depends on the driver, so every suffix is read.
  // Each is read once, without scanning a driver inside it: a later suffix already covers what that would find.
  for (let i = 1; i < words.length; i += 1) collectAgentsOfProgram(words.slice(i), wordExpands.slice(i), found, depth, wide, false);
}

/** The words a JS runner names as what it runs: its entry, and the value of any `-p`/`--package`. Indexes into `words`. */
function runnerEntries(words: readonly string[]): number[] {
  const entries: number[] = [];
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i]!;
    if (w === "-p" || w === "--package") {
      if (i + 1 < words.length) entries.push(i + 1);
      i += 1;
    } else if (w.startsWith("--package=")) {
      entries.push(i); // agentOfEntry drops the option's name.
    } else if (!w.startsWith("-") && !RUNNER_VERBS.has(w)) {
      entries.push(i);
      break;
    }
  }
  return entries;
}

/** The agent a program word or package spec names (`claude`, `/usr/bin/codex`, `npm:@openai/codex@latest`), if any. */
function agentOfEntry(word: string): string | undefined {
  const spec = word.toLowerCase().replace(/^--package=/, "").replace(/^npm:/, "").replace(/(?<=.)@[^/]*$/, "");
  const base = baseName(spec);
  if (KERYX_ENTRY_NAMES.has(base)) return "keryx";
  return HC_AGENT_PACKAGES.get(base) ?? (HC_LAUNCHABLE_AGENTS.has(base) ? base : undefined);
}

/** The first agent an `hc run` in the line starts (`claude`, `keryx`, …), or undefined when it starts none. Pure. */
export function hcAgentLaunchOf(command: string): string | undefined {
  return hcAgentLaunchesOf(command)[0];
}

const COVERAGE_WAIVER_FLAG = "--waive";
const ANSI_C_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** Decode the body of a `$'…'` word the way bash does (`\xHH`, `\uHHHH`, `\UHHHHHHHH`, octal, `\n` …). */
function decodeAnsiC(body: string): string {
  return body.replace(/\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3})|(.))/gs, (_m, x?: string, u?: string, big?: string, oct?: string, ch?: string) => {
    const code = x ?? u ?? big;
    if (code !== undefined) return String.fromCodePoint(Math.min(Number.parseInt(code, 16), 0x10ffff));
    if (oct !== undefined) return String.fromCharCode(Number.parseInt(oct, 8) & 0xff);
    return ANSI_C_ESCAPES[ch ?? ""] ?? `\\${ch ?? ""}`;
  });
}

/** A backslash-newline is removed by the shell before any word is cut, so `--waive-c\<NL>overage` is the flag. */
function joinContinuations(command: string): string {
  return command.replace(/\\\r?\n/g, "");
}

/** Replace each `$'…'` word with its decoded text in single quotes, so the word splitter sees what the shell will. */
function expandAnsiCQuotes(command: string): string {
  return command.replace(/\$'((?:[^'\\]|\\.)*)'/gs, (_m, body: string) => `'${decodeAnsiC(body).replace(/'/g, "'\\''")}'`);
}

/** Text with every quote and backslash removed: the form a split-quote or escaped spelling collapses to. */
function collapseQuoting(command: string): string {
  return expandAnsiCQuotes(command).replace(/["'\\]/g, "");
}

/**
 * Segments of the command as written AND with its `$'…'` words expanded. Inside a double-quoted `bash -c` body the shell
 * leaves `$'…'` for the inner shell to expand, so only the as-written spelling carries it intact into the recursion.
 */
function segmentsOfBothSpellings(raw: string): ReturnType<typeof splitSegments> {
  const command = joinContinuations(raw);
  const expanded = expandAnsiCQuotes(command);
  return expanded === command ? splitSegments(command) : [...splitSegments(command), ...splitSegments(expanded)];
}

/** A word the shell will still rewrite (parameter or command substitution, brace expansion), so its text is not its value. */
function wordIsOpaque(word: string): boolean {
  return /[$`{]/.test(word);
}

/** How deep a `bash -c`/`eval` body or a word that is itself a command line is followed. */
const MAX_SHELL_NESTING = 4;

/**
 * The arguments after the keryx entry of a simple command, or undefined when the command is not keryx. A head the
 * shell has yet to expand (`$K review complete`) counts as keryx: it may be.
 */
function keryxArgs(words: readonly string[]): string[] | undefined {
  if (words.length === 0) return undefined;
  if (wordIsOpaque(words[0]!)) return words.slice(1);
  let at = 0;
  if (JS_RUNNERS.has(baseName(words[0]))) {
    at = words.findIndex((w, i) => i > 0 && !w.startsWith("-") && !["run", "x", "exec"].includes(w));
    if (at < 0) return undefined;
  }
  return KERYX_ENTRY_NAMES.has(baseName(words[at])) ? words.slice(at + 1) : undefined;
}

/** Words the shell will expand, leaving out the value of a `--package` flag (a path, never a flag). */
function opaqueArgs(args: readonly string[]): boolean {
  return args.some((w, i) => wordIsOpaque(w) && args[i - 1] !== "--package");
}

/**
 * For each word {@link splitWords} cuts from `raw`, whether the shell still rewrites it: a `$` or a backtick outside
 * single quotes, or a `{` outside any quotes, none of them backslash-escaped. Text in single quotes is literal. Cut on
 * exactly the boundaries `splitWords` uses, so the result lines up with its words.
 */
function wordExpansions(raw: string): boolean[] {
  const result: boolean[] = [];
  let quote: '"' | "'" | undefined;
  let started = false;
  let length = 0;
  let expands = false;
  let escaped = false;
  const push = (): void => {
    if (started || length > 0) result.push(expands);
    started = false;
    length = 0;
    expands = false;
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote !== undefined) {
      if (quote === '"' && ch === "\\" && raw[i + 1] !== undefined) {
        length += 2;
        i++;
        continue;
      }
      if (ch === quote) quote = undefined;
      else {
        length += 1;
        if (quote === '"' && (ch === "$" || ch === "`")) expands = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      escaped = false;
      continue;
    }
    if (/\s/.test(ch)) {
      escaped = false;
      if (length > 0 || started) push();
      continue;
    }
    if (!escaped && (ch === "$" || ch === "`" || ch === "{")) expands = true;
    escaped = !escaped && ch === "\\";
    length += 1;
  }
  push();
  return result;
}

/**
 * The segments the walker reads: {@link segmentsOfBothSpellings} first, then what shell syntax hid inside them
 * (`if x; then cmd; fi`, `(cmd)`, `{ cmd; }`, `! cmd`, `a & cmd`, `$(cmd)`, backticks), see {@link structuralCommands}.
 * Strictly additive: every family keeps its reading of the line as written, because an opaque word such as
 * `$(which keryx)` means something there that cutting it open would lose.
 */
function walkedSegments(raw: string): Segment[] {
  const segments = segmentsOfBothSpellings(raw);
  const seen = new Set(segments.map((seg) => seg.raw));
  const command = joinContinuations(raw);
  for (const piece of [...structuralCommands(command), ...structuralCommands(expandAnsiCQuotes(command))]) {
    if (seen.has(piece)) continue;
    seen.add(piece);
    segments.push(...splitSegments(piece));
  }
  return segments;
}

/** For each word of `seg`, whether the shell has yet to expand it. Should the two cuts ever disagree, every word is judged by its text (the wider reading). */
function expansionsOf(seg: Segment): boolean[] {
  const cut = wordExpansions(seg.raw);
  return cut.length === seg.words.length ? cut : seg.words.map(wordIsOpaque);
}

/**
 * Run `visit` over every simple command, descending into `bash -c`/`eval` bodies and, with `followArguments`, any word
 * that is itself a command line.
 */
function anySimpleCommand(
  command: string,
  visit: (words: string[], expands: readonly boolean[], rawWords: readonly string[]) => boolean,
  depth = 0,
  followArguments = true,
): boolean {
  for (const seg of walkedSegments(command)) {
    const words = seg.words.map(unescapeWord);
    const peeled = peelWrappers(words);
    const all = expansionsOf(seg);
    const expands = all.slice(all.length - peeled.words.length);
    if (visit(peeled.words, expands, words)) return true;
    // A terminal driver runs the rest of its line as a program (`script -q /dev/null keryx review …`, `unbuffer keryx …`).
    if (TERMINAL_DRIVERS.has(baseName(peeled.words[0])) && peeled.words.some((_w, i) => i > 0 && visit(peeled.words.slice(i), expands.slice(i), words))) return true;
    if (depth < MAX_SHELL_NESTING) {
      if (peeled.inner !== undefined && anySimpleCommand(peeled.inner, visit, depth + 1, followArguments)) return true;
      if (followArguments && words.some((w) => /\s/.test(w) && anySimpleCommand(w, visit, depth + 1, followArguments))) return true;
    }
  }
  return false;
}

/**
 * Parsed check: does a keryx command (found through wrappers, `bash -c`, `eval` and any word that is itself a
 * command line) carry the waiver flag once quoting and escapes are resolved, or run `review complete` with a word
 * the shell has yet to expand? Prose that merely names the flag (a commit message, a search pattern) is not a keryx
 * command and does not match.
 */
function parsedCoverageWaiver(command: string): boolean {
  return anySimpleCommand(command, (words) => {
    const args = keryxArgs(words);
    if (args === undefined) return false;
    const lower = args.map((w) => w.toLowerCase());
    if (lower[0] === "ctx" && lower[1] === "rg") return false;
    if (lower.some((w) => w.includes(COVERAGE_WAIVER_FLAG))) return true;
    const review = lower.indexOf("review");
    if (review < 0) return false;
    const rest = args.slice(review + 1);
    const completeLike = lower.slice(review + 1).includes("complete") || (rest[0] !== undefined && wordIsOpaque(rest[0]));
    return completeLike && opaqueArgs(rest);
  });
}

/**
 * Flow 431 (AC10): `keryx review complete --waive-coverage "<quote>"` is the operator accepting that in-scope files
 * went unreviewed. The quote has to be theirs, so the command asks in every permission mode, like `flow confirm`.
 *
 * Matched on PARSED words like {@link touchesSchedulerControl}, for a keryx command only: split quotes
 * (`--waive-""coverage`), `$'\x2d…'` ANSI-C words, backslash escapes, environment prefixes and `bash -c`/`eval`
 * bodies are resolved first, and a `review complete` whose arguments hold an expansion (`$X`, `$(…)`, a backtick, a
 * brace) asks too, because the flag could be inside it. Globs are left out on purpose: they expand to existing file
 * names, never to a flag. The quote-collapsed text is one more net, for nesting beyond {@link MAX_SHELL_NESTING} and
 * for a keryx command behind a program the parser does not unwrap (`find -exec`); it needs `review` and `complete`
 * beside the flag, so a search for the flag or a commit message about it is not caught. HONEST LIMIT: a script file
 * or an interpreter one-liner is out of reach; `runComplete` therefore also requires a terminal for the waiver. Pure.
 */
export function touchesCoverageWaiver(raw: string): boolean {
  const command = joinContinuations(raw);
  const collapsed = collapseQuoting(command).toLowerCase();
  if (collapsed.includes(COVERAGE_WAIVER_FLAG) && /\breview\b/.test(collapsed) && /\bcomplete\b/.test(collapsed)) return true;
  return parsedCoverageWaiver(command);
}

/**
 * Flow 431 (R2-16): `keryx review chunks estimate --answer …` lifts the pass ceiling on the operator's word, so it
 * asks like the waiver. Parsed words, so a split or escaped spelling is seen too, and so is a verb or flag the shell
 * assembles (`$A`, `--ans${X}wer`) in a keryx command. `runChunks` also requires a terminal for the answer.
 */
export function touchesChunkEstimateAnswer(raw: string): boolean {
  const isAnswer = (w: string): boolean => w === "--answer" || w.startsWith("--answer=");
  const found = anySimpleCommand(joinContinuations(raw), (words) => {
    const lower = words.map((w) => w.toLowerCase());
    const chunks = lower.indexOf("chunks");
    const after = chunks >= 0 ? lower.slice(chunks + 1) : [];
    if (after.includes("estimate") && after.some(isAnswer)) return true;
    const args = keryxArgs(words);
    if (args === undefined) return false;
    const lowerArgs = args.map((w) => w.toLowerCase());
    if (lowerArgs[0] === "ctx" && lowerArgs[1] === "rg") return false;
    if (lowerArgs.includes("estimate") && lowerArgs.some(isAnswer)) return true;
    if (lowerArgs.some(isAnswer) && opaqueArgs(args)) return true;
    const verb = lowerArgs.indexOf("chunks");
    if (verb < 0) return false;
    const rest = args.slice(verb + 1);
    return (rest[0] !== undefined && wordIsOpaque(rest[0])) || (lowerArgs.slice(verb + 1).includes("estimate") && opaqueArgs(rest));
  });
  if (found) return true;
  // Past the recursion limit the quoting of a deeply nested `bash -c` is all that hides the flag.
  return /chunks\s+estimate\b[^;&|]*--answer/i.test(collapseQuoting(joinContinuations(raw)));
}

/**
 * Flow 451: `keryx review publish` posts a review to GitHub under the operator's name, so it asks in every permission mode
 * and no answer is remembered; the body is shown to the operator before they say yes. Parsed words, like the waiver, so a
 * split or escaped spelling and a `review` verb the shell assembles are seen too. Pure.
 */
export function touchesReviewPublish(raw: string): boolean {
  return anySimpleCommand(joinContinuations(raw), (words) => {
    const args = keryxArgs(words);
    if (args === undefined) return false;
    const lower = args.map((w) => w.toLowerCase());
    if (lower[0] === "ctx" && lower[1] === "rg") return false;
    const review = lower.indexOf("review");
    if (review < 0) return false;
    const rest = args.slice(review + 1);
    return lower.slice(review + 1).includes("publish") || (rest[0] !== undefined && wordIsOpaque(rest[0]));
  });
}

/** `keryx review` verbs only the operator takes (their handlers refuse without a terminal). */
const OPERATOR_REVIEW_VERBS: ReadonlySet<string> = new Set(["waive-mutation", "override-reviewers", "confirm-plan", "decide-premise"]);
/** `keryx review` verbs whose `--unattended` the handler refuses without a terminal (`plan` hands it to `start`). */
const UNATTENDED_REVIEW_VERBS: ReadonlySet<string> = new Set(["start", "attach", "plan"]);
/** `keryx hub machine` verbs that enroll this machine, widen what the Hub may run here, or drop the enrollment. */
const HUB_MACHINE_OPERATOR_VERBS: ReadonlySet<string> = new Set(["pair", "allow", "configure", "unpair"]);
/**
 * The command paths of the operator floor ({@link touchesOperatorDecision}): `learn accept|promote|graduate`, `agents
 * external apply`, the `review` verbs of {@link isOperatorReviewForm}, `hub machine pair|allow|configure|unpair`.
 */
const OPERATOR_COMMAND_PATHS: readonly (readonly string[])[] = [
  ...["accept", "promote", "graduate"].map((verb) => ["learn", verb]),
  ["agents", "external", "apply"],
  ...[...OPERATOR_REVIEW_VERBS, ...UNATTENDED_REVIEW_VERBS, "estimate"].map((verb) => ["review", verb]),
  ["review", "comments", "reply"],
  ["review", "chunks", "estimate"],
  ...[...HUB_MACHINE_OPERATOR_VERBS].map((verb) => ["hub", "machine", verb]),
];
/** The deepest operator command path (`hub machine pair`, `agents external apply`, `review comments reply`). */
const MAX_COMMAND_PATH = Math.max(...OPERATOR_COMMAND_PATHS.map((path) => path.length));
/** Literal words of an operator command: with one of them, a command whose head is an expansion may be keryx. */
const OPERATOR_PATH_WORDS: ReadonlySet<string> = new Set(OPERATOR_COMMAND_PATHS.flat());

/** Are these literal words the start of an operator command that still needs more words? */
function startsOperatorPath(literal: readonly string[]): boolean {
  return OPERATOR_COMMAND_PATHS.some((path) => path.length > literal.length && literal.every((w, i) => path[i] === w));
}

/**
 * True when the shell has yet to expand a word of the command path (the words before the first flag, at most
 * {@link MAX_COMMAND_PATH}) at a point where it could still complete an operator command: `keryx $X`, `keryx $H machine
 * pair`, `keryx hub $M pair`, `keryx hub $(printf machine) pair`, `keryx review comments $V --final`. Literal words that
 * already rule every operator command out (`keryx ctx read "$F"`, `keryx wiki ask "$Q"`) leave the command known, and a
 * single-quoted word is literal. A head that is itself an expansion (`$K …`) may stand for any part of the path, so it
 * counts beside any expanded path word and a literal operator word, and `$PY $SCRIPT` is not caught.
 */
function hasOpaqueCommandPath(args: readonly string[], expands: readonly boolean[], headExpands: boolean): boolean {
  const firstFlag = args.findIndex((w) => w.startsWith("-"));
  const pathLength = Math.min(firstFlag < 0 ? args.length : firstFlag, MAX_COMMAND_PATH);
  if (headExpands) {
    return expands.slice(0, pathLength).some(Boolean) && args.some((w) => OPERATOR_PATH_WORDS.has(w.toLowerCase()));
  }
  const literal: string[] = [];
  for (let i = 0; i < pathLength; i++) {
    if (expands[i] === true) return startsOperatorPath(literal);
    literal.push(args[i]!.toLowerCase());
    if (!startsOperatorPath(literal)) return false;
  }
  return false;
}

/**
 * The review forms the handlers refuse without a terminal, and only those: `--unattended` on `start|attach|plan`,
 * `estimate --confirm`, `comments reply --final` outside `--dry-run` and a `--fixtures` rehearsal, and `chunks estimate
 * --mode automatic` (a value the shell has yet to expand may be `automatic`).
 */
function isOperatorReviewForm(args: readonly string[]): boolean {
  const lower = args.map((w) => w.toLowerCase());
  const hasFlag = (flag: string): boolean => lower.some((w) => w === flag || w.startsWith(`${flag}=`));
  if (lower.some((w) => OPERATOR_REVIEW_VERBS.has(w))) return true;
  if (UNATTENDED_REVIEW_VERBS.has(lower.find((w) => !w.startsWith("-")) ?? "") && hasFlag("--unattended")) return true;
  if (lower.includes("estimate") && hasFlag("--confirm")) return true;
  if (lower.includes("comments") && lower.includes("reply") && hasFlag("--final")) {
    const fixtures = optionValues(args, "--fixtures");
    return !args.includes("--dry-run") && !(fixtures.length > 0 && !fixtures.some(wordIsOpaque));
  }
  if (lower.includes("chunks") && lower.includes("estimate")) {
    return optionValues(args, "--mode").some((value) => value.toLowerCase() === "automatic" || wordIsOpaque(value));
  }
  return false;
}

/**
 * Flow 456: `keryx learn accept|promote|graduate`, `keryx agents external apply`, the operator-only `keryx review` forms ({@link isOperatorReviewForm}) and `keryx hub machine pair|allow|configure|unpair` are decisions only the operator takes
 * (their CLI needs a terminal; inside keryx shell the operator answers a card instead). A `shell_exec` of one of them always
 * asks, in every permission mode, and no answer is remembered. Parsed words like {@link touchesReviewPublish}, so a split or
 * escaped spelling and a verb the shell assembles (`learn $V`, `keryx $H machine pair`) are seen too. Pure.
 */
export function touchesOperatorDecision(raw: string): boolean {
  return anySimpleCommand(joinContinuations(raw), (words, expands) => {
    const args = keryxArgs(words);
    if (args === undefined) return false;
    const lower = args.map((w) => w.toLowerCase());
    if (lower[0] === "ctx" && lower[1] === "rg") return false;
    // keryxArgs takes a head with `$`, a backtick or `{` for keryx; a single-quoted one is literal text, not an expansion.
    const headOpaque = wordIsOpaque(words[0]!);
    if ((!headOpaque || expands[0] === true) && hasOpaqueCommandPath(args, expands.slice(words.length - args.length), headOpaque)) return true;
    const learn = lower.indexOf("learn");
    if (learn >= 0) {
      const rest = args.slice(learn + 1);
      if (lower.slice(learn + 1).some((w) => w === "accept" || w === "promote" || w === "graduate") || (rest[0] !== undefined && wordIsOpaque(rest[0]))) return true;
    }
    const review = lower.indexOf("review");
    if (review >= 0 && isOperatorReviewForm(args.slice(review + 1))) return true;
    const hub = lower.indexOf("hub");
    if (hub >= 0) {
      const machine = lower.indexOf("machine", hub + 1);
      const rest = args.slice(machine + 1);
      if (machine >= 0 && (lower.slice(machine + 1).some((w) => HUB_MACHINE_OPERATOR_VERBS.has(w)) || (rest[0] !== undefined && wordIsOpaque(rest[0])))) return true;
    }
    const external = lower.indexOf("external");
    if (external >= 0) {
      const rest = args.slice(external + 1);
      if (lower.slice(external + 1).includes("apply") || (rest[0] !== undefined && wordIsOpaque(rest[0]))) return true;
    }
    return false;
  });
}
