/**
 * Deterministic review-scope builder — the pre-filter that runs BEFORE reviewer
 * dispatch (flow 202, AC3/AC4/AC5).
 *
 * Nothing in here calls a model, reads a file, or shells out. `buildReviewScope`
 * is a pure function of `(diff, config)`, which is the whole point: dropping a
 * lockfile from a review needs no judgement, so it must not cost a model call
 * and must not depend on a model doing as it was told. Every rule below used to
 * be a sentence in `review-orchestrator/SKILL.md` asking a model to "collect a
 * bounded scope"; a sentence cannot be tested and cannot be counted.
 *
 * Two invariants the rest of the pipeline depends on:
 *
 * 1. **Nothing disappears silently.** Every path and every change block this
 *    module removes is returned in `drops` with a reason and a human detail
 *    string. A scope that shrank without saying so reads downstream as "we
 *    reviewed everything", which is the exact shape of claim this flow exists to
 *    stop making.
 * 2. **A false retain is always preferred to a false drop.** Reviewing a
 *    lockfile wastes tokens; hiding a real change hides a bug. Every heuristic
 *    here is written to fail towards keeping the hunk, and the ones that could
 *    not be made safe are not implemented at all — see `NOT DETECTED` below.
 *
 * ## NOT DETECTED, deliberately
 *
 * - **`@generated` / `DO NOT EDIT` content markers.** A diff carries changed
 *   lines, not file headers, so the marker is usually not in the input at all.
 *   Detecting it would need the working tree, which would end the purity that
 *   makes this testable offline.
 * - **Build-output directory names below a source root.** `build/`, and equally
 *   `dist`, `out`, `target`, `generated` and `coverage`, are ordinary words:
 *   `src/target/resolve.ts` is a resolver and `app/components/out/Button.tsx`
 *   is a component. The ambiguous names are only treated as build output when
 *   no source root (`src`, `lib`, `app`, `test`, …) precedes them, and `build/`
 *   is not on the list at all. gdgraph's index can afford that false skip, a
 *   review cannot. Residual gap: the source-root list is a word list, so a
 *   source directory under a parent it does not know — `web/out/Button.tsx` —
 *   is still dropped, and there is no per-repository opt-out for that
 *   direction (`additionalGeneratedDirectories` only adds drops).
 * - **`*.d.ts`, `go.mod`, `package.json`, `Cargo.toml`, `requirements.txt`.**
 *   Declaration files are frequently hand-written, and the manifest files are
 *   dependency *decisions* — the thing a reviewer most wants to see next to the
 *   lockfile churn this module drops.
 * - **Comment-only detection outside a fixed extension whitelist.** An unknown
 *   extension is never classified as comment-only. Doing this properly is a
 *   tokenizer per language; this module ships a line scanner and refuses to
 *   guess where the scanner has no grammar.
 * - **Comment-only detection inside a hunk that could contain a multi-line
 *   string.** A template literal, a Python triple-quote or a shell heredoc can
 *   hold lines that begin with `//` or `#` and are not comments, so the presence
 *   of a delimiter anywhere in the hunk disables the check for that hunk.
 * - **Comment-only detection in a hunk whose own change touches a block-comment
 *   delimiter.** Adding a `/*` above live code, or deleting the `*\/` below it,
 *   comments that code out while every *changed* line is a comment — the whole
 *   file's behaviour changes and the diff looks like a docstring edit. The hunk
 *   is reviewed instead. The same refusal covers a delimiter sitting next to a
 *   quote, because `const marker = "*\/";` would otherwise convince the scanner
 *   that the hunk opened inside a block comment and flag the real code above it.
 * - **Line joins and splits are never whitespace-only.** Removing a newline is
 *   semantic under ASI and under Python's grammar, so the whitespace comparison
 *   is per line and a change in line count is a real change.
 * - **Whitespace inside a multi-line string that is not quote-delimited.**
 *   Whitespace inside a string literal is content, not formatting, so complete
 *   single-line literals are compared verbatim and a hunk carrying an
 *   unterminated quote is never called whitespace-only. A shell heredoc body or
 *   a Python docstring carries no quote on its content lines, so a spacing edit
 *   inside one is still invisible — and for whitespace-sensitive file types,
 *   where only trailing whitespace is normalised, trailing whitespace inside a
 *   multi-line string is still dropped.
 * - **Semantic indentation.** For whitespace-sensitive file types only trailing
 *   whitespace is normalised, so a re-indent of a Python block is a real change.
 * - **Move detection, rename-only diffs, mode changes, and submodule bumps.**
 *   They arrive as ordinary hunks or as no hunks; nothing special is claimed.
 */

/** Why the pre-filter removed something. One reason per drop, always recorded. */
export const SCOPE_DROP_REASONS = [
  "lockfile",
  "generated",
  "vendored",
  "snapshot",
  "minified",
  "binary",
  "whitespace-only",
  "comment-only",
] as const;
export type ScopeDropReason = (typeof SCOPE_DROP_REASONS)[number];

/**
 * One removal, with the reason and the rule that produced it.
 *
 * `granularity` distinguishes "the whole path never reached a reviewer" from
 * "this change block inside a reviewed file did not": the counts in a review
 * record are unreadable if the two are added together.
 */
