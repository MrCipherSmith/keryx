import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { resolveProjectRoot } from "../lib/contained-path";
import { redactRaw } from "../security/guard";
import { runCtxHook } from "../ctx/hook";
import { installRuntimeHook, uninstallRuntimeHook } from "../ctx/hook-install";
import { resolveRuntimes, runtimeIds, UNSUPPORTED_RUNTIMES } from "../ctx/runtimes";
import {
  compactLines,
  detectStructuredFormat,
  excerptNotice,
  importantLines,
  omissionNote,
  shownSuffix,
} from "../ctx/lines";
import type { OmittedRange } from "../ctx/lines";
import { buildLossManifest, renderLossManifest } from "../ctx/manifest";
import {
  jsonlExcerptNotice,
  repairJsonLines,
  structuralSummaryNotice,
  summarizeJsonDocument,
} from "../ctx/structured";

type CtxArtifact = {
  id: string;
  kind: string;
  command: string;
  exitCode: number;
  rawPath: string;
  summaryPath: string;
  bytesIn: number;
  bytesOut: number;
  truncated: boolean;
};

type CtxConfig = {
  maxOutputLines: number;
  maxImportantLines: number;
  maxGroupItems: number;
  compactHeadLines: number;
  compactTailLines: number;
  outlineMaxEntries: number;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  raw: string;
  exitCode: number;
};

/**
 * What a summariser needs to make its own losses recoverable.
 *
 * The address has to be decided BEFORE the summary is rendered, because the
 * manifest inside the summary quotes it. Previously the id was minted inside
 * `writeArtifact`, after summarising, which is why the only pointer that could
 * be printed was a trailer bolted on afterwards.
 */
export type SummaryContext = {
  /** Project-relative path of this run's raw copy — the `raw:` line's value. */
  address: string;
};

/**
 * The fallback address for a summariser called without a context (unit tests,
 * and any future caller that does not persist an artifact). `latest` is a real,
 * working address rather than a placeholder, so a recovery command built from
 * it still runs.
 */
const LATEST_ADDRESS = ".metaproject/data/gdctx/raw/latest.log";

/** Rendered-summary budget for a structural JSON summary, in UTF-8 bytes. */
function structuredBudgetBytes(config: CtxConfig): number {
  // Sized off the same line budget the text path gets, at a nominal 40 bytes a
  // line, so the two formats cost a reader about the same.
  return (config.compactHeadLines + config.compactTailLines) * 40;
}

const DEFAULT_CONFIG: CtxConfig = {
  maxOutputLines: 120,
  maxImportantLines: 60,
  maxGroupItems: 12,
  compactHeadLines: 120,
  compactTailLines: 80,
  outlineMaxEntries: 160,
};

