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
const FLOW_CONFIRM_MARKERS: readonly string[] = ["flow confirm"];

/** True when `command` mentions `keryx flow confirm`. Pure. */
export function touchesFlowConfirm(command: string): boolean {
  const text = command.toLowerCase().replace(/\s+/g, " ");
  return FLOW_CONFIRM_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Every command whose purpose is to show that a person, not the agent, took a
 * step: SAC's review confirmation and flow 299's completion confirmation. The
 * approval gate's `sacReviewConfirmation` floor is fed from this, so both force
 * `ask` in every permission mode, `auto` included.
 */
export function touchesHumanConfirmation(command: string): boolean {
  return touchesSacConfirmReview(command) || touchesFlowConfirm(command);
}
