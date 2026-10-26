// Completion gate for a managed review run in the shell. The shell's model ends
// a turn at the first friction ("this is not the final report") and the harness
// used to accept it; a review is finished when `keryx review complete` accepts
// the package, not when the model stops writing. Deterministic: no model judges.

import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveActiveReview } from "./active-review";
import { reviewCompletionBlockers, reviewsRoot } from "./managed";
import { readManifestHead } from "./package-location";
import { SHELL_TOOL_NAMES } from "../lib/shell-tool-names";
import { mapBounded } from "../lib/map-bounded";

export const MAX_REVIEW_GATE_CONTINUES = 20;
export const MAX_REVIEW_GATE_STALLS = 3;

export type OpenManagedReview = {
  reviewId: string;
  packageDir: string;
  blockers: string[];
  /** Changes whenever the package or the working data under it gains or changes an artifact. */
  signature: string;
};

/** At most this many file hashes are remembered between stops; the oldest goes first. */
const MAX_HASHED_FILES = 4096;
/**
 * A remembered hash is reused only for a file whose timestamps were already this much older than the moment it was
 * hashed. Inside a filesystem's timestamp granularity a same-size rewrite can leave size and times unchanged (git's
 * "racily clean" entries); such a file is hashed again on every stop.
 */
const RACY_WINDOW_MS = 2_000;
/** File -> its stat key and content hash, so a stop re-reads only the files that changed since the last one. */
const fileHashes = new Map<string, { key: string; hash: string }>();

/** The number of file hashes currently remembered (for tests). */
export const hashedFileCount = (): number => fileHashes.size;

/** `now` is injectable so a test can age a file past {@link RACY_WINDOW_MS} without sleeping. */
export async function fileHash(file: string, now: number = Date.now()): Promise<string> {
  const info = await stat(file).catch(() => undefined);
  if (info === undefined) return "unreadable";
  const key = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
  const hit = fileHashes.get(file);
  if (hit !== undefined && hit.key === key) return hit.hash;
  const hash = await readFile(file).then((body) => createHash("sha256").update(body).digest("hex")).catch(() => "unreadable");
  fileHashes.delete(file);
  if (hash !== "unreadable" && now - Math.max(info.mtimeMs, info.ctimeMs) > RACY_WINDOW_MS) {
    fileHashes.set(file, { key, hash });
    if (fileHashes.size > MAX_HASHED_FILES) fileHashes.delete(fileHashes.keys().next().value as string);
  }
  return hash;
}

/** A signature of every file under `dir` (by content; a file unchanged since the last stop is not read again). */
async function dirSignature(dir: string): Promise<string> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const parts: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      const content = entry.isDirectory() ? await dirSignature(file) : await fileHash(file);
      parts.push(`${entry.name}:${content}`);
    }
    return parts.join(",");
  } catch {
    return "";
  }
}

type PackageCandidate = { dir: string; mtime: number; id: string; root: string };

const METAPROJECT = ".metaproject";
const REVIEWS = "reviews";
/** A package path's prefix ends at whitespace, a quote, a shell operator or `=` (`--package=dir`). */
const PREFIX_DELIMITERS = new Set([..."\"'`<>|;&()="]);
/** The longest prefix walked back from `.metaproject`: a longer one is not a package path the session named. */
const MAX_PREFIX_CHARS = 1024;
const MAX_NAME_CHARS = 255;
/** The most recent project roots the gate scans: each one costs directory reads on every stop. */
export const MAX_SESSION_REVIEW_ROOTS = 8;
/** The most recent package directories the session named by path. */
const MAX_SESSION_REVIEW_DIRS = 32;
/** The most recent review ids the session named (an explicit argument, or keryx's own `# managed review:` line). */
const MAX_SESSION_REVIEW_IDS = 32;
/** Tool calls awaiting their result: one that never gets one is dropped once this many are newer. */
const MAX_PENDING_CALLS = 64;
/** A review id fit to quote in a harness nudge or to match as a token. */
const SAFE_REVIEW_ID = /^[A-Za-z0-9._:-]{1,120}$/;

const isPathDelimiter = (ch: string): boolean => PREFIX_DELIMITERS.has(ch) || /\s/.test(ch);
const isSeparator = (ch: string | undefined): boolean => ch === "/" || ch === "\\";

/**
 * Every `<prefix>.metaproject/reviews/<name>` in `text`, in linear time: each occurrence of the literal is found
 * with indexOf, the prefix is walked back to the nearest delimiter (never past the previous match and never more
 * than {@link MAX_PREFIX_CHARS}), and the name is walked forward. No regex runs over the whole text.
 */
