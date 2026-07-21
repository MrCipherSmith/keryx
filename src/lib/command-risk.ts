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
// docs/decisions/keryx-harness/ADR-0008-destructive-command-escalation.md.
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
