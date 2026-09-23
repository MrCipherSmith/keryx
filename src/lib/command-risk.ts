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

import { commandWord, splitSegments, stripAssignments } from "./shell-syntax";
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

/**
 * Force push. Destructive against a protected branch, and escalated when no
 * target is named at all — that form pushes the CURRENT branch, so the target is
 * unknown at approval time and the fail-closed direction is to ask.
 */
const ruleForcePush: Rule = (v) => {
  if (v.cmd !== "git" || !v.positionals.includes("push")) return false;
  const forced = v.args.some((x) => x === "-f" || x === "--force" || x.startsWith("--force-with-lease"));
  if (!forced) return false;
  const after = v.positionals.slice(v.positionals.indexOf("push") + 1);
  if (after.length === 0) return true;
  const named = after.map((x) => x.split("/").pop()?.toLowerCase() ?? "");
  return named.some((n) => PROTECTED_BRANCHES.includes(n));
};

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
];

/** Classify ONE simple command: destructive when ANY rule matches. */
function classifySegment(seg: Segment): boolean {
  const view: SegmentView = {
    raw: seg.raw,
    cmd: head(seg.words),
    args: args(seg.words),
    positionals: positionals(seg.words),
    words: seg.words,
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

  for (const seg of segments) {
    if (classifySegment(seg)) return "destructive";
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
  const text = command.toLowerCase();
  return CREDENTIAL_MARKERS.some((marker) => text.includes(marker));
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
  const text = command.toLowerCase();
  return SAC_REVIEW_MARKERS.some((marker) => text.includes(marker));
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
  if (peeled.inner !== undefined) return depth < 4 && parsedSchedulerControl(peeled.inner, depth + 1);
  const words = peeled.words;
  if (words.length === 0) return false;
  const cmd = (words[0]!.split("/").pop() ?? "").toLowerCase();
  const rest = words.slice(1).map((w) => w.toLowerCase());
  const positional = rest.filter((w) => !w.startsWith("-"));
  if (cmd === "crontab" || cmd === "launchctl" || cmd === "loginctl") return true;
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
 * True when `command` creates, changes or runs a schedule, or drives the OS scheduler. Pure.
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
  return touchesSacConfirmReview(command) || touchesFlowConfirm(command) || touchesSchedulerControl(command);
}