export function reviewPackagePaths(text: string): Array<{ prefix: string; name: string }> {
  const found: Array<{ prefix: string; name: string }> = [];
  let from = 0;
  let floor = 0;
  for (;;) {
    const at = text.indexOf(METAPROJECT, from);
    if (at < 0) return found;
    const sep = at + METAPROJECT.length;
    from = sep;
    if (!isSeparator(text[sep]) || !text.startsWith(REVIEWS, sep + 1) || !isSeparator(text[sep + 1 + REVIEWS.length])) continue;
    const nameStart = sep + REVIEWS.length + 2;
    let end = nameStart;
    while (end < text.length && end - nameStart < MAX_NAME_CHARS && !isSeparator(text[end]) && !isPathDelimiter(text[end]!)) end += 1;
    if (end === nameStart) continue;
    let start = at;
    while (start > floor && at - start < MAX_PREFIX_CHARS && !isPathDelimiter(text[start - 1]!)) start -= 1;
    found.push({ prefix: text.slice(start, at), name: text.slice(nameStart, end) });
    from = end;
    floor = end;
  }
}

/** What this session's own executed `keryx review` commands named. The gate looks only here, never at arbitrary tool output. */
export type SessionReviewNames = {
  /** Project roots (the directory holding `.metaproject`) inside `cwd`, other than `cwd`: the newest {@link MAX_SESSION_REVIEW_ROOTS}. */
  roots: readonly string[];
  /** Absolute package directories named by path. */
  packageDirs: readonly string[];
  /**
   * Review ids this session named: an explicit argument of its `keryx review` commands (`status|readiness|complete|… <id>`,
   * `--review-id <id>`, `--package <id>`), or the id keryx itself printed in reply (`# managed review: <id>`).
   */
  reviewIds: readonly string[];
  /** Whether this session ran a review: loaded the review skill, or executed any `keryx review` command. */
  runSeen?: boolean | undefined;
  /** When the session started: the earliest message timestamp seen, kept when the history is later compacted. */
  startedAt?: number | undefined;
};

type HistoryMessage = {
  role?: string | undefined;
  content?: unknown;
  ts?: string | undefined;
  toolCalls?: ReadonlyArray<{ id?: string | undefined; name?: string | undefined; arguments: string }> | undefined;
  toolCallId?: string | undefined;
};

/** The subcommands that print the package they opened (`# managed review: <id>` and `path: <dir>`). */
const OPENING_SUBCOMMANDS: ReadonlySet<string> = new Set(["start", "attach", "ingest"]);
/** The subcommands whose first positional argument is a review id or package path. */
const PACKAGE_ARG_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "readiness", "complete", "attach", "publish", "verdict", "show"]);
/**
 * The `keryx review` flags that take no value (the ones `review.ts` reads with `args.includes`, plus the publish and
 * import switches): the word after one can still be the positional id. Any other `--flag` (no `=`) takes the next word,
 * so `--waive-coverage "<reason>"` and `--detail`-less forms stay right. A test keeps this list equal to the flags
 * `review.ts` reads as switches.
 */
export const VALUELESS_FLAGS: ReadonlySet<string> = new Set([
  "--json",
  "--yes",
  "--dry-run",
  "--force",
  "--partial",
  "--help",
  "--unattended",
  "--automatic",
  "--final",
  "--allow-closed-pr",
  "--no-prior-round",
  "--detail",
  "--brief",
  "--all",
  "--gating",
  "--style",
  "--confirm",
  "--explain",
  "--live",
  "--full",
  "--no-related-tests",
  "--no-text-links",
  "--report-only",
  "--scoped-diff",
  "--security",
  "--premise",
  "--from-shell-config",
  "--forced-strategy-change",
  "--allow-flagged",
]);
/** The lines `keryx review start|attach|ingest` prints about the package it opened. */
const OWN_OUTPUT_LINE = /^(# managed review|path): (\S.*)$/;
/** The npm package keryx runs from through `npx`/`bunx`/`pnpx`/`bun x`, with an optional `@version`. */
const KERYX_PACKAGE = /^(?:@mrciphersmith\/)?keryx(?:@[^\s/]+)?$/;
/**
 * Programs a pipeline's later stage may run while what the tool printed stays the left command's output: they pass on,
 * cut or copy what they read. Every reader of files (`cat`, `head`, `tail`, `less`, `more`, `grep`) counts only as a pure
 * stdin filter: naming a file of its own, or searching a tree, prints something that is not keryx's output.
 */
const PIPE_FILTERS: ReadonlySet<string> = new Set(["tee", "head", "tail", "cat", "grep", "less", "more"]);
/**
 * Options that consume the next word as their value, per reader, so that word is not a file operand. `cat`, `less` and
 * `more` have none here: their `-n`, `-c`, `-m` are plain switches, and a word after one is a file (review LG-R5-001).
 */
const NO_VALUE_OPTIONS: ReadonlySet<string> = new Set();
const HEAD_TAIL_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-n", "-c", "--lines", "--bytes"]);
const GREP_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-m", "--max-count", "-A", "-B", "-C", "--include", "--exclude"]);
const READER_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  head: HEAD_TAIL_VALUE_OPTIONS,
  tail: HEAD_TAIL_VALUE_OPTIONS,
  cat: NO_VALUE_OPTIONS,
  less: NO_VALUE_OPTIONS,
  more: NO_VALUE_OPTIONS,
};
/** grep options that take the pattern (or the pattern file) from the option, so a file operand is every positional word. */
const GREP_PATTERN_OPTIONS: ReadonlySet<string> = new Set(["-e", "--regexp", "-f", "--file"]);
/** grep options that read a tree or a directory instead of stdin. */
const GREP_TREE_OPTION = /^(?:--(?:recursive|dereference-recursive|directories(?:=.*)?)|-[A-Za-z]*[rRd][A-Za-z]*)$/;
/** The keryx package names a checkout's or install's `package.json` carries. */
const KERYX_PACKAGE_NAMES: ReadonlySet<string> = new Set(["keryx", "@mrciphersmith/keryx"]);