export async function ctxCommand(args: string[]): Promise<void> {
  const command = args[0];
  const config = await loadConfig();

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "status") {
    await printCtxStatus();
    return;
  }

  if (command === "diff") {
    await diffAndSummarize(args.slice(1), config);
    return;
  }

  if (command === "rg") {
    await rgAndSummarize(args.slice(1), config);
    return;
  }

  if (command === "read") {
    await readAndSummarize(args.slice(1), config);
    return;
  }

  if (command === "run") {
    const separatorIndex = args.indexOf("--");
    const runArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : args.slice(1);
    if (runArgs.length === 0) {
      console.error("Usage: keryx ctx run -- <command...>");
      process.exitCode = 1;
      return;
    }
    await runAndSummarize("run", runArgs, config);
    return;
  }

  if (command === "show") {
    await showArtifact(args.slice(1));
    return;
  }

  if (command === "hook") {
    await runCtxHook(args[1]);
    return;
  }

  if (command === "install-hook") {
    await handleInstallHook(args.slice(1));
    return;
  }

  if (command === "uninstall-hook") {
    await handleUninstallHook(args.slice(1));
    return;
  }

  console.error(`Unknown ctx command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function printCtxStatus(): Promise<void> {
  const root = path.join(resolveProjectRoot(process.cwd()), ".metaproject");
  const manifestPath = path.join(root, "metaproject.json");
  const configPath = path.join(root, "gdctx.config.json");
  const gdctxRoot = path.join(root, "data", "gdctx");
  const latestSummaryPath = path.join(gdctxRoot, "artifacts", "latest.md");

  console.log("# gdctx status");
  console.log("");
  console.log(`metaproject: ${(await pathExists(root)) ? "present" : "missing"}`);
  console.log(`manifest: ${(await pathExists(manifestPath)) ? "present" : "missing"}`);
  console.log(`config: ${(await pathExists(configPath)) ? ".metaproject/gdctx.config.json" : "default"}`);
  console.log(`module data: ${(await pathExists(gdctxRoot)) ? gdctxRoot : "missing"}`);
  console.log(`latest summary: ${(await pathExists(latestSummaryPath)) ? latestSummaryPath : "missing"}`);

  if (await pathExists(manifestPath)) {
    const manifest = await readJsonFileOr<{
      modules?: Record<string, { enabled?: boolean }>;
    }>(manifestPath, {});
    console.log(`gdctx enabled: ${manifest.modules?.gdctx?.enabled === true ? "yes" : "no"}`);
  }
}

// Bare `git diff` shows ONLY unstaged changes to tracked files, so staged work
// and brand-new files are invisible to it. In a worktree mid-flow — where
// workers stage at task boundaries and add new files — that reported
// "Changed files: 0" while hundreds of changed lines sat in the index and in
// untracked files, which reads as "this worktree is clean". Default to
// `git diff HEAD` so staged work is included, and list untracked files
// separately because no diff form can show them.
async function diffAndSummarize(args: string[], config: CtxConfig): Promise<void> {
  const workingTree = isWorkingTreeDiff(args);
  const base = workingTree ? await defaultDiffBase() : undefined;
  const command = ["git", "diff", ...args, ...(base ? [base] : [])];
  const result = await runCommand(command);
  const untracked = workingTree ? await listUntrackedFiles() : null;
  const summary = summarizeDiff(command.join(" "), result, config, untracked);
  const artifact = await writeArtifact({
    kind: "diff",
    command: command.join(" "),
    raw: result.raw,
    summary,
    exitCode: result.exitCode,
  });

  printArtifactSummary(artifact, summary);
  process.exitCode = result.exitCode;
}

async function rgAndSummarize(args: string[], config: CtxConfig): Promise<void> {
  // `--json` is OUR structured-output flag (a token-aware summary), consumed
  // here and NOT forwarded to rg (whose native `--json` emits a different,
  // verbose stream). Strip it before building the rg command.
  const wantsJson = args.includes("--json");
  const rgArgs = args.filter((arg) => arg !== "--json");
  if (rgArgs.length === 0) {
    console.error('Usage: keryx ctx rg "<pattern>" [path] [--json]');
    process.exitCode = 1;
    return;
  }

  // `--files-with-matches`/`--files`/`--count` make rg emit bare paths (or
  // `path:count`), not the `file:line:col:text` the match parser expects — so
  // summarize those as a file list instead of garbled "(unknown) 0:0" matches.
  const listMode = rgListMode(rgArgs);
  const built = buildRgCommand(rgArgs, listMode);
  if (!built.ok) {
    console.error(built.reason);
    process.exitCode = 1;
    return;
  }
  const command = built.command;
  let result: CommandResult;
  try {
    result = await runCommand(command);
  } catch (cause) {
    // `keryx ctx rg` (and thus the agent's search_code) hard-depends on ripgrep.
    // When it is absent `Bun.spawn` throws a bare `Executable not found …` — a
    // signal the model cannot act on. Emit a diagnosis + fix instead of crashing.
    if (isMissingExecutableError(cause)) {
      console.error(MISSING_RG_MESSAGE);
      process.exitCode = 127;
      return;
    }
    throw cause;
  }

  if (wantsJson) {
    const lines = nonEmptyLines(result.raw);
    const payload = listMode
      ? { command: command.join(" "), exitCode: result.exitCode, mode: listMode, files: lines }
      : { command: command.join(" "), exitCode: result.exitCode, matches: parseRgMatches(lines) };
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = result.exitCode;
    return;
  }
  const summary = listMode
    ? summarizeRgFileList(command.join(" "), result, config, listMode)
    : summarizeRg(command.join(" "), result, config);
  const artifact = await writeArtifact({
    kind: "rg",
    command: command.join(" "),
    raw: result.raw,
    summary,
    exitCode: result.exitCode,
  });

  // rg/read are the two callers where nothing downstream depends on the
  // pointer trailer (see printArtifactSummary) — suppress it once the body
  // shown above already IS the full content.
  printArtifactSummary(artifact, summary, { alwaysShowPointer: false });
  process.exitCode = result.exitCode;
}

async function readAndSummarize(args: string[], config: CtxConfig): Promise<void> {
  const file = args[0];
  if (!file) {
    console.error("Usage: keryx ctx read <file> [--mode outline|compact|full]");
    process.exitCode = 1;
    return;
  }

  const mode = optionValue(args, "--mode") ?? "compact";
  if (!["outline", "compact", "full"].includes(mode)) {
    console.error(`Unsupported read mode: ${mode}`);
    console.error("Supported modes: outline, compact, full");
    process.exitCode = 1;
    return;
  }

  const absolutePath = path.resolve(process.cwd(), file);
  let rawContent: string;
  try {
    rawContent = await readFile(absolutePath, "utf8");
  } catch (cause) {
    reportUnreadable(file, cause);
    return;
  }
  // Redact any detected secret before it is summarized/persisted into a gdctx
  // artifact. No-op (byte-identical) when security is disabled or nothing is
  // detected.
  const content = (
    await redactRaw({ cwd: process.cwd(), content: rawContent, source: "trusted-project" })
  ).content;
  const lines = content.split("\n");
  const id = newArtifactId("read");
  const context: SummaryContext = { address: rawAddress(id) };
  const summary =
    mode === "full"
      ? summarizeFullFile(file, lines)
      : mode === "outline"
        ? summarizeOutline(file, lines, config)
        : summarizeCompact(file, lines, config, context);

  const artifact = await writeArtifact({
    id,
    kind: "read",
    command: `read ${file} --mode ${mode}`,
    raw: content,
    summary,
    exitCode: 0,
  });

  printArtifactSummary(artifact, summary, {
    alwaysShowPointer: false,
    ...(args.includes("--base") ? { prefix: NO_DELTA_REASON } : {}),
  });
}

// AC3 (AFC-14) closes with "неверная база возвращает full-view с причиной" — an
// incorrect base returns the full view with a reason. That clause qualifies a
// feature that DOES NOT EXIST in this codebase, and this is where that is
// recorded rather than quietly passed.
//
// Measured on this checkout (flow 235 / T9): `src/commands/ctx.ts` and
// `src/ctx/*.ts` contain no `baseSnapshot`, no `delta`, no `--base` and no
// consumer snapshot — zero matches. `keryx ctx read <file> --base <anything>`
// returned exit 0 and an ordinary view with nothing saying the argument had
// been discarded, which is the worst of the three possible behaviours: it lets
// a caller believe a delta was computed against their base.
//
// The honest minimum, and what is implemented here: `--base` is accepted,
// nothing is elided against it, and the reason is stated. NOT implemented, and
// deliberately so — this is the gap a later flow would have to close:
//
//   · an explicit base snapshot (a recorded, addressable prior read),
//   · consumer isolation, so one consumer's base cannot be read by another,
//   · a `version-conflict` when the source drifts between base and read.
//
// Until those exist there is no such thing as a "correct" base here, so every
// base is an incorrect one and every read is a full view with a reason. Do not
// read the passing AC3 base test as evidence that delta-from-base works.
const NO_DELTA_REASON =
  "Base ignored: keryx ctx offers no delta mode — there is no base snapshot to " +
  "diff against, so the full view is returned. (Not a fallback from a failed " +
  "delta: delta-from-base is unimplemented.)";

// AC4 (AFC-30): "закрытый объект не выдаёт existence/id", and specification.md
// §3: "Ошибка с частными деталями нормализуется одинаково для denied и unknown
// скрытого объекта."
//
// Measured before this fix:
//   keryx ctx read /etc/master.passwd → EACCES: permission denied, open '/etc/master.passwd'
//   keryx ctx read <missing>          → ENOENT: no such file or directory, open '<abs path>'
//
// Two separate leaks in three lines. EACCES positively CONFIRMS the object
// exists — the exact disclosure the criterion forbids — and both echo the
// resolved absolute path, which is an identifier the caller never supplied.
//
// What "closed" means here, since the criterion presumes a notion of it: this
// codebase has two. `resolveContainedPath` (src/lib/contained-path.ts) refuses
// paths outside the project root, and the OS refuses paths the process may not
// read. `ctx read` deliberately applies only the second. The routing guard
// sends every `cat`/`head`/`tail` to this command, including reads of build
// logs and temporary files outside the project, so adding a containment refusal
// here would break legitimate use to satisfy a clause about disclosure. The
// disclosure is what is fixed: denied, missing and unreadable are now one
// answer with one exit code.
//
// The caller's own argument is echoed back, because they supplied it; the
// resolved path, the errno and the syscall are not.
const OPAQUE_ERRNOS = new Set(["ENOENT", "EACCES", "EPERM", "ELOOP", "ENOTDIR", "ENAMETOOLONG"]);

function reportUnreadable(requested: string, cause: unknown): void {
  const code = (cause as { code?: unknown } | null)?.code;
  process.exitCode = 1;
  if (typeof code === "string" && OPAQUE_ERRNOS.has(code)) {
    console.error(
      `keryx ctx read: \`${requested}\` is unavailable. It does not exist, or it is not ` +
        `readable by this process; keryx does not disclose which.`,
    );
    return;
  }
  if (code === "EISDIR") {
    console.error(`keryx ctx read: \`${requested}\` is a directory, not a file.`);
    return;
  }
  console.error(`keryx ctx read: \`${requested}\` could not be read.`);
}

async function runAndSummarize(
  kind: string,
  command: string[],
  config: CtxConfig,
): Promise<void> {
  const result = await runCommand(command);
  const id = newArtifactId(kind);
  const summary = summarizeCommandOutput(command.join(" "), result, config, {
    address: rawAddress(id),
  });
  const artifact = await writeArtifact({
    id,
    kind,
    command: command.join(" "),
    raw: result.raw,
    summary,
    exitCode: result.exitCode,
  });

  printArtifactSummary(artifact, summary);
  process.exitCode = result.exitCode;
}

// Where this project's gdctx artifacts live.
//
// Rooted at `process.cwd()` this wrote a NEW `.metaproject/data/gdctx/` into
// whatever directory the command ran from, so `keryx ctx rg` from a docs or
// fixture folder scattered half-empty `.metaproject/` trees through the repo —
// and `keryx ctx show latest` from anywhere but the root then could not find
// the artifact it had just written elsewhere. `resolveProjectRoot` walks up to
// the nearest `.metaproject/` or `.git/`; at a genuine project root it returns
// that root unchanged.
function gdctxRootDir(): string {
  return path.join(resolveProjectRoot(process.cwd()), ".metaproject", "data", "gdctx");
}

// `ctx show` is the recovery end of AC4's "доступный пропуск раскрывается по
// адресу без поиска". Two things stopped it being that, both measured on this
// checkout (flow 235 / T9):
//
//   1. The address it PRINTS was not an address it ACCEPTS. A summary ends
//      `raw: .metaproject/data/gdctx/raw/<id>_read.log`; feeding that back gave
//      `Artifact not found: …/.metaproject/data/gdctx/raw/.metaproject/data/gdctx/raw/<id>_read.log`,
//      because the target was blindly joined onto the root a second time. The
//      reader had to know to strip four path segments first.
//   2. Recovery was all-or-nothing. `--raw` dumped the entire raw copy — 1 MB
//      for a 6 KB summary — so recovering one omitted region meant re-reading
//      everything and searching it again, which is the re-search the criterion
//      exists to remove. `--lines A-B` returns exactly the range a manifest
//      entry names.
async function showArtifact(args: string[]): Promise<void> {
  const target = args[0] ?? "latest";
  const raw = args.includes("--raw");
  const root = gdctxRootDir();
  const filePath = resolveArtifactPath(root, target, raw);

  if (!(await pathExists(filePath))) {
    console.error(`Artifact not found: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  const range = parseLineRange(optionValue(args, "--lines"));
  if (range === "invalid") {
    console.error("Usage: keryx ctx show <artifact> [--raw] [--lines <start>-<end>]");
    process.exitCode = 1;
    return;
  }

  const content = await readFile(filePath, "utf8");
  if (!range) {
    console.log(content);
    return;
  }

  const lines = content.split("\n");
  const start = Math.max(1, range.start);
  const end = Math.min(lines.length, range.end);
  if (start > lines.length) {
    // The range is outside the artifact — say so instead of printing nothing,
    // which would read as "that range is empty".
    console.error(
      `Requested lines ${range.start}-${range.end}, but the artifact has ${lines.length}.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`# lines ${start}-${end} of ${lines.length} — ${path.basename(filePath)}`);
  console.log("");
  console.log(lines.slice(start - 1, end).join("\n"));
}

/**
 * Accept every spelling of an artifact address that this tool hands out.
 *
 * `latest`; a bare id (`2026-…Z_read`); a bare filename (`2026-…Z_read.log`);
 * and — the one that was broken — the project-relative path printed as `raw:`
 * or `summary:`. Anything resolving outside the gdctx directory is pinned back
 * inside it by basename, so `--raw ../../etc/passwd` cannot walk out.
 */
function resolveArtifactPath(root: string, target: string, raw: boolean): string {
  const dir = path.join(root, raw ? "raw" : "artifacts");
  const extension = raw ? ".log" : ".md";
  if (target === "latest") {
    return path.join(dir, `latest${extension}`);
  }
  // A printed address, absolute or project-relative: keep only its basename,
  // which is what identifies the artifact inside its own directory.
  const name = path.basename(target);
  return path.join(dir, path.extname(name) === extension ? name : `${name}${extension}`);
}

/** `"121-2500"` → `{start,end}`; undefined for absent; `"invalid"` otherwise. */
function parseLineRange(
  value: string | undefined,
): { start: number; end: number } | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match) {
    return "invalid";
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start >= 1 && end >= start ? { start, end } : "invalid";
}