export type ScopeDrop = {
  path: string;
  reason: ScopeDropReason;
  /** The rule that matched, in words. Rendered verbatim into the review record. */
  detail: string;
  granularity: "file" | "block";
  /** New-file line span of a dropped change block. Absent for a whole-path drop. */
  startLine?: number | undefined;
  endLine?: number | undefined;
  /**
   * Added/removed diff lines this drop removed from review. Counted for a path
   * drop too — "we dropped 3,214 lockfile lines" is what makes a stage count
   * worth reading — and 0 for a binary file, which has no diff lines at all.
   */
  changedLines: number;
};

/**
 * One bounded window a reviewer is dispatched over: the changed lines plus
 * `contextLines` on each side, never the whole file.
 *
 * `contextTruncated` is true when the window asked for lines the diff did not
 * carry. That is either "the diff was generated with a smaller `-U` than the
 * configured window" or "the file ends there", and a diff alone cannot tell the
 * two apart — so it reports the ambiguity rather than resolving it wrongly. The
 * window is always correct; it may just be narrower than asked, and saying so is
 * cheaper than letting a reviewer assume it saw the enclosing function.
 */
export type ScopedRegion = {
  path: string;
  startLine: number;
  endLine: number;
  changedLines: number;
  contextTruncated: boolean;
  /** The window in unified-diff form, prefixes preserved. */
  text: string;
};

/**
 * What each stage removed, in the form AC11 asks a review record to carry.
 *
 * `filesDropped` is `filesSeen - filesRetained` by construction, and it includes
 * three cases: a path-level rule matched (one `drops` row), the file was binary
 * (one `drops` row), and every change block in the file was dropped
 * individually (one `drops` row per block, none for the file — counting the file
 * again would make the arithmetic double-count). A file whose diff carried no
 * hunks at all — a mode change, a pure rename — is in `filesDropped` with no
 * row, because it contained no changed line to hide.
 */
export type ReviewScopeCounts = {
  filesSeen: number;
  filesRetained: number;
  filesDropped: number;
  blocksSeen: number;
  blocksRetained: number;
  blocksDropped: number;
  changedLinesRetained: number;
  changedLinesDropped: number;
  droppedByReason: Record<ScopeDropReason, number>;
};

export type ReviewScope = {
  schemaVersion: 1;
  mode: "diff" | "path";
  contextLines: number;
  /** Retained paths, in input order, deduplicated. */
  files: string[];
  /** Empty in path mode: there is no diff to bound. */
  regions: ScopedRegion[];
  drops: ScopeDrop[];
  counts: ReviewScopeCounts;
};

export type ReviewScopeConfig = {
  /**
   * Lines of context on each side of a changed block.
   *
   * Default 20, not git's 3. `-U3` is a display convention for a human scanning
   * a patch; a reviewer is being asked whether the change is *correct*, and the
   * dominant failure of hunk-scoped review is a finding about a binding defined
   * eight lines above the hunk.
   *
   * Measured on this repository (`git diff --diff-filter=M -U$N HEAD~10 --
   * src/**`, 17 modified files, scoped bytes against whole-file bytes):
   *
   *     U=3   59 regions   29.4% of whole-file review
   *     U=10  41 regions   37.1%
   *     U=20  32 regions   44.4%   <- default
   *     U=40  27 regions   53.8%
   *
   * 20 buys the enclosing block for the large majority of functions here — the
   * median source file is 157 lines (p75 297, p90 629) — for 15 points over
   * git's default, and the next 20 lines cost another 9.4 for much less.
   *
   * It is configurable because the right number is a property of the codebase,
   * not of this module.
   */
  contextLines: number;
  detectWhitespaceOnly: boolean;
  detectCommentOnly: boolean;
  /**
   * Project-local directory names to treat as generated, on top of the built-in
   * list. Matched as a whole path segment at any depth and unconditionally: a
   * configured name is an explicit statement about *this* repository, so unlike
   * the ambiguous built-ins (`dist`, `out`, …) it is not second-guessed by the
   * source-root rule. This is also the escape hatch for a project that really
   * does generate into `src/generated/`.
   */
  additionalGeneratedDirectories: readonly string[];
};

export const DEFAULT_CONTEXT_LINES = 20;

export const DEFAULT_REVIEW_SCOPE_CONFIG: ReviewScopeConfig = {
  contextLines: DEFAULT_CONTEXT_LINES,
  detectWhitespaceOnly: true,
  detectCommentOnly: true,
  additionalGeneratedDirectories: [],
};

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

/**
 * Dependency-manager output. Exact basenames only — no globbing, because a
 * pattern like `*.lock` would take `schema.lock` or a hand-written `foo.lock`
 * with it. `go.sum` is here and `go.mod` deliberately is not: one is resolved
 * output, the other is a dependency decision a reviewer must see.
 */
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "flake.lock",
  "go.sum",
  "gradle.lockfile",
  "packages.lock.json",
]);

/** Third-party source checked into the tree. Matched as a whole path segment. */
const VENDOR_DIRECTORIES = new Set(["node_modules", "vendor", "third_party", "thirdparty", "bower_components", "Pods"]);

/**
 * Build output whose directory name is unambiguous — matched as a whole path
 * segment at any depth. Nothing names a hand-written source directory
 * `__pycache__` or `.next`, so depth carries no information here.
 *
 * Derived from `IGNORE_DIRS` in `src/gdgraph/build.ts`, which is this
 * repository's existing answer to the same question, minus `build` (see the
 * module header) and minus the agent-scratch entries that are not build output.
 */
