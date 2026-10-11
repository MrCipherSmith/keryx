// Narrow allowlist of local, non-publishing commands a `trust`-mode turn may run
// without a prompt even after untrusted content (an MCP or web result) entered the
// turn. Escalation floors (destructive, credentials, SAC/flow confirmation,
// publish) are checked first and are never lifted. Pure string analysis.

import { isDestructiveCommand, isPublishCommand, touchesAgentCredentials, touchesHumanConfirmation } from "./command-risk";
import { hasUnquotedMetacharacter, splitSegments, stripAssignments } from "./shell-syntax";

const MAX_CHAIN_SEGMENTS = 4;
const MAX_HELP_WORDS = 4;
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "rev-list",
  "ls-files",
  "merge-base",
  "blame",
]);
const EXEC_FLAGS: readonly string[] = ["--pre", "--hostname-bin", "--output", "--ext-diff", "--exec", "--upload-pack", "--post", "--publish", "--push"];

/**
 * One row of the routine-command table: the words after `keryx` that must lead the command (or, for a
 * `suffix` row, the word that must end it), plus an optional flag the command must carry.
 */
export type RoutineKeryxEntry = {
  readonly id: string;
  readonly words: readonly string[];
  readonly suffix?: string;
  readonly requireFlag?: string;
  /** A command that matches this row, shown in tests, docs and the replay. */
  readonly example: string;
};

function row(words: readonly string[], options: { id?: string; requireFlag?: string } = {}): RoutineKeryxEntry {
  const flag = options.requireFlag;
  return {
    id: options.id ?? words.join(" "),
    words,
    ...(flag !== undefined ? { requireFlag: flag } : {}),
    example: ["keryx", ...words, ...(flag !== undefined ? [flag] : [])].join(" "),
  };
}

function rows(group: string, verbs: readonly string[]): RoutineKeryxEntry[] {
  return verbs.map((verb) => row([group, verb]));
}

/**
 * The single list of read-only or local keryx commands that run without a prompt in `trust` and
 * `review-auto`, even after untrusted content entered the turn. No other file lists them.
 */
export const TRUST_ROUTINE_KEYRYX: readonly RoutineKeryxEntry[] = [
  row(["help"]),
  { id: "command-help", words: [], suffix: "--help", example: "keryx review --help" },
  ...["list", "status", "--help"].map((verb) => row(["harness", verb])),
  row(["agents", "external", "list"], { requireFlag: "--no-probe" }),
  ...rows("review", [
    "attach",
    "start",
    "scope",
    "slice",
    "dispatch-check",
    "retry-plan",
    "ledger",
    "floor",
    "blast-radius",
    "budget",
    "tier",
    "status",
    "reviewers",
    "required",
    "ingest",
    "complete",
  ]),
  ...rows("flow", ["status", "list", "check", "next"]),
  ...rows("gdgraph", ["find", "context", "affected", "cycles", "orphans"]),
  ...rows("ctx", ["rg", "read", "diff"]),
];

/** Tools (not shell commands) that never need a prompt in `trust` and `review-auto`: the session's own notes. */
export const TRUST_ROUTINE_TOOLS: readonly string[] = ["slate_note", "slate_trail"];

export function isTrustRoutineTool(name: string): boolean {
  return TRUST_ROUTINE_TOOLS.includes(name);
}

function hasExecFlag(words: readonly string[]): boolean {
  return words.some((w) => w === "-c" || EXEC_FLAGS.some((f) => w === f || w.startsWith(`${f}=`)));
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((word, i) => words[i] === word);
}

function matchesEntry(entry: RoutineKeryxEntry, args: readonly string[]): boolean {
  if (entry.suffix !== undefined) {
    return (
      args.length >= 2 &&
      args.length <= MAX_HELP_WORDS &&
      args[args.length - 1] === entry.suffix &&
      args.slice(0, -1).every((w) => !w.startsWith("-"))
    );
  }
  if (!startsWith(args, entry.words)) return false;
  return entry.requireFlag === undefined || args.includes(entry.requireFlag);
}

function isRoutineKeryx(words: readonly string[]): boolean {
  const args = words.slice(1);
  if (args[0] === "ctx" && args[1] === "run") {
    const dashes = words.indexOf("--");
    return dashes >= 3 && isRoutineSegment(words.slice(dashes + 1));
  }
  if (hasExecFlag(words)) return false;
  return TRUST_ROUTINE_KEYRYX.some((entry) => matchesEntry(entry, args));
}

function isRoutineSegment(words: readonly string[]): boolean {
  if (words.length === 0 || stripAssignments(words).length !== words.length) return false;
  switch (words[0]) {
    case "cd":
      return words.length === 2;
    case "keryx":
      return isRoutineKeryx(words);
    case "bun":
      return words[1] === "test";
    case "git":
      return words[1] !== undefined && GIT_READ_SUBCOMMANDS.has(words[1]) && !hasExecFlag(words);
    default:
      return false;
  }
}

/** True for a short `&&` chain of local review/context/test/read-only commands (`cd` included). */
export function isTrustRoutineCommand(command: string): boolean {
  if (command.trim().length === 0) return false;
  if (/\$\(|\$\{|`/.test(command)) return false;
  if (isDestructiveCommand(command) || touchesAgentCredentials(command)) return false;
  if (touchesHumanConfirmation(command) || isPublishCommand(command)) return false;
  const segments = splitSegments(command);
  if (segments.length === 0 || segments.length > MAX_CHAIN_SEGMENTS) return false;
  return segments.every(
    (seg) =>
      (seg.precededBy === undefined || seg.precededBy === "&&") &&
      !hasUnquotedMetacharacter(seg.raw) &&
      isRoutineSegment(seg.words),
  );
}