function parseRuntimeArg(args: string[]): string[] {
  const value = optionValue(args, "--runtime") ?? "claude";
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function reportUnsupported(ids: string[]): void {
  for (const id of ids) {
    console.log(`  · ${id} — not supported: ${UNSUPPORTED_RUNTIMES[id]}`);
  }
}

// Opt-in install of the routing guard for one or more harnesses. Validates each
// rendered config so a silent no-op is impossible.
async function handleInstallHook(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const { runtimes, unknown, unsupported } = resolveRuntimes(parseRuntimeArg(args));
  if (unknown.length > 0) {
    console.error(`Unknown runtime(s): ${unknown.join(", ")}`);
    console.error(`Supported: ${runtimeIds().join(", ")}, all`);
    process.exitCode = 1;
    return;
  }

  console.log("# gdctx routing guard installed");
  console.log("");
  console.log("mode: deny + feedback (raw rg/grep/cat/head/tail/git diff|log|show -> keryx ctx ...)");
  console.log("escape: append `# keryx:raw <reason>` to run a raw command anyway");
  console.log("");
  for (const runtime of runtimes) {
    const { path: file, errors, upgraded } = await installRuntimeHook(cwd, runtime);
    const tag = runtime.confidence === "experimental" ? " (experimental — verify on a live install)" : "";
    if (errors.length > 0) {
      for (const error of errors) console.error(`  ✗ ${error}`);
      process.exitCode = 1;
    } else {
      console.log(`  ✓ ${runtime.id} -> ${path.relative(cwd, file)}${tag}`);
      // Said out loud, because the install silently overwrites it: an operator
      // who ran install-hook before a tool was added has no other way to learn
      // that their guard had stopped covering one.
      if (upgraded) console.log(`    ${upgraded}`);
    }
  }
  reportUnsupported(unsupported);
}

async function handleUninstallHook(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const { runtimes, unknown, unsupported } = resolveRuntimes(parseRuntimeArg(args));
  if (unknown.length > 0) {
    console.error(`Unknown runtime(s): ${unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  console.log("# gdctx routing guard uninstall");
  console.log("");
  for (const runtime of runtimes) {
    const removed = await uninstallRuntimeHook(cwd, runtime);
    console.log(
      `  ${removed ? "✓" : "·"} ${runtime.id} ${removed ? `-> ${path.relative(cwd, runtime.locate(cwd))}` : "nothing to remove"}`,
    );
  }
  reportUnsupported(unsupported);
}

// Actionable guidance when ripgrep is missing. Kept as a shared constant so the
// exit message here and the agent-tool normalizer (metaproject-tools.ts) stay in
// lockstep — the tool layer keys its "rg unavailable" detection on this text.
export const MISSING_RG_MESSAGE =
  'ripgrep (rg) is not installed or not on PATH. `keryx ctx rg` (and the agent\'s ' +
  "search_code) needs it. Install it: `brew install ripgrep` (macOS) or " +
  "`apt install ripgrep` (Debian/Ubuntu).";

/** True when an error is a "binary not found on PATH" spawn failure. */
export function isMissingExecutableError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /Executable not found|\bENOENT\b|not found in \$?PATH/i.test(message);
}

async function runCommand(command: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const raw = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");

  return redactCommandResult({ stdout, stderr, raw, exitCode });
}

// Security seam (§11): redact detected secrets from raw command output before it
// is summarized or persisted, so a secret in raw output never lands in a gdctx
// artifact. `redactRaw` is a zero-cost no-op (byte-identical) whenever security
// is disabled or nothing sensitive is detected, so existing behavior is
// preserved on the common path.
async function redactCommandResult(result: CommandResult): Promise<CommandResult> {
  const cwd = process.cwd();
  const [raw, stdout, stderr] = await Promise.all([
    redactRaw({ cwd, content: result.raw, source: "tool-output" }),
    redactRaw({ cwd, content: result.stdout, source: "tool-output" }),
    redactRaw({ cwd, content: result.stderr, source: "tool-output" }),
  ]);
  return {
    raw: raw.content,
    stdout: stdout.content,
    stderr: stderr.content,
    exitCode: result.exitCode,
  };
}

/**
 * Mint the artifact id up front, so the summary can quote its own address.
 *
 * A loss manifest has to name the command that recovers each omitted range, and
 * it is rendered before the artifact is written — so the id cannot be minted
 * inside `writeArtifact` any more.
 */
function newArtifactId(kind: string): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}_${kind}`;
}

/** The `raw:` address of an artifact id — project-root-relative, as printed. */
function rawAddress(id: string): string {
  const projectRoot = resolveProjectRoot(process.cwd());
  return path.relative(projectRoot, path.join(gdctxRootDir(), "raw", `${id}.log`));
}

async function writeArtifact({
  id,
  kind,
  command,
  raw,
  summary,
  exitCode,
}: {
  id?: string;
  kind: string;
  command: string;
  raw: string;
  summary: string;
  exitCode: number;
}): Promise<CtxArtifact> {
  const projectRoot = resolveProjectRoot(process.cwd());
  const root = gdctxRootDir();
  const rawRoot = path.join(root, "raw");
  const artifactsRoot = path.join(root, "artifacts");
  await mkdir(rawRoot, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });

  const resolvedId = id ?? newArtifactId(kind);
  const rawPath = path.join(rawRoot, `${resolvedId}.log`);
  const summaryPath = path.join(artifactsRoot, `${resolvedId}.md`);
  const latestRawPath = path.join(rawRoot, "latest.log");
  const latestSummaryPath = path.join(artifactsRoot, "latest.md");
  const bytesIn = Buffer.byteLength(raw);
  const bytesOut = Buffer.byteLength(summary);

  const artifact: CtxArtifact = {
    id: resolvedId,
    kind,
    command,
    exitCode,
    // Project-root-relative, not cwd-relative: the artifact now always lands
    // under the project's `.metaproject/`, so a cwd-relative path printed from
    // a subdirectory would be a `../../` walk that reads as a path escape.
    rawPath: path.relative(projectRoot, rawPath),
    summaryPath: path.relative(projectRoot, summaryPath),
    bytesIn,
    bytesOut,
    truncated: bytesOut < bytesIn,
  };
  const summaryWithMeta = `${summary.trimEnd()}

## Metadata

\`\`\`json
${JSON.stringify(artifact, null, 2)}
\`\`\`
`;

  await writeFile(rawPath, raw, "utf8");
  await writeFile(summaryPath, summaryWithMeta, "utf8");
  await writeFile(latestRawPath, raw, "utf8");
  await writeFile(latestSummaryPath, summaryWithMeta, "utf8");

  return artifact;
}

// True when the invocation means "what is different in this working tree" and
// we may therefore append a base revision. Anything else — an explicit
// revision, a `--` pathspec separator, or `--staged`/`--cached` (already
// explicit about which side it wants) — is passed to git verbatim, since
// appending a revision after a pathspec would change how git parses the args.
export function isWorkingTreeDiff(args: string[]): boolean {
  return args.every(
    (arg) => arg.startsWith("-") && arg !== "--" && arg !== "--staged" && arg !== "--cached",
  );
}

// `HEAD`, unless the repo has no commits yet (fresh `git init`) where it does
// not resolve and plain `git diff` is the only meaningful form.
async function defaultDiffBase(): Promise<string | undefined> {
  const head = await runCommand(["git", "rev-parse", "--verify", "--quiet", "HEAD"]);
  return head.exitCode === 0 ? "HEAD" : undefined;
}

async function listUntrackedFiles(): Promise<string[]> {
  const result = await runCommand(["git", "ls-files", "--others", "--exclude-standard"]);
  return result.exitCode === 0 ? nonEmptyLines(result.stdout) : [];
}

// `untracked` is null for explicit invocations (revision/pathspec/--staged),
// where a working-tree untracked listing would be noise.
export function summarizeDiff(
  command: string,
  result: CommandResult,
  config: CtxConfig,
  untracked: string[] | null = null,
): string {
  const lines = nonEmptyLines(result.raw);
  const shape = parseDiffOutput(lines);
  const count = diffFileCount(shape);
  const risky = shape.files.filter((file) =>
    /(^|\/)(package\.json|bun\.lockb|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|tsconfig.*\.json|\.github\/|scripts\/|src\/cli\.ts|src\/commands\/)/.test(file.path),
  );
  const allHunks = lines.filter((line) => line.startsWith("@@"));
  const shownHunks = allHunks.slice(0, config.maxOutputLines);
  const hunkNote = omissionNote(shownHunks.length, allHunks.length, "hunk headers");
  const hunks = hunkNote ? [...shownHunks, hunkNote] : shownHunks;

  return `# gdctx diff summary

Command: \`${command}\`
Exit code: \`${result.exitCode}\`
Changed files: \`${count ?? "unknown"}\`
${shape.mode === "patch" || shape.mode === "empty" ? "" : `Output shape: \`${shape.mode}\`\n`}${untracked ? `Untracked files: \`${untracked.length}\`\n` : ""}Raw lines: \`${lines.length}\`

## Files

${renderDiffFiles(shape, config)}
${untracked ? `\n## Untracked\n\n${renderUntrackedFiles(untracked, config)}\n` : ""}
## Risk Hints

${renderRiskHints(risky, shape, shape.files)}

## Hunks

\`\`\`text
${hunks.length > 0 ? hunks.join("\n") : "(no hunk headers)"}
\`\`\`

${importantSection(lines, config)}
`;
}

// ---------------------------------------------------------------------------
// ripgrep argv construction (flow 126 / S-001)
//
// The caller's pattern used to be spread straight into rg's argv. ripgrep then
// parses any value beginning with `-` as one of ITS options — and ripgrep has
// options that run an external program for every file it considers. So
// `keryx ctx rg "--pre=…"` reached arbitrary command execution through the one
// operation agents are explicitly told to prefer over raw grep.
//
// A `--` separator alone is not enough, because callers legitimately pass rg
// flags and everything after `--` is positional. So flags are allowlisted and
// the separator goes between them and the pattern:
//
//   rg <keryx flags> <allowlisted caller flags> -- <pattern> [paths]
//
// The allowlist is the part that fails closed. An unknown `-…` is refused
// rather than forwarded, so an option added to a future ripgrep — including a
// new way to execute something — is denied by default instead of inherited.

/** rg boolean flags keryx forwards. */
const RG_SAFE_FLAGS = new Set([
  "-i", "--ignore-case",
  "-s", "--case-sensitive",
  "-S", "--smart-case",
  "-w", "--word-regexp",
  "-x", "--line-regexp",
  "-F", "--fixed-strings",
  "-v", "--invert-match",
  "-U", "--multiline",
  "--multiline-dotall",
  "-l", "--files-with-matches",
  "--files-without-match",
  "--files",
  "-c", "--count",
  "--count-matches",
  "--hidden",
  "--no-ignore",
  "--no-ignore-vcs",
  "--follow",
  "-n", "--line-number",
  "-N", "--no-line-number",
  "--column", "--no-column",
  "--no-heading", "--heading",
  "--stats",
  "--crlf",
  "--word-regexp",
]);

/** rg flags that consume a following value (or use `--flag=value`). */
const RG_SAFE_VALUE_FLAGS = new Set([
  "-e", "--regexp",
  "-g", "--glob",
  "--iglob",
  "-t", "--type",
  "-T", "--type-not",
  "-A", "--after-context",
  "-B", "--before-context",
  "-C", "--context",
  "-m", "--max-count",
  "-M", "--max-columns",
  "--max-depth",
  "--sort", "--sortr",
]);

export type RgCommandResult =
  | { ok: true; command: string[] }
  | { ok: false; reason: string };

/**
 * Build the ripgrep argv, refusing any option that is not explicitly allowed.
 *
 * Exported so the separator and the allowlist can be asserted directly on the
 * produced array. A behaviour-level test would prove less: ripgrep may not be
 * installed (it is not, on some dev hosts), and a dangerous option may be
 * absent from a given build — so such a test could pass for the wrong reason
 * and keep passing after the guard was deleted.
 */
export function buildRgCommand(rgArgs: string[], listMode: "files" | "count" | null): RgCommandResult {
  // `--with-filename` is passed UNCONDITIONALLY. ripgrep omits the filename
  // whenever it is given a single explicit file path, which breaks the
  // `file:line:col:text` shape `parseRgMatches` expects — so
  // `keryx ctx rg "pattern" src/foo.ts` reported `Top Files: (unknown)` and
  // `0:0` for every hit, handing agents matches they could not locate.
  // `--no-heading` does not restore the filename; only `-H` / `--with-filename`
  // does. It is a no-op for the multi-path and directory cases, so the common
  // path is byte-identical.
  const base = listMode
    ? ["rg", "--with-filename", "--no-heading"]
    : ["rg", "--with-filename", "--line-number", "--column", "--no-heading"];

  const flags: string[] = [];
  const operands: string[] = [];
  let index = 0;
  let sawSeparator = false;

  while (index < rgArgs.length) {
    const arg = rgArgs[index]!;

    // An explicit `--` from the caller: everything after it is already a
    // pattern/path by their own intent.
    if (arg === "--" && !sawSeparator) {
      sawSeparator = true;
      index += 1;
      continue;
    }

    if (!sawSeparator && arg.startsWith("-") && arg !== "-") {
      const [name] = arg.split("=", 1) as [string];
      const inlineValue = arg.includes("=");

      if (RG_SAFE_VALUE_FLAGS.has(name)) {
        if (inlineValue) {
          flags.push(arg);
          index += 1;
          continue;
        }
        const value = rgArgs[index + 1];
        if (value === undefined) {
          return { ok: false, reason: `keryx ctx rg: ${name} needs a value.` };
        }
        // A dash-leading VALUE is refused, not forwarded. As a separate token it
        // is left to ripgrep's parser to classify, and older clap-based builds
        // treat a `--…` token following a pending option as a new option — which
        // re-opens the execution vector the separator closes. Folding into
        // `--flag=value` is not a general fix either, because short flags do not
        // accept the `=` form. Refusing is parser-independent, and the inline
        // form remains available for a genuine dash-leading value.
        if (value.startsWith("-") && value !== "-") {
          return {
            ok: false,
            reason:
              `keryx ctx rg: the value for ${name} may not start with a dash (${value}). ` +
              `Use the inline form instead, which cannot be re-parsed as an option: ${name}=${value}.`,
          };
        }
        flags.push(arg);
        flags.push(value);
        index += 2;
        continue;
      }

      if (RG_SAFE_FLAGS.has(name) && !inlineValue) {
        flags.push(arg);
        index += 1;
        continue;
      }

      return {
        ok: false,
        reason:
          `keryx ctx rg: unsupported ripgrep option ${name}. ` +
          `Only a reviewed set of options is forwarded, because ripgrep has options that execute external programs. ` +
          `To search for a literal string that starts with a dash, put it after -- (keryx ctx rg -- "${arg}").`,
      };
    }

    operands.push(arg);
    index += 1;
  }

  if (operands.length === 0) {
    return { ok: false, reason: 'keryx ctx rg: no pattern given. Usage: keryx ctx rg "<pattern>" [path]' };
  }

  // The separator is unconditional: with it present, no operand can be read as
  // an option no matter what it looks like.
  return { ok: true, command: [...base, ...flags, "--", ...operands] };
}

// rg flags that change output from matches to a file list (or per-file counts).
export function rgListMode(args: string[]): "files" | "count" | null {
  const has = (flags: string[]): boolean => args.some((a) => flags.includes(a));
  if (has(["-l", "--files-with-matches", "--files-without-match", "--files"])) {
    return "files";
  }
  if (has(["-c", "--count", "--count-matches"])) {
    return "count";
  }
  return null;
}

// Summarize `rg --files-with-matches` / `--files` / `--count` output, whose lines
// are bare paths (or `path:count`), not `file:line:col:text`.
export function summarizeRgFileList(
  command: string,
  result: CommandResult,
  config: CtxConfig,
  mode: "files" | "count",
): string {
  const lines = nonEmptyLines(result.raw);
  const shown = lines.slice(0, config.maxOutputLines);
  const note = omissionNote(shown.length, lines.length, "files");

  return `# gdctx rg (file list)

Command: \`${command}\`
Exit code: \`${result.exitCode}\`
${mode === "count" ? "Files (path:count)" : "Files"}: \`${lines.length}\`${shownSuffix(shown.length, lines.length)}

## Files

${shown.length > 0 ? shown.map((line) => `- ${line}`).join("\n") : "- none"}
${note ? `\n${note}` : ""}
${result.stderr.trim() ? `\n${renderStderr(result.stderr, config)}` : ""}`;
}

// Defect (flow 235 / T7, #1): the header counted the whole search and the body
// showed a fraction of it, with nothing between them saying so. Measured:
// `Matches: 50` printed above four matches, `Matches: 60` above 28, `Files: 20`
// above 12. The header count is true — it is the only number in the output that
// is — so a reader takes it as a description of what they are looking at and
// builds an enumeration on a twelfth of the result. The counts stay; what they
// gain is the size of the body beside them, and a marker at every cut.
export function summarizeRg(
  command: string,
  result: CommandResult,
  config: CtxConfig,
): string {
  const lines = nonEmptyLines(result.raw);
  const matches = parseRgMatches(lines);
  const grouped = groupBy(matches, (match) => match.file);
  const files = [...grouped.entries()]
    .map(([file, fileMatches]) => ({ file, matches: fileMatches }))
    .sort((a, b) => b.matches.length - a.matches.length);

  const shownFiles = files.slice(0, config.maxGroupItems);
  const shownMatches = shownFiles.reduce(
    (total, item) => total + Math.min(item.matches.length, RG_EXAMPLES_PER_FILE),
    0,
  );
  const topFilesNote = omissionNote(shownFiles.length, files.length, "files");

  return `# gdctx rg summary

Command: \`${command}\`
Exit code: \`${result.exitCode}\`
Matches: \`${matches.length}\`${shownSuffix(shownMatches, matches.length)}
Files: \`${files.length}\`${shownSuffix(shownFiles.length, files.length)}
Raw lines: \`${lines.length}\`

## Top Files

${files.length > 0 ? [...shownFiles.map((item) => `- ${item.file}: ${item.matches.length}`), ...(topFilesNote ? [topFilesNote] : [])].join("\n") : "- none"}

## Matches

${renderRgMatches(files, config)}

${result.stderr.trim() ? renderStderr(result.stderr, config) : ""}
`;
}

export function summarizeCommandOutput(
  command: string,
  result: CommandResult,
  config: CtxConfig,
  context: SummaryContext = { address: LATEST_ADDRESS },
): string {
  const lines = nonEmptyLines(result.raw);
  const compaction = compactLines(lines, config.maxOutputLines, config.maxImportantLines);
  // A command whose output IS a document (`--reporter=json`, a `cat` of a
  // manifest) must not hand back a compacted body that still looks like one.
  const format = compaction.omitted > 0 ? detectStructuredFormat(result.raw) : null;

  return `# gdctx command summary

Command: \`${command}\`
Exit code: \`${result.exitCode}\`
Raw lines: \`${lines.length}\`
stdout bytes: \`${Buffer.byteLength(result.stdout)}\`
stderr bytes: \`${Buffer.byteLength(result.stderr)}\`
${format ? `${excerptNotice(format, compaction.lines.length - 1, lines.length)}\n` : ""}
${importantSection(lines, config)}${manifestSection(compaction.omittedRanges, context)}## Output

\`\`\`text
${compaction.lines.join("\n") || "(no output)"}
\`\`\`
`;
}

/** The `## Omitted` block, with a trailing blank line, or "". */
function manifestSection(ranges: OmittedRange[], context: SummaryContext): string {
  const rendered = renderLossManifest(buildLossManifest(ranges, context.address));
  return rendered ? `${rendered}\n` : "";
}

function summarizeFullFile(file: string, lines: string[]): string {
  return `# gdctx full file

File: \`${file}\`
Lines: \`${lines.length}\`

\`\`\`text
${lines.join("\n")}
\`\`\`
`;
}

function summarizeOutline(file: string, lines: string[], config: CtxConfig): string {
  const imports = outlineEntries(lines, /^\s*import\b/, config);
  const exports = outlineEntries(lines, /^\s*export\b/, config);
  const declarations = outlineEntries(
    lines,
    /^\s*(export\s+)?(abstract\s+)?(class|interface|type|enum|function|async function|const|let|var)\b/,
    config,
  );
  const todos = outlineEntries(lines, /\b(TODO|FIXME|HACK)\b/i, config);

  return `# gdctx file outline

File: \`${file}\`
Lines: \`${lines.length}\`

## Imports

\`\`\`text
${imports.join("\n") || "(none)"}
\`\`\`

## Exports / Declarations

\`\`\`text
${dedupe([...exports, ...declarations]).join("\n") || "(none)"}
\`\`\`

## TODO / FIXME

\`\`\`text
${todos.join("\n") || "(none)"}
\`\`\`
`;
}

// `keryx ctx read --mode compact` — the highest-traffic read in the project,
// because the routing guard sends every `cat`/`head`/`tail` here.
//
// Three properties this had to gain (flow 235 / T9), each measured failing on
// this checkout first:
//
//   1. It sliced head+tail with its own inline code and never called
//      `compactLines`, so the verdict rescue `ctx run` already had was absent:
//      a `not ok` in the middle of a 4,000-line test log appeared zero times,
//      under a footer reporting 95% saved. An agent told to READ the log lost
//      every failure; the same content through `ctx run -- cat` kept them. The
//      two paths now share one compactor, so they cannot drift again.
//   2. An elided JSON document was line-truncated. Labelling it "an excerpt
//      that does not parse" (flow 235 / T7) stopped it claiming to be whole,
//      but left nothing machine-readable. It is now a structural summary that
//      parses — see src/ctx/structured.ts.
//   3. The only disclosure of loss was a scalar byte count, so an omitted
//      region could be recovered only by re-reading the whole raw copy and
//      searching it again. Each omitted range is now addressed.
//
// A file that fits entirely is untouched in all three respects: no manifest, no
// excerpt notice, no envelope.
export function summarizeCompact(
  file: string,
  lines: string[],
  config: CtxConfig,
  context: SummaryContext = { address: LATEST_ADDRESS },
): string {
  const budget = config.compactHeadLines + config.compactTailLines;
  const content = lines.join("\n");

  // JSON first: for a structured document, "what to keep" is a question about
  // the structure, not about which lines happen to sit at the ends of the file.
  const recover = `keryx ctx show ${context.address} --raw`;
  const structured =
    lines.length > budget
      ? summarizeJsonDocument(content, { maxBytes: structuredBudgetBytes(config), recover })
      : null;
  if (structured) {
    return `# gdctx compact file

File: \`${file}\`
Lines: \`${lines.length}\`
${structured.complete ? "" : `${structuralSummaryNotice(lines.length, recover)}\n`}
\`\`\`json
${structured.text}
\`\`\`
`;
  }

  const compaction = compactLines(lines, budget, config.maxImportantLines);
  // A JSONL document, or a JSON one the structural summariser declined, still
  // must not read as whole once it has been cut.
  const format = compaction.omitted > 0 ? detectStructuredFormat(content) : null;
  // For JSONL the unit of validity is the row, and every source row already
  // parses — the only line that does not is the compaction marker. Rewriting it
  // as a row keeps `lines.map(JSON.parse)` working over the excerpt.
  const body = format === "jsonl" ? repairJsonLines(compaction.lines, recover) : compaction.lines;
  const notice =
    format === "jsonl"
      ? jsonlExcerptNotice(compaction.lines.length - 1, lines.length)
      : format
        ? excerptNotice(format, compaction.lines.length - 1, lines.length)
        : null;

  return `# gdctx compact file

File: \`${file}\`
Lines: \`${lines.length}\`
${notice ? `${notice}\n` : ""}
${manifestSection(compaction.omittedRanges, context)}\`\`\`${format === "jsonl" ? "jsonl" : "text"}
${body.join("\n")}
\`\`\`
`;
}

export type DiffFileStat = {
  path: string;
  /** Exact, from patch or `--numstat`. `undefined` when the shape cannot give them. */
  added?: number;
  removed?: number;
  /** Total changed lines, from `--stat`, which reports one number and a histogram. */
  changed?: number;
};

export type DiffOutputShape = {
  mode: "empty" | "patch" | "numstat" | "stat" | "name-status" | "name-only" | "unenumerable";
  files: DiffFileStat[];
  /** git's own count, from a `N files changed` summary line. Beats counting rows. */
  reportedFileCount?: number;
  /** `--stat` elides long paths to `.../tail`, so path-matching is unreliable. */
  pathsAbbreviated: boolean;
};

const STAT_SUMMARY = /^\s*(\d+) files? changed/;
const NUMSTAT_ROW = /^(\d+|-)\t(\d+|-)\t(.+)$/;
const STAT_ROW = /^\s*(\S.*?)\s+\|\s+(\d+|Bin)\b/;
const NAME_STATUS_ROW = /^([ACDMRTUXB]\d*)\t(.+)$/;

// The summariser used to understand ONE output shape — a full patch, found by
// its `diff --git` headers and counted from `+`/`-` lines. Every other shape git
// can be asked for (`--stat`, `--numstat`, `--name-only`, `--name-status`,
// `--shortstat`) carries no such header, so the parser found nothing and the
// summary said `Changed files: 0` over a real diff. That is a FALSE-CLEAN
// report: an agent reading the summary concludes the tree is untouched while
// the raw log beside it lists hundreds of changed lines. Reproduced against 14
// modified files whose raw log ended `14 files changed, 831 insertions(+)`.
//
// So the shape is now inferred from the OUTPUT rather than from the flags — the
// same fact regardless of how the flag was spelled (`--stat`, `--stat=200`,
// `-p --stat`) — and any shape that cannot be enumerated reports `unknown`
// rather than a confident zero. Only genuinely empty output means zero.
export function parseDiffOutput(lines: string[]): DiffOutputShape {
  if (lines.length === 0) {
    return { mode: "empty", files: [], reportedFileCount: 0, pathsAbbreviated: false };
  }

  if (lines.some((line) => line.startsWith("diff --git "))) {
    return { mode: "patch", files: parsePatchFiles(lines), pathsAbbreviated: false };
  }

  const numstat = lines.map((line) => line.match(NUMSTAT_ROW)).filter((m) => m !== null);
  if (numstat.length > 0) {
    const files = numstat.map((m) => ({
      path: m[3] as string,
      // git writes `-` for binary files; absent counts, not zero ones — a
      // reported `+0 -0` would claim the file was touched without changing.
      ...(m[1] === "-" ? {} : { added: Number(m[1]) }),
      ...(m[2] === "-" ? {} : { removed: Number(m[2]) }),
    }));
    return { mode: "numstat", files: sortBySize(files), pathsAbbreviated: false };
  }

  const summary = lines.map((line) => line.match(STAT_SUMMARY)).find((m) => m !== null);
  const statRows = lines
    .filter((line) => !STAT_SUMMARY.test(line))
    .map((line) => line.match(STAT_ROW))
    .filter((m) => m !== null);
  if (summary || statRows.length > 0) {
    const files = statRows.map((m) => ({
      path: (m[1] as string).trim(),
      ...(m[2] === "Bin" ? {} : { changed: Number(m[2]) }),
    }));
    return {
      mode: "stat",
      files: sortBySize(files),
      ...(summary ? { reportedFileCount: Number(summary[1]) } : {}),
      pathsAbbreviated: files.some((file) => file.path.includes(".../")),
    };
  }

  const nameStatus = lines.map((line) => line.match(NAME_STATUS_ROW)).filter((m) => m !== null);
  if (nameStatus.length > 0) {
    return {
      mode: "name-status",
      files: nameStatus.map((m) => ({ path: m[2] as string })),
      pathsAbbreviated: false,
    };
  }

  // `--name-only`: bare paths, one per line. Required to be unanimous — a single
  // line of prose means this is some other shape and guessing would invent files.
  if (lines.every((line) => /^[^\s|]\S*$/.test(line))) {
    return { mode: "name-only", files: lines.map((path) => ({ path })), pathsAbbreviated: false };
  }

  return { mode: "unenumerable", files: [], pathsAbbreviated: false };
}

function sortBySize(files: DiffFileStat[]): DiffFileStat[] {
  const size = (file: DiffFileStat): number =>
    file.changed ?? (file.added ?? 0) + (file.removed ?? 0);
  return [...files].sort((a, b) => size(b) - size(a));
}

function parsePatchFiles(lines: string[]): DiffFileStat[] {
  const files = new Map<string, { path: string; added: number; removed: number }>();
  let current: { path: string; added: number; removed: number } | undefined;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const filePath = line.match(/ b\/(.+)$/)?.[1] ?? line.split(" ").at(-1)?.replace(/^b\//, "") ?? "unknown";
      current = files.get(filePath) ?? { path: filePath, added: 0, removed: 0 };
      files.set(filePath, current);
      continue;
    }

    if (!current || line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    if (line.startsWith("+")) {
      current.added += 1;
    } else if (line.startsWith("-")) {
      current.removed += 1;
    }
  }

  return sortBySize([...files.values()]);
}

/** What the `Changed files:` line reports. `undefined` means "not knowable here". */
export function diffFileCount(shape: DiffOutputShape): number | undefined {
  if (shape.reportedFileCount !== undefined) {
    return shape.reportedFileCount;
  }
  return shape.mode === "unenumerable" ? undefined : shape.files.length;
}

function renderDiffFiles(shape: DiffOutputShape, config: CtxConfig): string {
  if (shape.files.length === 0) {
    const count = diffFileCount(shape);
    if (count === undefined) {
      return `- not enumerable: this output shape carries no per-file rows. Read the raw log.`;
    }
    if (count > 0) {
      return `- ${count} file(s) changed, but this output shape lists no per-file rows (\`--shortstat\`). Read the raw log.`;
    }
    return "- none";
  }

  const shown = shape.files.slice(0, config.maxGroupItems);
  const note = omissionNote(shown.length, shape.files.length, "files");
  return [
    ...shown.map((file) => `- ${file.path}${renderDiffCounts(file)}`),
    ...(note ? [note] : []),
  ].join("\n");
}

function renderDiffCounts(file: DiffFileStat): string {
  if (file.added !== undefined || file.removed !== undefined) {
    return `: +${file.added ?? "?"} -${file.removed ?? "?"}`;
  }
  return file.changed !== undefined ? `: ~${file.changed} changed` : "";
}

// `--stat` elides a long path to `.../tail`, so the risk regexes — which match on
// prefixes like `src/commands/` — cannot fire on paths that no longer carry one.
// Reporting "- none" there would be the same false-clean the file-count fix
// removed, one section further down.
function renderRiskHints(risky: DiffFileStat[], shape: DiffOutputShape, files: DiffFileStat[]): string {
  const hints = risky.map((file) => `- ${file.path}`);
  if (shape.pathsAbbreviated) {
    hints.push(
      "- (paths are abbreviated by `--stat`; risk matching is unreliable — re-run with `--numstat` or `--name-only` to check)",
    );
  }
  if (hints.length === 0) {
    // "- none" may ONLY be said when a file list was actually examined. Three
    // states get confused otherwise, and two of them are lies:
    //
    //   - `unenumerable`: no list at all — already handled.
    //   - a shape that reports a COUNT but no rows (`--shortstat`, or a `--stat`
    //     whose rows all failed to parse): the count proves files changed and
    //     the empty row set proves none were inspected. This printed "- none".
    //   - a genuinely empty diff: nothing changed, so nothing is risky, and
    //     "- none" is the honest answer.
    //
    // The middle case is what shipped: `keryx ctx diff v0.2.73 v0.2.74
    // --shortstat -- package.json src/commands/ctx.ts` said `Changed files: 2`
    // and `Risk Hints: - none`, while `package.json` — which the risk regexes
    // match — was one of the two. Same false-clean class as the `Changed files:
    // 0` fix this section sits below, twenty lines further down.
    if (shape.mode === "unenumerable") {
      return "- unknown: no file list in this output shape";
    }
    if (files.length === 0 && (shape.reportedFileCount ?? 0) > 0) {
      return `- unknown: ${shape.reportedFileCount} file(s) changed but this output shape lists no per-file rows — nothing was checked. Re-run with \`--numstat\` or \`--name-only\`.`;
    }
    return "- none";
  }
  return hints.join("\n");
}

function renderUntrackedFiles(untracked: string[], config: CtxConfig): string {
  if (untracked.length === 0) {
    return "- none";
  }

  const shown = untracked.slice(0, config.maxGroupItems);
  const note = omissionNote(shown.length, untracked.length, "untracked files");
  return [...shown.map((file) => `- ${file}`), ...(note ? [note] : [])].join("\n");
}

function parseRgMatches(lines: string[]): Array<{ file: string; line: string; column: string; text: string }> {
  return lines.map((line) => {
    const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (!match) {
      return { file: "(unknown)", line: "0", column: "0", text: line };
    }
    const [, file = "(unknown)", lineNumber = "0", column = "0", text = ""] = match;
    return { file, line: lineNumber, column, text: text.trim() };
  });
}

/** How many hits are rendered per file before the rest are named as omitted. */
const RG_EXAMPLES_PER_FILE = 4;

function renderRgMatches(
  files: Array<{ file: string; matches: Array<{ line: string; column: string; text: string }> }>,
  config: CtxConfig,
): string {
  if (files.length === 0) {
    return "- none";
  }

  const rendered = files.slice(0, config.maxGroupItems).map((item) => {
    const shown = item.matches.slice(0, RG_EXAMPLES_PER_FILE);
    const note = omissionNote(shown.length, item.matches.length, "matches in this file");
    return [
      `- ${item.file}`,
      ...shown.map((match) => `  - ${match.line}:${match.column} ${truncate(match.text, 180)}`),
      ...(note ? [`  ${note}`] : []),
    ].join("\n");
  });
  const note = omissionNote(rendered.length, files.length, "files");
  return [...rendered, ...(note ? [note] : [])].join("\n");
}

/** stderr, bounded, with the marker that says the bound was reached. */
function renderStderr(stderr: string, config: CtxConfig): string {
  const lines = stderr.split("\n");
  const shown = lines.slice(0, config.maxImportantLines);
  const note = omissionNote(shown.length, lines.length, "stderr lines");
  return renderTextSection("stderr", note ? [...shown, note] : shown);
}

function outlineEntries(lines: string[], pattern: RegExp, config: CtxConfig): string[] {
  const matched = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => pattern.test(line))
    .map(({ line, number }) => `${number}: ${line.trimEnd()}`);
  const shown = matched.slice(0, config.outlineMaxEntries);
  const note = omissionNote(shown.length, matched.length, "entries");
  return note ? [...shown, note] : shown;
}