const GENERATED_DIRECTORIES = new Set([
  "__generated__",
  "__pycache__",
  ".venv",
  ".next",
  ".turbo",
  ".docusaurus",
  "storybook-static",
]);

/**
 * Build-output names that are also ordinary words a source directory can be
 * called: `src/target/resolve.ts` is a resolver, not a Rust build directory,
 * and `app/components/out/Button.tsx` is a component.
 *
 * These match only when no source root precedes them, which keeps the case that
 * matters — `dist/`, `packages/core/dist/`, `apps/web/out/` — and gives up the
 * case that cannot be told apart from source. The author already removed
 * `build` from the list above for exactly this reason; this is the same
 * judgement applied to the rest of the ambiguous names, and `keryx` ships as a
 * general CLI where the source-directory reading is a real repository shape.
 */
const AMBIGUOUS_GENERATED_DIRECTORIES = new Set(["dist", "out", "coverage", "generated", "target"]);

/**
 * Directory names that mean "hand-written code lives under here".
 *
 * A heuristic word list, and only ever the cause of a false *retain*: an
 * ambiguous build directory below one of these is reviewed rather than dropped.
 * Workspace containers (`packages`, `apps`) are deliberately absent — they hold
 * projects, not sources, so `packages/core/dist/` stays build output.
 */
const SOURCE_ROOT_SEGMENTS = new Set([
  "src",
  "source",
  "sources",
  "lib",
  "app",
  "components",
  "internal",
  "pkg",
  "cmd",
  "test",
  "tests",
  "spec",
  "specs",
  "__tests__",
]);

/** Generator output identified by filename rather than directory. */
const GENERATED_SUFFIXES = [
  ".js.map",
  ".mjs.map",
  ".cjs.map",
  ".css.map",
  ".pb.go",
  ".pb.cc",
  ".pb.h",
  "_pb2.py",
  "_pb2_grpc.py",
  ".generated.ts",
  ".g.dart",
  ".freezed.dart",
];

const MINIFIED_SUFFIXES = [".min.js", ".min.mjs", ".min.cjs", ".min.css"];

const SNAPSHOT_DIRECTORIES = new Set(["__snapshots__"]);
const SNAPSHOT_SUFFIXES = [".snap"];

export type PathClassification = { reason: ScopeDropReason; detail: string };

/**
 * Decide whether a path is excluded from review outright, and why.
 *
 * `null` means "review it". Ordered so the reported reason is the most specific
 * true one: a lockfile inside `node_modules/` reads as vendored, because that is
 * the fact a human checking the record cares about.
 */