/** One `keryx review` invocation of a shell line: the directory it ran in, its words after `review`, and whether it ran alone. */
export type ReviewInvocation = { cwd: string; subcommand: string; args: string[]; alone: boolean };

/** One command of a shell line: its words, and whether it reads a pipe (a later stage of a pipeline). */
export type ShellCommand = { words: string[]; piped: boolean };

/** What {@link shellCommands} has read so far: the finished commands and the command and word being built. */
type LexState = {
  commands: ShellCommand[];
  words: string[];
  word: string;
  inWord: boolean;
  quotedWord: boolean;
  quote: "'" | '"' | undefined;
  piped: boolean;
  /** The next word is a redirection's target: dropped. */
  dropNext: boolean;
};

const nextIs = (line: string, at: number, chars: string): boolean => at + 1 < line.length && chars.includes(line[at + 1]!);

function endWord(state: LexState): void {
  if (state.inWord) {
    if (state.dropNext) state.dropNext = false;
    else state.words.push(state.word);
  }
  state.word = "";
  state.inWord = false;
  state.quotedWord = false;
}

function endCommand(state: LexState, nextPiped: boolean): void {
  endWord(state);
  state.dropNext = false;
  if (state.words.length > 0) state.commands.push({ words: state.words, piped: state.piped });
  state.words = [];
  state.piped = nextPiped;
}

/**
 * A character inside quotes. In double quotes a backslash escapes only `$`, a backtick, `"`, `\` and a newline (as sh
 * reads it): a Windows path keeps its separators. Returns the index of the last character used.
 */
function readQuoted(state: LexState, line: string, at: number): number {
  const ch = line[at]!;
  if (ch === state.quote) state.quote = undefined;
  else if (ch === "\\" && state.quote === '"' && at + 1 < line.length && '$`"\\\n'.includes(line[at + 1]!)) {
    state.word += line[at + 1];
    return at + 1;
  } else state.word += ch;
  return at;
}

/** A redirection operator at `at` (`>`, `<` or `&>`): ends the word before it and drops its target. Returns the index of the operator's last character. */
function readRedirection(state: LexState, line: string, at: number): number {
  const ch = line[at]!;
  // The fd number of `2>` belongs to the redirection, not to the command.
  if (state.inWord && !state.quotedWord && /^\d+$/.test(state.word)) {
    state.word = "";
    state.inWord = false;
  } else endWord(state);
  let last = at;
  if (ch === "&") {
    last += 1;
    if (nextIs(line, last, ">")) last += 1;
  } else if (ch === ">") {
    if (nextIs(line, last, ">&|")) last += 1;
  } else if (nextIs(line, last, "<")) {
    last += 1;
    if (nextIs(line, last, "<")) last += 1;
  } else if (nextIs(line, last, "&>")) last += 1;
  state.dropNext = true;
  return last;
}

/** A command separator at `at` (`&`, `&&`, `;`, newline, `|`, `||`, `|&`): ends the command. Returns the index of its last character. */
function readSeparator(state: LexState, line: string, at: number): number {
  const ch = line[at]!;
  if (ch !== "|") {
    endCommand(state, false);
    return ch === "&" && nextIs(line, at, "&") ? at + 1 : at;
  }
  if (nextIs(line, at, "|")) {
    endCommand(state, false);
    return at + 1;
  }
  endCommand(state, true);
  return nextIs(line, at, "&") ? at + 1 : at;
}

/**
 * The shell line split into commands, each into words (quotes removed, a backslash escaping the next character outside
 * single quotes). A command ends at `;`, `&&`, `||`, a background `&`, a newline, or a pipe `|`/`|&` (the command after
 * a pipe is `piped`). A redirection is neither a separator nor a word: `>`, `>>`, `<`, `<<`, `<<<`, `>|`, `<>`, `>&n`,
 * `<&n`, `&>`, `&>>`, and an fd number written right before one (`2>&1`), are dropped with their target. A small reader,
 * not a shell: it is enough to tell which program a command runs and with which words. Subshells, command
 * substitutions and heredocs are not read.
 */
export function shellCommands(line: string): ShellCommand[] {
  const state: LexState = { commands: [], words: [], word: "", inWord: false, quotedWord: false, quote: undefined, piped: false, dropNext: false };
  for (let at = 0; at < line.length; at += 1) {
    const ch = line[at]!;
    if (state.quote !== undefined) at = readQuoted(state, line, at);
    else if (ch === "'" || ch === '"') {
      state.quote = ch;
      state.inWord = true;
      state.quotedWord = true;
    } else if (ch === "\\" && at + 1 < line.length) {
      state.word += line[++at];
      state.inWord = true;
    } else if (ch === ">" || ch === "<" || (ch === "&" && nextIs(line, at, ">"))) at = readRedirection(state, line, at);
    else if (ch === "&" || ch === ";" || ch === "\n" || ch === "|") at = readSeparator(state, line, at);
    else if (/\s/.test(ch)) endWord(state);
    else {
      state.word += ch;
      state.inWord = true;
    }
  }
  endCommand(state, false);
  return state.commands;
}

