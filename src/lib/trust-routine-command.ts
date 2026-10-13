// Narrow allowlist of local, non-publishing commands a `trust`-mode turn may run
// without a prompt even after untrusted content (an MCP or web result) entered the
// turn. Escalation floors (destructive, credentials, SAC/flow confirmation,
// publish) are checked first and are never lifted. String analysis, plus two reads of the file system:
// the project's `bunfig.toml` (a `bun test` is routine only while it is the file the session started with)
// and the real path of a review command's path flags.
//
// The table is a gate in front of the command, not the command's own check: a review command refuses an
// out-of-root path itself (review-path-flags.ts) and that refusal is the authoritative one. The project root
// here is computed once from the initial cwd; a `cd` moves the working directory the later segments are
// judged from, never the root.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { optionValues } from "./args";
import { isDestructiveCommand, isPublishCommand, touchesAgentCredentials, touchesHumanConfirmation } from "./command-risk";
import { realOrResolved, resolveProjectRoot } from "./contained-path";
import { confinedPathFlags, reviewPathFlagRefusal } from "./review-path-flags";
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
const BUN_TEST_FLAGS: ReadonlySet<string> = new Set(["--bail", "--only", "--todo"]);
const BUN_TEST_COUNT_FLAGS: ReadonlySet<string> = new Set(["--rerun-each", "--timeout"]);
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
    "compare-reference",
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

export type TrustRoutineContext = {
  /** Where the command runs. Defaults to the process working directory. */
  cwd?: string;
  /** Untrusted content (an MCP or web result) entered the turn: no `bun test` form is routine then. */
  untrustedContent?: boolean;
};

/** State one command line is walked with: a `cd` earlier in the chain moves `cwd` for the segments after it. */
type Walk = { projectRoot: string; cwd: string | undefined; untrusted: boolean };

// Baselines are per process and per project root; the first one recorded for a root wins. Two sessions of one
// process that share a root therefore share the baseline of whichever started first, which is the file as it
// was at that first turn.
const bunfigBaselines = new Map<string, string>();

/**
 * True when a bunfig can load code before the tests: a `preload` key at any depth (the parse normalises quoted and
 * escaped spellings of the key), or a file that does not parse, which fails closed. Whether untrusted content shaped
 * the file is the call site's rule (no `bun test` after untrusted content), not this detector's.
 */
function carriesPreload(text: string): boolean {
  try {
    const hasKey = (value: unknown): boolean =>
      typeof value === "object" && value !== null && Object.entries(value).some(([key, inner]) => key === "preload" || hasKey(inner));
    return hasKey(Bun.TOML.parse(text));
  } catch {
    return true;
  }
}