export function classifyPath(path: string, config: ReviewScopeConfig = DEFAULT_REVIEW_SCOPE_CONFIG): PathClassification | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const basename = segments.at(-1) ?? normalized;
  const directories = segments.slice(0, -1);

  for (const segment of directories) {
    if (VENDOR_DIRECTORIES.has(segment)) {
      return { reason: "vendored", detail: `vendored: path segment "${segment}/"` };
    }
  }
  const extraGenerated = new Set(config.additionalGeneratedDirectories);
  let sawSourceRoot = false;
  for (const segment of directories) {
    if (GENERATED_DIRECTORIES.has(segment)) {
      return { reason: "generated", detail: `generated: build-output directory "${segment}/"` };
    }
    if (extraGenerated.has(segment)) {
      return { reason: "generated", detail: `generated: project-configured directory "${segment}/"` };
    }
    if (AMBIGUOUS_GENERATED_DIRECTORIES.has(segment) && !sawSourceRoot) {
      return { reason: "generated", detail: `generated: build-output directory "${segment}/" with no source root above it` };
    }
    if (SOURCE_ROOT_SEGMENTS.has(segment)) {
      sawSourceRoot = true;
    }
  }
  for (const segment of directories) {
    if (SNAPSHOT_DIRECTORIES.has(segment)) {
      return { reason: "snapshot", detail: `snapshot: path segment "${segment}/"` };
    }
  }
  if (SNAPSHOT_SUFFIXES.some((suffix) => basename.endsWith(suffix))) {
    return { reason: "snapshot", detail: `snapshot: filename ends with "${SNAPSHOT_SUFFIXES.find((s) => basename.endsWith(s)) ?? ""}"` };
  }
  if (LOCKFILE_BASENAMES.has(basename)) {
    return { reason: "lockfile", detail: `lockfile: dependency-manager output "${basename}"` };
  }
  const minified = MINIFIED_SUFFIXES.find((suffix) => basename.endsWith(suffix));
  if (minified !== undefined) {
    return { reason: "minified", detail: `minified: filename ends with "${minified}"` };
  }
  const generatedSuffix = GENERATED_SUFFIXES.find((suffix) => basename.endsWith(suffix));
  if (generatedSuffix !== undefined) {
    return { reason: "generated", detail: `generated: filename ends with "${generatedSuffix}"` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified-diff parsing
// ---------------------------------------------------------------------------

type DiffLineKind = "context" | "add" | "del";

type ParsedLine = {
  kind: DiffLineKind;
  /** The line as it appears in the diff, prefix included. */
  raw: string;
  /** The line without its diff prefix. */
  text: string;
  /**
   * New-file line number this line sits at. A removed line has no new-file line,
   * so it is anchored to the position it was removed from — the number the next
   * new-file line will take. Off by at most one, against a window of 20.
   */
  anchor: number;
};

type ParsedHunk = { header: string; lines: ParsedLine[] };

type ParsedFile = { path: string; binary: boolean; hunks: ParsedHunk[] };

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripDiffPathPrefix(raw: string): string {
  const withoutTimestamp = raw.split("\t")[0] ?? raw;
  const trimmed = withoutTimestamp.trim();
  if (trimmed === "/dev/null") {
    return trimmed;
  }
  return /^[ab]\//.test(trimmed) ? trimmed.slice(2) : trimmed;
}

/**
 * Parse a unified diff into files and hunks.
 *
 * Deliberately its own parser rather than a reuse of `lib/patch-risk.ts`: that
 * module reasons about target paths only and never looks inside a hunk, which is
 * the entire input to hunk-level scoping. Never throws — input that is not a
 * diff yields no files, and the caller then reviews nothing rather than
 * reviewing everything.
 */
function parseUnifiedDiff(diff: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | undefined;
  let hunk: ParsedHunk | undefined;
  let newCursor = 0;
  let pendingOldPath: string | undefined;

  const closeHunk = (): void => {
    if (hunk !== undefined && current !== undefined) {
      current.hunks.push(hunk);
    }
    hunk = undefined;
  };
  const closeFile = (): void => {
    closeHunk();
    if (current !== undefined) {
      files.push(current);
    }
    current = undefined;
    pendingOldPath = undefined;
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      closeFile();
      const match = /^diff --git (.+?) (\S+)$/.exec(line);
      const path = match ? stripDiffPathPrefix(match[2]!) : "";
      current = { path, binary: false, hunks: [] };
      continue;
    }
    if (line.startsWith("--- ")) {
      closeHunk();
      pendingOldPath = stripDiffPathPrefix(line.slice(4));
      if (current === undefined) {
        current = { path: pendingOldPath, binary: false, hunks: [] };
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      closeHunk();
      const newPath = stripDiffPathPrefix(line.slice(4));
      if (current === undefined) {
        current = { path: newPath, binary: false, hunks: [] };
      }
      const resolved = newPath === "/dev/null" ? (pendingOldPath ?? current.path) : newPath;
      if (resolved.length > 0 && resolved !== "/dev/null") {
        current.path = resolved;
      }
      continue;
    }
    if (current !== undefined && (line.startsWith("Binary files ") || line.startsWith("GIT binary patch"))) {
      closeHunk();
      current.binary = true;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header !== null && current !== undefined) {
      closeHunk();
      newCursor = Number.parseInt(header[3]!, 10);
      hunk = { header: line, lines: [] };
      continue;
    }
    if (hunk === undefined) {
      continue;
    }
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — metadata, not content.
      continue;
    }
    const marker = line.charAt(0);
    // Anchors are clamped to 1: a wholly deleted file has a `+0,0` header, so
    // the new-file cursor is 0 and every removed line would anchor outside every
    // window — the file would then silently produce no scope at all.
    const anchor = Math.max(1, newCursor);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", raw: line, text: line.slice(1), anchor });
      newCursor += 1;
      continue;
    }
    if (marker === "-") {
      hunk.lines.push({ kind: "del", raw: line, text: line.slice(1), anchor });
      continue;
    }
    if (marker === " " || line.length === 0) {
      hunk.lines.push({ kind: "context", raw: line, text: line.slice(1), anchor });
      newCursor += 1;
      continue;
    }
    // Anything else ends the hunk body (trailing `-- ` signature, `index …` of a
    // following file that lacked a `diff --git` line, and so on).
    closeHunk();
  }
  closeFile();
  return files.filter((file) => file.path.length > 0 && file.path !== "/dev/null");
}

// ---------------------------------------------------------------------------
// Change blocks
// ---------------------------------------------------------------------------

type ChangeBlock = {
  /** Index into the hunk's line array of the first changed line. */
  from: number;
  /** Index one past the last changed line. */
  to: number;
  lines: ParsedLine[];
};