/** The last path component of a program or script word, for a `/` or a `\` separated path. */
const baseName = (word: string): string => path.posix.basename(word.replace(/\\/g, "/"));

/**
 * The words after the keryx program when `command` runs keryx, else undefined: `keryx` by any path; `npx`, `bunx`,
 * `pnpx` or `bun x` of the `keryx` / `@mrciphersmith/keryx` package (any version); `bun`/`node` [`run`] of a `cli.ts` or
 * `cli.js` that is keryx's own entry point (see {@link isKeryxEntry}; `bun src/cli.ts` in a keryx checkout, resolved from
 * `cwd`); `bun run keryx` (the package script).
 */
export function keryxArgs(command: readonly string[], cwd: string = process.cwd()): string[] | undefined {
  const [program, ...rest] = command;
  if (program === undefined) return undefined;
  const name = baseName(program);
  if (name === "keryx") return rest;
  const bunX = name === "bun" && rest[0] === "x";
  if (name === "npx" || name === "bunx" || name === "pnpx" || bunX) {
    const words = bunX ? rest.slice(1) : rest;
    let at = 0;
    for (; at < words.length && words[at]!.startsWith("-"); at += 1) {
      if (words[at] === "--") {
        at += 1;
        break;
      }
      if (words[at] === "-p" || words[at] === "--package") at += 1;
    }
    return at < words.length && KERYX_PACKAGE.test(words[at]!) ? words.slice(at + 1) : undefined;
  }
  if (name !== "bun" && name !== "node") return undefined;
  const run = rest[0] === "run";
  let at = run ? 1 : 0;
  while (at < rest.length && rest[at]!.startsWith("-")) at += 1;
  const script = rest[at];
  if (script === undefined) return undefined;
  const bunScript = name === "bun" && run && script === "keryx";
  return bunScript || isKeryxEntry(script, cwd) ? rest.slice(at + 1) : undefined;
}

/**
 * Whether `script` (resolved from `cwd`) is a `cli.ts` / `cli.js` of the keryx package: the nearest `package.json` above it
 * (at most three directories up) names keryx. Another project's `cli.js` is not keryx's.
 */
function isKeryxEntry(script: string, cwd: string): boolean {
  const scriptName = baseName(script);
  if (scriptName !== "cli.ts" && scriptName !== "cli.js") return false;
  let dir = path.dirname(path.resolve(cwd, script));
  for (let up = 0; up < 3; up += 1, dir = path.dirname(dir)) {
    try {
      const { name } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown };
      return typeof name === "string" && KERYX_PACKAGE_NAMES.has(name);
    } catch {
      // No readable package.json here: look one directory up.
    }
  }
  return false;
}

/** The words of a file-reading filter that name a file (or, for grep, a tree): positional words other than option values. */
function readerOperands(args: readonly string[], skipValue: ReadonlySet<string>): string[] {
  const operands: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === "--") operands.push(...args.slice(at + 1));
    else if (skipValue.has(arg)) at += 1;
    else if (!arg.startsWith("-")) operands.push(arg);
    if (arg === "--") break;
  }
  return operands;
}

/** True for a pipeline stage that only passes the left command's output on (see {@link PIPE_FILTERS}). */
function isPipeFilter(command: readonly string[]): boolean {
  const program = command[0] === undefined ? "" : baseName(command[0]);
  if (!PIPE_FILTERS.has(program)) return false;
  const args = command.slice(1);
  if (program === "tee") return true;
  if (program !== "grep") return readerOperands(args, READER_VALUE_OPTIONS[program] ?? NO_VALUE_OPTIONS).length === 0;
  if (args.some((arg) => GREP_TREE_OPTION.test(arg))) return false;
  // The pattern is one positional word, unless an option supplies it; any further word is a file.
  const patternFromOption = args.some((arg) => GREP_PATTERN_OPTIONS.has(arg));
  return readerOperands(args, new Set([...GREP_VALUE_OPTIONS, ...GREP_PATTERN_OPTIONS])).length <= (patternFromOption ? 0 : 1);
}

/**
 * The `keryx review` invocations of one executed shell line, each with the directory it ran in: the session's cwd, moved
 * by a `cd <dir>` command before it (`cd sub && keryx review start …`). `alone` is true when the line holds nothing but
 * `cd` commands, this one invocation and pipe filters reading its output (`| tee log`), so what the tool printed is
 * keryx's own output. A redirection (`2>&1`) is neither a command nor a word (see {@link shellCommands}); keryx is
 * recognised however it is run (see {@link keryxArgs}).
 */