function bunfigState(root: string): { fingerprint: string; preload: boolean } {
  try {
    const text = readFileSync(path.join(root, "bunfig.toml"), "utf8");
    return { fingerprint: createHash("sha256").update(text).digest("hex"), preload: carriesPreload(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { fingerprint: "absent", preload: false };
    return { fingerprint: "unreadable", preload: true };
  }
}

/**
 * Remember the `bunfig.toml` of the project that contains `cwd`, as it is now. The first call for a project root
 * wins for the life of the process; call it when a session starts, for each directory a shell tool runs in.
 */
export function recordBunfigBaseline(cwd: string = process.cwd()): void {
  const root = realOrResolved(resolveProjectRoot(cwd));
  if (!bunfigBaselines.has(root)) bunfigBaselines.set(root, bunfigState(root).fingerprint);
}

function isNonNegativeInteger(value: string | undefined): boolean {
  return value !== undefined && /^\d+$/.test(value);
}

/** True for no arguments, or only `--bail`, `--only`, `--todo`, `--rerun-each N` and `--timeout N`. */
function hasOnlyAllowedBunTestArgs(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (BUN_TEST_FLAGS.has(arg)) continue;
    const eq = arg.indexOf("=");
    if (eq > 0 && BUN_TEST_COUNT_FLAGS.has(arg.slice(0, eq)) && isNonNegativeInteger(arg.slice(eq + 1))) continue;
    if (BUN_TEST_COUNT_FLAGS.has(arg) && isNonNegativeInteger(args[i + 1])) {
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

function isRoutineBunTest(words: readonly string[], walk: Walk): boolean {
  if (walk.untrusted || walk.cwd === undefined) return false;
  const root = realOrResolved(walk.projectRoot);
  if (realOrResolved(walk.cwd) !== root) return false;
  if (!hasOnlyAllowedBunTestArgs(words.slice(2))) return false;
  const baseline = bunfigBaselines.get(root);
  const now = bunfigState(root);
  return baseline !== undefined && baseline === now.fingerprint && !now.preload;
}

/** A value the shell would expand (home, variable, glob, brace, escape) before the command sees it cannot be judged here. */
function isExpandable(value: string): boolean {
  return value.startsWith("~") || /[$\\*?[\]{}`]/.test(value);
}

/**
 * Where a `cd` leaves the shell, or undefined when that cannot be known: an option (`cd -P`, `cd --`), an empty or
 * expandable target, `-`, or a relative target while `CDPATH` is set (the shell may then look elsewhere first).
 * Every check that needs the working directory fails closed on undefined.
 */
function movedTo(cwd: string | undefined, target: string): string | undefined {
  if (cwd === undefined || target === "" || target.startsWith("-") || isExpandable(target)) return undefined;
  const cdpath = process.env.CDPATH;
  if (cdpath !== undefined && cdpath !== "" && !path.isAbsolute(target) && !target.startsWith("./") && !target.startsWith("../")) {
    return undefined;
  }
  return path.resolve(cwd, target);
}

function areReviewPathFlagsInside(sub: string, args: readonly string[], walk: Walk): boolean {
  const values = confinedPathFlags(sub).flatMap((flag) => optionValues(args, flag));
  if (values.length === 0) return true;
  if (walk.cwd === undefined || values.some(isExpandable)) return false;
  return reviewPathFlagRefusal(sub, args, { projectRoot: walk.projectRoot, cwd: walk.cwd }) === undefined;
}

function isRoutineKeryx(words: readonly string[], walk: Walk): boolean {
  const args = words.slice(1);
  if (args[0] === "ctx" && args[1] === "run") {
    const dashes = words.indexOf("--");
    // A copy of the walk: a `cd` inside `keryx ctx run --` runs in the child and must not move the segments after it.
    return dashes >= 3 && isRoutineSegment(words.slice(dashes + 1), { ...walk });
  }
  if (hasExecFlag(words)) return false;
  if (!TRUST_ROUTINE_KEYRYX.some((entry) => matchesEntry(entry, args))) return false;
  const sub = args[1];
  if (args[0] === "review" && sub !== undefined && confinedPathFlags(sub).length > 0) {
    return areReviewPathFlagsInside(sub, args.slice(2), walk);
  }
  return true;
}

function isRoutineSegment(words: readonly string[], walk: Walk): boolean {
  if (words.length === 0 || stripAssignments(words).length !== words.length) return false;
  switch (words[0]) {
    case "cd":
      if (words.length !== 2) return false;
      walk.cwd = movedTo(walk.cwd, words[1] as string);
      return true;
    case "keryx":
      return isRoutineKeryx(words, walk);
    case "bun":
      return words[1] === "test" && isRoutineBunTest(words, walk);
    case "git":
      return words[1] !== undefined && GIT_READ_SUBCOMMANDS.has(words[1]) && !hasExecFlag(words);
    default:
      return false;
  }
}

/** True for a short `&&` chain of local review/context/test/read-only commands (`cd` included). */
export function isTrustRoutineCommand(command: string, context: TrustRoutineContext = {}): boolean {
  if (command.trim().length === 0) return false;
  if (/\$\(|\$\{|`/.test(command)) return false;
  if (isDestructiveCommand(command) || touchesAgentCredentials(command)) return false;
  if (touchesHumanConfirmation(command) || isPublishCommand(command)) return false;
  const segments = splitSegments(command);
  if (segments.length === 0 || segments.length > MAX_CHAIN_SEGMENTS) return false;
  const cwd = path.resolve(context.cwd ?? process.cwd());
  const walk: Walk = { projectRoot: resolveProjectRoot(cwd), cwd, untrusted: context.untrustedContent === true };
  return segments.every(
    (seg) =>
      (seg.precededBy === undefined || seg.precededBy === "&&") &&
      !hasUnquotedMetacharacter(seg.raw) &&
      isRoutineSegment(seg.words, walk),
  );
}