async function loadConfig(): Promise<CtxConfig> {
  const configPath = path.join(
    resolveProjectRoot(process.cwd()),
    ".metaproject",
    "gdctx.config.json",
  );
  if (!(await pathExists(configPath))) {
    return DEFAULT_CONFIG;
  }

  const parsed = await readJsonFileOr<Partial<CtxConfig>>(configPath, {});
  return {
    maxOutputLines: parsed.maxOutputLines ?? DEFAULT_CONFIG.maxOutputLines,
    maxImportantLines: parsed.maxImportantLines ?? DEFAULT_CONFIG.maxImportantLines,
    maxGroupItems: parsed.maxGroupItems ?? DEFAULT_CONFIG.maxGroupItems,
    compactHeadLines: parsed.compactHeadLines ?? DEFAULT_CONFIG.compactHeadLines,
    compactTailLines: parsed.compactTailLines ?? DEFAULT_CONFIG.compactTailLines,
    outlineMaxEntries: parsed.outlineMaxEntries ?? DEFAULT_CONFIG.outlineMaxEntries,
  };
}

// Verdict lines for the `Errors / Warnings` section, with the marker that says
// how many the budget cut. Which lines count is `classifyLine` in ctx/lines.ts —
// shared with compaction, which used to carry a second, different regex.
function importantSection(lines: string[], config: CtxConfig): string {
  const { kept, total } = importantLines(lines, config.maxImportantLines);
  if (kept.length === 0) {
    return "";
  }
  const note = omissionNote(kept.length, total, "failure/warning lines");
  return renderTextSection("Errors / Warnings", note ? [...kept, note] : kept);
}