export function keryxReviewInvocations(line: string, cwd: string): ReviewInvocation[] {
  const found: ReviewInvocation[] = [];
  let dir = cwd;
  let others = 0;
  let pipedKeryx = false;
  for (const { words, piped } of shellCommands(line)) {
    let start = 0;
    while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!)) start += 1;
    const command = words.slice(start);
    if (!piped && command[0] === "cd" && command.length === 2) {
      dir = path.resolve(dir, command[1]!);
      continue;
    }
    const keryx = keryxArgs(command, dir);
    if (keryx !== undefined && keryx[0] === "review") {
      found.push({ cwd: dir, subcommand: keryx[1] ?? "", args: keryx.slice(2), alone: false });
      // A keryx fed by a pipe ran, but what the tool printed may still be the left command's.
      if (piped) pipedKeryx = true;
      continue;
    }
    // A pipeline keeps its left command: a filter reading that command's output is not another command.
    if (piped && isPipeFilter(command)) continue;
    others += 1;
  }
  const alone = found.length === 1 && others === 0 && !pipedKeryx;
  return found.map((invocation) => ({ ...invocation, alone }));
}

/** The shell line of a tool call, when it is a shell tool's (`{ command }`); undefined for any other tool. */
function executedCommand(call: { name?: string | undefined; arguments: string }): string | undefined {
  if (call.name === undefined || !SHELL_TOOL_NAMES.has(call.name)) return undefined;
  try {
    const parsed = JSON.parse(call.arguments) as { command?: unknown };
    return typeof parsed?.command === "string" ? parsed.command : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The review ids an invocation names at an explicit argument position: the value of `--review-id`/`--package`, and for a
 * subcommand that takes a package, its first positional word. A word right after another `--flag` (no `=`) is that flag's
 * value, not the positional (`readiness --flow 460 <id>` names `<id>`, never `460`), unless the flag takes none.
 */
export function explicitReviewIds(invocation: ReviewInvocation): string[] {
  const ids: string[] = [];
  const args = invocation.args;
  let positional: string | undefined;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    const flag = /^--(review-id|package)(?:=(.*))?$/.exec(arg);
    if (flag !== null) {
      const value = flag[2] ?? args[at + 1];
      if (flag[2] === undefined) at += 1;
      if (value !== undefined && SAFE_REVIEW_ID.test(value)) ids.push(value);
    } else if (arg.startsWith("-")) {
      if (arg.startsWith("--") && !arg.includes("=") && !VALUELESS_FLAGS.has(arg)) at += 1;
    } else positional ??= arg;
  }
  if (PACKAGE_ARG_SUBCOMMANDS.has(invocation.subcommand) && positional !== undefined && SAFE_REVIEW_ID.test(positional)) ids.push(positional);
  return ids;
}

function remember<T>(items: Map<T, true>, item: T, cap: number): void {
  items.delete(item);
  items.set(item, true);
  if (items.size > cap) items.delete(items.keys().next().value as T);
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel.split(/[\\/]/)[0] !== ".." && !path.isAbsolute(rel));
}

/**
 * Collects {@link SessionReviewNames} from a history incrementally: `update` scans only the messages added since the
 * last call. When the history is rewritten (compacted or cleared) the scan starts over on the new history, but what
 * the session named so far is kept: a compaction drops the `keryx review` calls that named a package, not the fact
 * that they ran. Only executed shell commands count (a file write that mentions `keryx review` names nothing), and
 * only the ids and paths they name are kept, never the command text.
 */
export class SessionReviewTracker {
  private cursor = 0;
  private last: unknown;
  private runSeen = false;
  private startedAt: number | undefined;
  /** Call id -> the invocation whose result is awaited (only one that ran alone and opens a package). */
  private readonly pendingCalls = new Map<string, ReviewInvocation>();
  private readonly roots = new Map<string, true>();
  private readonly packageDirs = new Map<string, true>();
  private readonly reviewIds = new Map<string, true>();

  constructor(readonly cwd: string) {}

  update(history: ReadonlyArray<HistoryMessage>): SessionReviewNames {
    if (history.length < this.cursor || (this.cursor > 0 && history[this.cursor - 1] !== this.last)) this.rescan();
    for (; this.cursor < history.length; this.cursor += 1) this.scan(history[this.cursor]!);
    this.last = history[this.cursor - 1];
    return {
      roots: [...this.roots.keys()],
      packageDirs: [...this.packageDirs.keys()],
      reviewIds: [...this.reviewIds.keys()],
      runSeen: this.runSeen,
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
    };
  }

  /** The history was rewritten: read it again from the start, keeping what was already named. */
  private rescan(): void {
    this.cursor = 0;
    this.last = undefined;
    this.pendingCalls.clear();
  }