/** Maximal consecutive runs of added/removed lines inside one hunk. */
function changeBlocks(hunk: ParsedHunk): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let start: number | undefined;
  for (let index = 0; index <= hunk.lines.length; index += 1) {
    const line = hunk.lines[index];
    const changed = line !== undefined && line.kind !== "context";
    if (changed && start === undefined) {
      start = index;
    }
    if (!changed && start !== undefined) {
      blocks.push({ from: start, to: index, lines: hunk.lines.slice(start, index) });
      start = undefined;
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Whitespace-only detection
// ---------------------------------------------------------------------------

/**
 * File types where leading whitespace carries meaning. For these only trailing
 * whitespace is normalised, so a re-indent is a real change and reaches a
 * reviewer.
 */
const INDENT_SIGNIFICANT_EXTENSIONS = new Set([
  ".py",
  ".pyi",
  ".yml",
  ".yaml",
  ".md",
  ".mdx",
  ".markdown",
  ".txt",
  ".rst",
  ".sass",
  ".styl",
  ".haml",
  ".slim",
  ".pug",
  ".jade",
  ".coffee",
  ".nim",
]);

function extensionOf(path: string): string {
  const basename = path.split("/").at(-1) ?? path;
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot).toLowerCase();
}

/**
 * A string literal that opens and closes on the same line, escapes honoured.
 *
 * Not a lexer, and not trying to be: it exists so that whitespace *inside* a
 * literal is compared verbatim while whitespace between tokens is normalised.
 * Without it `parts.join(" ")` and `parts.join("")` normalise to the same text
 * and a separator change is dropped as formatting.
 */
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * True when a quote is left over after every complete literal is removed, i.e.
 * the line opens a string it does not close — a template literal, a PHP or Ruby
 * multi-line string — and the lines after it are string content, where leading
 * whitespace is data rather than formatting.
 *
 * Over-matches: an apostrophe in prose ("don't") reads as an unterminated
 * literal, and so does a quote inside a regex literal. Both cost a retained
 * hunk, which is the direction this module is required to fail in.
 */
function hasUnterminatedQuote(text: string): boolean {
  return /["'`]/.test(text.replace(STRING_LITERAL, ""));
}

/**
 * Collapse whitespace that is formatting; leave whitespace that is data.
 *
 * Runs of whitespace *between* tokens become a single space rather than
 * vanishing, because "a space was removed" is a change — `join(" ")` to
 * `join("")` is the case that reached review as nothing at all. Complete string
 * literals are copied through untouched, so a spacing edit inside a SQL string
 * or a prompt template is a difference.
 */
function normalizeForWhitespace(text: string, indentSignificant: boolean): string {
  if (indentSignificant) {
    return text.replace(/\s+$/, "");
  }
  let normalized = "";
  let cursor = 0;
  for (const match of text.matchAll(STRING_LITERAL)) {
    const index = match.index ?? 0;
    normalized += text.slice(cursor, index).replace(/\s+/g, " ") + match[0];
    cursor = index + match[0].length;
  }
  normalized += text.slice(cursor).replace(/\s+/g, " ");
  return normalized.trim();
}

/**
 * True when the block changes nothing but whitespace.
 *
 * Compared per line, never as one concatenated string: a concatenation would
 * also call a line join or split whitespace-only, and removing a newline is
 * semantic under ASI and under Python's grammar. Lines that normalise to nothing
 * are dropped from both sides first, so adding or removing blank lines counts as
 * whitespace-only.
 *
 * The whole hunk is refused when any of its lines opens a string it does not
 * close: the changed lines may then be string *content*, and the check is per
 * hunk rather than per changed line because the opening quote is usually a
 * context line above the edit.
 */
function isWhitespaceOnly(hunk: ParsedHunk, block: ChangeBlock, indentSignificant: boolean): boolean {
  if (!indentSignificant && hunk.lines.some((line) => hasUnterminatedQuote(line.text))) {
    return false;
  }
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of block.lines) {
    const normalized = normalizeForWhitespace(line.text, indentSignificant);
    if (normalized.length === 0) {
      continue;
    }
    (line.kind === "del" ? removed : added).push(normalized);
  }
  if (removed.length !== added.length) {
    return false;
  }
  return removed.every((value, index) => value === added[index]);
}

// ---------------------------------------------------------------------------
// Comment-only detection
// ---------------------------------------------------------------------------

type CommentStyle = { line: readonly string[]; block: boolean; multilineStringMarkers: readonly string[] };

const C_FAMILY: CommentStyle = { line: ["//"], block: true, multilineStringMarkers: ["`"] };
const HASH_FAMILY: CommentStyle = { line: ["#"], block: false, multilineStringMarkers: ['"""', "'''", "<<"] };
const DASH_FAMILY: CommentStyle = { line: ["--"], block: false, multilineStringMarkers: ["[["] };

/**
 * Extensions whose comment syntax this scanner is willing to claim. An extension
 * that is not here is never classified as comment-only — the hunk is reviewed.
 */
const COMMENT_STYLES: ReadonlyMap<string, CommentStyle> = new Map<string, CommentStyle>([
  ...[
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".java",
    ".c",
    ".h",
    ".cc",
    ".cpp",
    ".hpp",
    ".cs",
    ".go",
    ".rs",
    ".swift",
    ".kt",
    ".kts",
    ".scala",
    ".php",
    ".dart",
    ".zig",
    ".proto",
    ".gradle",
  ].map((extension) => [extension, C_FAMILY] as const),
  ...[".py", ".rb", ".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml", ".tf", ".tfvars"].map(
    (extension) => [extension, HASH_FAMILY] as const,
  ),
  ...[".sql", ".lua"].map((extension) => [extension, DASH_FAMILY] as const),
]);

/**
 * Comment text that changes behaviour rather than describing it.
 *
 * Matched as a case-insensitive substring, which over-matches — a comment
 * mentioning prettier in prose is kept. That is the safe direction: a false
 * retain costs tokens, a false drop hides a suppression change from review.
 */
const DIRECTIVE_MARKERS = [
  "eslint",
  "ts-ignore",
  "ts-expect-error",
  "ts-nocheck",
  "@ts-",
  "prettier",
  "biome-ignore",
  "rome-ignore",
  "oxlint",
  "stylelint",
  "istanbul ignore",
  "c8 ignore",
  "v8 ignore",
  "coverage:",
  "nolint",
  "golangci",
  "go:build",
  "go:generate",
  "go:embed",
  "deno-lint",
  "noinspection",
  "pylint",
  "mypy",
  "type: ignore",
  "noqa",
  "flake8",
  "pragma",
  "nosec",
  "bandit",
  "shellcheck",
  "swiftlint",
  "codeql",
  "sonar",
  "keryx:",
  "-*- coding",
  "use strict",
  "@flow",
  "@jsx",
  "clang-format",
  "editorconfig",
  "webpackchunkname",
  "@vite-ignore",
  "sourcemappingurl",
];

function isDirectiveComment(text: string): boolean {
  const lowered = text.toLowerCase();
  if (lowered.trimStart().startsWith("#!")) {
    return true;
  }
  return DIRECTIVE_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Classify every line of a hunk as comment / not comment, tracking `/* … *\/`
 * state across the hunk.
 *
 * The hunk starts mid-file so the initial block state is unknown — except that
 * seeing a close before any open *proves* the hunk began inside a block comment,
 * which is what the pre-scan below uses.
 */
function commentFlags(lines: readonly ParsedLine[], style: CommentStyle): boolean[] {
  let inBlock = false;
  if (style.block) {
    const openIndex = lines.findIndex((line) => line.text.includes("/*"));
    const closeIndex = lines.findIndex((line) => line.text.includes("*/"));
    inBlock = closeIndex >= 0 && (openIndex < 0 || closeIndex < openIndex);
  }

  return lines.map((line) => {
    const trimmed = line.text.trim();
    if (inBlock) {
      const close = trimmed.lastIndexOf("*/");
      if (close < 0) {
        return true;
      }
      inBlock = false;
      return trimmed.slice(close + 2).trim().length === 0;
    }
    if (trimmed.length === 0) {
      return true;
    }
    if (style.line.some((marker) => trimmed.startsWith(marker))) {
      return true;
    }
    if (style.block && trimmed.startsWith("/*")) {
      const close = trimmed.lastIndexOf("*/");
      if (close < 0) {
        inBlock = true;
        return true;
      }
      return trimmed.slice(close + 2).trim().length === 0;
    }
    return false;
  });
}

const BLOCK_COMMENT_DELIMITER = /\/\*|\*\//;

/** A block-comment delimiter sitting inside what looks like a string literal. */
const QUOTED_BLOCK_DELIMITER = /["'`][^"'`]*(?:\/\*|\*\/)/;

/**
 * True when every added and removed line in the block is a comment, no changed
 * comment is a directive, and the hunk carries no multi-line string delimiter
 * that could be hiding a comment marker inside a string.
 *
 * The two block-comment guards are what stop the most dangerous drop this
 * module can make. `commentFlags` walks one line sequence, but a hunk holds
 * *two* files interleaved; that single walk is only valid when the old and the
 * new file agree on where the block comments are.
 *
 * - A changed line carrying `/*` or `*\/` breaks that agreement by definition,
 *   and it is exactly the edit that comments live code out (`+  /*` above an
 *   authorization check) or swallows it (`-   *\/` below one). The added line is
 *   then the only changed line, the code it disabled is untouched context, and
 *   the block reads as a pure comment edit. Refusing the whole hunk — not just
 *   the block — is deliberate: one delimiter shifts the comment state of every
 *   other block in the hunk too.
 * - A delimiter inside a string (`const marker = "*\/";`) makes the pre-scan
 *   below conclude the hunk opened inside a block comment, which flags the real
 *   code above it as comment. Detected by proximity to a quote rather than by
 *   lexing, so it over-matches onto a hunk that merely has a quote and a
 *   delimiter near each other, and over-matching here only retains a hunk.
 */
function isCommentOnly(hunk: ParsedHunk, block: ChangeBlock, path: string): boolean {
  const style = COMMENT_STYLES.get(extensionOf(path));
  if (style === undefined) {
    return false;
  }
  if (style.multilineStringMarkers.some((marker) => hunk.lines.some((line) => line.text.includes(marker)))) {
    return false;
  }
  if (style.block) {
    const changedDelimiter = hunk.lines.some((line) => line.kind !== "context" && BLOCK_COMMENT_DELIMITER.test(line.text));
    if (changedDelimiter || hunk.lines.some((line) => QUOTED_BLOCK_DELIMITER.test(line.text))) {
      return false;
    }
  }
  const flags = commentFlags(hunk.lines, style);
  let sawComment = false;
  for (let index = block.from; index < block.to; index += 1) {
    const line = hunk.lines[index];
    if (line === undefined) {
      return false;
    }
    if (flags[index] !== true) {
      return false;
    }
    if (line.text.trim().length === 0) {
      continue;
    }
    if (isDirectiveComment(line.text)) {
      return false;
    }
    sawComment = true;
  }
  return sawComment;
}

// ---------------------------------------------------------------------------
// Scope construction
// ---------------------------------------------------------------------------

function emptyCounts(): ReviewScopeCounts {
  const droppedByReason = Object.fromEntries(SCOPE_DROP_REASONS.map((reason) => [reason, 0])) as Record<ScopeDropReason, number>;
  return {
    filesSeen: 0,
    filesRetained: 0,
    filesDropped: 0,
    blocksSeen: 0,
    blocksRetained: 0,
    blocksDropped: 0,
    changedLinesRetained: 0,
    changedLinesDropped: 0,
    droppedByReason,
  };
}

function resolveConfig(config?: Partial<ReviewScopeConfig>): ReviewScopeConfig {
  // Field by field rather than a spread: under `exactOptionalPropertyTypes` a
  // `Partial` may legally carry an explicit `undefined`, and a spread would let
  // it overwrite the default with it — `contextLines` would then be NaN.
  const contextLines = config?.contextLines ?? DEFAULT_REVIEW_SCOPE_CONFIG.contextLines;
  return {
    contextLines: Number.isFinite(contextLines) ? Math.max(0, Math.trunc(contextLines)) : DEFAULT_CONTEXT_LINES,
    detectWhitespaceOnly: config?.detectWhitespaceOnly ?? DEFAULT_REVIEW_SCOPE_CONFIG.detectWhitespaceOnly,
    detectCommentOnly: config?.detectCommentOnly ?? DEFAULT_REVIEW_SCOPE_CONFIG.detectCommentOnly,
    additionalGeneratedDirectories:
      config?.additionalGeneratedDirectories ?? DEFAULT_REVIEW_SCOPE_CONFIG.additionalGeneratedDirectories,
  };
}

type Window = { start: number; end: number; blocks: ChangeBlock[] };

function windowsFor(blocks: readonly ChangeBlock[], contextLines: number): Window[] {
  const windows: Window[] = [];
  for (const block of blocks) {
    const anchors = block.lines.map((line) => line.anchor);
    const first = Math.min(...anchors);
    const last = Math.max(...anchors);
    const start = Math.max(1, first - contextLines);
    const end = last + contextLines;
    const previous = windows.at(-1);
    if (previous !== undefined && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
      previous.blocks.push(block);
      continue;
    }
    windows.push({ start, end, blocks: [block] });
  }
  return windows;
}

/**
 * Build the bounded scope reviewers are dispatched over, from a unified diff.
 *
 * Pure: same input, same output, no filesystem, no network, no model. The
 * returned `drops` array is exhaustive — every path and every change block the
 * input contained and the output does not is in it, with a reason.
 */
export function buildReviewScope(diff: string, config?: Partial<ReviewScopeConfig>): ReviewScope {
  const resolved = resolveConfig(config);
  const counts = emptyCounts();
  const drops: ScopeDrop[] = [];
  const regions: ScopedRegion[] = [];
  const files: string[] = [];

  for (const file of parseUnifiedDiff(diff)) {
    counts.filesSeen += 1;

    // Counted even for a path that is about to be dropped: "we dropped 3,214
    // lockfile lines" is the number that makes a stage count worth reading.
    const fileChangedLines = file.hunks.reduce(
      (total, current) => total + current.lines.filter((line) => line.kind !== "context").length,
      0,
    );

    const pathDrop = classifyPath(file.path, resolved);
    if (pathDrop !== null) {
      counts.filesDropped += 1;
      counts.changedLinesDropped += fileChangedLines;
      counts.droppedByReason[pathDrop.reason] += 1;
      drops.push({
        path: file.path,
        reason: pathDrop.reason,
        detail: pathDrop.detail,
        granularity: "file",
        changedLines: fileChangedLines,
      });
      continue;
    }
    if (file.binary) {
      counts.filesDropped += 1;
      counts.droppedByReason.binary += 1;
      drops.push({
        path: file.path,
        reason: "binary",
        detail: "binary: the diff carries no reviewable text for this file",
        granularity: "file",
        changedLines: 0,
      });
      continue;
    }

    const indentSignificant = INDENT_SIGNIFICANT_EXTENSIONS.has(extensionOf(file.path));
    let retainedInFile = 0;

    for (const hunk of file.hunks) {
      const retained: ChangeBlock[] = [];
      for (const block of changeBlocks(hunk)) {
        counts.blocksSeen += 1;
        const changedLines = block.lines.length;
        const span = {
          startLine: Math.min(...block.lines.map((line) => line.anchor)),
          endLine: Math.max(...block.lines.map((line) => line.anchor)),
        };

        if (resolved.detectWhitespaceOnly && isWhitespaceOnly(hunk, block, indentSignificant)) {
          counts.blocksDropped += 1;
          counts.changedLinesDropped += changedLines;
          counts.droppedByReason["whitespace-only"] += 1;
          drops.push({
            path: file.path,
            reason: "whitespace-only",
            detail: indentSignificant
              ? "whitespace-only: trailing whitespace only (leading whitespace is significant for this file type and was compared)"
              : "whitespace-only: identical once whitespace is removed, with no change in line count",
            granularity: "block",
            startLine: span.startLine,
            endLine: span.endLine,
            changedLines,
          });
          continue;
        }
        if (resolved.detectCommentOnly && isCommentOnly(hunk, block, file.path)) {
          counts.blocksDropped += 1;
          counts.changedLinesDropped += changedLines;
          counts.droppedByReason["comment-only"] += 1;
          drops.push({
            path: file.path,
            reason: "comment-only",
            detail: `comment-only: every changed line is a comment in ${extensionOf(file.path)} and none is a tool directive`,
            granularity: "block",
            startLine: span.startLine,
            endLine: span.endLine,
            changedLines,
          });
          continue;
        }

        counts.blocksRetained += 1;
        counts.changedLinesRetained += changedLines;
        retained.push(block);
      }

      if (retained.length === 0) {
        continue;
      }
      const hunkFirst = hunk.lines[0]?.anchor ?? 1;
      const hunkLast = hunk.lines.at(-1)?.anchor ?? hunkFirst;
      for (const window of windowsFor(retained, resolved.contextLines)) {
        const lines = hunk.lines.filter((line) => line.anchor >= window.start && line.anchor <= window.end);
        if (lines.length === 0) {
          continue;
        }
        const truncated = (window.start < hunkFirst && hunkFirst > 1) || window.end > hunkLast;
        regions.push({
          path: file.path,
          startLine: lines[0]!.anchor,
          endLine: lines.at(-1)!.anchor,
          changedLines: window.blocks.reduce((total, block) => total + block.lines.length, 0),
          contextTruncated: truncated,
          text: lines.map((line) => line.raw).join("\n"),
        });
        retainedInFile += 1;
      }
    }

    if (retainedInFile > 0) {
      counts.filesRetained += 1;
      files.push(file.path);
    } else {
      // Every block in the file was dropped. The file itself is not counted as a
      // path drop — each block drop is already recorded with its own reason, and
      // double-counting it here would make the record's arithmetic wrong.
      counts.filesDropped += 1;
    }
  }

  return { schemaVersion: 1, mode: "diff", contextLines: resolved.contextLines, files, regions, drops, counts };
}

/**
 * Path-mode scope: the same exclusions applied to a file list, with no diff to
 * bound. `regions` is empty because there are no changed hunks — path mode
 * reviews whole files by design, and pretending otherwise would be a lie about
 * what the reviewer saw.
 */
export function buildPathScope(paths: readonly string[], config?: Partial<ReviewScopeConfig>): ReviewScope {
  const resolved = resolveConfig(config);
  const counts = emptyCounts();
  const drops: ScopeDrop[] = [];
  const files: string[] = [];

  for (const path of paths) {
    if (path.trim().length === 0) {
      continue;
    }
    counts.filesSeen += 1;
    const classification = classifyPath(path, resolved);
    if (classification === null) {
      counts.filesRetained += 1;
      files.push(path);
      continue;
    }
    counts.filesDropped += 1;
    counts.droppedByReason[classification.reason] += 1;
    drops.push({
      path,
      reason: classification.reason,
      detail: classification.detail,
      granularity: "file",
      changedLines: 0,
    });
  }

  return { schemaVersion: 1, mode: "path", contextLines: resolved.contextLines, files, regions: [], drops, counts };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/**
 * The review-record form: retained scope AND the full drop list with reasons.
 *
 * Both halves are non-optional. A record that carried only the retained half
 * would read as "we reviewed everything", which is the claim this flow exists to
 * stop the pipeline making.
 */
export function renderReviewScopeMarkdown(scope: ReviewScope): string {
  const lines: string[] = [];
  lines.push("## Pre-filter scope");
  lines.push("");
  lines.push(`mode: ${scope.mode}`);
  lines.push(`context_lines: ${scope.contextLines}`);
  lines.push(`files_seen: ${scope.counts.filesSeen}`);
  lines.push(`files_retained: ${scope.counts.filesRetained}`);
  lines.push(`files_dropped: ${scope.counts.filesDropped}`);
  lines.push(`blocks_seen: ${scope.counts.blocksSeen}`);
  lines.push(`blocks_retained: ${scope.counts.blocksRetained}`);
  lines.push(`blocks_dropped: ${scope.counts.blocksDropped}`);
  lines.push(`changed_lines_retained: ${scope.counts.changedLinesRetained}`);
  lines.push(`changed_lines_dropped: ${scope.counts.changedLinesDropped}`);
  lines.push("");

  lines.push("### Retained");
  lines.push("");
  if (scope.mode === "path") {
    lines.push(scope.files.length === 0 ? "_none_" : scope.files.map((file) => `- ${file}`).join("\n"));
  } else if (scope.regions.length === 0) {
    lines.push("_none_");
  } else {
    lines.push("| file | lines | changed | context |");
    lines.push("|---|---|---|---|");
    for (const region of scope.regions) {
      const context = region.contextTruncated
        ? `<= ${scope.contextLines} (diff carried no more; file end or smaller -U)`
        : `${scope.contextLines}`;
      lines.push(`| ${escapePipes(region.path)} | ${region.startLine}-${region.endLine} | ${region.changedLines} | ${context} |`);
    }
  }
  lines.push("");

  lines.push("### Dropped by the pre-filter");
  lines.push("");
  if (scope.drops.length === 0) {
    lines.push("_nothing was dropped_");
  } else {
    lines.push("| path | where | reason | why |");
    lines.push("|---|---|---|---|");
    for (const drop of scope.drops) {
      const where =
        drop.granularity === "file" ? "whole file" : `lines ${drop.startLine ?? "?"}-${drop.endLine ?? "?"} (${drop.changedLines})`;
      lines.push(`| ${escapePipes(drop.path)} | ${where} | ${drop.reason} | ${escapePipes(drop.detail)} |`);
    }
  }
  lines.push("");
  lines.push("Counts by reason: " + SCOPE_DROP_REASONS.map((reason) => `${reason}=${scope.counts.droppedByReason[reason]}`).join(", "));
  lines.push("");
  return lines.join("\n");
}

/** The bounded windows, in the form handed to a reviewer in place of a raw diff. */
export function renderScopedDiff(scope: ReviewScope): string {
  return scope.regions
    .map((region) => `--- ${region.path}\n@@ ${region.startLine},${region.endLine} @@\n${region.text}`)
    .join("\n\n");
}