function nonEmptyLines(value: string): string[] {
  return value.split("\n").filter((line) => line.trim().length > 0);
}

function renderTextSection(title: string, lines: string[]): string {
  return `## ${title}

\`\`\`text
${lines.join("\n") || "(none)"}
\`\`\`
`;
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

// Defect (flow 238 / phase 6 / T5, #1): a four-byte `ctx read` printed 311
// bytes and a single-hit `ctx rg` printed ~490-520 — the raw/summary pointer
// trailer below was unconditional, so it cost tens of times the payload on
// small input. The trailer earns its keep only when the body above is NOT
// the whole story: `artifact.truncated` (compaction actually cut something)
// means the printed body is partial, so a pointer to the full raw copy is
// the tool's "expandable without re-reading" contract. When nothing was cut,
// the body already IS everything — the same pointer would be pure overhead.
//
// `alwaysShowPointer` lets `run`/`diff` keep their unconditional trailer
// (existing callers, e.g. the "writes to the project root" regression test,
// key off its presence regardless of size) while `read`/`rg` — the two
// commands the small-input defect was measured on — drop it once
// `artifact.truncated` is false.
function printArtifactSummary(
  artifact: CtxArtifact,
  summary: string,
  {
    alwaysShowPointer = true,
    prefix,
  }: { alwaysShowPointer?: boolean; prefix?: string } = {},
): void {
  if (prefix) {
    console.log(prefix);
    console.log("");
  }
  console.log(summary.trimEnd());
  if (!alwaysShowPointer && !artifact.truncated) {
    return;
  }
  console.log("");
  if (artifact.truncated && artifact.bytesIn > 0) {
    const savedPct = Math.round((1 - artifact.bytesOut / artifact.bytesIn) * 100);
    console.log(
      `compacted: ${artifact.bytesIn.toLocaleString("en-US")} → ${artifact.bytesOut.toLocaleString("en-US")} bytes (${savedPct}% saved; full output in raw)`,
    );
  }
  console.log(`raw: ${artifact.rawPath}`);
  console.log(`summary: ${artifact.summaryPath}`);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function printHelp(): void {
  console.log(`keryx ctx

Usage:
  keryx ctx status
  keryx ctx diff [--staged|--stat|<revision>]   # no args: staged + unstaged (git diff HEAD) + untracked list
  keryx ctx rg "<pattern>"
  keryx ctx read <file> [--mode outline|compact|full] [--base <ref>]
  keryx ctx run -- <command...>
  keryx ctx show <artifact|latest> [--raw] [--lines <start>-<end>]
  keryx ctx install-hook [--runtime <id|all>]   # opt-in routing guard
  keryx ctx uninstall-hook [--runtime <id|all>]
  keryx ctx hook <runtime>                       # internal: invoked by the hook

Notes:
  --base is accepted and has no effect. keryx ctx has NO delta mode: there is
  no base snapshot to diff against, so every read returns the full view and
  says so. Delta-from-base is unbuilt, not broken — see NO_DELTA_REASON in
  src/commands/ctx.ts for what building it would require.
  --lines recovers one range named by a summary's "## Omitted" manifest,
  addressed by the "raw:" line that same summary printed.
`);
}