  private scan(message: HistoryMessage): void {
    const at = message.ts === undefined ? Number.NaN : Date.parse(message.ts);
    if (!Number.isNaN(at) && (this.startedAt === undefined || at < this.startedAt)) this.startedAt = at;
    for (const call of message.toolCalls ?? []) {
      if (call.name === "skill_load" && call.arguments.includes("review-orchestrator")) this.runSeen = true;
      const command = executedCommand(call);
      if (command === undefined || !command.includes("review")) continue;
      const cwd = path.resolve(this.cwd);
      for (const invocation of keryxReviewInvocations(command, cwd)) {
        this.runSeen = true;
        // A `keryx review` command run in another directory (`cd sub && …`) works on that directory's project, whether or
        // not its output was read: it is a root to scan.
        if (invocation.cwd !== cwd && inside(cwd, invocation.cwd)) remember(this.roots, invocation.cwd, MAX_SESSION_REVIEW_ROOTS);
        for (const arg of invocation.args) this.namePaths(arg, invocation.cwd);
        for (const id of explicitReviewIds(invocation)) remember(this.reviewIds, id, MAX_SESSION_REVIEW_IDS);
        if (call.id !== undefined && invocation.alone && OPENING_SUBCOMMANDS.has(invocation.subcommand)) {
          this.pendingCalls.delete(call.id);
          this.pendingCalls.set(call.id, invocation);
          if (this.pendingCalls.size > MAX_PENDING_CALLS) this.pendingCalls.delete(this.pendingCalls.keys().next().value as string);
        }
      }
    }
    if (message.role !== "tool" || message.toolCallId === undefined) return;
    const invocation = this.pendingCalls.get(message.toolCallId);
    if (invocation === undefined) return;
    this.pendingCalls.delete(message.toolCallId);
    if (typeof message.content !== "string" || !message.content.includes("# managed review: ")) return;
    for (const line of message.content.split("\n")) {
      const own = OWN_OUTPUT_LINE.exec(line.trimEnd());
      if (own === null) continue;
      // keryx prints `path:` relative to the directory it ran in, which a leading `cd` moved.
      if (own[1] === "path") this.namePaths(own[2]!, invocation.cwd);
      else if (SAFE_REVIEW_ID.test(own[2]!)) remember(this.reviewIds, own[2]!, MAX_SESSION_REVIEW_IDS);
    }
  }

  private namePaths(text: string, from: string): void {
    const cwd = path.resolve(this.cwd);
    for (const { prefix, name } of reviewPackagePaths(text)) {
      const root = path.resolve(from, prefix === "" ? "." : prefix);
      if (!inside(cwd, root)) continue;
      remember(this.packageDirs, path.join(root, METAPROJECT, REVIEWS, name), MAX_SESSION_REVIEW_DIRS);
      if (root !== cwd) remember(this.roots, root, MAX_SESSION_REVIEW_ROOTS);
    }
  }
}

const trackers = new WeakMap<object, SessionReviewTracker>();

/**
 * {@link SessionReviewNames} for `history`, cached per history array so each stop scans only the new messages.
 * Taken only from this session's executed `keryx review` commands (a shell tool call), from explicit argument
 * positions and paths, and from the `path:` and `# managed review:` lines keryx printed in reply to one that ran alone,
 * and only for paths inside `cwd`.
 */
export function sessionReviewNames(history: ReadonlyArray<HistoryMessage>, cwd: string): SessionReviewNames {
  let tracker = trackers.get(history);
  if (tracker === undefined || tracker.cwd !== cwd) {
    tracker = new SessionReviewTracker(cwd);
    trackers.set(history, tracker);
  }
  return tracker.update(history);
}

/**
 * True when this session named the package: by its path, or by its review id (an explicit argument of an executed
 * `keryx review` command, or keryx's own output to one). The id is the package's directory name, the name keryx resolves
 * an id to — never the `reviewId` its manifest claims: review ids are predictable (date, mode, PR slug), so a manifest a
 * pull request commits under another directory could claim the id this session's `review start` prints (SEC-R2-001).
 */
function namedBySession(named: Partial<SessionReviewNames>, dir: string): boolean {
  const target = path.resolve(dir);
  if ((named.packageDirs ?? []).some((p) => path.resolve(p) === target)) return true;
  const id = path.basename(target);
  return SAFE_REVIEW_ID.test(id) && (named.reviewIds ?? []).includes(id);
}

type ClosedPackage = { dir: string; mtime: number };

/** At most this many package manifests of one root are read at once. */
const SCAN_CONCURRENCY = 16;

async function scanRoot(root: string, since: number, named: Partial<SessionReviewNames>): Promise<{ open: PackageCandidate[]; closed: ClosedPackage[] }> {
  let names: string[];
  try {
    names = (await readdir(reviewsRoot(root), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    names = [];
  }
  const read = await mapBounded(names, SCAN_CONCURRENCY, async (name) => {
    const dir = path.join(reviewsRoot(root), name);
    const head = await readManifestHead(dir);
    if (head === undefined || (head.mode !== "review-flow" && head.mode !== "ingest")) return undefined;
    const info = await stat(path.join(dir, "manifest.json")).catch(() => undefined);
    return info === undefined ? undefined : { dir, name, head, mtime: info.mtimeMs };
  });
  const open: PackageCandidate[] = [];
  const closed: ClosedPackage[] = [];
  for (const entry of read) {
    if (entry === undefined) continue;
    const { dir, name, head, mtime } = entry;
    if (head.status === "closed") {
      if (mtime >= since) closed.push({ dir, mtime });
      continue;
    }
    // An open package whose manifest predates the session is another run's (a checkout carries old drafts), unless
    // this session's own commands name it: then the session is continuing it. `ingest --review-id` flips the run's
    // own package to mode ingest, which this covers too.
    if (mtime < since && !namedBySession(named, dir)) continue;
    open.push({ dir, mtime, id: name, root });
  }
  return { open, closed };
}

/**
 * The package this session is reviewing. A candidate this session's own commands name comes first: the one the
 * active-review pointer names when it is among them, else the newest. Only when the session named none is the pointer a
 * tie-breaker — when it was written this session (a concurrent session's newer pointer never beats what this session
 * named, review CB-003) — else the newest open candidate. An older pointer alone never wins: an earlier session's
 * pointer to another PR is how the nudge was misdirected before (flow 460 C).
 */
async function pickPackage(roots: readonly string[], candidates: readonly PackageCandidate[], since: number, named: Partial<SessionReviewNames>): Promise<PackageCandidate | null> {
  const newest = (list: readonly PackageCandidate[]): PackageCandidate | null => list.reduce<PackageCandidate | null>((best, candidate) => (best === null || candidate.mtime > best.mtime ? candidate : best), null);
  const pointers = (await Promise.all(roots.map(async (root) => ({ root, pointer: await resolveActiveReview(root) })))).filter((entry) => entry.pointer !== undefined);
  const pointed = (candidate: PackageCandidate): boolean => pointers.some(({ pointer }) => path.resolve(pointer!.dir) === path.resolve(candidate.dir));
  const sessionNamed = candidates.filter((candidate) => namedBySession(named, candidate.dir));
  if (sessionNamed.length > 0) return sessionNamed.find(pointed) ?? newest(sessionNamed);
  for (const { root, pointer } of pointers) {
    if (Date.parse(pointer!.startedAt) < since) continue;
    const head = await readManifestHead(pointer!.dir);
    if (head === undefined || head.status === "closed") continue;
    const mtime = await stat(path.join(pointer!.dir, "manifest.json")).then((i) => i.mtimeMs).catch(() => 0);
    return { dir: pointer!.dir, mtime, id: path.basename(pointer!.dir), root };
  }
  return newest(candidates);
}

/** The review id as quoted in a harness nudge: an id that is not a plain token is replaced, never rendered raw. */
function displayId(id: string, dir: string): string {
  if (SAFE_REVIEW_ID.test(id)) return id;
  const base = path.basename(dir).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return base === "" ? "(unnamed package)" : base;
}

/** The placeholder blocker when this session neither opened nor named a package. It never claims none exists. */
export const NO_PACKAGE_BLOCKER =
  "no review package this session opened or named: `keryx review start` has not opened one, and no `keryx review` command in this session names an open package by its path or review id";

/**
 * The state `keryx review complete` is waiting on. `null` when a package this session opened or named (by path or
 * review id) was closed since `since`, under the chosen package's root and after the chosen package was last written:
 * the run is done. A closed manifest nobody in this session named — another session's, or one the pull request commits
 * — never ends the gate (review LG-002, SEC-R2-002). Otherwise the package this session is reviewing (see
 * {@link pickPackage}), searched under `cwd` and the project roots this session's own `keryx review` commands named. An
 * open package older than `since` is named only when this session's commands name its path or review id. With none, a
 * placeholder that says so: a run that built scope and slices but never opened a package is not finished either.
 */
export async function findReviewGateState(
  cwd: string,
  since: number,
  named: Partial<SessionReviewNames> = {},
): Promise<OpenManagedReview | null> {
  const roots = [...new Set([cwd, ...(named.roots ?? [])].map((r) => path.resolve(r)))];
  // The roots are independent: read them together.
  const scanned = await Promise.all(roots.map(async (root) => ({ root, ...(await scanRoot(root, since, named)) })));
  const candidates = scanned.flatMap((entry) => entry.open);
  const best = await pickPackage(roots, candidates, since, named);
  // Only a package this session opened or named, closed under the root of the package it is on (any root while it is on
  // none), releases the gate: one closed elsewhere, or by another session, cannot end it.
  const ours = scanned.filter((entry) => best === null || entry.root === best.root).flatMap((entry) => entry.closed).filter((closed) => namedBySession(named, closed.dir));
  const closedAt = Math.max(0, ...ours.map((closed) => closed.mtime));
  if (closedAt > 0 && (best === null || best.mtime < closedAt)) return null;
  const workingRoot = best?.root ?? cwd;
  const working = await dirSignature(path.join(workingRoot, ".metaproject", "data", "review"));
  if (best === null) {
    return {
      reviewId: "(no package yet)",
      packageDir: "",
      blockers: [NO_PACKAGE_BLOCKER],
      signature: `none#${working}`,
    };
  }
  const blockers = await reviewCompletionBlockers(best.dir);
  return {
    reviewId: displayId(best.id, best.dir),
    packageDir: best.dir,
    blockers,
    signature: [blockers.join("|"), await dirSignature(best.dir), working].join("#"),
  };
}

/**
 * True when the transcript shows the review skill was loaded or a `keryx review` command was executed in this session:
 * the same definition the session tracker keeps (`SessionReviewNames.runSeen`), any subcommand — `status` and `attach`
 * continue a review as much as `start` does.
 */
export function reviewRunSeenInHistory(history: ReadonlyArray<HistoryMessage>): boolean {
  return new SessionReviewTracker(process.cwd()).update(history).runSeen === true;
}

/** The earliest message timestamp in the transcript: packages closed before it are not this run's. */
export function sessionStartedAt(history: ReadonlyArray<{ ts?: string | undefined }>): number {
  for (const message of history) {
    const at = message.ts === undefined ? Number.NaN : Date.parse(message.ts);
    if (!Number.isNaN(at)) return at;
  }
  return Date.now();
}

/** How the agent closes the package: the card when this session has the tool, the command otherwise (a session with no card tool). */
function closeStep(card: boolean): string {
  return card
    ? "call the `review_complete` card (the operator answers it; you never run `keryx review complete` yourself)"
    : "run `keryx review complete`";
}

function nextStep(open: OpenManagedReview, card: boolean): string {
  if (open.packageDir === "") {
    return `Next: to continue a review opened in an earlier session, name its package (\`keryx review status <review-id-or-path>\`); otherwise \`keryx review start --pr <n> --report <path>\` opens the package; then dispatch the reviewers per slice, save each result, \`keryx review ledger build <input-dir> --package <review-dir>\`, \`keryx review ingest ... --research <review-dir>/research.json\`, then ${closeStep(card)}.`;
  }
  if (open.blockers.some((b) => /research|dispatch/.test(b))) {
    return `Next: dispatch the reviewers per slice, build the research ledger with \`keryx review ledger build <input-dir> --package <review-dir>\` (it names every gap), \`keryx review ingest ... --research <review-dir>/research.json\`, then ${closeStep(card)}.`;
  }
  return `Next: write or ingest the missing artifacts (\`keryx review ingest\`), then ${closeStep(card)}.`;
}

export type ReviewGateInput = {
  open: OpenManagedReview | null;
  runSeen: boolean;
  continues: number;
  stalls: number;
  lastSignature: string | undefined;
  /** Whether this session has the `review_complete` card tool; false (a readline session) keeps the command wording. Default true. */
  cardAvailable?: boolean | undefined;
};

export type ReviewGateDecision =
  | { action: "accept" }
  | { action: "continue"; message: string; stalls: number; signature: string }
  | { action: "stop"; report: string };

const MAX_NUDGE_BLOCKERS = 20;
const MAX_NUDGE_BLOCKER_CHARS = 300;

/** One blocker as one bounded line: line breaks and control characters carried in from package text are flattened. */
function nudgeLine(blocker: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = blocker.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return flat.length > MAX_NUDGE_BLOCKER_CHARS ? `${flat.slice(0, MAX_NUDGE_BLOCKER_CHARS)}…` : flat;
}

export function describeBlockers(open: OpenManagedReview, card = true): string {
  if (open.blockers.length === 0) return `- none listed; ${card ? "call the `review_complete` card" : "run `keryx review complete`"} to close the package`;
  const shown = open.blockers.slice(0, MAX_NUDGE_BLOCKERS).map((b) => `- ${nudgeLine(b)}`);
  const more = open.blockers.length - shown.length;
  return [...shown, ...(more > 0 ? [`- … and ${more} more (\`keryx review complete\` lists them all)`] : [])].join("\n");
}

export function decideReviewGate(input: ReviewGateInput): ReviewGateDecision {
  const { open } = input;
  if (open === null || !input.runSeen) return { action: "accept" };
  const card = input.cardAvailable !== false;
  const stalls = input.lastSignature === open.signature ? input.stalls + 1 : 0;
  if (input.continues >= MAX_REVIEW_GATE_CONTINUES || stalls >= MAX_REVIEW_GATE_STALLS) {
    return {
      action: "stop",
      report:
        `Review ${open.reviewId} is not complete after ${input.continues} continue(s)` +
        `${stalls >= MAX_REVIEW_GATE_STALLS ? " and no new artifact in the last " + stalls : ""}. ` +
        `${card ? "The review_complete card" : "`keryx review complete`"} would still be refused on:\n${describeBlockers(open, card)}`,
    };
  }
  return {
    action: "continue",
    stalls,
    signature: open.signature,
    message:
      `The managed review ${open.reviewId} is not finished: it is finished when the package is closed (${card ? "the operator answers the `review_complete` card and its gates pass" : "`keryx review complete` accepts it"}), not when you stop writing. ` +
      `It still refuses on:\n${describeBlockers(open, card)}\n` +
      `${nextStep(open, card)}\n` +
      "Do the next missing step now. Step 1 (Build Review Context Pack) has no CLI command; it is a prose step, so mark it done and move on. " +
      "A command that is refused is not a blocker: run `keryx review --help` for the accepted usage and retry with the right flags. " +
      "A plan item you marked blocked for such a reason is not blocked: mark it in_progress. " +
      "A tool loop guard or an empty child result is not a reason to ask the operator to resend the request or to continue: change the arguments, retry the failed pass on a smaller slice, and keep going. " +
      `Stop only after ${card ? "the `review_complete` card has" : "`keryx review complete` has"} closed the package, or report the one real blocker with its evidence.`,
  };
}
